from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession
from app.db import get_db
from app.schemas import LoginRequest, TokenResponse, UserResponse, UserCreate, ChangePasswordRequest, PasswordChangeResponse, RefreshRequest, VerifyEmailRequest, VerifyEmailResponse, ResendVerificationRequest, MessageResponse, RoleSwitchRequest, RoleHandoffIssueResponse, RoleHandoffExchangeRequest, SetPasswordRequest, SetPasswordResponse, InvitationStatusResponse, ForgotPasswordRequest
from app.crud.user import get_user_by_email, create_user
from sqlalchemy import select, update
from app.core.security import (
    verify_password,
    create_access_token,
    create_refresh_token,
    get_password_hash,
    verify_auth0_token,
    Auth0VerificationError,
    auth0_password_grant,
    Auth0PasswordError,
)
from app.core.config import settings
from app.core.deps import get_current_user, get_tenant_db
from app.models.user import User, UserRole
from app.models.refresh_token import RefreshToken
from app.core.rate_limit import limiter
from app.services.activity import (
    TENANT_ADMIN_ACTIVITY_SCOPE,
    build_activity_event,
    record_activity_events,
)

DEFAULT_MAX_FAILED_ATTEMPTS = 5
DEFAULT_LOCKOUT_DURATION_MINUTES = 15


# ── HttpOnly refresh-token cookie ───────────────────────────────────
# The refresh token moves out of JS-readable storage into an HttpOnly
# cookie so XSS can't exfiltrate it. The short-lived access token still
# travels in the Authorization header (the SPA needs to read it), but the
# long-lived refresh token is now invisible to JavaScript.
#
# Path=/ (not /auth): the dev Vite proxy serves the API under /api/* and
# rewrites /api away before it hits the backend, so the browser sees the
# refresh request as /api/auth/refresh. A Path=/auth cookie would never be
# sent on that URL. Path=/ is reliably sent everywhere; HttpOnly keeps it
# unreadable regardless of which requests carry it. SameSite=Lax blocks it
# on cross-site subrequests; Secure (prod only) keeps it off plaintext HTTP.
REFRESH_COOKIE_NAME = "refresh_token"
REFRESH_COOKIE_PATH = "/"
REFRESH_COOKIE_MAX_AGE_SECONDS = settings.refresh_token_expire_days * 24 * 60 * 60


def _set_refresh_cookie(response: Response, token: str) -> None:
    """Write the refresh token as an HttpOnly cookie. Secure only outside
    debug so the flow still works over http://localhost in dev."""
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=token,
        max_age=REFRESH_COOKIE_MAX_AGE_SECONDS,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=not settings.debug,
        samesite="lax",
    )


def _clear_refresh_cookie(response: Response) -> None:
    """Delete the refresh cookie. Must target the same Path it was set with,
    or the browser keeps the original and 'logout' doesn't log out."""
    response.delete_cookie(
        key=REFRESH_COOKIE_NAME,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=not settings.debug,
        samesite="lax",
    )


# ── Platform-admin refresh-token storage (Redis-backed) ─────────────
# PA refresh tokens cannot live in the shared `refresh_tokens` table
# because that table FKs to `users(id)` and PA ids live in the separate
# `platform_admins` table in the control plane. We persist the jti -> pa_id
# mapping in Redis with TTL = refresh-token expiry. Revocation flips a
# flag (rather than deleting) so the refresh endpoint can return the
# correct "revoked" message instead of "unknown token".
_PA_REFRESH_KEY = "pa_refresh:{jti}"


async def _redis():
    import redis.asyncio as redis_async
    return redis_async.from_url(settings.redis_url, decode_responses=True)


async def _pa_refresh_remember(jti: str, pa_id: int, expires_at: datetime) -> None:
    """Persist a freshly-issued PA refresh token's jti -> pa_id in Redis."""
    try:
        r = await _redis()
        ttl = max(int((expires_at - datetime.now(timezone.utc)).total_seconds()), 60)
        await r.hset(_PA_REFRESH_KEY.format(jti=jti), mapping={"pa_id": str(pa_id), "revoked": "0"})
        await r.expire(_PA_REFRESH_KEY.format(jti=jti), ttl)
        await r.close()
    except Exception as exc:  # noqa: BLE001 - log and move on; auth still works for ~30min via access token
        import logging
        logging.getLogger(__name__).warning("pa_refresh_remember failed for jti=%s: %s", jti, exc)


async def _pa_refresh_consume(jti: str) -> int | None:
    """Atomically validate, mark revoked, and return the pa_id if the token
    was live. Returns None when the jti is missing or already revoked."""
    try:
        r = await _redis()
        key = _PA_REFRESH_KEY.format(jti=jti)
        async with r.pipeline(transaction=True) as pipe:
            await pipe.hgetall(key)
            await pipe.hset(key, "revoked", "1")
            results = await pipe.execute()
        await r.close()
        record = results[0]
        if not record or record.get("revoked") == "1":
            return None
        return int(record.get("pa_id"))
    except Exception as exc:  # noqa: BLE001
        import logging
        logging.getLogger(__name__).warning("pa_refresh_consume failed for jti=%s: %s", jti, exc)
        return None


async def _pa_refresh_revoke_all(pa_id: int) -> None:
    """Scan PA refresh keys and revoke any that belong to this pa_id.
    Best-effort; falls through on Redis unavailability."""
    try:
        r = await _redis()
        async for key in r.scan_iter(match="pa_refresh:*"):
            rec = await r.hgetall(key)
            if rec.get("pa_id") == str(pa_id) and rec.get("revoked") != "1":
                await r.hset(key, "revoked", "1")
        await r.close()
    except Exception as exc:  # noqa: BLE001
        import logging
        logging.getLogger(__name__).warning("pa_refresh_revoke_all failed for pa=%s: %s", pa_id, exc)


async def _resolve_tenant_slug(db: AsyncSession, tenant_id: int | None) -> str | None:
    """Look up the slug for a tenant_id; None for platform admins."""
    if tenant_id is None:
        return None
    from sqlalchemy import text
    row = (await db.execute(
        text("SELECT slug FROM tenants WHERE id = :tid"),
        {"tid": tenant_id},
    )).first()
    return row[0] if row else None


def _build_token_payload(
    *,
    user_id: int,
    tenant_id: int | None,
    can_review: bool,
    realm: str,
    tenant_slug: str | None,
    active_role: str | None = None,
    token_version: int | None = None,
) -> dict:
    """Assemble the JWT payload for access and refresh tokens.

    Single source of truth so login + refresh agree on claim shape.
    ``active_role`` is the per-token role for multi-role users; lets
    two tabs of the same user act as different roles independently.
    ``token_version`` (claim ``tv``) is the user's force-logout counter:
    get_current_user rejects a token whose ``tv`` is below the user's
    current value. Omitted for control-plane (PA) tokens, which have no
    per-tenant user row.
    """
    payload = {
        "sub": str(user_id),
        "tenant_id": tenant_id,
        "tenant_slug": tenant_slug,
        "realm": realm,
        "can_review": can_review,
    }
    if active_role is not None:
        payload["active_role"] = active_role
    if token_version is not None:
        payload["tv"] = token_version
    return payload


async def _lockout_policy(db: AsyncSession, tenant_id: int | None) -> tuple[int, int]:
    """(max_attempts, lockout_minutes) — per tenant with defaults."""
    if tenant_id is None:
        return DEFAULT_MAX_FAILED_ATTEMPTS, DEFAULT_LOCKOUT_DURATION_MINUTES
    from app.models.tenant_settings import TenantSettings
    from sqlalchemy import select as _select
    result = await db.execute(
        _select(TenantSettings.key, TenantSettings.value).where(
            TenantSettings.tenant_id == tenant_id,
            TenantSettings.key.in_(("max_failed_login_attempts", "lockout_duration_minutes")),
        )
    )
    rows = {row[0]: row[1] for row in result.all()}
    def _i(v, d):
        try:
            n = int(str(v).strip())
            return max(1, n)
        except Exception:
            return d
    return (
        _i(rows.get("max_failed_login_attempts"), DEFAULT_MAX_FAILED_ATTEMPTS),
        _i(rows.get("lockout_duration_minutes"), DEFAULT_LOCKOUT_DURATION_MINUTES),
    )

