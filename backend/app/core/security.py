import bcrypt
import secrets
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional
import httpx
from jose import JWTError, jwt
from app.core.config import settings

logger = logging.getLogger(__name__)


class Auth0VerificationError(Exception):
    """Raised when an Auth0 access token cannot be resolved to a user."""


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a plain password against a hashed password."""
    return bcrypt.checkpw(plain_password.encode(), hashed_password.encode())


def get_password_hash(password: str) -> str:
    """Hash a password."""
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Create a JWT access token.

    Carries a unique ``jti`` so the token can be added to a short-lived
    revocation denylist on logout (access tokens are otherwise valid until
    expiry). Callers don't need the jti; it is read back from the decoded
    payload when revoking.
    """
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(
            timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)

    to_encode.update({"exp": int(expire.timestamp()), "jti": secrets.token_urlsafe(16)})
    encoded_jwt = jwt.encode(
        to_encode, settings.secret_key, algorithm=settings.algorithm)
    logger.debug("Token created successfully")
    return encoded_jwt


def create_refresh_token(
    data: dict,
    expires_delta: Optional[timedelta] = None,
    jti: Optional[str] = None,
    expires_at: Optional[datetime] = None,
) -> tuple[str, str, datetime]:
    """Create a JWT refresh token with a unique jti claim.

    Returns (encoded_jwt, jti, expires_at) so the caller can persist the token.

    ``jti`` and ``expires_at`` may be supplied to deterministically RE-MINT an
    existing token's exact string (used by the rotation grace window to hand a
    racing request the same successor token that was already issued). When
    omitted a fresh jti and a default 7-day expiry are generated.
    """
    to_encode = data.copy()
    if expires_at is not None:
        expire = expires_at
    elif expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + \
            timedelta(days=settings.refresh_token_expire_days)

    if jti is None:
        jti = secrets.token_urlsafe(32)
    to_encode.update({"exp": int(expire.timestamp()), "jti": jti})
    encoded_jwt = jwt.encode(
        to_encode, settings.secret_key, algorithm=settings.algorithm)
    return encoded_jwt, jti, expire


def generate_service_token_id() -> str:
    """Public token identifier surfaced as the prefix of new tokens.

    Indexed on ``service_tokens.token_id`` so authentication does a
    single keyed lookup instead of a per-tenant bcrypt sweep. 16 hex
    characters = 64 bits of entropy, plenty to make collisions
    practically impossible while keeping the on-the-wire prefix short.
    """
    return secrets.token_hex(8)


def generate_service_token() -> tuple[str, str, str]:
    """Generate a new service token.

    Returns ``(public_token, token_id, secret)`` where ``public_token``
    is the value the caller hands to the ingestion platform, and the
    other two are persisted on ``service_tokens`` (token_id verbatim,
    secret hashed via :func:`hash_service_token`). Surfaced as a tuple
    so the API endpoint that creates the row stays explicit about
    which piece goes where.
    """
    token_id = generate_service_token_id()
    secret = secrets.token_urlsafe(48)  # 64-char URL-safe
    return f"{token_id}.{secret}", token_id, secret


def split_service_token(raw: str) -> tuple[str | None, str]:
    """Split an inbound token into ``(token_id, secret)``.

    New-format tokens carry a ``<token_id>.<secret>`` shape; legacy
    tokens (no dot) are returned as ``(None, raw)`` so the caller can
    fall through to the loop-and-bcrypt path.
    """
    if "." not in raw:
        return None, raw
    token_id, _, secret = raw.partition(".")
    if not token_id or not secret:
        return None, raw
    return token_id, secret


def hash_service_token(token: str) -> str:
    """Hash a service token (or its secret half) for storage. Uses bcrypt."""
    return bcrypt.hashpw(token.encode(), bcrypt.gensalt()).decode()


def verify_service_token(plain_token: str, hashed_token: str) -> bool:
    """Verify a plaintext token against its stored hash."""
    return bcrypt.checkpw(plain_token.encode(), hashed_token.encode())


