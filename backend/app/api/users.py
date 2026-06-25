import logging
from datetime import date, datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Request, status, Query, UploadFile
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel as PydanticBaseModel
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession
from app.schemas import UserResponse, UserCreate, UserUpdate, UserSelfUpdate, UserProfileResponse, ChangePasswordRequest, MessageResponse, UserCreateResponse, AdminPasswordResetRequest, UserPreferences, UserPreferencesUpdate
from app.crud.user import get_user_by_id, create_user, update_user, delete_user, list_users
from app.core.permissions import get_user_permissions, shadow_check
from app.core.deps import get_current_user, get_tenant_db, require_role, require_same_tenant
from app.models.user import User
from app.models.assignments import EmployeeManagerAssignment
from app.core.security import verify_password, get_password_hash, auth0_password_grant, Auth0PasswordError
from app.models.user import UserRole
from app.crud.tenant import get_tenant
from app.services.ingestion_sync import _send_outbound_webhook
from app.services.activity import (
    PLATFORM_ADMIN_ACTIVITY_SCOPE,
    TENANT_ADMIN_ACTIVITY_SCOPE,
    build_activity_event,
    record_activity_events,
)
from sqlalchemy.exc import IntegrityError

router = APIRouter(prefix="/users", tags=["users"])
logger = logging.getLogger(__name__)

MANAGER_CHAIN_ROLES = {UserRole.MANAGER}


def _filter_users_py(users, *, q=None, role=None, status=None, audience=None,
                     no_manager=False, unverified=False):
    """In-Python equivalent of the SQL user filters, for the manager-chain
    path where the candidate set is already loaded in memory."""
    out = users
    if q:
        ql = q.strip().lower()
        out = [u for u in out if ql in (u.full_name or "").lower()
               or ql in (u.email or "").lower() or ql in (u.username or "").lower()]
    if role:
        rv = role.value if hasattr(role, "value") else str(role)
        out = [u for u in out if (u.role.value if hasattr(u.role, "value") else str(u.role)) == rv]
    if status == "active":
        out = [u for u in out if u.is_active]
    elif status == "inactive":
        out = [u for u in out if not u.is_active]
    # Audience buckets: internal / external / client. Client roles are external
    # too, so exclude them from internal/external to keep the buckets distinct.
    _client_role_values = {"CLIENT", "CLIENT_MANAGER", "CLIENT_EMPLOYEE"}
    def _is_client(u):
        return (u.role.value if hasattr(u.role, "value") else str(u.role)) in _client_role_values
    if audience == "internal":
        out = [u for u in out if not u.is_external and not _is_client(u)]
    elif audience == "external":
        out = [u for u in out if u.is_external and not _is_client(u)]
    elif audience == "client":
        out = [u for u in out if _is_client(u)]
    if no_manager:
        out = [u for u in out if u.manager_id is None]
    if unverified:
        out = [u for u in out if not u.email_verified]
    return out


async def _get_descendant_user_ids(
    db: AsyncSession, manager_id: int, tenant_id: int
) -> set[int]:
    """Walk the manager-chain to all transitive direct reports.

    BFS is tenant-scoped via User.tenant_id since EmployeeManagerAssignment
    has no tenant_id column.
    """
    descendant_ids: set[int] = set()
    frontier: set[int] = {manager_id}

    while frontier:
        result = await db.execute(
            select(EmployeeManagerAssignment.employee_id)
            .join(User, User.id == EmployeeManagerAssignment.employee_id)
            .where(EmployeeManagerAssignment.manager_id.in_(frontier))
            .where(User.tenant_id == tenant_id)
        )
        children = set(result.scalars().all())
        next_frontier = children - descendant_ids
        descendant_ids.update(next_frontier)
        frontier = next_frontier

    return descendant_ids


async def _get_managed_employees(db: AsyncSession, manager_id: int, tenant_id: int) -> list[User]:
    descendant_ids = await _get_descendant_user_ids(db, manager_id, tenant_id)
    if not descendant_ids:
        return []

    result = await db.execute(
        select(User)
        .where(User.id.in_(descendant_ids))
        .where(User.role == UserRole.EMPLOYEE)
        .where(User.tenant_id == tenant_id)
        .options(
            selectinload(User.manager_assignment),
            selectinload(User.manager_assignments),
            selectinload(User.project_access),
            selectinload(User.task_access),
        )
        .order_by(User.full_name.asc())
    )
    return list(result.scalars().all())


async def _get_managed_users(db: AsyncSession, manager_id: int, tenant_id: int) -> list[User]:
    """The internal reports under a manager, for the 'My Team' management view.

    External users (clients / contractors) are excluded: they're not part of a
    manager's internal org and shouldn't appear in their team-management screen,
    even if an employee_manager_assignment exists for routing purposes elsewhere.
    """
    descendant_ids = await _get_descendant_user_ids(db, manager_id, tenant_id)
    if not descendant_ids:
        return []

    result = await db.execute(
        select(User)
        .where(User.id.in_(descendant_ids))
        .where(User.tenant_id == tenant_id)
        .where(User.is_external.is_(False))
        .options(
            selectinload(User.manager_assignment),
            selectinload(User.manager_assignments),
            selectinload(User.project_access),
            selectinload(User.task_access),
        )
        .order_by(User.full_name.asc())
    )
    return list(result.scalars().all())


def _validate_new_password(password: str) -> None:
    from app.core.password_policy import validate_password
    error = validate_password(password)
    if error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error,
        )


@router.get("/assignable", response_model=list[UserResponse])
async def list_assignable_users(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role(
        "MANAGER", "VIEWER", "ADMIN", "PLATFORM_ADMIN"
    )),
) -> list[User]:
    """Full tenant employee list for assignment dropdowns (e.g. ingestion review panel)."""
    return await list_users(db, tenant_id=current_user.tenant_id, skip=0, limit=1000)


@router.get("", response_model=list[UserResponse])
async def list_all_users(
    request: Request,
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    q: str | None = Query(None),
    role: UserRole | None = Query(None),
    status_filter: str | None = Query(None, alias="status"),
    audience: str | None = Query(None),
    no_manager: bool = Query(False),
    unverified: bool = Query(False),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """List users; scope depends on role (platform/tenant/manager-chain).

    Supports server-side pagination (skip/limit) plus search/filters
    (q, role, status, audience, no_manager, unverified). The total matching
    count is returned in the ``X-Total-Count`` header so the UI can page.
    """
    old_decision = current_user.role in {
        UserRole.PLATFORM_ADMIN,
        UserRole.ADMIN,
        UserRole.MANAGER,
        UserRole.VIEWER,
    }
    await shadow_check(
        db,
        current_user,
        "user.read",
        old_decision=old_decision,
        context="GET /users",
    )

    if current_user.role == UserRole.PLATFORM_ADMIN:
        # PA tokens carry tenant_id=None, so we must filter to the
        # tenant the request is scoped to. get_tenant_db already
        # routed the session via X-Tenant-Slug; look up the matching
        # tenant id in the control plane and filter by it. This is
        # defense-in-depth: for an isolated tenant the per-tenant DB
        # only contains that tenant's users anyway, but for a
        # non-isolated tenant the session is bound to the shared
        # legacy DB and an unfiltered query would leak every tenant's
        # users.
        target_tenant_id: int | None = None
        header_slug = request.headers.get("X-Tenant-Slug")
        if header_slug:
            from app.db_control import AsyncControlSessionLocal
            from app.models.control import ControlTenant
            async with AsyncControlSessionLocal() as control_db:
                target_tenant_id = await control_db.scalar(
                    select(ControlTenant.id).where(ControlTenant.slug == header_slug)
                )
        from app.crud.user import _apply_user_filters, count_users
        if target_tenant_id is not None:
            total = await count_users(
                db, target_tenant_id, q=q, role=role, status=status_filter,
                audience=audience, no_manager=no_manager, unverified=unverified,
            )
            query = _apply_user_filters(
                select(User).where(User.tenant_id == target_tenant_id),
                q=q, role=role, status=status_filter, audience=audience,
                no_manager=no_manager, unverified=unverified,
            ).options(
                selectinload(User.manager_assignment),
            selectinload(User.manager_assignments),
                selectinload(User.project_access),
                selectinload(User.task_access),
            )
            result = await db.execute(
                query.order_by(User.full_name.asc()).offset(skip).limit(limit)
            )
            orm_users = list(result.scalars().all())
        else:
            # Fail closed: an unresolved slug must return no rows.
            orm_users, total = [], 0
    elif current_user.role == UserRole.ADMIN:
        from app.crud.user import count_users
        orm_users = await list_users(
            db, tenant_id=current_user.tenant_id, skip=skip, limit=limit,
            q=q, role=role, status=status_filter, audience=audience,
            no_manager=no_manager, unverified=unverified,
        )
        total = await count_users(
            db, current_user.tenant_id, q=q, role=role, status=status_filter,
            audience=audience, no_manager=no_manager, unverified=unverified,
        )
    elif current_user.role in MANAGER_CHAIN_ROLES:
        # Manager chain is loaded fully then filtered in Python (small set).
        managed = await _get_managed_users(db, current_user.id, current_user.tenant_id)
        managed = _filter_users_py(
            managed, q=q, role=role, status=status_filter, audience=audience,
            no_manager=no_manager, unverified=unverified,
        )
        total = len(managed)
        orm_users = managed[skip: skip + limit]
    else:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied",
        )

    # Serialize while the session is still open so @property accessors
    # (manager_id, project_ids) can read their eagerly-loaded relationships
    # before SQLAlchemy expires the ORM objects on session close.
    # Return JSONResponse directly to bypass FastAPI's response_model re-validation
    # which runs after the session closes and would lose the loaded relationship data.
    data = [UserResponse.model_validate(u).model_dump(mode='json') for u in orm_users]
    return JSONResponse(content=data, headers={"X-Total-Count": str(total)})