async def _login_with_auth0(
    *,
    request: Request,
    response: Response,
    email: str,
    password: str,
    db: AsyncSession,
) -> dict | None:
    """Try logging the user in via Auth0; return None to signal fallback.

    Two-step server-side flow: exchange (email, password) for an Auth0
    access token using the password-realm grant (with client secret),
    then verify that token via /userinfo and issue our own JWT pair.

    Returns the standard token-response dict on success.
    Returns ``None`` if Auth0 doesn't recognize the user — the caller
    should fall through to the bcrypt path. Raises HTTPException on
    explicit credential rejection so we don't quietly let bcrypt mask
    a wrong-password attempt as a successful Auth0 login.
    """
    try:
        access_token_str = await auth0_password_grant(email, password)
    except Auth0PasswordError as exc:
        # Auth0 doesn't surface "user doesn't exist" vs "wrong password"
        # to avoid enumeration. Both come back as ``invalid_grant``. We
        # use bcrypt as the fallback for the not-yet-migrated case but
        # only when Auth0 itself was reachable; on transport failure we
        # still try bcrypt so a flaky network doesn't lock everyone out.
        # Fall back to bcrypt when: user unknown, wrong password (invalid_grant),
        # user not yet provisioned in Auth0 (access_denied), or account blocked
        # by Auth0 brute-force protection (too_many_attempts) — in that case
        # local credentials are still authoritative.
        if exc.code in {"invalid_grant", "access_denied", "too_many_attempts", None}:
            return None
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    try:
        userinfo = await verify_auth0_token(access_token_str)
    except Auth0VerificationError:
        # We just got the token from Auth0 a moment ago, so /userinfo
        # failing here is a server-side problem, not bad credentials.
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Auth0 verification failed",
        )

    auth0_email = (userinfo.get("email") or "").strip().lower()
    auth0_sub = userinfo.get("sub")
    submitted_email = email.strip().lower()

    if auth0_email != submitted_email:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Auth0 token email does not match login email",
        )

    user = await get_user_by_email(db, submitted_email)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is inactive",
        )

    tenant_slug = await _resolve_tenant_slug(db, user.tenant_id)
    use_tenant_db = bool(tenant_slug)

    # Re-fetch from the tenant DB if isolated, so we update the row
    # that's the source of truth.
    if use_tenant_db:
        from app.db_tenant import tenant_session
        try:
            async with tenant_session(tenant_slug) as tenant_db:
                refreshed = await get_user_by_email(tenant_db, submitted_email)
            if refreshed is not None:
                user = refreshed
            else:
                use_tenant_db = False
        except (LookupError, ValueError):
            use_tenant_db = False

    realm = "platform" if user.role == UserRole.PLATFORM_ADMIN else "tenant"
    token_payload = _build_token_payload(
        user_id=user.id,
        tenant_id=user.tenant_id,
        can_review=user.can_review,
        realm=realm,
        tenant_slug=tenant_slug,
        token_version=user.token_version,
    )
    access_token = create_access_token(token_payload)
    refresh_token, jti, expires_at = create_refresh_token(token_payload)

    now = datetime.now(timezone.utc)
    previous_last_login_at = user.last_login_at

    if use_tenant_db:
        from app.db_tenant import tenant_session
        async with tenant_session(tenant_slug) as tenant_db:
            target = (await tenant_db.execute(
                select(User).where(User.id == user.id)
            )).scalar_one()
            if not target.auth0_sub:
                target.auth0_sub = auth0_sub
            # Auth0 owns email verification once we cut over; trust
            # its email_verified claim instead of our local flag.
            if userinfo.get("email_verified") and not target.email_verified:
                target.email_verified = True
                target.email_verified_at = now
            target.failed_login_attempts = 0
            target.locked_until = None
            target.last_login_at = now
            tenant_db.add(target)
            tenant_db.add(RefreshToken(user_id=user.id, jti=jti, expires_at=expires_at))
            await tenant_db.commit()
            await record_activity_events(tenant_db, [build_activity_event(
                activity_type="LOGIN_SUCCESS",
                visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                tenant_id=user.tenant_id,
                actor_user=target,
                entity_type="user",
                entity_id=user.id,
                summary=f"{target.full_name} logged in via Auth0.",
                route="/auth/login",
                metadata={"provider": "auth0"},
            )])
    else:
        if not user.auth0_sub:
            user.auth0_sub = auth0_sub
        if userinfo.get("email_verified") and not user.email_verified:
            user.email_verified = True
            user.email_verified_at = now
        user.failed_login_attempts = 0
        user.locked_until = None
        user.last_login_at = now
        db.add(user)
        db.add(RefreshToken(user_id=user.id, jti=jti, expires_at=expires_at))
        await db.commit()
        await record_activity_events(db, [build_activity_event(
            activity_type="LOGIN_SUCCESS",
            visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
            tenant_id=user.tenant_id,
            actor_user=user,
            entity_type="user",
            entity_id=user.id,
            summary=f"{user.full_name} logged in via Auth0.",
            route="/auth/login",
            metadata={"provider": "auth0"},
        )])

    # Re-fetch with eager loads for response serialization.
    if tenant_slug:
        from app.db_tenant import tenant_session
        try:
            async with tenant_session(tenant_slug) as tenant_db:
                refreshed = await get_user_by_email(tenant_db, user.email)
            if refreshed is not None:
                user = refreshed
            else:
                user = await get_user_by_email(db, user.email)
        except (LookupError, ValueError):
            user = await get_user_by_email(db, user.email)
    else:
        user = await get_user_by_email(db, user.email)

    _set_refresh_cookie(response, refresh_token)
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": user,
        "previous_last_login_at": (
            previous_last_login_at.isoformat() if previous_last_login_at else None
        ),
    }


router = APIRouter(prefix="/auth", tags=["authentication"])


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def register(
    user_create: UserCreate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> User:
    """
    Register a new user (Admin only).

    Note: this endpoint pre-dates the multi-tenant POST /users flow that
    the frontend now uses; we keep it for API-only callers. Writes land
    in the per-tenant DB; create_user mirrors back to the shared DB index.
    """
    # Check if admin or platform admin
    if current_user.role not in (UserRole.ADMIN, UserRole.PLATFORM_ADMIN):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can register new users",
        )

    # Prevent ADMIN from escalating to PLATFORM_ADMIN role
    if current_user.role != UserRole.PLATFORM_ADMIN and user_create.role == UserRole.PLATFORM_ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only a Platform Admin can create Platform Admin users",
        )

    # Determine tenant_id for the new user
    if current_user.role == UserRole.PLATFORM_ADMIN:
        if user_create.role == UserRole.PLATFORM_ADMIN:
            # New PLATFORM_ADMIN users have no tenant
            tenant_id = None
        elif not user_create.tenant_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="tenant_id is required when creating users as platform admin",
            )
        else:
            tenant_id = user_create.tenant_id
    else:
        # Tenant ADMIN can only create users in their own tenant
        tenant_id = current_user.tenant_id

    # Check if user already exists in this tenant.
    existing_user = await get_user_by_email(db, user_create.email)
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered",
        )

    # Inject the resolved tenant_id
    user_create.tenant_id = tenant_id

    # Enforce password policy if a password is explicitly provided
    if user_create.password:
        from app.api.users import _validate_new_password
        _validate_new_password(user_create.password)

    # Create user (in per-tenant DB; create_user mirrors stub into shared DB).
    new_user, _temp_password, _invite_url = await create_user(db, user_create)
    return new_user


