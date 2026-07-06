from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.security import decode_token, split_service_token, verify_service_token
from app.db import get_db
from app.db_tenant import get_session_factory_for_slug
from app.models import User
from app.models.user import UserRole
from app.models.service_token import ServiceToken
import logging

logger = logging.getLogger(__name__)
security = HTTPBearer()

# ── CLIENT-role allowlist (fail-closed) ──────────────────────────────────────
# Paths a CLIENT user is permitted to reach. Everything else is denied by
# get_current_user. Entries match by exact path or as a prefix (so the whole
# client-portal API is covered without listing each route). Keep this list
# tight: the security of the client portal rests on it being an allowlist, not
# a denylist. Self-service entries let a client manage their own session.
_CLIENT_ALLOWED_EXACT = frozenset({
    "/auth/me",
    "/auth/logout",
    "/auth/change-password",
    "/auth/switch-role",          # harmless: a CLIENT has only the CLIENT role
    "/users/me/permissions",
    "/users/me/preferences",
})
_CLIENT_ALLOWED_PREFIXES = (
    "/client-portal",             # the entire client-portal API surface
    "/users/me/",                 # self-service profile/preferences subpaths
)

# Every client-side role (the flat legacy CLIENT plus the two-tier
# CLIENT_MANAGER / CLIENT_EMPLOYEE) is confined to the same fail-closed portal
# allowlist. The client-portal API itself does the finer per-role gating.
_CLIENT_SIDE_ROLES = (
    UserRole.CLIENT,
    UserRole.CLIENT_MANAGER,
    UserRole.CLIENT_EMPLOYEE,
)


def _client_path_allowed(path: str) -> bool:
    """True if a client-side user may reach this request path. Fail-closed:
    anything not explicitly allowed is denied. A trailing-slash-insensitive
    match keeps behaviour stable across route definitions."""
    p = path.rstrip("/") or "/"
    if p in _CLIENT_ALLOWED_EXACT or path in _CLIENT_ALLOWED_EXACT:
        return True
    return any(path.startswith(prefix) for prefix in _CLIENT_ALLOWED_PREFIXES)


def _decode_or_raise(credentials: HTTPAuthorizationCredentials) -> dict:
    """Decode the JWT or raise 401. Shared by every dep that needs the
    payload before the user object is loaded."""
    payload = decode_token(credentials.credentials)
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return payload