@router.get("/me/permissions")
async def get_my_permissions(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_tenant_db),
) -> dict:
    perms = await get_user_permissions(db, current_user)
    return {"permissions": sorted(perms)}


# Allowed values for known preference keys. Unknown keys are accepted as-is
# so the frontend can introduce new ones without a backend change, but known
# keys are validated to keep the column from accumulating typos.
_INBOX_VIEW_MODES = {"cards", "table"}


# UI preference keys that a brand-new user inherits from the tenant's
# customization defaults on first login. Each maps a stored preference key to
# the public setting that supplies its default. Only seeded when the user has
# not already set that preference, so an explicit user choice always wins and
# the value is never written back to the column (it stays a computed default
# until the user saves their own).
_PREF_DEFAULT_FROM_SETTING = {
    "theme": "default_theme",
    "palette": "default_palette",
    "landing": "default_landing",
    "page_size": "default_page_size",
}


@router.get("/me/preferences", response_model=UserPreferences)
async def get_my_preferences(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Return the caller's persisted UI preferences.

    For a brand-new user (a preference key not yet set), the tenant's
    customization defaults (theme, palette, landing, page size) are merged in
    so the user inherits the team default once. The defaults are computed, not
    persisted: the moment the user saves their own choice it takes over.
    """
    prefs = dict(current_user.preferences or {})

    if current_user.tenant_id is not None:
        try:
            from app.core.tenant_settings import get_public_settings

            public = await get_public_settings(db, current_user.tenant_id)
        except Exception:  # pragma: no cover - defensive; never block prefs read
            public = {}
        for pref_key, setting_key in _PREF_DEFAULT_FROM_SETTING.items():
            if pref_key in prefs:
                continue
            value = public.get(setting_key)
            # Skip empty/blank defaults (e.g. palette "" = app default) so the
            # frontend falls back to its own default instead of an empty string.
            if value is None or value == "":
                continue
            prefs[pref_key] = value

    return prefs


@router.patch("/me/preferences", response_model=UserPreferences)
async def update_my_preferences(
    payload: UserPreferencesUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Partial-update the caller's UI preferences.

    Only keys explicitly provided are merged. Unknown keys are rejected at
    the schema layer; known keys are value-validated here so the column
    stays clean. Returns the full merged preferences object so the caller
    can mirror it into local cache without a second round-trip.
    """
    incoming = payload.model_dump(exclude_unset=True)

    if "inbox_view_mode" in incoming:
        mode = incoming["inbox_view_mode"]
        if mode is not None and mode not in _INBOX_VIEW_MODES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail='Inbox view must be either "cards" or "table".',
            )

    # Merge over the existing dict instead of replacing it so unrelated
    # preferences keys survive partial PATCHes.
    merged = dict(current_user.preferences or {})
    for key, value in incoming.items():
        if value is None:
            merged.pop(key, None)
        else:
            merged[key] = value
    current_user.preferences = merged
    # SQLAlchemy doesn't flag JSONB mutations by default; re-assigning the
    # whole dict above already triggers an UPDATE, so commit and return.
    await db.commit()
    return merged


@router.get("/me/profile", response_model=UserProfileResponse)
async def get_my_profile(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Return the logged-in user's read-only profile fields."""
    direct_reports_result = await db.execute(
        select(User)
        .join(EmployeeManagerAssignment, EmployeeManagerAssignment.employee_id == User.id)
        .where(EmployeeManagerAssignment.manager_id == current_user.id)
        .order_by(User.full_name.asc())
    )
    direct_reports = list(direct_reports_result.scalars().all())

    manager_name = None
    manager_user = None
    if current_user.manager_id is not None:
        manager_user = await get_user_by_id(db, current_user.manager_id)
        manager_name = manager_user.full_name if manager_user else None

    supervisor_chain: list[User] = []
    seen_user_ids = {current_user.id}
    next_supervisor = manager_user
    while next_supervisor and next_supervisor.id not in seen_user_ids:
        supervisor_chain.append(next_supervisor)
        seen_user_ids.add(next_supervisor.id)
        if next_supervisor.manager_id is None:
            break
        next_supervisor = await get_user_by_id(db, next_supervisor.manager_id)

    return {
        "id": current_user.id,
        "email": current_user.email,
        "username": current_user.username,
        "full_name": current_user.full_name,
        "title": current_user.title,
        "department": current_user.department,
        "timezone": current_user.timezone,
        "role": current_user.role,
        "manager_id": current_user.manager_id,
        "manager_name": manager_name,
        "direct_reports": direct_reports,
        "supervisor_chain": supervisor_chain,
    }


@router.patch("/me/profile", response_model=UserResponse)
async def update_my_profile(
    payload: UserSelfUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> User:
    """Self-update profile. Regular users can edit name/title/timezone/username.
    Platform admins can also edit their email."""
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy import select as sa_select

    data = payload.model_dump(exclude_unset=True)

    # Only platform admins can change their own email.
    if "email" in data and current_user.role != UserRole.PLATFORM_ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only platform administrators can change their own email.",
        )

    # Pre-check username uniqueness to surface a friendly error instead of 500.
    if "username" in data and data["username"] is not None:
        next_username = data["username"].strip().lower()
        if not next_username:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Username cannot be blank.",
            )
        if next_username != current_user.username:
            taken = await db.execute(
                sa_select(User.id).where(User.username == next_username)
            )
            if taken.scalar_one_or_none() is not None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="That username is already taken.",
                )
        data["username"] = next_username

    # Pre-check email uniqueness for platform admin self-edits.
    if "email" in data and data["email"] is not None:
        next_email = data["email"].strip().lower()
        if next_email != current_user.email:
            taken = await db.execute(
                sa_select(User.id).where(User.email == next_email)
            )
            if taken.scalar_one_or_none() is not None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="That email is already in use.",
                )
        data["email"] = next_email

    update = UserUpdate(**data)
    try:
        # current_user is bound to the auth session, not this request's tenant
        # `db`. Re-fetch the row within `db` so update_user operates on a
        # session-attached instance (otherwise flush/refresh fail with
        # "not persistent within this Session").
        target = await get_user_by_id(db, current_user.id)
        if target is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        return await update_user(db, target, update)
    except IntegrityError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That username or email is already in use.",
        )


@router.post("/me/password", response_model=MessageResponse)
async def change_my_password(
    payload: ChangePasswordRequest,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> MessageResponse:
    """Allow a user to change password by providing current password first.

    Mirrors the branching in ``POST /auth/change-password``: Auth0
    users go through the Management API, bcrypt users update the
    local hash. The frontend hits ``/auth/change-password`` for the
    main self-service form; this endpoint exists for the post-
    verification first-password set flow but must also handle Auth0
    users so direct API callers aren't broken.
    """
    is_auth0_user = bool(current_user.auth0_sub)

    if is_auth0_user:
        try:
            await auth0_password_grant(current_user.email, payload.current_password)
        except Auth0PasswordError as exc:
            if exc.code == "invalid_grant":
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Current password is incorrect",
                ) from exc
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Could not verify current password (Auth0 unreachable). Try again in a moment.",
            ) from exc
        if payload.current_password == payload.new_password:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="New password must be different from current password",
            )
        from app.services.auth0_mgmt import Auth0MgmtError, set_user_password
        try:
            await set_user_password(
                sub=current_user.auth0_sub,
                password=payload.new_password,
            )
        except Auth0MgmtError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc
        # Replace local hash with a throwaway so a future Auth0-
        # disabled fallback can never accept the user's old bcrypt.
        import secrets
        current_user.hashed_password = get_password_hash(secrets.token_urlsafe(48))
    else:
        if not verify_password(payload.current_password, current_user.hashed_password):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Current password is incorrect",
            )
        if payload.current_password == payload.new_password:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="New password must be different from current password",
            )
        _validate_new_password(payload.new_password)
        current_user.hashed_password = get_password_hash(payload.new_password)

    current_user.has_changed_password = True
    db.add(current_user)
    await db.commit()

    # Audit: password changed
    await record_activity_events(db, [build_activity_event(
        activity_type="PASSWORD_CHANGED",
        visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
        tenant_id=current_user.tenant_id,
        actor_user=current_user,
        entity_type="user",
        entity_id=current_user.id,
        summary=f"{current_user.full_name} changed their password.",
        route="/users/me/password",
    )])

    return MessageResponse(message="Password updated successfully")