@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")
async def login(
    request: Request,
    login_request: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Login with email + password.

    Resolution order:
      1. Platform admin via the control plane (bcrypt) — unchanged.
      2. Auth0 password-realm grant — backend exchanges the credentials
         for an Auth0 token, verifies it via /userinfo, and issues our
         own JWT pair. Returns ``None`` on Auth0-side rejection so we
         can fall through to (3).
      3. Legacy per-tenant bcrypt path with lockout.

    The frontend always sends ``{email, password}`` and is unaware of
    which path served it.
    """
    from app.db_control import AsyncControlSessionLocal
    from app.models.control import PlatformAdmin
    async with AsyncControlSessionLocal() as control_db:
        pa_row = (await control_db.execute(
            select(PlatformAdmin).where(PlatformAdmin.email == login_request.email)
        )).scalar_one_or_none()

    if pa_row is not None:
        # Try Auth0 first when configured. The first login per PA goes
        # through Auth0's Custom-Database connection: Auth0 calls our
        # /auth/auth0-db/verify-pa endpoint, which validates against
        # our bcrypt hash. Auth0 imports the PA at that moment and the
        # Post-Login Action writes auth0_sub back to our row. From the
        # second login onwards, Auth0 already knows the PA and skips
        # our verify endpoint entirely.
        #
        # We attempt Auth0 unconditionally (not gated on auth0_sub)
        # because the bootstrap case has auth0_sub NULL but we still
        # want Auth0 to take over. The bcrypt fallback below catches
        # the rare cases where Auth0 is unreachable.
        pa_auth0_token = None
        if settings.auth0_enabled and settings.auth0_pa_connection:
            try:
                pa_auth0_token = await auth0_password_grant(
                    login_request.email,
                    login_request.password,
                    connection=settings.auth0_pa_connection,
                )
            except Auth0PasswordError as exc:
                # Same fallback policy as the tenant path: only quietly
                # fall through on bad-creds-shaped errors. Network /
                # config failures bubble up.
                if exc.code not in {"invalid_grant", "access_denied", "too_many_attempts", None}:
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail="Invalid email or password",
                    )
                pa_auth0_token = None

        if pa_auth0_token is not None:
            # Auth0 accepted the credentials. Verify the token and
            # confirm it actually belongs to this PA before issuing
            # our JWT (defence against email-substitution attacks).
            try:
                userinfo = await verify_auth0_token(pa_auth0_token)
            except Auth0VerificationError:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Auth0 verification failed",
                )
            auth0_email = (userinfo.get("email") or "").strip().lower()
            submitted_email = login_request.email.strip().lower()
            if auth0_email != submitted_email:
                import logging as _logging
                _logging.getLogger(__name__).warning(
                    "PA Auth0 token email mismatch: submitted=%r token=%r sub=%r",
                    submitted_email,
                    auth0_email,
                    userinfo.get("sub"),
                )
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Auth0 token email does not match login email",
                )
            # Auth0 said yes — fall through to the existing PA JWT
            # issuance below by short-circuiting the bcrypt verify.
        elif not verify_password(login_request.password, pa_row.hashed_password):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password",
            )
        if not pa_row.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="User account is inactive",
            )
        pa_payload = _build_token_payload(
            user_id=pa_row.id,
            tenant_id=None,
            can_review=False,
            realm="platform",
            tenant_slug=None,
        )
        pa_access = create_access_token(pa_payload)
        pa_refresh, pa_jti, pa_expires = create_refresh_token(pa_payload)
        # Persist the PA refresh token's jti in Redis so /auth/refresh
        # can validate it (the shared-DB refresh_tokens table FKs to
        # users(id) and PA ids live in a separate platform_admins table).
        # Redis TTL matches the refresh-token expiry so revocation also
        # happens automatically when the token would naturally expire.
        await _pa_refresh_remember(pa_jti, pa_row.id, pa_expires)
        _set_refresh_cookie(response, pa_refresh)
        return {
            "access_token": pa_access,
            "token_type": "bearer",
            "user": {
                "id": pa_row.id,
                "tenant_id": None,
                "email": pa_row.email,
                "username": pa_row.username,
                "full_name": pa_row.full_name,
                "title": None,
                "department": None,
                "timezone": "UTC",
                "role": UserRole.PLATFORM_ADMIN,
                "is_active": pa_row.is_active,
                "manager_id": None,
                "project_ids": [],
                "default_client_id": None,
                "has_changed_password": pa_row.has_changed_password,
                "email_verified": pa_row.email_verified,
                "can_review": False,
                "is_external": False,
                "created_at": pa_row.created_at,
                "updated_at": pa_row.updated_at,
            },
        }

    # Try Auth0 first when configured. Returns None if Auth0 doesn't
    # recognize the user (i.e., not migrated yet) so we can fall
    # through to the legacy bcrypt path. Explicit credential rejection
    # raises directly and short-circuits the fallback.
    if settings.auth0_enabled:
        auth0_result = await _login_with_auth0(
            request=request,
            response=response,
            email=login_request.email,
            password=login_request.password,
            db=db,
        )
        if auth0_result is not None:
            return auth0_result

    # Look up by email in shared DB, then re-fetch from the tenant DB
    # if the tenant is isolated (source of truth for password + lockout).
    user = await get_user_by_email(db, login_request.email)

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    tenant_slug = await _resolve_tenant_slug(db, user.tenant_id)
    use_tenant_db = bool(tenant_slug)

    if use_tenant_db:
        from app.db_tenant import tenant_session
        try:
            async with tenant_session(tenant_slug) as tenant_db:
                refreshed = await get_user_by_email(tenant_db, login_request.email)
            if refreshed is not None:
                user = refreshed
            else:
                # Tenant DB doesn't know this email; fall back to shared.
                use_tenant_db = False
        except (LookupError, ValueError):
            use_tenant_db = False

    # Check if account is locked
    if user.locked_until and user.locked_until > datetime.now(timezone.utc):
        remaining = int((user.locked_until - datetime.now(timezone.utc)).total_seconds() / 60) + 1
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Account is locked due to too many failed attempts. Try again in {remaining} minute(s).",
        )

    # Verify password
    if not verify_password(login_request.password, user.hashed_password):
        max_attempts, lockout_minutes = await _lockout_policy(db, user.tenant_id)
        # When the user lives in an isolated per-tenant DB, all writes
        # (lockout counter, activity event) MUST use the tenant DB —
        # the shared row may not exist or may have a different id, so
        # the actor_user_id FK on activity_log would fail. The success
        # path already does this; we now mirror the same pattern here.
        if use_tenant_db:
            from app.db_tenant import tenant_session
            async with tenant_session(tenant_slug) as tenant_db:
                target = (await tenant_db.execute(
                    select(User).where(User.id == user.id)
                )).scalar_one()
                target.failed_login_attempts = (target.failed_login_attempts or 0) + 1
                locked = target.failed_login_attempts >= max_attempts
                if locked:
                    target.locked_until = datetime.now(timezone.utc) + timedelta(minutes=lockout_minutes)
                tenant_db.add(target)
                await tenant_db.commit()
                user = target
                await record_activity_events(tenant_db, [build_activity_event(
                    activity_type="LOGIN_FAILED",
                    visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                    tenant_id=user.tenant_id,
                    actor_user=user,
                    entity_type="user",
                    entity_id=user.id,
                    summary=f"Failed login attempt for {user.email} (attempt {user.failed_login_attempts}){' (account locked)' if locked else ''}.",
                    route="/user-management",
                    route_params={"userId": user.id},
                    metadata={"attempt": user.failed_login_attempts, "locked": locked},
                    severity="warning" if not locked else "critical",
                )])
        else:
            user.failed_login_attempts = (user.failed_login_attempts or 0) + 1
            locked = user.failed_login_attempts >= max_attempts
            if locked:
                user.locked_until = datetime.now(timezone.utc) + timedelta(minutes=lockout_minutes)
            db.add(user)
            await db.commit()
            await record_activity_events(db, [build_activity_event(
                activity_type="LOGIN_FAILED",
                visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                tenant_id=user.tenant_id,
                actor_user=user,
                entity_type="user",
                entity_id=user.id,
                summary=f"Failed login attempt for {user.email} (attempt {user.failed_login_attempts}){' (account locked)' if locked else ''}.",
                route="/user-management",
                route_params={"userId": user.id},
                metadata={"attempt": user.failed_login_attempts, "locked": locked},
                severity="warning" if not locked else "critical",
            )])

        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is inactive",
        )

    if not user.email_verified:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="EMAIL_NOT_VERIFIED",
        )

    realm = "platform" if user.role == UserRole.PLATFORM_ADMIN else "tenant"
    token_payload = _build_token_payload(
        user_id=user.id,
        tenant_id=user.tenant_id,
        can_review=user.can_review,
        realm=realm,
        tenant_slug=tenant_slug,
        token_version=user.token_version,
    )
    access_token = create_access_token(token_payload)
    refresh_token, jti, expires_at = create_refresh_token(token_payload)

    now = datetime.now(timezone.utc)
    previous_last_login_at = user.last_login_at

    if use_tenant_db:
        from app.db_tenant import tenant_session
        async with tenant_session(tenant_slug) as tenant_db:
            target = (await tenant_db.execute(
                select(User).where(User.id == user.id)
            )).scalar_one()
            target.failed_login_attempts = 0
            target.locked_until = None
            target.last_login_at = now
            tenant_db.add(target)
            tenant_db.add(RefreshToken(user_id=user.id, jti=jti, expires_at=expires_at))
            await tenant_db.commit()
            await record_activity_events(tenant_db, [build_activity_event(
                activity_type="LOGIN_SUCCESS",
                visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                tenant_id=user.tenant_id,
                actor_user=target,
                entity_type="user",
                entity_id=user.id,
                summary=f"{target.full_name} logged in.",
                route="/auth/login",
            )])
    else:
        user.failed_login_attempts = 0
        user.locked_until = None
        user.last_login_at = now
        db.add(user)
        db.add(RefreshToken(user_id=user.id, jti=jti, expires_at=expires_at))
        await db.commit()
        await record_activity_events(db, [build_activity_event(
            activity_type="LOGIN_SUCCESS",
            visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
            tenant_id=user.tenant_id,
            actor_user=user,
            entity_type="user",
            entity_id=user.id,
            summary=f"{user.full_name} logged in.",
            route="/auth/login",
        )])

    # Re-fetch with eager loads so response serialization doesn't hit
    # expired attributes after the commits above.
    if tenant_slug:
        from app.db_tenant import tenant_session
        try:
            async with tenant_session(tenant_slug) as tenant_db:
                refreshed = await get_user_by_email(tenant_db, user.email)
            if refreshed is not None:
                user = refreshed
            else:
                user = await get_user_by_email(db, user.email)
        except (LookupError, ValueError):
            user = await get_user_by_email(db, user.email)
    else:
        user = await get_user_by_email(db, user.email)

    # Refresh token rides in an HttpOnly cookie, not the JSON body, so JS
    # (and therefore XSS) can't read it.
    _set_refresh_cookie(response, refresh_token)
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": user,
        "previous_last_login_at": (
            previous_last_login_at.isoformat() if previous_last_login_at else None
        ),
    }


@router.post("/refresh", response_model=TokenResponse)
@limiter.limit("20/minute")
async def refresh_token(
    request: Request,
    response: Response,
    body: RefreshRequest | None = None,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Refresh access token; single-use rotation with FOR UPDATE row lock."""
    from app.core.security import decode_token
    from app.crud.user import get_user_by_id
    from app.db_tenant import tenant_session

    # Prefer the HttpOnly cookie; fall back to the request body for API-only
    # clients (and during the frontend transition).
    token = request.cookies.get(REFRESH_COOKIE_NAME) or (body.refresh_token if body else None)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No refresh token provided")

    payload = decode_token(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token")

    user_id = payload.get("sub")
    jti = payload.get("jti")
    token_tenant_slug = payload.get("tenant_slug")
    token_active_role = payload.get("active_role")
    token_realm = payload.get("realm", "tenant")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")

    # Platform-admin refresh uses Redis-backed storage rather than the
    # tenant refresh_tokens table (PA ids don't FK to users.id).
    if token_realm == "platform":
        if not jti:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")
        consumed_pa_id = await _pa_refresh_consume(jti)
        if consumed_pa_id is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Refresh token has been revoked",
            )
        if str(consumed_pa_id) != str(user_id):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Refresh token does not match user",
            )

        # Re-issue
        from app.db_control import AsyncControlSessionLocal
        from app.models.control import PlatformAdmin
        async with AsyncControlSessionLocal() as control_db:
            pa_row = await control_db.get(PlatformAdmin, consumed_pa_id)
        if pa_row is None or not pa_row.is_active:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="User not found or inactive",
            )
        pa_payload = _build_token_payload(
            user_id=pa_row.id,
            tenant_id=None,
            can_review=False,
            realm="platform",
            tenant_slug=None,
        )
        new_access = create_access_token(pa_payload)
        new_refresh, new_jti, new_expires = create_refresh_token(pa_payload)
        await _pa_refresh_remember(new_jti, pa_row.id, new_expires)
        _set_refresh_cookie(response, new_refresh)
        return {
            "access_token": new_access,
            "token_type": "bearer",
            "user": {
                "id": pa_row.id,
                "tenant_id": None,
                "email": pa_row.email,
                "username": pa_row.username,
                "full_name": pa_row.full_name,
                "title": None,
                "department": None,
                "timezone": "UTC",
                "role": UserRole.PLATFORM_ADMIN,
                "is_active": pa_row.is_active,
                "manager_id": None,
                "project_ids": [],
                "default_client_id": None,
                "has_changed_password": pa_row.has_changed_password,
                "email_verified": pa_row.email_verified,
                "can_review": False,
                "is_external": False,
                "roles": [],
                "phones": [],
                "created_at": pa_row.created_at,
                "updated_at": pa_row.updated_at,
            },
        }

    # Refresh tokens for an isolated tenant live in the per-tenant DB,
    # so check/revoke/insert all happen in one transaction.
    use_tenant_db = bool(token_tenant_slug)

    async def _do_refresh(session: AsyncSession) -> tuple[User, str, str, datetime]:
        """Lock + revoke + insert on the given session, atomically."""
        if jti:
            stored = (await session.execute(
                select(RefreshToken)
                .where(RefreshToken.jti == jti)
                .with_for_update()
            )).scalars().first()
            if not stored or stored.revoked:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Refresh token has been revoked",
                )
            stored.revoked = True
            session.add(stored)

        user = await get_user_by_id(session, int(user_id))
        if not user or not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="User not found or inactive",
            )

        realm = "platform" if user.role == UserRole.PLATFORM_ADMIN else "tenant"
        # Carry forward active_role so multi-role users don't get
        # downgraded; re-validated against user.roles on next request.
        token_payload = _build_token_payload(
            user_id=user.id,
            tenant_id=user.tenant_id,
            can_review=user.can_review,
            realm=realm,
            tenant_slug=token_tenant_slug,
            active_role=token_active_role,
            token_version=user.token_version,
        )
        new_access = create_access_token(token_payload)
        new_refresh, new_jti, new_expires = create_refresh_token(token_payload)

        session.add(RefreshToken(user_id=user.id, jti=new_jti, expires_at=new_expires))
        await session.commit()
        return user, new_access, new_refresh, new_expires

    if use_tenant_db:
        try:
            async with tenant_session(token_tenant_slug) as tenant_db:
                user, access_token, new_refresh_token, _ = await _do_refresh(tenant_db)
        except (LookupError, ValueError):
            user, access_token, new_refresh_token, _ = await _do_refresh(db)
    else:
        user, access_token, new_refresh_token, _ = await _do_refresh(db)

    _set_refresh_cookie(response, new_refresh_token)
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": user,
    }


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(
    request: Request,
    response: Response,
    current_user: User = Depends(get_current_user),
):
    """Return the current authenticated user.

    Conditional GET: clients that send ``If-None-Match`` matching our
    ETag get a 304 with no body. The DB query has already run by the
    time we know the ETag, so the win here is "no JSON over the wire,
    no parse on the client" — not "no DB hit". For typical reload
    flows that's still meaningful: ~50-100ms saved on the round trip
    plus a few KB not transferred.
    """
    from app.core.etag import respond_with_etag

    # Serialize through the response_model schema so the ETag is keyed
    # on the same shape the client receives, not on a richer ORM dump.
    payload = UserResponse.model_validate(current_user).model_dump(mode="json")
    return respond_with_etag(request, response, payload)