async def get_tenant_db(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),
):
    """Yield a session bound to the caller's tenant database.

    Platform-realm tokens must pass ``X-Tenant-Slug``; tenant-realm
    tokens use the ``tenant_slug`` JWT claim. Falls back to the shared
    DB when no slug is resolvable.
    """
    payload = _decode_or_raise(credentials)
    realm = payload.get("realm", "tenant")
    slug: str | None = None

    if realm == "platform":
        header_slug = request.headers.get("X-Tenant-Slug")
        if not header_slug:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Platform-admin tokens must specify a tenant via the "
                    "X-Tenant-Slug header to access tenant-scoped routes."
                ),
            )
        slug = header_slug
    else:
        slug = payload.get("tenant_slug")

    if not slug:
        async for session in get_db():
            yield session
        return

    try:
        factory = await get_session_factory_for_slug(slug)
    except LookupError as exc:
        # Slug came from the JWT or from a header. Either way the
        # caller handed us an identifier that doesn't exist in the
        # control plane -- treat it as unauthenticated, never 500.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unknown tenant",
        ) from exc
    async with factory() as session:
        yield session


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> User:
    """
    Extract and validate current user from JWT token.
    Also verifies that the tenant_id in the token matches the database record.
    Raises HTTPException if token is invalid or user not found.
    """
    from app.crud.user import get_user_by_id

    try:
        token = credentials.credentials
        logger.debug("Validating token")

        payload = decode_token(token)
        if payload is None:
            logger.warning("Token decode failed")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication credentials",
                headers={"WWW-Authenticate": "Bearer"},
            )

        # Reject access tokens that were revoked on logout / force-logout.
        # Stash the jti+exp on request.state so the logout handler can revoke
        # the very token that authorized the request.
        access_jti = payload.get("jti")
        request.state.access_jti = access_jti
        request.state.access_exp = payload.get("exp")
        from app.core.token_denylist import is_access_jti_revoked
        if await is_access_jti_revoked(access_jti):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token has been revoked",
                headers={"WWW-Authenticate": "Bearer"},
            )

        sub = payload.get("sub")
        if not sub:
            logger.warning("No user_id in payload")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token",
                headers={"WWW-Authenticate": "Bearer"},
            )
        try:
            user_id = int(sub)
        except (ValueError, TypeError):
            logger.warning("Invalid user_id in payload")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token",
                headers={"WWW-Authenticate": "Bearer"},
            )
        if not user_id:
            logger.warning("No user_id in payload")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token",
                headers={"WWW-Authenticate": "Bearer"},
            )

        token_tenant_id = payload.get("tenant_id")
        token_realm = payload.get("realm", "tenant")

        # Platform tokens load from the control plane and return a
        # detached User-shaped adapter. Routes only read scalar columns
        # off current_user, so the lack of session binding is fine.
        if token_realm == "platform":
            from app.db_control import AsyncControlSessionLocal
            from app.models.control import PlatformAdmin
            async with AsyncControlSessionLocal() as control_db:
                pa = await control_db.get(PlatformAdmin, user_id)
            if pa is None:
                logger.warning(f"PlatformAdmin {user_id} not found")
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="User not found",
                    headers={"WWW-Authenticate": "Bearer"},
                )
            if not pa.is_active:
                logger.warning(f"PlatformAdmin {user_id} is inactive")
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Inactive user",
                )
            adapter = User()
            adapter.id = pa.id
            adapter.tenant_id = None
            adapter.email = pa.email
            adapter.username = pa.username
            adapter.full_name = pa.full_name
            # change-password reads current_user.hashed_password to verify
            # the current password before mutating. Must mirror from the
            # control-plane row so PA self-service password changes work.
            adapter.hashed_password = pa.hashed_password
            adapter.title = None
            adapter.department = None
            adapter.timezone = "UTC"
            adapter.role = UserRole.PLATFORM_ADMIN
            # F-032: UserResponse schema requires list[str] for these
            # JSONB fields. The PA adapter is in-memory only and never
            # commits, so empty defaults are correct.
            adapter.roles = []
            adapter.phones = []
            # preferences was added to UserResponse in the inbox-view-mode
            # slice. Default to empty dict on the PA adapter so /auth/me
            # serialization doesn't fail with a ResponseValidationError.
            # PAs have no inbox / per-user UI prefs today; if that changes
            # we'd need to back it with a real column on PlatformAdmin.
            adapter.preferences = {}
            adapter.is_active = pa.is_active
            adapter.has_changed_password = pa.has_changed_password
            adapter.email_verified = pa.email_verified
            adapter.can_review = False
            adapter.is_external = False
            adapter.timesheet_locked = False
            adapter.failed_login_attempts = 0
            adapter.locked_until = None
            adapter.created_at = pa.created_at
            adapter.updated_at = pa.updated_at
            # UserResponse.manager_id reads the manager_assignment relationship
            # via a guarded property that raises if it's unloaded. The PA
            # adapter is in-memory and never queried, so set it explicitly to
            # None (a platform admin has no manager) — otherwise /auth/me 500s
            # on serialization with "manager_assignment was not eager-loaded".
            adapter.manager_assignments = []
            request.state.current_user = adapter
            return adapter

        # Resolve the user. When the token carries a tenant_slug we go
        # to the tenant DB first — its ids are the canonical ones the
        # token's ``sub`` came from. Falling back to the shared DB only
        # for tokens minted before isolation existed (no tenant_slug
        # claim) keeps every other path identical to before.
        token_tenant_slug = payload.get("tenant_slug")
        user = None
        if token_tenant_slug:
            from app.db_tenant import tenant_session
            try:
                async with tenant_session(token_tenant_slug) as tenant_db:
                    user = await get_user_by_id(tenant_db, user_id)
            except (LookupError, ValueError) as exc:
                logger.warning(
                    "tenant DB lookup failed for slug=%s user=%s: %s",
                    token_tenant_slug, user_id, exc,
                )
        if user is None:
            user = await get_user_by_id(db, user_id)
        if user is None:
            logger.warning(f"User {user_id} not found")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="User not found",
                headers={"WWW-Authenticate": "Bearer"},
            )

        if not user.is_active:
            logger.warning(f"User {user_id} is inactive")
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Inactive user",
            )

        # Force-logout check: every access token carries the token_version it
        # was minted at. An admin force-logout (or revoke-all-sessions) bumps
        # user.token_version, instantly invalidating every outstanding token.
        # Tokens predating this feature have no `tv` claim; treat them as
        # version 0 so they keep working until they expire (≤30 min).
        token_tv = payload.get("tv", 0)
        if token_tv < (user.token_version or 0):
            logger.warning(
                "Stale token_version for user_id=%s (token tv=%s < current %s)",
                user_id, token_tv, user.token_version,
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Session has been revoked. Please log in again.",
                headers={"WWW-Authenticate": "Bearer"},
            )

        # active_role on the token is the role this request acts as.
        # Must still be in the user's allowed roles — a token cannot
        # grant a role the user isn't authorized for.
        token_active_role = payload.get("active_role")
        if token_active_role:
            allowed_roles = list(user.roles or [])
            if not allowed_roles:
                allowed_roles = [
                    user.role.value if hasattr(user.role, "value") else str(user.role)
                ]
            if token_active_role not in allowed_roles:
                logger.warning(
                    "Token active_role=%s not in user.roles=%s for user_id=%s",
                    token_active_role, allowed_roles, user_id,
                )
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Token role is no longer authorized.",
                    headers={"WWW-Authenticate": "Bearer"},
                )
            try:
                user.role = UserRole(token_active_role)
            except ValueError:
                logger.warning("Token active_role=%r not a valid UserRole", token_active_role)
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Token role is invalid.",
                    headers={"WWW-Authenticate": "Bearer"},
                )

        # Reject tokens minted before a tenant move.
        if user.tenant_id != token_tenant_id:
            logger.warning(
                f"User {user_id} tenant mismatch: token={token_tenant_id}, db={user.tenant_id}"
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication credentials",
                headers={"WWW-Authenticate": "Bearer"},
            )

        # F-022/F-023: cross-check the tenant_slug claim against the
        # resolved user's actual tenant slug. Without this check, a
        # forged token with mismatched (tenant_id, tenant_slug) can
        # exploit the shared-DB fallback to authenticate as any user.
        if token_tenant_slug and user.tenant_id is not None:
            from app.db_tenant import resolve_slug_for_tenant_id
            try:
                expected_slug = await resolve_slug_for_tenant_id(user.tenant_id)
            except LookupError:
                expected_slug = None
            if expected_slug and expected_slug != token_tenant_slug:
                logger.warning(
                    "User %s tenant_slug mismatch: token=%s, db=%s",
                    user_id, token_tenant_slug, expected_slug,
                )
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid authentication credentials",
                    headers={"WWW-Authenticate": "Bearer"},
                )

        # ── Fail-closed gate for the CLIENT role ──────────────────────────────
        # A CLIENT (external client-portal person) may reach ONLY an explicit
        # allowlist of paths: the client-portal API + a handful of self-service
        # endpoints. Every other authenticated route — including the many that
        # have no require_role gate — is denied by default. New routes are
        # auto-denied to CLIENT unless added to the allowlist, so this can't
        # silently leak. Enforced here because every authenticated request
        # funnels through get_current_user.
        if user.role in _CLIENT_SIDE_ROLES and not _client_path_allowed(request.url.path):
            logger.warning("Client-side user %s (%s) blocked from %s", user_id, user.role.value, request.url.path)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Client accounts can only access the client portal.",
            )

        logger.debug("User validated successfully")
        request.state.current_user = user
        return user
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in get_current_user: {e}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication failed",
        )