# ── Tenant Settings ──────────────────────────────────────────────────────────

@router.get("/tenant-settings", response_model=dict)
async def get_tenant_settings(
    current_user: User = Depends(require_role("ADMIN")),
    db: AsyncSession = Depends(get_tenant_db),
) -> dict:
    """Get every setting for the tenant; falls back to catalog defaults."""
    from app.core.tenant_settings import get_all_settings

    if current_user.tenant_id is None:
        return {}
    return await get_all_settings(db, current_user.tenant_id)


@router.get("/tenant-settings/catalog", response_model=list)
async def get_tenant_settings_catalog(
    current_user: User = Depends(require_role("ADMIN")),
    db: AsyncSession = Depends(get_tenant_db),
) -> list:
    """Return the full setting-definition catalog used by the admin settings form."""
    from app.core.tenant_settings import get_catalog

    return await get_catalog(db)


@router.get("/tenant-settings/public", response_model=dict)
async def get_public_tenant_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_tenant_db),
) -> dict:
    """Whitelisted tenant settings readable by any authenticated user."""
    from app.core.tenant_settings import get_public_settings

    if current_user.tenant_id is None:
        return {}
    return await get_public_settings(db, current_user.tenant_id)


class TenantSettingsUpdate(PydanticBaseModel):
    """Wraps the {key: value} body for /users/tenant-settings so OpenAPI
    shows ``object`` instead of a raw ``dict``. Per-key validation against
    the setting catalog still happens in ``set_setting``."""
    model_config = {"extra": "allow"}


@router.patch("/tenant-settings", response_model=dict)
async def update_tenant_settings(
    body: TenantSettingsUpdate,
    current_user: User = Depends(require_role("ADMIN")),
    db: AsyncSession = Depends(get_tenant_db),
) -> dict:
    """Upsert tenant settings; validated against the catalog (422 on failure)."""
    from app.core.tenant_settings import set_setting

    await shadow_check(
        db,
        current_user,
        "tenant.settings.update",
        old_decision=True,
        context="PATCH /users/tenant-settings",
    )

    if current_user.tenant_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="PLATFORM_ADMIN has no tenant-scoped settings",
        )

    result: dict = {}
    for key, value in body.model_dump(exclude_unset=True).items():
        try:
            result[key] = await set_setting(
                db,
                current_user.tenant_id,
                key,
                value,
                actor_id=current_user.id,
            )
        except KeyError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Unrecognized setting: {key}",
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=str(exc),
            )
    await db.commit()
    return result


@router.post("/smtp-test", status_code=200)
async def test_smtp_connection(
    current_user: User = Depends(require_role("ADMIN")),
    db: AsyncSession = Depends(get_tenant_db),
) -> dict:
    """Open a live SMTP connection using the tenant's stored smtp_* settings.

    Does not send a message. Returns {"ok": true} or {"ok": false, "detail": "..."}.
    Requires the custom_outbound_email feature flag.
    """
    import asyncio
    import smtplib

    from app.services.tenant_features import has_feature
    from app.services.tenant_email_service import build_tenant_smtp_config

    if current_user.tenant_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No tenant assigned.",
        )

    if not await has_feature(current_user.tenant_id, "custom_outbound_email"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Custom Outbound Email feature is not enabled for this tenant.",
        )

    cfg = await build_tenant_smtp_config(db, current_user.tenant_id)
    if cfg is None:
        return {"ok": False, "detail": "SMTP host is not configured. Enter a host in the Email / SMTP settings first."}

    def _probe() -> None:
        # smtplib is synchronous; run it off the event loop so concurrent
        # admin "Test connection" clicks don't serialize on a 5s wait.
        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=5) as server:
            if cfg["use_tls"]:
                server.starttls()
            if cfg["username"]:
                server.login(cfg["username"], cfg["password"])

    try:
        await asyncio.to_thread(_probe)
        return {"ok": True}
    except smtplib.SMTPAuthenticationError as exc:
        return {"ok": False, "detail": f"Authentication failed: {exc.smtp_error.decode(errors='replace') if isinstance(exc.smtp_error, bytes) else str(exc)}"}
    except smtplib.SMTPConnectError as exc:
        return {"ok": False, "detail": f"Could not connect to {cfg['host']}:{cfg['port']}: {exc}"}
    except Exception as exc:
        return {"ok": False, "detail": str(exc)}


class EmailTemplatePreviewRequest(PydanticBaseModel):
    purpose: str  # "invite" | "reset"
    subject: str = ""
    greeting: str = ""
    body: str = ""
    button_label: str = ""
    signoff: str = ""


@router.post("/email-template-preview", status_code=200)
async def email_template_preview(
    body: EmailTemplatePreviewRequest,
    current_user: User = Depends(require_role("ADMIN")),
) -> dict:
    """Render a preview of the invitation or reset email using the supplied
    field overrides and dummy recipient data.

    Returns {"subject": str, "html": str, "text": str}.
    No feature-flag check -- admins can preview on any tier.
    """
    from app.services.email_verification import (
        _build_modern_invite_html,
        _build_modern_invite_text,
    )

    purpose = body.purpose if body.purpose in ("invite", "reset") else "invite"
    first_name = "Alex"
    org = "Acme Corp"
    action_url = "https://app.acufy.ai/set-password?token=preview"

    if purpose == "reset":
        default_subject      = "Reset your Acufy Timesheet password"
        default_greeting     = f"Hi {first_name},"
        default_body         = "We received a request to reset your password on Acufy Timesheet. Click the button below to choose a new one."
        default_button_label = "Reset my password"
        default_signoff      = "Acufy AI Security"
        headline             = "Reset your password"
    else:
        default_subject      = "You're invited to Acufy Timesheet"
        default_greeting     = f"Hi {first_name},"
        default_body         = f"{org} has set up your account on Acufy Timesheet. Set your password to get started."
        default_button_label = "Set my password"
        default_signoff      = f"Sent on behalf of {org}"
        headline             = "Welcome to Acufy Timesheet"

    subject      = body.subject.strip()      or default_subject
    greeting     = body.greeting.strip()     or default_greeting
    body_text    = body.body.strip()         or default_body
    button_label = body.button_label.strip() or default_button_label
    signoff      = body.signoff.strip()      or default_signoff

    # Greeting always starts with "Hi {first_name}," -- append custom text after
    if body.greeting.strip():
        greeting = f"Hi {first_name}, {body.greeting.strip()}"

    intro = f"{greeting} {body_text}"

    html_out = _build_modern_invite_html(
        headline=headline,
        intro=intro,
        button_label=button_label,
        invite_url=action_url,
        footer_inviter=signoff,
    )
    text_out = _build_modern_invite_text(
        headline=headline,
        intro=intro,
        invite_url=action_url,
        footer_inviter=signoff,
    )

    return {"subject": subject, "html": html_out, "text": text_out}


class BulkDeleteUsersRequest(PydanticBaseModel):
    user_ids: list[int]


@router.post("/bulk-delete")
async def bulk_delete_users(
    body: BulkDeleteUsersRequest,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> dict:
    deleted = 0
    for user_id in body.user_ids:
        user = await get_user_by_id(db, user_id)
        if not user:
            continue
        if user.tenant_id != current_user.tenant_id and current_user.role != UserRole.PLATFORM_ADMIN:
            continue
        if user.id == current_user.id:
            continue
        success = await delete_user(db, user_id)
        if success:
            deleted += 1
    return {"deleted": deleted}


@router.post("/{user_id:int}/reset-password", response_model=MessageResponse)
async def reset_user_password(
    user_id: int,
    payload: AdminPasswordResetRequest,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> MessageResponse:
    """Admin resets a user's password. Syncs to Auth0 when the user has an auth0_sub."""
    user = await get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if user.tenant_id != current_user.tenant_id and current_user.role != UserRole.PLATFORM_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    if user.id == current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Use the change password page to update your own password")

    _validate_new_password(payload.new_password)

    # Sync to Auth0 first (before local write) so a policy rejection surfaces
    # as a clean 400 without any partial state being committed.
    if user.auth0_sub:
        from app.services import auth0_mgmt
        try:
            await auth0_mgmt.set_user_password(
                sub=user.auth0_sub,
                password=payload.new_password,
                mark_email_verified=True,
            )
        except auth0_mgmt.Auth0MgmtError as exc:
            # Don't surface raw Auth0 SDK error text to the user; log it instead.
            logger.warning("Auth0 password set failed for user %s: %s", user.id, exc)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Couldn't update the password. Please try again.",
            )
        # For Auth0 users, Auth0 is the source of truth. Write a random
        # throwaway hash locally so a future Auth0-disabled fallback can
        # never accept the user's *old* bcrypt as valid — and so this
        # endpoint can't leave the two stores divergent if the local
        # commit fails after Auth0 already succeeded. The other two
        # password-change endpoints already follow this pattern; this
        # one was the outlier.
        import secrets
        user.hashed_password = get_password_hash(secrets.token_urlsafe(48))
    else:
        user.hashed_password = get_password_hash(payload.new_password)
    user.has_changed_password = False
    db.add(user)
    await db.commit()

    return MessageResponse(message="Password reset successfully. User will be prompted to change it on next login.")


@router.post("/{user_id:int}/resend-verification", response_model=MessageResponse)
async def resend_verification_email_endpoint(
    user_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> MessageResponse:
    """Admin resends a verification email; rotates temp password + token."""
    user = await get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if user.tenant_id != current_user.tenant_id and current_user.role != UserRole.PLATFORM_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    if user.email_verified:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="User is already verified. Use Reset Password instead.",
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot send verification: user account is inactive",
        )
    if user.is_external:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot send verification: external users do not log in.",
        )
    # Refuse the synthesized @local.invalid placeholder used when no email was set.
    if (user.email or "").lower().endswith("@local.invalid"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot send verification: user has no real email address. Add one first.",
        )

    from app.crud.user import _generate_default_password
    from app.services.email_verification import set_verification_token, send_verification_email

    new_temp_password = _generate_default_password()
    user.hashed_password = get_password_hash(new_temp_password)
    user.has_changed_password = False
    token = set_verification_token(user)
    db.add(user)
    await db.commit()

    tenant_name = None
    if user.tenant_id is not None:
        from app.crud.tenant import get_tenant
        tenant = await get_tenant(db, user.tenant_id)
        tenant_name = tenant.name if tenant else None

    await send_verification_email(
        user,
        token,
        temporary_password=new_temp_password,
        tenant_name=tenant_name,
        tenant_id=user.tenant_id,
        resend=True,
    )

    return MessageResponse(message=f"Verification email resent to {user.email}.")