@router.post("/change-password", response_model=PasswordChangeResponse)
async def change_password(
    request: Request,
    change_password_request: ChangePasswordRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Change password and revoke all of the user's refresh tokens.

    Two verification paths depending on the user's auth source:

    - If ``current_user.auth0_sub`` is set, the user authenticates via
      Auth0 and their real password lives there. Verify the current
      password against Auth0 via the password-realm grant, then PATCH
      the new password through the Management API. Auth0 enforces its
      own password policy on the new value.
    - Otherwise (legacy bcrypt user), verify the current hash and
      validate the new password against our local policy.

    After verification, the local DB write still runs in both cases:
    refresh tokens get revoked + an activity event is recorded. For
    Auth0 users the local ``hashed_password`` is replaced with a
    cryptographically random throwaway hash so a future Auth0-disabled
    code path can never accidentally accept the user's old local
    bcrypt as valid.
    """
    is_auth0_user = bool(current_user.auth0_sub)

    if is_auth0_user:
        # Verify current password against Auth0. ``invalid_grant`` is
        # the "wrong password" code; any other failure (network,
        # mis-configured client, etc.) propagates as 503 rather than
        # silently falling back to the stale local bcrypt — that
        # would defeat the security property.
        try:
            await auth0_password_grant(current_user.email, change_password_request.current_password)
        except Auth0PasswordError as exc:
            if exc.code == "invalid_grant":
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Current password is incorrect",
                ) from exc
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Could not verify current password (Auth0 unreachable). Try again in a moment.",
            ) from exc

        # Push the new password to Auth0. Auth0 enforces the
        # connection's password policy at this step, so a too-weak
        # password surfaces as Auth0MgmtError with the policy text.
        from app.services.auth0_mgmt import Auth0MgmtError, set_user_password
        try:
            await set_user_password(
                sub=current_user.auth0_sub,
                password=change_password_request.new_password,
            )
        except Auth0MgmtError as exc:
            # 400 because the message is usually about the new
            # password not meeting the policy. The exception's
            # description is safe to surface to the caller.
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc
    else:
        if not verify_password(change_password_request.current_password, current_user.hashed_password):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Current password is incorrect",
            )

        from app.core.password_policy import validate_password
        error = validate_password(change_password_request.new_password)
        if error:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=error,
            )

    # For Auth0 users the new password lives in Auth0, not in our DB.
    # Replace the local hash with a random throwaway so a future
    # Auth0-disabled fallback path can never accept the user's old
    # bcrypt as valid. For bcrypt users the local hash IS the real
    # one.
    if is_auth0_user:
        import secrets
        new_hash = get_password_hash(secrets.token_urlsafe(48))
    else:
        new_hash = get_password_hash(change_password_request.new_password)

    auth_hdr = request.headers.get("authorization", "")
    token_tenant_slug: str | None = None
    if auth_hdr.lower().startswith("bearer "):
        from app.core.security import decode_token
        payload = decode_token(auth_hdr[7:])
        if payload:
            token_tenant_slug = payload.get("tenant_slug")

    if token_tenant_slug:
        from app.db_tenant import tenant_session
        async with tenant_session(token_tenant_slug) as tenant_db:
            target = (await tenant_db.execute(
                select(User).where(User.id == current_user.id)
            )).scalar_one()
            target.hashed_password = new_hash
            target.has_changed_password = True
            tenant_db.add(target)
            await tenant_db.execute(
                update(RefreshToken)
                .where(
                    RefreshToken.user_id == current_user.id,
                    RefreshToken.revoked == False,  # noqa: E712
                )
                .values(revoked=True)
            )
            await tenant_db.commit()
            await record_activity_events(tenant_db, [build_activity_event(
                activity_type="PASSWORD_CHANGED",
                visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                tenant_id=current_user.tenant_id,
                actor_user=target,
                entity_type="user",
                entity_id=target.id,
                summary=f"{target.full_name} changed their password.",
                route="/auth/change-password",
            )])
    elif current_user.role == UserRole.PLATFORM_ADMIN:
        # Platform admins live in acufy_control.platform_admins, not
        # timesheet_db.users. Update their password in the control plane
        # and revoke any cached Redis-backed refresh tokens.
        from app.db_control import AsyncControlSessionLocal
        from app.models.control import PlatformAdmin
        async with AsyncControlSessionLocal() as control_db:
            pa = await control_db.get(PlatformAdmin, current_user.id)
            if pa is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Platform admin record not found",
                )
            pa.hashed_password = new_hash
            pa.has_changed_password = True
            control_db.add(pa)
            await control_db.commit()
        await _pa_refresh_revoke_all(current_user.id)
    else:
        # Legacy tenant user without a tenant_slug claim - rare but
        # possible for tokens minted before isolation. Update the
        # shared DB; the mirror+per-tenant divergence is acceptable
        # for these legacy sessions.
        current_user.hashed_password = new_hash
        current_user.has_changed_password = True
        db.add(current_user)
        await db.execute(
            update(RefreshToken)
            .where(
                RefreshToken.user_id == current_user.id,
                RefreshToken.revoked == False,  # noqa: E712
            )
            .values(revoked=True)
        )
        await db.commit()
        await record_activity_events(db, [build_activity_event(
            activity_type="PASSWORD_CHANGED",
            visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
            tenant_id=current_user.tenant_id,
            actor_user=current_user,
            entity_type="user",
            entity_id=current_user.id,
            summary=f"{current_user.full_name} changed their password.",
            route="/auth/change-password",
        )])

    return {
        "success": True,
        "message": "Password changed successfully",
    }


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    body: RefreshRequest | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Revoke the current refresh token AND the access token (logout).

    Tenant users' RefreshToken rows live in their per-tenant DB, so we
    route based on the refresh token's ``tenant_slug`` claim before
    looking up the row. Platform-admin tokens (and legacy tokens with no
    slug claim) fall back to the shared DB.
    """
    from app.core.security import decode_token
    from app.core.token_denylist import revoke_access_jti
    from app.db_tenant import tenant_session

    # Always clear the refresh cookie, on every exit path. Done first so the
    # browser drops it even when there's no token to revoke server-side.
    _clear_refresh_cookie(response)

    # Immediately revoke the access token that authorized this request, so it
    # can't be reused for the rest of its TTL. get_current_user stashed its
    # jti/exp on request.state. Done first so logout kills the access token
    # even when no refresh token is supplied.
    await revoke_access_jti(
        getattr(request.state, "access_jti", None),
        getattr(request.state, "access_exp", None),
    )

    # Prefer the cookie; fall back to the body for API-only clients.
    token = request.cookies.get(REFRESH_COOKIE_NAME) or (body.refresh_token if body else None)
    if not token:
        return {"message": "Logged out successfully"}

    payload = decode_token(token)
    if not payload:
        return {"message": "Logged out successfully"}

    jti = payload.get("jti")
    if not jti:
        return {"message": "Logged out successfully"}

    token_tenant_slug = payload.get("tenant_slug")
    token_realm = payload.get("realm", "tenant")

    # Platform-admin refresh tokens live in Redis, not the SQL refresh_tokens table.
    if token_realm == "platform":
        await _pa_refresh_consume(jti)  # idempotent revoke
        return {"message": "Logged out successfully"}

    async def _revoke_in(session: AsyncSession) -> None:
        stored = (await session.execute(
            select(RefreshToken).where(
                RefreshToken.jti == jti,
                RefreshToken.user_id == current_user.id,
            )
        )).scalars().first()
        if stored and not stored.revoked:
            stored.revoked = True
            session.add(stored)
            await session.commit()

    if token_tenant_slug:
        try:
            async with tenant_session(token_tenant_slug) as tenant_db:
                await _revoke_in(tenant_db)
        except (LookupError, ValueError):
            await _revoke_in(db)
    else:
        await _revoke_in(db)

    return {"message": "Logged out successfully"}


@router.post("/revoke-all-tokens")
async def revoke_all_user_tokens(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Revoke all refresh tokens for the current user (force logout all sessions).

    Routes to the per-tenant DB so isolated tenants' tokens actually get
    revoked. Falls back to the shared DB only for platform admins (whose
    refresh tokens are not yet persisted; see F-013 follow-up) or tokens
    without a tenant_slug claim.
    """
    from app.db_tenant import resolve_slug_for_tenant_id, tenant_session

    # Platform admin refresh tokens are in Redis.
    if current_user.role == UserRole.PLATFORM_ADMIN:
        await _pa_refresh_revoke_all(current_user.id)
        return {"message": "All sessions have been revoked"}

    async def _revoke_in(session: AsyncSession) -> None:
        await session.execute(
            update(RefreshToken)
            .where(
                RefreshToken.user_id == current_user.id,
                RefreshToken.revoked == False,  # noqa: E712
            )
            .values(revoked=True)
        )
        # Bump token_version so every outstanding access token is invalidated
        # immediately, not just blocked from refreshing.
        await session.execute(
            update(User)
            .where(User.id == current_user.id)
            .values(token_version=User.token_version + 1)
        )
        await session.commit()

    if current_user.tenant_id is not None:
        try:
            slug = await resolve_slug_for_tenant_id(current_user.tenant_id)
            async with tenant_session(slug) as tenant_db:
                await _revoke_in(tenant_db)
            return {"message": "All sessions have been revoked"}
        except (LookupError, ValueError):
            pass

    await _revoke_in(db)
    return {"message": "All sessions have been revoked"}


@router.post("/verify-email", response_model=VerifyEmailResponse)
async def verify_email(
    body: VerifyEmailRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Verify the user's email via the token from the verification email.

    The verification token is stored on the per-tenant ``users`` row (the
    shared ``timesheet_db.users`` row only carries an email->slug index).
    We look up by token first on the shared DB to find which tenant the
    user belongs to, then mutate ``email_verified`` on the per-tenant row
    so the login handler (which reads from the tenant DB) sees the
    update. Falls back to the shared DB only for users with no tenant
    slug resolvable.
    """
    from sqlalchemy import select
    from app.services.email_verification import mark_email_verified
    from app.db_tenant import resolve_slug_for_tenant_id, tenant_session
    from datetime import timezone

    # Step 1: find the candidate user by token in the shared DB. This is
    # an O(1) indexed lookup since the token is unique platform-wide.
    result = await db.execute(
        select(User).where(User.email_verification_token == body.token)
    )
    user = result.scalars().first()

    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired verification token")

    if user.email_verified:
        return {"message": "Email already verified", "email": user.email}

    if user.email_verification_token_expires_at and user.email_verification_token_expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Verification link has expired. Please request a new one.")

    # Step 2: mutate on the per-tenant DB so login reads the verified state.
    if user.tenant_id is not None:
        try:
            slug = await resolve_slug_for_tenant_id(user.tenant_id)
            async with tenant_session(slug) as tenant_db:
                tenant_user = (await tenant_db.execute(
                    select(User).where(User.email == user.email)
                )).scalars().first()
                if tenant_user is not None:
                    await mark_email_verified(tenant_db, tenant_user)
                    await tenant_db.commit()
                # Also mark the shared-DB index so /resend-verification
                # behaves correctly next time. Best-effort.
                await mark_email_verified(db, user)
                await db.commit()
                return {"message": "Email verified successfully", "email": user.email}
        except (LookupError, ValueError):
            pass

    # Fallback: legacy user with no resolvable tenant slug.
    await mark_email_verified(db, user)
    await db.commit()
    return {"message": "Email verified successfully", "email": user.email}


@router.post("/resend-verification", response_model=MessageResponse)
async def resend_verification(
    body: ResendVerificationRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Resend the account verification email. Rate-limited.

    Token regeneration must hit the per-tenant DB so /verify-email
    (which now mutates per-tenant) and login (which reads per-tenant)
    see consistent state. The shared-DB row is also updated so the
    initial lookup-by-token in /verify-email still works.
    """
    from app.services.email_verification import set_verification_token, send_verification_email
    from app.crud.user import get_user_by_email
    from app.db_tenant import resolve_slug_for_tenant_id, tenant_session

    user = await get_user_by_email(db, body.email)
    if not user or user.email_verified:
        # Enumeration-resistant: same response regardless of existence.
        return {"message": "If that email exists and is unverified, a new link has been sent."}

    token = set_verification_token(user)
    db.add(user)
    await db.commit()

    # Mirror the new token onto the per-tenant row.
    if user.tenant_id is not None:
        try:
            slug = await resolve_slug_for_tenant_id(user.tenant_id)
            async with tenant_session(slug) as tenant_db:
                tenant_user = await get_user_by_email(tenant_db, body.email)
                if tenant_user is not None:
                    tenant_user.email_verification_token = user.email_verification_token
                    tenant_user.email_verification_token_expires_at = user.email_verification_token_expires_at
                    tenant_db.add(tenant_user)
                    await tenant_db.commit()
        except (LookupError, ValueError):
            pass

    await send_verification_email(user, token, temporary_password="[Use the password from your original email, or contact your admin]")
    return {"message": "If that email exists and is unverified, a new link has been sent."}


@router.post("/admin/revoke-user-tokens/{user_id}")
async def admin_revoke_user_tokens(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Admin: revoke all refresh tokens for a specific user (force logout).

    Both the RefreshToken update and the audit-log event must land in the
    target user's tenant DB, otherwise the revoke silently no-ops for
    isolated tenants (F-014/F-015 root cause).
    """
    from app.core.deps import require_same_tenant
    from app.crud.user import get_user_by_id
    from app.db_tenant import resolve_slug_for_tenant_id, tenant_session

    if current_user.role not in (UserRole.ADMIN, UserRole.PLATFORM_ADMIN):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can revoke other users' tokens",
        )

    target_user = await get_user_by_id(db, user_id)
    if not target_user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    require_same_tenant(target_user.tenant_id, current_user)

    async def _revoke_and_audit(session: AsyncSession) -> None:
        await session.execute(
            update(RefreshToken)
            .where(
                RefreshToken.user_id == user_id,
                RefreshToken.revoked == False,  # noqa: E712
            )
            .values(revoked=True)
        )
        # Bump token_version so the user's outstanding ACCESS tokens are
        # rejected immediately (refresh revocation alone leaves access tokens
        # valid until expiry). This is the "force-logout actually works now"
        # part: one increment invalidates every device/tab at once.
        await session.execute(
            update(User)
            .where(User.id == user_id)
            .values(token_version=User.token_version + 1)
        )
        await session.commit()
        await record_activity_events(session, [build_activity_event(
            activity_type="USER_TOKENS_REVOKED",
            visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
            tenant_id=current_user.tenant_id,
            actor_user=current_user,
            entity_type="user",
            entity_id=user_id,
            summary=f"{current_user.full_name} revoked all sessions for {target_user.full_name}.",
            route="/auth/admin/revoke-user-tokens",
            severity="warning",
        )])

    if target_user.tenant_id is not None:
        try:
            slug = await resolve_slug_for_tenant_id(target_user.tenant_id)
            async with tenant_session(slug) as tenant_db:
                await _revoke_and_audit(tenant_db)
            return {"message": f"All sessions revoked for user {target_user.full_name}"}
        except (LookupError, ValueError):
            pass

    await _revoke_and_audit(db)
    return {"message": f"All sessions revoked for user {target_user.full_name}"}


@router.post("/switch-role", response_model=TokenResponse)
@limiter.limit("30/minute")
async def switch_role(
    request: Request,
    response: Response,
    body: RoleSwitchRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Flip the current user's active role and return fresh tokens."""
    from app.db_tenant import tenant_session

    requested_role_value = body.role.value if hasattr(body.role, "value") else str(body.role)
    allowed = list(current_user.roles or [])

    if not allowed:
        # Pre-multi-role rows fall back to the active role.
        allowed = [
            current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role)
        ]

    if requested_role_value not in allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"User is not authorized to act as {requested_role_value}.",
        )

    if requested_role_value == (
        current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role)
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="User is already acting as that role.",
        )

    auth_hdr = request.headers.get("authorization", "")
    token_tenant_slug: str | None = None
    if auth_hdr.lower().startswith("bearer "):
        from app.core.security import decode_token
        payload = decode_token(auth_hdr[7:])
        if payload:
            token_tenant_slug = payload.get("tenant_slug")

    if token_tenant_slug:
        async with tenant_session(token_tenant_slug) as tenant_db:
            target = (await tenant_db.execute(
                select(User).where(User.id == current_user.id)
            )).scalar_one()
            target.role = body.role
            tenant_db.add(target)
            await tenant_db.commit()
            await record_activity_events(tenant_db, [build_activity_event(
                activity_type="ROLE_SWITCHED",
                visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                tenant_id=current_user.tenant_id,
                actor_user=target,
                entity_type="user",
                entity_id=target.id,
                summary=f"{target.full_name} switched active role to {requested_role_value}.",
                route="/auth/switch-role",
            )])
            target = await get_user_by_email(tenant_db, target.email)
    else:
        target = (await db.execute(
            select(User).where(User.id == current_user.id)
        )).scalar_one()
        target.role = body.role
        db.add(target)
        await db.commit()
        await record_activity_events(db, [build_activity_event(
            activity_type="ROLE_SWITCHED",
            visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
            tenant_id=current_user.tenant_id,
            actor_user=target,
            entity_type="user",
            entity_id=target.id,
            summary=f"{target.full_name} switched active role to {requested_role_value}.",
            route="/auth/switch-role",
        )])
        target = await get_user_by_email(db, target.email)

    realm = "platform" if target.role == UserRole.PLATFORM_ADMIN else "tenant"
    # Mint with active_role so refresh-on-hard-reload preserves the
    # chosen role. Without this claim, a refresh round-trips through
    # users.role from the DB, which is the user's *last explicit
    # choice* — fine in the common case but flips silently if any
    # other path (a background process, another tab, a DB session)
    # mutated users.role between the original switch and the refresh.
    # Matches the contract the role-handoff endpoint already follows.
    payload = _build_token_payload(
        user_id=target.id,
        tenant_id=target.tenant_id,
        can_review=target.can_review,
        realm=realm,
        tenant_slug=token_tenant_slug,
        active_role=requested_role_value,
        token_version=target.token_version,
    )
    access = create_access_token(payload)
    refresh, jti, expires_at = create_refresh_token(payload)

    if token_tenant_slug:
        async with tenant_session(token_tenant_slug) as tenant_db:
            tenant_db.add(RefreshToken(user_id=target.id, jti=jti, expires_at=expires_at))
            await tenant_db.commit()
    else:
        db.add(RefreshToken(user_id=target.id, jti=jti, expires_at=expires_at))
        await db.commit()

    # Set the HttpOnly cookie. The new-tab handoff shares the same-origin
    # cookie, so the refresh token no longer needs to ride in the body.
    _set_refresh_cookie(response, refresh)
    return {
        "access_token": access,
        "token_type": "bearer",
        "user": target,
    }