def require_role(*allowed_roles: str):
    """Dependency: 403 unless user has one of the allowed roles."""
    async def role_checker(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role.value not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have permission to do that.",
            )
        return current_user

    return role_checker


def require_same_tenant(resource_tenant_id: int, current_user: User) -> None:
    """Raise 403 unless the resource belongs to the user's tenant.

    PLATFORM_ADMIN bypasses.
    """
    if current_user.role == UserRole.PLATFORM_ADMIN:
        return
    if resource_tenant_id != current_user.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: resource belongs to a different tenant",
        )


SERVICE_TOKEN_HEADER = "X-Service-Token"
SERVICE_TENANT_HEADER = "X-Tenant-ID"


async def get_service_token_tenant(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> tuple[int, ServiceToken]:
    """Validate X-Service-Token + X-Tenant-ID; return (tenant_id, token)."""
    raw_token = request.headers.get(SERVICE_TOKEN_HEADER)
    tenant_id_header = request.headers.get(SERVICE_TENANT_HEADER)

    if not raw_token or not tenant_id_header:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing service token or tenant ID header",
        )

    try:
        tenant_id = int(tenant_id_header)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-Tenant-ID must be an integer",
        )

    # New format: <token_id>.<secret>, indexed lookup.
    # Legacy tokens (no dot) fall through to the bcrypt sweep below.
    token_id, secret = split_service_token(raw_token)
    matched_token: ServiceToken | None = None

    if token_id is not None:
        stored = (await db.execute(
            select(ServiceToken).where(
                (ServiceToken.token_id == token_id) &
                (ServiceToken.tenant_id == tenant_id) &
                (ServiceToken.is_active == True)  # noqa: E712
            )
        )).scalar_one_or_none()
        if stored is not None and verify_service_token(secret, stored.token_hash):
            matched_token = stored
    else:
        result = await db.execute(
            select(ServiceToken).where(
                (ServiceToken.tenant_id == tenant_id) &
                (ServiceToken.is_active == True) &  # noqa: E712
                (ServiceToken.token_id.is_(None))
            )
        )
        for stored in result.scalars().all():
            if verify_service_token(raw_token, stored.token_hash):
                matched_token = stored
                break

    if not matched_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or inactive service token",
        )

    # Update last_used_at (non-blocking — don't fail the request if this fails)
    try:
        from datetime import datetime, timezone
        matched_token.last_used_at = datetime.now(timezone.utc).isoformat()
        await db.commit()
    except Exception as e:
        logger.warning("Failed to update service token last_used_at: %s", e)

    return tenant_id, matched_token