@router.post("/{user_id:int}/resend-invite", response_model=MessageResponse)
async def resend_invite_email_endpoint(
    user_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> MessageResponse:
    """Issue a fresh /set-password invite link and email it to the user.

    Works for users who already have an auth0_sub (provisioned) but haven't
    set their password yet, or for any active user whose original invite
    link expired. The previous token is left in the DB as consumed-equivalent
    (it will just fail the jti lookup on use), so only the new link works.
    """
    from app.services.password_invite import issue_invite_token, build_set_password_url
    from app.services.email_verification import send_local_invitation_email
    from app.api.platform_settings import get_effective_smtp_config

    user = await get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if user.tenant_id != current_user.tenant_id and current_user.role != UserRole.PLATFORM_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot send invite: user account is inactive",
        )
    if user.is_external:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot send invite: external users do not log in.",
        )
    if (user.email or "").lower().endswith("@local.invalid"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot send invite: user has no real email address. Add one first.",
        )
    # A set-password invite works whether or not the user is Auth0-bound: bound
    # users sync to Auth0, others set a local bcrypt password via /set-password.
    # (Previously this hard-required auth0_sub, which broke resend on Auth0-off
    # deployments like prod.)

    token = await issue_invite_token(db, user, purpose="invite")
    await db.commit()

    invite_url = build_set_password_url(token, purpose="invite")
    smtp_config = await get_effective_smtp_config(db)
    tenant_name: str | None = None
    if user.tenant_id is not None:
        tenant = await get_tenant(db, user.tenant_id)
        tenant_name = tenant.name if tenant else None

    await send_local_invitation_email(user, invite_url, smtp_config, tenant_name, user.tenant_id)

    return MessageResponse(message=f"Invite email resent to {user.email}.")


@router.post("/{user_id:int}/send-invite", response_model=MessageResponse)
async def send_invite_endpoint(
    user_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> MessageResponse:
    """Unified Send invite. Picks the right flow based on the user's state:

    * If the user has an ``auth0_sub`` (provisioned in Auth0), send a fresh
      /set-password invite link. The user clicks the link, sets their own
      password on the SPA, and the password syncs to Auth0.
    * Otherwise, fall back to the legacy verification flow: rotate the
      user's temp password, mark them unverified, and email both the temp
      password and a /verify-account link.

    Replaces the dual "Resend verification" / "Resend invite link" buttons
    that exposed the Auth0-cutover seam to operators. Both old endpoints
    remain to keep any in-flight clients working; new UI should call here.
    """
    user = await get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if user.tenant_id != current_user.tenant_id and current_user.role != UserRole.PLATFORM_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot send invite: user account is inactive",
        )
    if user.is_external:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot send invite: external users do not log in.",
        )
    if (user.email or "").lower().endswith("@local.invalid"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot send invite: user has no real email address. Add one first.",
        )

    tenant_name: str | None = None
    if user.tenant_id is not None:
        from app.crud.tenant import get_tenant
        tenant = await get_tenant(db, user.tenant_id)
        tenant_name = tenant.name if tenant else None

    # Preferred for EVERY deployment: a /set-password invite link (no temp
    # password). Auth0-bound users sync the password to Auth0; Auth0-off
    # deployments (e.g. prod) set the local bcrypt hash via the same
    # /set-password endpoint. Only the rare can't-mint-a-token case falls back
    # to the legacy temp-password verification flow below.
    from app.services.password_invite import issue_invite_token, build_set_password_url
    from app.services.email_verification import send_local_invitation_email
    from app.api.platform_settings import get_effective_smtp_config

    token = await issue_invite_token(db, user, purpose="invite")
    await db.commit()
    invite_url = build_set_password_url(token, purpose="invite")
    smtp_config = await get_effective_smtp_config(db)
    await send_local_invitation_email(user, invite_url, smtp_config, tenant_name, user.tenant_id)
    return MessageResponse(message=f"Invite email sent to {user.email}.")