@router.post("/role-handoff", response_model=RoleHandoffIssueResponse)
@limiter.limit("30/minute")
async def issue_role_handoff(
    request: Request,
    body: RoleSwitchRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Mint a short-lived role-handoff token for opening another portal in a new tab."""
    from app.services.handoff import issue_role_handoff_token

    requested_role_value = body.role.value if hasattr(body.role, "value") else str(body.role)
    allowed = list(current_user.roles or [])
    if not allowed:
        allowed = [
            current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role)
        ]
    if requested_role_value not in allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"User is not authorized to act as {requested_role_value}.",
        )

    auth_hdr = request.headers.get("authorization", "")
    token_tenant_slug: str | None = None
    if auth_hdr.lower().startswith("bearer "):
        from app.core.security import decode_token
        payload = decode_token(auth_hdr[7:])
        if payload:
            token_tenant_slug = payload.get("tenant_slug")

    handoff_token = await issue_role_handoff_token(
        user_id=current_user.id,
        target_role=requested_role_value,
        target_tenant_slug=token_tenant_slug,
    )

    await record_activity_events(db, [build_activity_event(
        activity_type="ROLE_HANDOFF_ISSUED",
        visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
        tenant_id=current_user.tenant_id,
        actor_user=current_user,
        entity_type="user",
        entity_id=current_user.id,
        summary=f"{current_user.full_name} initiated portal switch to {requested_role_value}.",
        route="/auth/role-handoff",
    )])

    return {
        "handoff_token": handoff_token,
        "target_role": body.role,
    }


@router.post("/role-handoff/exchange", response_model=TokenResponse)
@limiter.limit("30/minute")
async def exchange_role_handoff(
    request: Request,
    body: RoleHandoffExchangeRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Redeem a role-handoff token; returns a fresh access + refresh pair."""
    from app.services.handoff import redeem_role_handoff_token
    from app.db_tenant import tenant_session

    try:
        user_id, target_role_value, target_tenant_slug = await redeem_role_handoff_token(
            body.handoff_token
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
        )

    if target_tenant_slug:
        async with tenant_session(target_tenant_slug) as tenant_db:
            target = (await tenant_db.execute(
                select(User).where(User.id == user_id)
            )).scalar_one_or_none()
    else:
        target = (await db.execute(
            select(User).where(User.id == user_id)
        )).scalar_one_or_none()

    if target is None or not target.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account is not available.",
        )

    allowed = list(target.roles or [])
    if not allowed:
        allowed = [
            target.role.value if hasattr(target.role, "value") else str(target.role)
        ]
    if target_role_value not in allowed:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User is no longer authorized for that role.",
        )

    try:
        new_role_enum = UserRole(target_role_value)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Unknown role {target_role_value!r}.",
        )

    realm = "platform" if new_role_enum == UserRole.PLATFORM_ADMIN else "tenant"
    # active_role on the token gives this tab its own session, independent
    # from the originating tab. Don't write users.role here — that column
    # is the user's last *explicit* choice (login or /auth/switch-role).
    payload = _build_token_payload(
        user_id=target.id,
        tenant_id=target.tenant_id,
        can_review=target.can_review,
        realm=realm,
        tenant_slug=target_tenant_slug,
        active_role=target_role_value,
        token_version=target.token_version,
    )
    access = create_access_token(payload)
    refresh, jti, expires_at = create_refresh_token(payload)

    if target_tenant_slug:
        async with tenant_session(target_tenant_slug) as tenant_db:
            tenant_db.add(RefreshToken(user_id=target.id, jti=jti, expires_at=expires_at))
            await tenant_db.commit()
            await record_activity_events(tenant_db, [build_activity_event(
                activity_type="ROLE_HANDOFF_REDEEMED",
                visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                tenant_id=target.tenant_id,
                actor_user=target,
                entity_type="user",
                entity_id=target.id,
                summary=f"{target.full_name} opened the {target_role_value} portal in a new tab.",
                route="/auth/role-handoff/exchange",
            )])
            target = await get_user_by_email(tenant_db, target.email)
    else:
        db.add(RefreshToken(user_id=target.id, jti=jti, expires_at=expires_at))
        await db.commit()
        await record_activity_events(db, [build_activity_event(
            activity_type="ROLE_HANDOFF_REDEEMED",
            visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
            tenant_id=target.tenant_id,
            actor_user=target,
            entity_type="user",
            entity_id=target.id,
            summary=f"{target.full_name} opened the {target_role_value} portal in a new tab.",
            route="/auth/role-handoff/exchange",
        )])
        target = await get_user_by_email(db, target.email)

    # Surface active role on response so the frontend renders the right portal.
    target.role = new_role_enum

    return {
        "access_token": access,
        "refresh_token": refresh,
        "token_type": "bearer",
        "user": target,
    }