def decode_token(token: str) -> dict:
    """Decode and validate a JWT token."""
    try:
        payload = jwt.decode(token, settings.secret_key,
                             algorithms=[settings.algorithm])
        logger.debug("Token decoded successfully")
        return payload
    except JWTError as e:
        logger.error(
            f"JWT decode error: {e}")
        return None


async def verify_auth0_token(auth0_access_token: str) -> dict:
    """Resolve an Auth0 access token to its user identity.

    Calls Auth0's ``/userinfo`` endpoint with the bearer token. Auth0
    validates the token's signature, expiry, and audience server-side
    and returns the OIDC user profile (``sub``, ``email``,
    ``email_verified``, ...). This avoids us having to maintain a JWKS
    cache in-process and works whether the access token is a JWT or
    opaque.

    Returns the userinfo dict; raises :class:`Auth0VerificationError`
    on any failure so callers can map to a 401.
    """
    if not settings.auth0_enabled:
        raise Auth0VerificationError("Auth0 is not configured on the server")

    url = f"https://{settings.auth0_domain}/userinfo"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                url,
                headers={"Authorization": f"Bearer {auth0_access_token}"},
            )
    except httpx.HTTPError as exc:
        logger.warning("Auth0 /userinfo request failed: %s", exc)
        raise Auth0VerificationError("Auth0 unreachable") from exc

    if resp.status_code != 200:
        logger.info("Auth0 /userinfo rejected token: %s", resp.status_code)
        raise Auth0VerificationError("Invalid Auth0 token")

    try:
        data = resp.json()
    except ValueError as exc:
        raise Auth0VerificationError("Auth0 returned non-JSON response") from exc

    if not data.get("sub") or not data.get("email"):
        raise Auth0VerificationError("Auth0 userinfo missing sub or email")
    return data


class Auth0PasswordError(Exception):
    """Raised when Auth0 rejects an email/password pair.

    Carries the Auth0 ``error`` code so the caller can distinguish
    "wrong password" from "user not in Auth0 yet" and fall back
    to legacy bcrypt only for the latter.
    """

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code


async def auth0_password_grant(
    email: str,
    password: str,
    *,
    connection: str | None = None,
) -> str:
    """Exchange (email, password) for an Auth0 access token.

    Done server-side because Regular Web App clients are confidential
    and Auth0 requires the client secret for the password-realm grant.
    Keeping this on the backend also means the frontend can keep its
    existing simple ``POST /auth/login`` shape.

    Returns the access_token. Raises :class:`Auth0PasswordError` on any
    Auth0-side rejection; the error's ``code`` is the Auth0 ``error``
    field (``invalid_grant``, ``access_denied``, ...) so the login
    handler can decide whether to fall back to bcrypt.

    ``connection`` overrides the realm. Defaults to
    ``settings.auth0_connection`` (the tenant-user connection). The
    PA login path passes ``settings.auth0_pa_connection`` so
    credentials are routed to the right Auth0 Custom-Database
    connection (e.g. ``acufy-platform-admins``).
    """
    if not settings.auth0_enabled:
        raise Auth0PasswordError("Auth0 is not configured on the server")

    realm = connection or settings.auth0_connection
    url = f"https://{settings.auth0_domain}/oauth/token"
    body = {
        "grant_type": "http://auth0.com/oauth/grant-type/password-realm",
        "realm": realm,
        "username": email,
        "password": password,
        "client_id": settings.auth0_client_id,
        "client_secret": settings.auth0_client_secret,
        "scope": "openid profile email",
    }
    if settings.auth0_audience:
        body["audience"] = settings.auth0_audience

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(url, data=body)
    except httpx.HTTPError as exc:
        logger.warning("Auth0 /oauth/token request failed: %s", exc)
        raise Auth0PasswordError("Auth0 unreachable") from exc

    if resp.status_code == 200:
        data = resp.json()
        token = data.get("access_token")
        if not token:
            raise Auth0PasswordError("Auth0 returned no access_token")
        return token

    code: str | None = None
    description: str | None = None
    try:
        err = resp.json()
        code = err.get("error")
        description = err.get("error_description")
    except ValueError:
        pass
    logger.info("Auth0 password grant rejected: %s %s", code, description)
    raise Auth0PasswordError(description or "Auth0 rejected credentials", code=code)