@router.get("/{user_id:int}", response_model=UserResponse)
async def get_user(
    user_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> User:
    """Get a user by ID. Users can only view themselves unless they are admin."""
    user = await get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if user_id != current_user.id:
        if current_user.role not in (UserRole.ADMIN, UserRole.PLATFORM_ADMIN):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        require_same_tenant(user.tenant_id, current_user)

    return user


@router.post("", response_model=UserCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_new_user(
    user_create: UserCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> dict:
    """Create a user. PLATFORM_ADMIN passes tenant_id; ADMIN uses their own."""
    from app.crud.user import get_user_by_email, get_user_by_username

    if current_user.role != UserRole.PLATFORM_ADMIN and user_create.role == UserRole.PLATFORM_ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only a Platform Admin can create Platform Admin users",
        )

    if current_user.role == UserRole.PLATFORM_ADMIN:
        if user_create.role == UserRole.PLATFORM_ADMIN:
            user_create.tenant_id = None
        elif user_create.tenant_id is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="tenant_id is required when creating a user as PLATFORM_ADMIN",
            )
    else:
        user_create.tenant_id = current_user.tenant_id

    if user_create.email:
        existing = await get_user_by_email(db, user_create.email)
        if existing:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="A user with this email already exists",
            )

    if user_create.username:
        existing_username = await get_user_by_username(db, user_create.username)
        if existing_username:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Username is already taken",
            )

    user_create.password = None  # always auto-generated

    try:
        from app.services.email_verification import (
            set_verification_token,
            send_verification_email,
            send_local_invitation_email,
        )
        from app.services.password_invite import issue_invite_token, build_set_password_url
        from app.api.platform_settings import get_effective_smtp_config
        new_user, temp_password, auth0_invite_url = await create_user(db, user_create)

        # Invitation email only goes to internal+active users with a real email.
        provided_real_email = bool(user_create.email)
        send_invitation = (
            new_user.is_active
            and not new_user.is_external
            and provided_real_email
        )

        # Preferred onboarding for EVERY deployment is the "set your password"
        # invite link — never a temp password shown on screen or emailed.
        #   - Auth0 on  → create_user already minted the invite URL (auth0_invite_url).
        #   - Auth0 off → mint our OWN set-password token here (same flow the
        #     /set-password endpoint consumes). This is the prod path; before
        #     this it fell back to the legacy verification email + a temp
        #     password surfaced to the admin.
        # Only fall back to a temp password if we somehow can't mint a token.
        token: str | None = None
        invite_url: str | None = auth0_invite_url
        if send_invitation and not invite_url:
            invite_token = await issue_invite_token(db, new_user, purpose="invite")
            invite_url = build_set_password_url(invite_token, purpose="invite")
        use_local_invite = bool(invite_url) and send_invitation
        if send_invitation and not use_local_invite:
            token = set_verification_token(new_user)
            db.add(new_user)
        await db.commit()

        # Re-fetch with eager-loaded relationships so serialisation works.
        new_user = await get_user_by_id(db, new_user.id)

        smtp_config = await get_effective_smtp_config(db)
        tenant_name: str | None = None
        if new_user.tenant_id is not None:
            tenant = await get_tenant(db, new_user.tenant_id)
            tenant_name = tenant.name if tenant else None

        if use_local_invite:
            background_tasks.add_task(
                send_local_invitation_email,
                new_user, invite_url, smtp_config, tenant_name,
                new_user.tenant_id,
            )
        elif send_invitation and token is not None:
            via_tenant_oauth = False
            if new_user.tenant_id is not None:
                from app.services.tenant_email_service import _get_active_oauth_mailbox
                via_tenant_oauth = await _get_active_oauth_mailbox(db, new_user.tenant_id) is not None
            background_tasks.add_task(
                send_verification_email,
                new_user, token, temp_password, smtp_config, tenant_name,
                new_user.tenant_id, via_tenant_oauth,
            )
        else:
            reason = (
                "external user" if new_user.is_external
                else ("inactive user" if not new_user.is_active else "no email on file")
            )
            logger.info(
                "invitation_email_skipped: user=%s reason=%s",
                new_user.email, reason,
            )

        activity_events: list[dict] = []
        # Platform admins don't exist in the per-tenant users table, so
        # `actor_user_id` (an FK into users) can't carry their id. Pass
        # actor_user=None and use actor_name_override for the audit
        # context. Otherwise the activity_log INSERT raises IntegrityError
        # right after a successful user create, the surrounding except
        # clause maps it to a misleading "already exists" 400, and the
        # caller sees an error even though the user was created.
        actor_is_pa = current_user.role == UserRole.PLATFORM_ADMIN
        actor_user_arg = None if actor_is_pa else current_user
        actor_name_arg = current_user.full_name if actor_is_pa else None
        if new_user.tenant_id is not None:
            if current_user.role == UserRole.PLATFORM_ADMIN and new_user.role == UserRole.ADMIN:
                tenant_name_for_log = tenant_name or f"tenant {new_user.tenant_id}"
                activity_events.append(
                    build_activity_event(
                        activity_type="TENANT_ADMIN_CREATED",
                        visibility_scope=PLATFORM_ADMIN_ACTIVITY_SCOPE,
                        tenant_id=new_user.tenant_id,
                        actor_user=actor_user_arg,
                        actor_name_override=actor_name_arg,
                        entity_type="tenant_admin",
                        entity_id=new_user.id,
                        summary=f"{current_user.full_name} added tenant admin {new_user.full_name} for {tenant_name}.",
                        route="/platform-admin",
                        route_params={"tenantId": new_user.tenant_id, "adminUserId": new_user.id},
                        metadata={"tenant_name": tenant_name, "user_role": new_user.role.value},
                    )
                )
            else:
                activity_events.append(
                    build_activity_event(
                        activity_type="USER_CREATED",
                        visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                        tenant_id=new_user.tenant_id,
                        actor_user=actor_user_arg,
                        actor_name_override=actor_name_arg,
                        entity_type="user",
                        entity_id=new_user.id,
                        summary=f"{current_user.full_name} created user {new_user.full_name}.",
                        route="/user-management",
                        route_params={"userId": new_user.id},
                        metadata={"role": new_user.role.value, "is_active": new_user.is_active},
                    )
                )

        await record_activity_events(db, activity_events)
        return {
            "user": new_user,
            # When a set-password invite was sent (Auth0 or our own token),
            # the user sets their own password — the temp bcrypt one we
            # generated is never shown to the user, so don't leak it to the
            # admin UI either. Only surfaced in the rare no-invite fallback.
            "temporary_password": None if use_local_invite else temp_password,
            "verification_email_sent": send_invitation,
        }
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )
    except IntegrityError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A user with this email or username already exists",
        )


@router.put("/{user_id:int}", response_model=UserResponse)
async def update_user_endpoint(
    user_id: int,
    user_update: UserUpdate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> User:
    """Update a user. Admins update any user; managers may set project access for reports."""
    user = await get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if current_user.role in (UserRole.ADMIN, UserRole.PLATFORM_ADMIN):
        require_same_tenant(user.tenant_id, current_user)
        if current_user.role == UserRole.ADMIN and (
            user_update.role == UserRole.PLATFORM_ADMIN
            or (user_update.roles is not None and UserRole.PLATFORM_ADMIN in user_update.roles)
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Tenant admins cannot assign the PLATFORM_ADMIN role",
            )

        was_active = user.is_active
        previous_role = user.role
        previous_manager_id = user.manager_id
        previous_project_ids = sorted(user.project_ids or [])
        deactivated = (
            user.ingestion_employee_id is not None
            and user_update.is_active is False
            and was_active is True
        )

        from sqlalchemy.exc import IntegrityError
        try:
            updated_user = await update_user(db, user, user_update)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            )
        except IntegrityError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="That username or email is already in use.",
            )

        # Snapshot the freshly-loaded scalars/derived values NOW, before any
        # other query on this session (e.g. the manager lookups below) can expire
        # `updated_user`. The `project_ids` property reads the `project_access`
        # relationship lazily; touching it after re-expiry raises MissingGreenlet
        # in async context — which left the manager change committed but the
        # request 500-ing ("Could not update access" but it actually saved).
        u_id = updated_user.id
        u_tenant_id = updated_user.tenant_id
        u_full_name = updated_user.full_name
        u_manager_id = updated_user.manager_id
        u_is_active = updated_user.is_active
        u_project_ids = sorted(updated_user.project_ids or [])

        if deactivated:
            background_tasks.add_task(
                _send_outbound_webhook,
                tenant_id=current_user.tenant_id,
                event_type="user.deactivated",
                local_id=user.id,
                ingestion_id=user.ingestion_employee_id,
                changed_fields={"is_active": {"old": True, "new": False}},
                changed_by_name=current_user.full_name,
                session=db,
            )

        activity_events: list[dict] = []
        if updated_user.tenant_id is not None:
            tenant = await get_tenant(db, updated_user.tenant_id) if current_user.role == UserRole.PLATFORM_ADMIN else None
            tenant_name = tenant.name if tenant else None

            if previous_role != updated_user.role:
                if current_user.role == UserRole.PLATFORM_ADMIN and (
                    previous_role == UserRole.ADMIN or updated_user.role == UserRole.ADMIN
                ):
                    activity_events.append(
                        build_activity_event(
                            activity_type="TENANT_ADMIN_ROLE_CHANGED",
                            visibility_scope=PLATFORM_ADMIN_ACTIVITY_SCOPE,
                            tenant_id=updated_user.tenant_id,
                            actor_user=current_user,
                            entity_type="tenant_admin",
                            entity_id=updated_user.id,
                            summary=f"{current_user.full_name} changed {updated_user.full_name}'s role from {previous_role.value} to {updated_user.role.value}{f' for {tenant_name}' if tenant_name else ''}.",
                            route="/platform-admin",
                            route_params={"tenantId": updated_user.tenant_id, "adminUserId": updated_user.id},
                            metadata={"old_role": previous_role.value, "new_role": updated_user.role.value, "tenant_name": tenant_name},
                        )
                    )
                else:
                    activity_events.append(
                        build_activity_event(
                            activity_type="USER_ROLE_CHANGED",
                            visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                            tenant_id=updated_user.tenant_id,
                            actor_user=current_user,
                            entity_type="user",
                            entity_id=updated_user.id,
                            summary=f"{current_user.full_name} changed {updated_user.full_name}'s role from {previous_role.value} to {updated_user.role.value}.",
                            route="/user-management",
                            route_params={"userId": updated_user.id},
                            metadata={"old_role": previous_role.value, "new_role": updated_user.role.value},
                        )
                    )

            if was_active != updated_user.is_active:
                if current_user.role == UserRole.PLATFORM_ADMIN and updated_user.role == UserRole.ADMIN:
                    activity_events.append(
                        build_activity_event(
                            activity_type="TENANT_ADMIN_STATUS_CHANGED",
                            visibility_scope=PLATFORM_ADMIN_ACTIVITY_SCOPE,
                            tenant_id=updated_user.tenant_id,
                            actor_user=current_user,
                            entity_type="tenant_admin",
                            entity_id=updated_user.id,
                            summary=f"{current_user.full_name} marked tenant admin {updated_user.full_name} as {'active' if updated_user.is_active else 'inactive'}{f' for {tenant_name}' if tenant_name else ''}.",
                            route="/platform-admin",
                            route_params={"tenantId": updated_user.tenant_id, "adminUserId": updated_user.id},
                            metadata={"old_is_active": was_active, "new_is_active": updated_user.is_active, "tenant_name": tenant_name},
                        )
                    )
                else:
                    activity_events.append(
                        build_activity_event(
                            activity_type="USER_STATUS_CHANGED",
                            visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                            tenant_id=updated_user.tenant_id,
                            actor_user=current_user,
                            entity_type="user",
                            entity_id=updated_user.id,
                            summary=f"{current_user.full_name} marked {updated_user.full_name} as {'active' if updated_user.is_active else 'inactive'}.",
                            route="/user-management",
                            route_params={"userId": updated_user.id},
                            metadata={"old_is_active": was_active, "new_is_active": updated_user.is_active},
                        )
                    )

            if previous_manager_id != u_manager_id:
                # Resolve names via lightweight scalar queries (these expire the
                # ORM `updated_user`, which is why we snapshotted its derived
                # values above before any of this).
                old_manager_name = (await db.execute(
                    select(User.full_name).where(User.id == previous_manager_id)
                )).scalar_one_or_none() if previous_manager_id else None
                new_manager_name = (await db.execute(
                    select(User.full_name).where(User.id == u_manager_id)
                )).scalar_one_or_none() if u_manager_id else None
                activity_events.append(
                    build_activity_event(
                        activity_type="USER_MANAGER_CHANGED",
                        visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                        tenant_id=u_tenant_id,
                        actor_user=current_user,
                        entity_type="user",
                        entity_id=u_id,
                        summary=f"{current_user.full_name} changed {u_full_name}'s manager from {old_manager_name or 'Unassigned'} to {new_manager_name or 'Unassigned'}.",
                        route="/user-management",
                        route_params={"userId": u_id},
                        metadata={
                            "old_manager_id": previous_manager_id,
                            "new_manager_id": u_manager_id,
                            "old_manager_name": old_manager_name,
                            "new_manager_name": new_manager_name,
                        },
                    )
                )

            if previous_project_ids != u_project_ids:
                activity_events.append(
                    build_activity_event(
                        activity_type="USER_PROJECT_ACCESS_CHANGED",
                        visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                        tenant_id=u_tenant_id,
                        actor_user=current_user,
                        entity_type="user",
                        entity_id=u_id,
                        summary=f"{current_user.full_name} updated project access for {u_full_name}.",
                        route="/user-management",
                        route_params={"userId": u_id},
                        metadata={"old_project_ids": previous_project_ids, "new_project_ids": u_project_ids},
                    )
                )

        await record_activity_events(db, activity_events)

        # Re-fetch fresh (eager-loaded) so response serialization never touches an
        # expired relationship after the activity-log queries above.
        return await get_user_by_id(db, u_id)

    if user_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Use /users/me/password to update your password",
        )

    if current_user.role not in MANAGER_CHAIN_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied",
        )

    if user.role != UserRole.EMPLOYEE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Managers can only update employee project access",
        )

    managed_employee_ids = {employee.id for employee in await _get_managed_employees(db, current_user.id, current_user.tenant_id)}
    if user.id not in managed_employee_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied",
        )

    requested_update_fields = set(
        user_update.model_dump(exclude_unset=True).keys())
    if requested_update_fields - {"project_ids"}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Managers can only update employee project assignments",
        )

    restricted_update = UserUpdate(project_ids=user_update.project_ids or [])
    previous_project_ids = sorted(user.project_ids or [])

    try:
        updated_user = await update_user(db, user, restricted_update)
        activity_events: list[dict] = []
        next_project_ids = sorted(updated_user.project_ids or [])
        if previous_project_ids != next_project_ids and updated_user.tenant_id is not None:
            activity_events.append(
                build_activity_event(
                    activity_type="USER_PROJECT_ACCESS_CHANGED",
                    visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                    tenant_id=updated_user.tenant_id,
                    actor_user=current_user,
                    entity_type="user",
                    entity_id=updated_user.id,
                    summary=f"{current_user.full_name} updated project access for {updated_user.full_name}.",
                    route="/user-management",
                    route_params={"userId": updated_user.id},
                    metadata={"old_project_ids": previous_project_ids, "new_project_ids": next_project_ids},
                )
            )
        await record_activity_events(db, activity_events)
        return updated_user
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )


@router.delete("/{user_id:int}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user_endpoint(
    user_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> None:
    """Delete a user (Admin or PLATFORM_ADMIN only)."""
    user = await get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    require_same_tenant(user.tenant_id, current_user)

    deleted_user_name = user.full_name
    deleted_user_email = user.email
    deleted_user_role = user.role.value
    deleted_tenant_id = user.tenant_id

    success = await delete_user(db, user_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    await record_activity_events(db, [build_activity_event(
        activity_type="USER_DELETED",
        visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
        tenant_id=deleted_tenant_id,
        actor_user=current_user,
        entity_type="user",
        entity_id=user_id,
        summary=f"{current_user.full_name} deleted user {deleted_user_name} ({deleted_user_email}).",
        route="/user-management",
        metadata={"deleted_role": deleted_user_role, "deleted_email": deleted_user_email},
        severity="warning",
    )])


MAX_ALIASES_PER_USER = 2


class EmailAliasRead(PydanticBaseModel):
    id: int
    email: str
    created_at: datetime


class EmailAliasCreateRequest(PydanticBaseModel):
    email: str


def _normalize_email(value: str) -> str:
    return (value or "").strip().lower()


async def _apply_alias_emails(
    db: AsyncSession, user: User, candidate_emails: list[str]
) -> list[str]:
    """Add the given alias emails to ``user`` where it's safe to do so.

    Returns a list of human-readable warnings for aliases that were
    skipped because they collide with another user. The caller can
    fold these into the per-row ``warnings`` array so the admin
    importing the CSV sees what happened. Aliases that are already
    on this user (re-import) are a no-op and produce no warning.

    Used by the CSV import flow's create AND overwrite branches so
    extra_email columns work consistently in both shapes.

    Caller is responsible for the surrounding ``await db.commit()``
    so multiple aliases can be added in one transaction with the
    other row writes.
    """
    from app.crud.user import get_user_by_email as _crud_get_user_by_email
    from app.models.user_email_alias import UserEmailAlias

    warnings: list[str] = []
    if not candidate_emails:
        return warnings

    # Snapshot the user's existing aliases once to avoid an O(N^2)
    # query for re-imports of the same row.
    existing_aliases_q = await db.execute(
        select(UserEmailAlias.email).where(UserEmailAlias.user_id == user.id)
    )
    already_on_user = {row[0].lower() for row in existing_aliases_q.all()}

    for raw in candidate_emails:
        alias = _normalize_email(raw)
        if not alias:
            continue
        if alias == _normalize_email(user.email or ""):
            # The alias is the same as the user's primary email.
            # Silent no-op rather than a warning — this is usually
            # the CSV defaulting one extra-email column to the
            # primary, which the admin didn't mean.
            continue
        if alias in already_on_user:
            continue
        existing_owner = await _crud_get_user_by_email(db, alias)
        if existing_owner is not None and existing_owner.id != user.id:
            warnings.append(
                f"Skipped alias {alias!r}: belongs to another user in this tenant"
            )
            continue
        db.add(UserEmailAlias(user_id=user.id, email=alias))
        already_on_user.add(alias)

    return warnings


@router.get("/{user_id:int}/email-aliases", response_model=list[EmailAliasRead])
async def list_email_aliases(
    user_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> list[EmailAliasRead]:
    """Aliases on a user. Self or admin only; cross-tenant access denied."""
    from app.models.user_email_alias import UserEmailAlias

    target = await get_user_by_id(db, user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if user_id != current_user.id:
        if current_user.role not in (UserRole.ADMIN, UserRole.PLATFORM_ADMIN):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        require_same_tenant(target.tenant_id, current_user)

    result = await db.execute(
        select(UserEmailAlias)
        .where(UserEmailAlias.user_id == user_id)
        .order_by(UserEmailAlias.created_at.asc())
    )
    return [
        EmailAliasRead(id=row.id, email=row.email, created_at=row.created_at)
        for row in result.scalars().all()
    ]


@router.post(
    "/{user_id:int}/email-aliases",
    response_model=EmailAliasRead,
    status_code=status.HTTP_201_CREATED,
)
async def add_email_alias(
    user_id: int,
    body: EmailAliasCreateRequest,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> EmailAliasRead:
    """Add an alias email (admin-only). Capped at MAX_ALIASES_PER_USER."""
    from app.crud.user import get_user_by_email
    from app.models.user_email_alias import UserEmailAlias

    target = await get_user_by_id(db, user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    require_same_tenant(target.tenant_id, current_user)

    normalized = _normalize_email(body.email)
    if not normalized or "@" not in normalized:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid email address")

    if normalized == (target.email or "").lower():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Alias matches the user's primary email",
        )

    from sqlalchemy import func as sa_func
    existing_count = (await db.execute(
        select(sa_func.count(UserEmailAlias.id))
        .where(UserEmailAlias.user_id == user_id)
    )).scalar_one()
    if existing_count >= MAX_ALIASES_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"At most {MAX_ALIASES_PER_USER} alias emails per user",
        )

    # Refuse if any other user already owns this address (primary or alias).
    existing_user = await get_user_by_email(db, normalized)
    if existing_user is not None and existing_user.id != user_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already in use by another user",
        )

    alias = UserEmailAlias(user_id=user_id, email=normalized)
    db.add(alias)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already in use",
        )
    await db.refresh(alias)
    return EmailAliasRead(id=alias.id, email=alias.email, created_at=alias.created_at)


@router.delete(
    "/{user_id:int}/email-aliases/{alias_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_email_alias(
    user_id: int,
    alias_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> None:
    """Remove an alias (admin-only)."""
    from app.models.user_email_alias import UserEmailAlias

    target = await get_user_by_id(db, user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    require_same_tenant(target.tenant_id, current_user)

    result = await db.execute(
        select(UserEmailAlias).where(
            (UserEmailAlias.id == alias_id) & (UserEmailAlias.user_id == user_id)
        )
    )
    alias = result.scalar_one_or_none()
    if not alias:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alias not found")
    await db.delete(alias)
    await db.commit()


@router.get("/{user_id:int}/clients", response_model=list)
async def list_user_client_assignments(
    user_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> list:
    from app.crud.user_client_assignment import get_assignments_for_user
    target = await get_user_by_id(db, user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    require_same_tenant(target.tenant_id, current_user)
    return await get_assignments_for_user(db, user_id, current_user.tenant_id)


@router.post("/{user_id:int}/clients/{client_id}", status_code=status.HTTP_201_CREATED)
async def add_user_client_assignment(
    user_id: int,
    client_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> dict:
    from app.crud.user_client_assignment import add_assignment, get_assignments_for_user
    from app.models.client import Client
    target = await get_user_by_id(db, user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    require_same_tenant(target.tenant_id, current_user)
    client = await db.get(Client, client_id)
    if not client or client.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Client not found")
    result = await add_assignment(db, user_id, client_id, current_user.tenant_id)
    if result is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Assignment already exists")
    await db.commit()
    assignments = await get_assignments_for_user(db, user_id, current_user.tenant_id)
    return {"assignments": assignments}


@router.delete("/{user_id:int}/clients/{client_id}", status_code=status.HTTP_200_OK)
async def remove_user_client_assignment(
    user_id: int,
    client_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> dict:
    from app.crud.user_client_assignment import remove_assignment, get_assignments_for_user
    target = await get_user_by_id(db, user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    require_same_tenant(target.tenant_id, current_user)
    deleted = await remove_assignment(db, user_id, client_id, current_user.tenant_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Assignment not found")
    await db.commit()
    assignments = await get_assignments_for_user(db, user_id, current_user.tenant_id)
    return {"assignments": assignments}


@router.post("/import/preview", response_model=dict)
async def import_users_preview(
    file: UploadFile = File(...),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
    db: AsyncSession = Depends(get_tenant_db),
) -> dict:
    """Parse an uploaded CSV/XLSX file and return headers + preview rows.

    No DB writes. The frontend uses this to render the column-mapping step.
    """
    from app.services.user_import import parse_file

    content = await file.read()
    try:
        headers, rows = parse_file(file.filename or "upload.csv", content)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    preview_rows = [
        {headers[i]: (row[i] if i < len(row) else "") for i in range(len(headers))}
        for row in rows[:5]
    ]

    return {
        "headers": headers,
        "preview_rows": preview_rows,
        "total_rows": len(rows),
        "all_rows": rows,
    }


class ImportValidateBody(PydanticBaseModel):
    mapping: dict[str, str]
    rows: list[list[str]]
    headers: list[str]


@router.post("/import/validate", response_model=dict)
async def import_users_validate(
    body: ImportValidateBody,
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
    db: AsyncSession = Depends(get_tenant_db),
) -> dict:
    """Classify all rows as new / exact_match / conflict / error.

    No DB writes. Called after column mapping so the frontend can show a
    conflict-resolution step before the final commit.
    """
    from app.services.user_import import apply_mapping, validate_row

    tenant_id = current_user.tenant_id
    existing_users_result = await db.execute(
        select(User.email, User.full_name, User.id).where(User.tenant_id == tenant_id)
    )
    existing_rows = existing_users_result.all()
    existing_emails: set[str] = {r.email.lower() for r in existing_rows if r.email}
    existing_email_to_name: dict[str, str] = {
        r.email.lower(): r.full_name for r in existing_rows if r.email and r.full_name
    }
    existing_name_to_id: dict[str, int] = {
        r.full_name.strip().lower(): r.id for r in existing_rows if r.full_name
    }

    records = apply_mapping(body.headers, body.rows, body.mapping)
    seen_emails: set[str] = set()
    validated_rows = []
    for idx, record in enumerate(records):
        v = validate_row(record, idx + 1, existing_emails, seen_emails, existing_email_to_name, existing_name_to_id)
        validated_rows.append(v)

    counts = {"new": 0, "exact_match": 0, "conflict": 0, "error": 0, "duplicate_in_file": 0}
    for v in validated_rows:
        counts[v["status"]] = counts.get(v["status"], 0) + 1

    return {"rows": validated_rows, "counts": counts}


class ImportCommitBody(PydanticBaseModel):
    mapping: dict[str, str]
    rows: list[list[str]]
    headers: list[str]
    user_type: str = "external"          # "external" | "internal"
    default_client_id: int | None = None
    default_project_id: int | None = None
    default_manager_id: int | None = None
    # Per-row conflict resolutions decided by the reviewer in the frontend.
    # Key = 1-based row index (str), value = "overwrite" | "skip".
    conflict_resolutions: dict[str, str] = {}


@router.post("/import/commit", response_model=dict)
async def import_users_commit(
    body: ImportCommitBody,
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
    db: AsyncSession = Depends(get_tenant_db),
) -> dict:
    """Commit a mapped + validated import batch.

    Each row is created independently; per-row errors are collected and
    returned without aborting the remaining rows.

    Batch-level defaults (user_type, default_client_id, default_project_id,
    default_manager_id) apply to every row unless that row's mapped columns
    provide a value. Per-row values always win.
    """
    from app.services.user_import import (
        apply_mapping, validate_row,
        resolve_client_id, resolve_project_id, resolve_manager_id,
    )
    from app.schemas import UserCreate
    from app.crud.user import create_user as crud_create_user, get_user_by_email
    from app.models.user_email_alias import UserEmailAlias
    from app.models.user import UserRole as _UserRole
    from app.models.client import Client as _Client, ClientType as _ClientType

    tenant_id = current_user.tenant_id

    # Per-import cache + audit list of clients we auto-create when an
    # imported row names a client that doesn't exist in the target
    # tenant. We default new clients to ``external`` (the common case
    # for contractor employers); admins can re-type them after import.
    # Keyed by lower-cased name so two rows naming the same client in
    # different cases coalesce into one new row.
    auto_created_clients: dict[str, int] = {}
    auto_created_client_names: list[str] = []

    async def _ensure_client_id(name: str) -> int | None:
        if not name:
            return None
        existing = await resolve_client_id(db, name, tenant_id)
        if existing is not None:
            return existing
        cache_key = name.strip().lower()
        if cache_key in auto_created_clients:
            return auto_created_clients[cache_key]
        client = _Client(
            tenant_id=tenant_id,
            name=name.strip(),
            client_type=_ClientType.external,
        )
        db.add(client)
        try:
            await db.flush()
        except Exception:
            # Race / unique-constraint collision: another concurrent
            # request created the client between our resolve and insert.
            # Roll back the partial flush and re-resolve.
            await db.rollback()
            existing = await resolve_client_id(db, name, tenant_id)
            if existing is not None:
                auto_created_clients[cache_key] = existing
            return existing
        auto_created_clients[cache_key] = client.id
        auto_created_client_names.append(client.name)
        return client.id
    is_external_default = body.user_type != "internal"

    existing_users_result = await db.execute(
        select(User.email, User.full_name, User.id).where(User.tenant_id == tenant_id)
    )
    existing_rows = existing_users_result.all()
    existing_emails: set[str] = {r.email.lower() for r in existing_rows if r.email}
    existing_email_to_name: dict[str, str] = {
        r.email.lower(): r.full_name for r in existing_rows if r.email and r.full_name
    }
    existing_email_to_id: dict[str, int] = {
        r.email.lower(): r.id for r in existing_rows if r.email
    }
    existing_name_to_id: dict[str, int] = {
        r.full_name.strip().lower(): r.id for r in existing_rows if r.full_name
    }

    records = apply_mapping(body.headers, body.rows, body.mapping)

    created: list[dict] = []
    updated: list[dict] = []
    skipped: list[dict] = []
    seen_emails: set[str] = set()

    for idx, record in enumerate(records):
        row_num = idx + 1
        validated = validate_row(record, row_num, existing_emails, seen_emails, existing_email_to_name, existing_name_to_id)
        row_status = validated["status"]

        if row_status == "error":
            skipped.append({"row": row_num, "reason": "; ".join(validated["errors"])})
            continue

        if row_status == "duplicate_in_file":
            skipped.append({"row": row_num, "reason": "; ".join(validated["errors"])})
            continue

        if row_status == "exact_match":
            # Name and email already match exactly — silently skip, nothing to do.
            skipped.append({"row": row_num, "reason": f"Already exists (exact match): {validated['email']}"})
            continue

        full_name = validated["full_name"]
        if not full_name:
            skipped.append({"row": row_num, "reason": "Full name is required"})
            continue

        # Auto-create the client if the row names one that doesn't
        # exist in this tenant yet. Keeps fresh-tenant rollouts a
        # single-step process — import the user roster and the client
        # directory comes along for the ride.
        row_client = await _ensure_client_id(validated["client"]) if (tenant_id and validated["client"]) else None
        row_project = await resolve_project_id(db, validated["project"], tenant_id) if (tenant_id and validated["project"]) else None
        row_manager = await resolve_manager_id(db, validated["manager"], tenant_id) if (tenant_id and validated["manager"]) else None

        client_id = row_client if row_client is not None else body.default_client_id
        project_id = row_project if row_project is not None else body.default_project_id
        manager_id = row_manager if row_manager is not None else body.default_manager_id

        if row_status == "conflict":
            resolution = body.conflict_resolutions.get(str(row_num), "skip")
            if resolution != "overwrite":
                skipped.append({"row": row_num, "reason": f"Conflict kept (not overwritten): {validated['email']}"})
                continue
            # Overwrite: update the existing user's name and other fields.
            existing_user_id = (
                existing_email_to_id.get(validated["email"])
                or validated.get("existing_user_id")
            )
            if existing_user_id is None:
                skipped.append({"row": row_num, "reason": f"Could not locate existing user for overwrite: {validated['email']}"})
                continue
            try:
                existing_user = await db.get(User, existing_user_id)
                if existing_user is None:
                    skipped.append({"row": row_num, "reason": f"Could not load existing user for overwrite: {validated['email']}"})
                    continue
                existing_user.full_name = full_name
                existing_user.title = validated["title"] or None
                existing_user.department = validated["department"] or None
                existing_user.role = _UserRole(validated["role"])
                existing_user.is_active = validated["is_active"]
                existing_user.default_client_id = client_id
                await db.commit()
            except Exception as exc:
                await db.rollback()
                skipped.append({"row": row_num, "reason": f"Update failed: {exc}"})
                continue
            # Apply any extra emails from the row to the updated user.
            # Pre-fix, the overwrite branch silently dropped aliases —
            # so re-importing a roster to add new alias columns never
            # worked. _apply_alias_emails warns instead of failing on
            # collisions so the import doesn't abort mid-batch.
            alias_warnings = await _apply_alias_emails(
                db, existing_user, validated["extra_emails"]
            )
            if alias_warnings:
                validated["warnings"] = (validated["warnings"] or []) + alias_warnings
                try:
                    await db.commit()
                except Exception:
                    await db.rollback()
            updated.append({"row": row_num, "user_id": existing_user_id, "full_name": full_name, "warnings": validated["warnings"]})
            continue

        # row_status == "new": create
        try:
            user_create = UserCreate(
                full_name=full_name,
                is_external=is_external_default,
                email=validated["email"] or None,
                title=validated["title"] or None,
                department=validated["department"] or None,
                role=_UserRole(validated["role"]),
                is_active=validated["is_active"],
                manager_id=manager_id,
                project_ids=[project_id] if project_id else [],
                default_client_id=client_id,
                phones=validated["phones"],
                tenant_id=tenant_id,
            )
            # CSV imports skip Auth0 provisioning — the per-row
            # round-trip would multiply the import time by 10x, and the
            # bulk-import script is the proper path for retro-fitting
            # Auth0 records to existing local users.
            user, _, _ = await crud_create_user(db, user_create, provision_auth0=False)
        except Exception as exc:
            # Boil down the database / SQLAlchemy exception to a single
            # short sentence the admin can act on. The full traceback
            # still gets logged server-side so we don't lose debug info.
            import logging as _logging
            from sqlalchemy.exc import IntegrityError as _IntegrityError
            _logging.getLogger(__name__).warning(
                "Import row %s skipped: %s", row_num, exc, exc_info=True,
            )
            exc_str = str(exc)
            if isinstance(exc, _IntegrityError):
                if "uq_users_tenant_email" in exc_str or "users_email" in exc_str:
                    reason = "Email already exists in this tenant."
                elif "uq_users_tenant_username" in exc_str or "users_username" in exc_str:
                    reason = "Username already in use."
                else:
                    reason = "Database constraint violation."
            else:
                reason = "Could not create user. Check the row's values and try again."
            skipped.append({"row": row_num, "reason": reason})
            continue

        alias_warnings = await _apply_alias_emails(db, user, validated["extra_emails"])
        if alias_warnings:
            validated["warnings"] = (validated["warnings"] or []) + alias_warnings
        try:
            await db.commit()
        except Exception:
            await db.rollback()

        if validated["email"]:
            existing_emails.add(validated["email"])

        created.append({
            "row": row_num,
            "user_id": user.id,
            "full_name": user.full_name,
            "warnings": validated["warnings"],
        })

    # Make sure newly-created clients are committed even if the last
    # row of the loop didn't trigger a commit (e.g. it ended in
    # ``continue``). ``rollback()`` only fires on per-row exceptions; the
    # standard happy-path commit lives inside the loop, so a trailing
    # auto-created client could otherwise be flushed but uncommitted.
    if auto_created_client_names:
        try:
            await db.commit()
        except Exception:
            await db.rollback()

    return {
        "created": len(created),
        "updated": len(updated),
        "skipped": len(skipped),
        "details": {"created": created, "updated": updated, "skipped": skipped},
        "new_clients": auto_created_client_names,
    }


# ---------------------------------------------------------------------------
# Export endpoints (ADMIN only)
# ---------------------------------------------------------------------------

def _export_response(
    content: bytes,
    mime: str,
    filename: str,
) -> Response:
    return Response(
        content=content,
        media_type=mime,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/export/users")
async def export_users_endpoint(
    fmt: str = Query("csv", regex="^(csv|xlsx)$"),
    user_type: str = Query("all", regex="^(all|internal|external)$"),
    role: str | None = Query(None),
    status_filter: str = Query("all", regex="^(all|active|inactive)$"),
    client_id: int | None = Query(None),
    department: str | None = Query(None),
    current_user: User = Depends(require_role("ADMIN")),
    db: AsyncSession = Depends(get_tenant_db),
) -> Response:
    from app.services.admin_export import export_users, serialize

    if not current_user.tenant_id:
        raise HTTPException(status_code=400, detail="Tenant scope required")

    headers, rows = await export_users(
        db,
        current_user.tenant_id,
        user_type=user_type,
        role=role,
        status_filter=status_filter,
        client_id=client_id,
        department=department,
    )
    content, mime, ext = serialize(headers, rows, fmt, sheet_name="Users")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    filename = f"users-{stamp}.{ext}"
    return _export_response(content, mime, filename)


@router.get("/export/clients")
async def export_clients_endpoint(
    fmt: str = Query("csv", regex="^(csv|xlsx)$"),
    current_user: User = Depends(require_role("ADMIN")),
    db: AsyncSession = Depends(get_tenant_db),
) -> Response:
    from app.services.admin_export import export_clients, serialize

    if not current_user.tenant_id:
        raise HTTPException(status_code=400, detail="Tenant scope required")

    headers, rows = await export_clients(db, current_user.tenant_id)
    content, mime, ext = serialize(headers, rows, fmt, sheet_name="Clients")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    filename = f"clients-{stamp}.{ext}"
    return _export_response(content, mime, filename)


@router.get("/export/timesheets")
async def export_timesheets_endpoint(
    period_start: date = Query(...),
    period_end: date = Query(...),
    fmt: str = Query("csv", regex="^(csv|xlsx)$"),
    user_type: str = Query("all", regex="^(all|internal|external)$"),
    user_id: int | None = Query(None),
    client_id: int | None = Query(None),
    project_id: int | None = Query(None),
    current_user: User = Depends(require_role("ADMIN")),
    db: AsyncSession = Depends(get_tenant_db),
) -> Response:
    from app.services.admin_export import export_approved_timesheets, serialize

    if not current_user.tenant_id:
        raise HTTPException(status_code=400, detail="Tenant scope required")
    if period_end < period_start:
        raise HTTPException(status_code=400, detail="period_end must be on or after period_start")

    headers, rows = await export_approved_timesheets(
        db,
        current_user.tenant_id,
        period_start=period_start,
        period_end=period_end,
        user_type=user_type,
        user_id=user_id,
        client_id=client_id,
        project_id=project_id,
    )
    content, mime, ext = serialize(headers, rows, fmt, sheet_name="Timesheets")
    filename = f"approved-timesheets-{period_start.isoformat()}-to-{period_end.isoformat()}.{ext}"
    return _export_response(content, mime, filename)


@router.post("/users/{user_id}/unlock-timesheet", response_model=dict)
async def unlock_user_timesheet(
    user_id: int,
    current_user: User = Depends(require_role("ADMIN")),
    db: AsyncSession = Depends(get_tenant_db),
) -> dict:
    """Admin manually unlocks a user's timesheet."""
    result = await db.execute(select(User).where(
        (User.id == user_id) & (User.tenant_id == current_user.tenant_id)
    ))
    target_user = result.scalar_one_or_none()
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")
    target_user.timesheet_locked = False
    target_user.timesheet_locked_reason = None
    await db.commit()
    return {"success": True, "user_id": user_id}