# Schemas for the Auth0 lazy-migration endpoints below. These are tiny
# request/response shapes private to this module; not worth promoting
# to ``app.schemas`` since no other code references them.
from pydantic import BaseModel  # noqa: E402  — bottom-of-file imports are fine here


# ──────────────────────────────────────────────────────────────────────
# Auth0 Custom-Database lazy-migration endpoints (Platform Admin scope)
#
# Auth0's Custom Database connection runs two server-side scripts —
# ``login`` and ``getUser`` — when an unknown email tries to log in.
# Both scripts make a single HTTPS POST to our backend; we verify the
# credentials against ``platform_admins.hashed_password`` and return
# the profile if it matches. Auth0 then imports the user into its own
# DB connection (using the plaintext password the user just typed) and
# fires a Post-Login Action that calls ``/auth/auth0-link-pa`` so we
# can write back the ``auth0_sub``.
#
# These endpoints are NOT user-facing. They're authenticated by a
# shared secret in the ``X-Auth0-DB-Secret`` header, set in
# ``settings.auth0_db_action_secret`` and configured on the Auth0
# scripts. Returns 401 on missing/bad secret.
# ──────────────────────────────────────────────────────────────────────


class _Auth0DbVerifyRequest(BaseModel):
    email: str
    password: str


class _Auth0DbVerifyResponse(BaseModel):
    user_id: str
    email: str
    email_verified: bool
    name: str
    # Auth0 stores arbitrary metadata. We tag PAs so the Action that
    # fires after migration can detect "this is a PA, route to /auth/
    # auth0-link-pa" instead of the tenant-user link endpoint.
    app_metadata: dict