async def get_service_token_tenant_db(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Authenticate the service token AND yield a session bound to the
    tenant's per-tenant DB.

    Service tokens are stored on the shared ``timesheet_db`` (control-plane-ish
    auth lookup), but the data operations they drive (employee/client/project
    upserts, timesheet pushes) must land in the tenant's per-tenant DB for
    isolated tenants. Returns a 3-tuple yielded into the route:
    ``(tenant_id, matched_token, tenant_session)``.

    For non-isolated tenants this still routes to the shared DB by way of
    ``db_tenant.tenant_session`` resolving to the shared URL.
    """
    tenant_id, matched_token = await get_service_token_tenant(request, db)

    from app.db_tenant import resolve_slug_for_tenant_id, tenant_session

    try:
        slug = await resolve_slug_for_tenant_id(tenant_id)
    except LookupError:
        # Tenant exists in legacy DB but not in control plane (F-011 family).
        # Fall back to the shared DB session passed in.
        yield tenant_id, matched_token, db
        return

    async with tenant_session(slug) as tenant_db:
        yield tenant_id, matched_token, tenant_db


def get_tenant_id(current_user: User = Depends(get_current_user)) -> int:
    """Return the current user's tenant_id (403 if unset for non-platform)."""
    if current_user.tenant_id is None and current_user.role != UserRole.PLATFORM_ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User has no tenant assignment",
        )
    return current_user.tenant_id


def get_tenant_slug(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> str:
    """Return the caller's tenant slug (mirrors ``get_tenant_db``'s rules)."""
    payload = _decode_or_raise(credentials)
    realm = payload.get("realm", "tenant")
    if realm == "platform":
        slug = request.headers.get("X-Tenant-Slug")
        if not slug:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Platform-admin tokens must specify a tenant via the "
                    "X-Tenant-Slug header to access tenant-scoped routes."
                ),
            )
        return slug
    slug = payload.get("tenant_slug")
    if not slug:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token has no tenant_slug claim; re-authenticate.",
        )
    return slug


async def require_ingestion_enabled(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_tenant_db),
) -> User:
    """Verify the current user's tenant has ingestion enabled."""
    from app.models.tenant import Tenant

    if current_user.tenant_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Email ingestion is not available without a tenant assignment.",
        )

    tenant = await db.get(Tenant, current_user.tenant_id)
    if not tenant or not tenant.ingestion_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Email ingestion is not enabled for this tenant. "
                "Contact your platform administrator."
            ),
        )
    return current_user


async def require_project_management_enabled(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_tenant_db),
) -> User:
    """Verify the current user's tenant has the project-management module enabled.

    Gates the Clients / Projects / Tasks / Insights (portfolio) endpoints. When
    the platform admin has turned the module off, those return 403 while personal
    time tracking, approvals, and time off stay available. Mirrors
    ``require_ingestion_enabled``."""
    from app.models.tenant import Tenant

    if current_user.tenant_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Project management is not available without a tenant assignment.",
        )

    # Read the flag from the CONTROL PLANE — that's the source of truth the
    # platform admin writes via PATCH /tenants/{id}. The per-tenant DB's tenants
    # row (what get_tenant_db would return for an isolated tenant) is not synced
    # on that write, so reading it here would miss the toggle. Fall back to the
    # local row only if the control plane is unreachable.
    enabled = True
    try:
        from app.models.control import ControlTenant
        from app.db_control import AsyncControlSessionLocal as ControlSession
        async with ControlSession() as control_db:
            ctrl = await control_db.get(ControlTenant, current_user.tenant_id)
            if ctrl is not None:
                enabled = bool(getattr(ctrl, "project_management_enabled", True))
    except Exception:  # noqa: BLE001 — control plane down: fall back to local row
        tenant = await db.get(Tenant, current_user.tenant_id)
        enabled = getattr(tenant, "project_management_enabled", True) is not False

    if not enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "The project management module is not enabled for this workspace. "
                "Contact your platform administrator."
            ),
        )
    return current_user


async def require_can_review(
    current_user: User = Depends(get_current_user),
) -> User:
    """Verify the user can access the reviewer inbox.

    Admin is excluded: admins switch to their manager role for review work.
    """
    if current_user.role == UserRole.ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role does not have reviewer access. Log in with your manager account.",
        )
    if not current_user.can_review:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have reviewer access.",
        )
    return current_user