class _Auth0DbGetUserRequest(BaseModel):
    email: str


class _Auth0LinkPaRequest(BaseModel):
    email: str
    auth0_sub: str


def _pa_auth0_user_id(pa_id: int) -> str:
    """Build the Auth0 ``user_id`` for a PA row, namespaced by environment.

    Multiple environments may share one Auth0 tenant (ldev + prod, etc.).
    Without an env prefix, ldev's PA #1 and prod's PA #1 collide under
    the same Auth0 user_id ``pa-1``. The prefix (set via
    ``AUTH0_PA_USER_ID_PREFIX``) keeps them distinct.

    Empty prefix → legacy ``pa-{id}`` shape (for envs that don't share
    the Auth0 tenant with anyone).
    """
    prefix = settings.auth0_pa_user_id_prefix.strip()
    if prefix:
        return f"{prefix}-pa-{pa_id}"
    return f"pa-{pa_id}"


def _require_auth0_db_secret(x_auth0_db_secret: str | None) -> None:
    expected = settings.auth0_db_action_secret
    if not expected:
        # No secret configured = endpoint disabled. Safer than letting
        # the call through when we forgot to set the secret on deploy.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Auth0 DB action endpoint not configured",
        )
    # Constant-time comparison so a timing attack can't lift the secret
    # byte-by-byte. ``hmac.compare_digest`` works on equal-length
    # strings; pad first to neutralise length-leak.
    import hmac
    a = (x_auth0_db_secret or "").encode("utf-8")
    b = expected.encode("utf-8")
    if len(a) != len(b) or not hmac.compare_digest(a, b):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Auth0 DB action secret",
        )


@router.post("/auth0-db/verify-pa", response_model=_Auth0DbVerifyResponse)
async def auth0_db_verify_pa(
    body: _Auth0DbVerifyRequest,
    x_auth0_db_secret: str | None = Header(default=None, alias="X-Auth0-DB-Secret"),
) -> dict:
    """Auth0 Custom-Database ``login`` script calls this with the email
    and password the user just typed. We check against
    ``platform_admins.hashed_password``; on match we return the profile,
    on miss we 401 (Auth0 maps that to ``WrongUsernameOrPassword``).

    This is the lazy-migration hinge: after the first successful call,
    Auth0 imports the PA into its own DB connection with that plaintext
    password and subsequent logins don't hit this endpoint anymore.
    """
    _require_auth0_db_secret(x_auth0_db_secret)

    from app.db_control import AsyncControlSessionLocal
    from app.models.control import PlatformAdmin

    email = body.email.strip().lower()
    async with AsyncControlSessionLocal() as control_db:
        pa_row = (await control_db.execute(
            select(PlatformAdmin).where(PlatformAdmin.email == email)
        )).scalar_one_or_none()

    if pa_row is None or not pa_row.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Wrong username or password",
        )
    if not verify_password(body.password, pa_row.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Wrong username or password",
        )

    # ``user_id`` here is the value Auth0 stores as its internal id for
    # the connection. We use the PA's primary key prefixed with ``pa-``
    # so it's namespaced away from tenant-user ids.
    return {
        "user_id": _pa_auth0_user_id(pa_row.id),
        "email": pa_row.email,
        "email_verified": pa_row.email_verified,
        "name": pa_row.full_name,
        "app_metadata": {
            "realm": "platform",
            "platform_admin_id": pa_row.id,
            # Tells the shared Post-Login Action which backend URL to
            # call when writing auth0_sub back. Empty if the env
            # didn't set BACKEND_PUBLIC_URL — Action falls back to
            # its hard-coded default.
            "backend_url": settings.backend_public_url,
        },
    }


@router.post("/auth0-db/get-user-pa", response_model=_Auth0DbVerifyResponse)
async def auth0_db_get_user_pa(
    body: _Auth0DbGetUserRequest,
    x_auth0_db_secret: str | None = Header(default=None, alias="X-Auth0-DB-Secret"),
) -> dict:
    """Auth0 Custom-Database ``getUser`` script calls this to ask
    "does a PA with this email exist?" — used by Auth0's password-
    reset flow so an unmigrated PA can still trigger 'forgot password'
    and recover even without remembering their bcrypt password.

    Returns the same shape as ``verify_pa`` but does NOT require a
    password (the password-reset flow doesn't have one yet).
    """
    _require_auth0_db_secret(x_auth0_db_secret)

    from app.db_control import AsyncControlSessionLocal
    from app.models.control import PlatformAdmin

    email = body.email.strip().lower()
    async with AsyncControlSessionLocal() as control_db:
        pa_row = (await control_db.execute(
            select(PlatformAdmin).where(PlatformAdmin.email == email)
        )).scalar_one_or_none()

    if pa_row is None or not pa_row.is_active:
        # Auth0 maps 404 to "user not found"; the reset email then
        # silently no-ops, which is the right behaviour for unknown
        # emails (no enumeration).
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    return {
        "user_id": _pa_auth0_user_id(pa_row.id),
        "email": pa_row.email,
        "email_verified": pa_row.email_verified,
        "name": pa_row.full_name,
        "app_metadata": {
            "realm": "platform",
            "platform_admin_id": pa_row.id,
            # Tells the shared Post-Login Action which backend URL to
            # call when writing auth0_sub back. Empty if the env
            # didn't set BACKEND_PUBLIC_URL — Action falls back to
            # its hard-coded default.
            "backend_url": settings.backend_public_url,
        },
    }


@router.post("/auth0-link-pa")
async def auth0_link_pa(
    body: _Auth0LinkPaRequest,
    x_auth0_db_secret: str | None = Header(default=None, alias="X-Auth0-DB-Secret"),
) -> dict:
    """Auth0 Post-Login Action calls this after a PA successfully
    authenticates via Auth0 (either fresh import or steady-state). We
    write the ``auth0_sub`` back to the PA row so our ``/auth/login``
    PA branch can recognise the Auth0 token on subsequent logins.

    Idempotent: if ``auth0_sub`` is already set and matches, this is a
    no-op. If it's set to a different value, we reject — that signals
    something is wrong (e.g. an Auth0 user got created twice for the
    same email).
    """
    _require_auth0_db_secret(x_auth0_db_secret)

    from app.db_control import AsyncControlSessionLocal
    from app.models.control import PlatformAdmin

    email = body.email.strip().lower()
    async with AsyncControlSessionLocal() as control_db:
        pa_row = (await control_db.execute(
            select(PlatformAdmin).where(PlatformAdmin.email == email)
        )).scalar_one_or_none()

        if pa_row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Platform admin not found",
            )

        # If the stored auth0_sub differs from what Auth0 just sent us,
        # overwrite it. The most common reason for divergence is a
        # one-time housekeeping event: an Auth0 user got deleted and
        # the lazy-migration created a fresh one (different sub).
        # Treating that as an error (409) blocks the heal. Since the
        # link endpoint is already authenticated by the shared secret
        # (only Auth0 can call it), trusting whatever Auth0 sends is
        # safe and the self-healing path is the right default.
        if pa_row.auth0_sub != body.auth0_sub:
            import logging as _logging
            if pa_row.auth0_sub:
                _logging.getLogger(__name__).info(
                    "PA Auth0 sub re-link: pa_id=%s old=%r new=%r",
                    pa_row.id, pa_row.auth0_sub, body.auth0_sub,
                )
            pa_row.auth0_sub = body.auth0_sub
            control_db.add(pa_row)
            await control_db.commit()

    return {"linked": True, "platform_admin_id": pa_row.id}
