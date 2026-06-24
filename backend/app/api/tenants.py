import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, get_db, get_tenant_db, require_role
from app.core.security import generate_service_token, get_password_hash, hash_service_token
from app.crud.tenant import create_tenant, get_tenant, get_tenant_by_slug, list_tenants, update_tenant
from app.db_control import AsyncControlSessionLocal
from app.models.control.platform_audit import PlatformAuditCategory, PlatformAuditSeverity
from app.models.service_token import ServiceToken
from app.schemas import (
    TenantAdminCreate,
    TenantCreate,
    TenantResponse,
    TenantUpdate,
    TenantFeaturesResponse,
    TenantFeaturesUpdate,
    TenantLifecycleAction,
    TenantLifecycleRequest,
)
from app.schemas.sync import ServiceTokenCreate, ServiceTokenRead, ServiceTokenCreatedResponse
from app.models.user import User, UserRole
from app.services.activity import (
    PLATFORM_ADMIN_ACTIVITY_SCOPE,
    build_activity_event,
    record_activity_events,
)
from app.services.platform_audit import record_platform_audit_event

router = APIRouter(prefix="/tenants", tags=["tenants"])


async def _seed_tenant_admin(
    *, tenant, full_name: str, email: str, actor: User
) -> dict:
    """Create an ADMIN user in a tenant's own database and email a set-password
    invite. Routes to the per-tenant DB (isolated) or the legacy shared DB
    automatically via ``tenant_session(slug)``. Returns a small status dict.

    Platform admins have no tenant of their own, so this can't reuse the
    request's ``get_db`` session — we open a tenant-scoped session for the
    TARGET tenant and create the admin there. Used by both tenant-create
    (optional first admin) and the standalone add-admin endpoint.
    """
    from app.db_tenant import tenant_session
    from app.crud.user import create_user, get_user_by_email
    from app.schemas import UserCreate
    from app.services.password_invite import issue_invite_token, build_set_password_url
    from app.services.email_verification import send_local_invitation_email
    from app.api.platform_settings import get_effective_smtp_config

    async with tenant_session(tenant.slug) as tdb:
        existing = await get_user_by_email(tdb, email)
        if existing is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"{email} already belongs to a user in this tenant.",
            )
        uc = UserCreate(
            full_name=full_name,
            email=email,
            role=UserRole.ADMIN,
            is_external=False,
            is_active=True,
            tenant_id=tenant.id,
        )
        new_admin, _temp_pw, auth0_url = await create_user(tdb, uc)
        await tdb.commit()

        # Email the set-password invite (best-effort: the admin exists even if
        # the email fails — it can be resent).
        invited = False
        try:
            token = await issue_invite_token(tdb, new_admin, purpose="invite")
            await tdb.commit()
            invite_url = auth0_url or build_set_password_url(token, purpose="invite")
            smtp_config = await get_effective_smtp_config(tdb)
            await send_local_invitation_email(
                new_admin, invite_url, smtp_config, tenant.name, tenant.id
            )
            invited = True
        except Exception:  # noqa: BLE001 — invite email is best-effort
            invited = False

        return {"id": new_admin.id, "email": email, "invited": invited}


@router.get("/mine", response_model=TenantResponse)
async def get_my_tenant(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Get the current user's own tenant. Any authenticated user can call this.

    Routes through ``get_tenant_db`` (NOT ``get_db``) so isolated tenants
    read from their own per-tenant DB. Otherwise we read from the legacy
    shared ``timesheet_db`` and miss anything written by per-tenant
    handlers (e.g. ``POST /admin/tenant/logo`` writes the logo into the
    per-tenant DB, so a ``get_db``-routed read here would return
    ``has_logo: false`` for a tenant that does have a logo).

    Conditional GET: returns 304 when the client's If-None-Match
    matches the current ETag. See app.core.etag for the contract.
    """
    from app.core.etag import respond_with_etag

    if not current_user.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No tenant assigned")
    tenant = await get_tenant(db, current_user.tenant_id)
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")
    # Populate the branding fields by deriving has_logo from the storage
    # key (so we never leak the internal path). Default-False on
    # TenantResponse covers every other call site that returns this
    # schema without going through this handler.
    payload = TenantResponse.model_validate(tenant)
    payload.has_logo = bool(getattr(tenant, "logo_storage_key", None))
    payload.logo_mime_type = getattr(tenant, "logo_mime_type", None)
    return respond_with_etag(request, response, payload.model_dump(mode="json"))


@router.get("", response_model=list[TenantResponse])
async def list_all_tenants(
    db: AsyncSession = Depends(get_db),
    include_archived: bool = False,
    _: object = Depends(require_role("PLATFORM_ADMIN")),
) -> list:
    """List all tenants (PLATFORM_ADMIN only).

    Archived tenants (soft-deleted via the Advanced tab "Delete tenant"
    action) are excluded by default. Pass ``?include_archived=true`` to
    see them - useful for audit forensics. The Advanced UI hides
    archived tenants entirely; surface them through a separate
    "show archived" toggle on the list page if/when that's needed.
    """
    tenants = await list_tenants(db)
    if include_archived:
        return tenants
    # Filter against the control-plane is_archived flag. Tenants not
    # mirrored in the control plane (legacy / half-provisioned) are
    # treated as not-archived.
    from app.models.control import ControlTenant
    from app.db_control import AsyncControlSessionLocal as ControlSession

    archived_ids: set[int] = set()
    try:
        async with ControlSession() as control_db:
            rows = await control_db.execute(
                select(ControlTenant.id).where(ControlTenant.is_archived.is_(True))
            )
            archived_ids = {row[0] for row in rows.all()}
    except Exception:  # noqa: BLE001 - control DB unreachable, fail open
        # If we can't reach the control plane, return the unfiltered
        # list rather than 500 the whole page. The Advanced tab won't
        # be reachable in this state anyway.
        return tenants
    return [t for t in tenants if t.id not in archived_ids]


@router.post("", response_model=TenantResponse, status_code=status.HTTP_201_CREATED)
async def create_new_tenant(
    tenant_in: TenantCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role("PLATFORM_ADMIN")),
) -> object:
    """Create a new tenant (PLATFORM_ADMIN only)."""
    existing = await get_tenant_by_slug(db, tenant_in.slug)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Slug already in use",
        )
    tenant = await create_tenant(db, tenant_in.name, tenant_in.slug)

    # Mirror the new tenant into the control plane immediately. The
    # tenant_features + tenant_provisioning_jobs tables (and several
    # other control-plane reads) FK into ``acufy_control.tenants``, so
    # a legacy-only insert leaves the tenant in a half-registered state
    # where feature-flag PATCHes fail with a ForeignKeyViolationError.
    # If this mirror write fails the whole create rolls back — better
    # to refuse the create than to ship a broken tenant.
    from app.models.control import ControlTenant
    from app.models.control.tenant import ControlTenantStatus
    async with AsyncControlSessionLocal() as control_db:
        existing_control = (
            await control_db.execute(
                select(ControlTenant).where(ControlTenant.id == tenant.id)
            )
        ).scalar_one_or_none()
        if existing_control is None:
            control_db.add(ControlTenant(
                id=tenant.id,
                name=tenant.name,
                slug=tenant.slug,
                status=ControlTenantStatus(tenant.status.value),
                ingestion_enabled=bool(tenant.ingestion_enabled),
                max_mailboxes=tenant.max_mailboxes,
                timezone=tenant.timezone,
            ))
            # Keep the control-plane sequence ahead of the inserted id
            # so future autoincrement creates don't collide with the
            # legacy ids we're mirroring here.
            from sqlalchemy import text as _sa_text
            await control_db.execute(_sa_text(
                "SELECT setval('tenants_id_seq', GREATEST((SELECT COALESCE(MAX(id), 0) FROM tenants), :new_id))"
            ), {"new_id": tenant.id})
            await control_db.commit()

    # Optional inline isolation. Only safe at onboarding because the
    # per-tenant DB is empty — there's nothing to migrate. If this
    # fails we leave the legacy + control rows in place (non-isolated)
    # so the admin can retry via the provisioning script.
    if tenant_in.is_isolated:
        from app.db_tenant import dispose_for_slug
        from app.services.tenant_provisioning import (
            ProvisionError,
            provision_tenant_db,
        )

        async with AsyncControlSessionLocal() as control_db:
            control_row = (
                await control_db.execute(
                    select(ControlTenant).where(ControlTenant.id == tenant.id)
                )
            ).scalar_one()
            try:
                result = await provision_tenant_db(control_db, control_row)
            except ProvisionError as exc:
                # ProvisioningJob row is already marked failed by the
                # service. Surface a 500 so the admin sees the
                # actionable detail and can re-run the script.
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=(
                        f"Tenant created but isolation provisioning failed: {exc}. "
                        f"Re-run scripts/provision_tenant_db.py {tenant.slug} "
                        "and flip is_isolated manually once it succeeds."
                    ),
                ) from exc
            # Only flip the flag after provision succeeds AND the
            # connection details are persisted. The service already
            # wrote db_name/host/port onto control_row in the same
            # session; we just set is_isolated and commit.
            control_row.is_isolated = True
            control_db.add(control_row)
            await control_db.commit()

        # Drop any cached engine for this slug so the next request
        # routes to the new isolated DB. For a freshly-created tenant
        # there's nothing cached yet, but call defensively in case a
        # prior request resolved the slug while it was still legacy.
        await dispose_for_slug(tenant.slug)

    # Platform admins aren't in the per-tenant users table, so pass
    # actor_user=None to keep the activity_log FK happy. The PA's name
    # is still captured via actor_name_override for audit context.
    await record_activity_events(
        db,
        [
            build_activity_event(
                activity_type="TENANT_CREATED",
                visibility_scope=PLATFORM_ADMIN_ACTIVITY_SCOPE,
                tenant_id=tenant.id,
                actor_user=None,
                actor_name_override=current_user.full_name,
                entity_type="tenant",
                entity_id=tenant.id,
                summary=f"{current_user.full_name} created tenant {tenant.name}.",
                route="/platform-admin",
                route_params={"tenantId": tenant.id},
                metadata={"tenant_name": tenant.name, "status": tenant.status.value},
            )
        ],
    )

    # Control-plane audit event. Separate DB session because the
    # platform_audit_events table lives in acufy_control. Helper is
    # best-effort so a write failure here never blocks tenant creation.
    async with AsyncControlSessionLocal() as control_db:
        await record_platform_audit_event(
            control_db,
            category=PlatformAuditCategory.tenant,
            event="tenant.created",
            summary=f"Tenant {tenant.name} provisioned",
            actor=current_user,
            severity=PlatformAuditSeverity.info,
            tenant_id=tenant.id,
            tenant_slug=tenant.slug,
            tenant_name=tenant.name,
            after_state={
                "id": tenant.id,
                "name": tenant.name,
                "slug": tenant.slug,
                "status": tenant.status.value,
            },
            request=request,
        )
        await control_db.commit()

    # Optional first admin. Created in the tenant's own DB (isolated or shared)
    # and emailed a set-password invite. Best-effort: a failure here does NOT
    # roll back the tenant (it already exists + is provisioned) — the PA can add
    # an admin afterward via the add-admin endpoint.
    if tenant_in.admin_full_name and tenant_in.admin_email:
        try:
            await _seed_tenant_admin(
                tenant=tenant,
                full_name=tenant_in.admin_full_name,
                email=str(tenant_in.admin_email),
                actor=current_user,
            )
        except HTTPException:
            raise
        except Exception:  # noqa: BLE001 — never block tenant create on admin seed
            pass

    return tenant


@router.post("/{tenant_id}/admins", status_code=status.HTTP_201_CREATED)
async def add_tenant_admin_endpoint(
    tenant_id: int,
    payload: TenantAdminCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role("PLATFORM_ADMIN")),
):
    """Add an ADMIN to an existing tenant (PLATFORM_ADMIN only) and email a
    set-password invite."""
    tenant = await get_tenant(db, tenant_id)
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")
    result = await _seed_tenant_admin(
        tenant=tenant,
        full_name=payload.full_name,
        email=str(payload.email),
        actor=current_user,
    )
    return result


@router.get("/{tenant_id}", response_model=TenantResponse)
async def get_tenant_endpoint(
    tenant_id: int,
    db: AsyncSession = Depends(get_db),
    _: object = Depends(require_role("PLATFORM_ADMIN")),
) -> object:
    """Get a specific tenant (PLATFORM_ADMIN only)."""
    tenant = await get_tenant(db, tenant_id)
    if not tenant:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tenant not found",
        )
    return tenant


@router.patch("/{tenant_id}", response_model=TenantResponse)
async def update_tenant_endpoint(
    tenant_id: int,
    tenant_in: TenantUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role("PLATFORM_ADMIN")),
) -> object:
    """Update a tenant (PLATFORM_ADMIN only)."""
    tenant = await get_tenant(db, tenant_id)
    if not tenant:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tenant not found",
        )
    previous_name = tenant.name
    previous_slug = tenant.slug
    previous_status = tenant.status
    previous_ingestion = tenant.ingestion_enabled
    updated_tenant = await update_tenant(db, tenant, **tenant_in.model_dump(exclude_unset=True))

    # Mirror name / slug / status / ingestion_enabled into the control
    # plane so the two tenant rows don't drift. tenant_features and
    # other control-plane FKs depend on the row being there; readers
    # (login routing, the platform dashboard, audit pages) read from
    # the control plane directly. Without this mirror, an Overview-tab
    # status flip never reaches the control plane and the platform
    # dashboard would show the stale value.
    if (
        previous_name != updated_tenant.name
        or previous_slug != updated_tenant.slug
        or previous_status != updated_tenant.status
        or previous_ingestion != updated_tenant.ingestion_enabled
    ):
        from app.models.control import ControlTenant
        from app.models.control.tenant import ControlTenantStatus
        async with AsyncControlSessionLocal() as control_db:
            ctrl = (
                await control_db.execute(
                    select(ControlTenant).where(ControlTenant.id == updated_tenant.id)
                )
            ).scalar_one_or_none()
            if ctrl is None:
                # Tenant was never registered in the control plane (legacy
                # data). Backfill it now so the FK can resolve for any
                # downstream feature-flag / provisioning writes.
                control_db.add(ControlTenant(
                    id=updated_tenant.id,
                    name=updated_tenant.name,
                    slug=updated_tenant.slug,
                    status=ControlTenantStatus(updated_tenant.status.value),
                    ingestion_enabled=bool(updated_tenant.ingestion_enabled),
                    max_mailboxes=updated_tenant.max_mailboxes,
                    timezone=updated_tenant.timezone,
                ))
            else:
                ctrl.name = updated_tenant.name
                ctrl.slug = updated_tenant.slug
                ctrl.status = ControlTenantStatus(updated_tenant.status.value)
                ctrl.ingestion_enabled = bool(updated_tenant.ingestion_enabled)
            await control_db.commit()

    activity_events: list[dict] = []
    if previous_status != updated_tenant.status:
        activity_events.append(
            build_activity_event(
                activity_type="TENANT_STATUS_CHANGED",
                visibility_scope=PLATFORM_ADMIN_ACTIVITY_SCOPE,
                tenant_id=updated_tenant.id,
                actor_user=current_user,
                entity_type="tenant",
                entity_id=updated_tenant.id,
                summary=f"{current_user.full_name} changed {updated_tenant.name} from {previous_status.value} to {updated_tenant.status.value}.",
                route="/platform-admin",
                route_params={"tenantId": updated_tenant.id},
                metadata={"old_status": previous_status.value, "new_status": updated_tenant.status.value},
            )
        )

    if previous_name != updated_tenant.name or previous_slug != updated_tenant.slug:
        activity_events.append(
            build_activity_event(
                activity_type="TENANT_UPDATED",
                visibility_scope=PLATFORM_ADMIN_ACTIVITY_SCOPE,
                tenant_id=updated_tenant.id,
                actor_user=current_user,
                entity_type="tenant",
                entity_id=updated_tenant.id,
                summary=f"{current_user.full_name} updated tenant {previous_name}.",
                route="/platform-admin",
                route_params={"tenantId": updated_tenant.id},
                metadata={
                    "old_name": previous_name,
                    "new_name": updated_tenant.name,
                    "old_slug": previous_slug,
                    "new_slug": updated_tenant.slug,
                },
            )
        )

    await record_activity_events(db, activity_events)

    # Mirror status / name / slug changes into the platform audit log.
    # Two parallel events so the audit page can filter by sub-event.
    if previous_status != updated_tenant.status or previous_name != updated_tenant.name or previous_slug != updated_tenant.slug:
        async with AsyncControlSessionLocal() as control_db:
            if previous_status != updated_tenant.status:
                await record_platform_audit_event(
                    control_db,
                    category=PlatformAuditCategory.tenant,
                    event="tenant.status_changed",
                    summary=(
                        f"{updated_tenant.name} status "
                        f"{previous_status.value} -> {updated_tenant.status.value}"
                    ),
                    actor=current_user,
                    severity=PlatformAuditSeverity.warn
                    if updated_tenant.status.value == "suspended"
                    else PlatformAuditSeverity.info,
                    tenant_id=updated_tenant.id,
                    tenant_slug=updated_tenant.slug,
                    tenant_name=updated_tenant.name,
                    before_state={"status": previous_status.value},
                    after_state={"status": updated_tenant.status.value},
                    request=request,
                )
            if previous_name != updated_tenant.name or previous_slug != updated_tenant.slug:
                await record_platform_audit_event(
                    control_db,
                    category=PlatformAuditCategory.tenant,
                    event="tenant.updated",
                    summary=f"Tenant {previous_name} edited",
                    actor=current_user,
                    tenant_id=updated_tenant.id,
                    tenant_slug=updated_tenant.slug,
                    tenant_name=updated_tenant.name,
                    before_state={
                        "name": previous_name,
                        "slug": previous_slug,
                    },
                    after_state={
                        "name": updated_tenant.name,
                        "slug": updated_tenant.slug,
                    },
                    request=request,
                )
            await control_db.commit()

    return updated_tenant


# ── Lifecycle endpoint (Advanced tab) ─────────────────────────────────
#
# Mark inactive / suspend / resume / delete actions, gated by the
# operator typing the tenant name. The typed value is re-validated
# server-side (defense in depth - frontend gate alone isn't trustworthy)
# and recorded in the audit log payload as proof of intent.

_LIFECYCLE_REQUIRES_TYPED_NAME = {
    TenantLifecycleAction.mark_inactive,
    TenantLifecycleAction.suspend,
    TenantLifecycleAction.delete,
}


@router.post("/{tenant_id}/lifecycle", response_model=TenantResponse)
async def update_tenant_lifecycle(
    tenant_id: int,
    body: TenantLifecycleRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role("PLATFORM_ADMIN")),
) -> object:
    """Apply a destructive lifecycle action to a tenant.

    Distinct from PATCH so the typed-name confirmation gate has a
    dedicated, audit-rich code path. Status changes coming through PATCH
    (legacy edit modal) still work, but the new Advanced tab routes
    everything here.

    Audit: one PlatformAuditEvent per call with before/after state and
    the typed confirmation in the payload. Tenant admins also see a
    matching activity_log entry through the existing tenant-scoped
    audit mechanism.
    """
    from app.models.control import ControlTenant
    from app.db_control import AsyncControlSessionLocal as ControlSession

    tenant = await get_tenant(db, tenant_id)
    if not tenant:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tenant not found",
        )

    # Re-validate the typed token server-side. Comparing trimmed
    # values so a trailing space in the input doesn't trip a user
    # who clearly typed it correctly.
    if body.action in _LIFECYCLE_REQUIRES_TYPED_NAME:
        typed = (body.confirmation_token or "").strip()
        if typed != tenant.name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Confirmation token does not match tenant name. "
                    "Type the exact tenant name to proceed."
                ),
            )

    previous_status = tenant.status
    previous_is_archived: bool | None = None

    # Map action -> status flip + archive flag.
    if body.action == TenantLifecycleAction.mark_inactive:
        new_status_value = "inactive"
        new_is_archived = False
        verb = "marked inactive"
        severity = PlatformAuditSeverity.info
    elif body.action == TenantLifecycleAction.suspend:
        new_status_value = "suspended"
        new_is_archived = False
        verb = "suspended"
        severity = PlatformAuditSeverity.warn
    elif body.action == TenantLifecycleAction.resume:
        new_status_value = "active"
        new_is_archived = False
        verb = "resumed"
        severity = PlatformAuditSeverity.info
    elif body.action == TenantLifecycleAction.delete:
        new_status_value = "suspended"
        new_is_archived = True
        verb = "deleted (archived)"
        severity = PlatformAuditSeverity.critical
    else:  # pragma: no cover - schema enforces enum
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported lifecycle action: {body.action}",
        )

    # Resume on an archived tenant would defeat the soft-delete; reject.
    # Tested via the control-plane row, not the legacy mirror, since the
    # legacy row doesn't carry is_archived.
    async with ControlSession() as control_db_read:
        control_row = await control_db_read.get(ControlTenant, tenant_id)
        if control_row is not None:
            previous_is_archived = control_row.is_archived
            if body.action == TenantLifecycleAction.resume and control_row.is_archived:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        "Tenant is archived. Resume is not available; "
                        "an archived tenant must be unarchived manually."
                    ),
                )

    # Apply to the legacy tenants table (the source of truth for status
    # via SQLAlchemy ORM).
    updated_tenant = await update_tenant(db, tenant, status=new_status_value)

    # Mirror archive flag into the control plane. Status is mirrored by
    # the existing update_tenant pathway via the cross-DB hooks.
    archive_changed = False
    async with ControlSession() as control_db:
        control_row = await control_db.get(ControlTenant, tenant_id)
        if control_row is not None:
            # Mirror status (control row may lag legacy on existing tenants
            # because not all status flips have been written to both yet;
            # tightening this is a separate concern).
            try:
                control_row.status = control_row.status.__class__(new_status_value)
            except (ValueError, KeyError):
                # Best-effort; if the control enum doesn't have the value,
                # leave it alone and surface in the audit summary.
                pass
            if control_row.is_archived != new_is_archived:
                control_row.is_archived = new_is_archived
                archive_changed = True

        await record_platform_audit_event(
            control_db,
            category=PlatformAuditCategory.tenant,
            event=f"tenant.{body.action.value}",
            summary=(
                f"{updated_tenant.name} {verb} by {current_user.full_name}"
            ),
            actor=current_user,
            severity=severity,
            tenant_id=updated_tenant.id,
            tenant_slug=updated_tenant.slug,
            tenant_name=updated_tenant.name,
            before_state={
                "status": previous_status.value,
                "is_archived": bool(previous_is_archived) if previous_is_archived is not None else None,
            },
            after_state={
                "status": new_status_value,
                "is_archived": new_is_archived,
            },
            request=request,
        )
        await control_db.commit()

    # Tenant-scoped activity log so the tenant's own admins see when
    # the platform took action on them.
    await record_activity_events(
        db,
        [
            build_activity_event(
                activity_type="TENANT_STATUS_CHANGED",
                visibility_scope=PLATFORM_ADMIN_ACTIVITY_SCOPE,
                tenant_id=updated_tenant.id,
                actor_user=None,
                actor_name_override=current_user.full_name,
                entity_type="tenant",
                entity_id=updated_tenant.id,
                summary=(
                    f"{current_user.full_name} {verb} tenant {updated_tenant.name}."
                ),
                route="/platform/tenants",
                route_params={"tenantId": updated_tenant.id},
                metadata={
                    "old_status": previous_status.value,
                    "new_status": new_status_value,
                    "action": body.action.value,
                    "is_archived": new_is_archived,
                    "archive_changed": archive_changed,
                },
            )
        ],
    )

    return updated_tenant


@router.post("/{tenant_id}/service-tokens",
             response_model=ServiceTokenCreatedResponse,
             status_code=status.HTTP_201_CREATED)
async def create_service_token(
    tenant_id: int,
    token_in: ServiceTokenCreate,
    db: AsyncSession = Depends(get_db),
    _: object = Depends(require_role("PLATFORM_ADMIN")),
) -> object:
    """
    Creates a new service token for a tenant.
    Returns the plaintext token ONCE — it cannot be retrieved again.
    The ingestion platform must store this token securely.
    """
    tenant = await get_tenant(db, tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    # New-format tokens (post-041) embed a public token_id prefix so
    # the auth dep does an indexed lookup instead of a per-tenant
    # bcrypt sweep. We only persist the secret half — the prefix is
    # stored verbatim alongside it.
    plaintext, token_id, secret = generate_service_token()
    token_record = ServiceToken(
        name=token_in.name,
        token_id=token_id,
        token_hash=hash_service_token(secret),
        tenant_id=tenant_id,
        issuer=token_in.issuer,
        is_active=True,
    )
    db.add(token_record)
    await db.commit()
    await db.refresh(token_record)

    return ServiceTokenCreatedResponse(
        id=token_record.id,
        name=token_record.name,
        tenant_id=token_record.tenant_id,
        issuer=token_record.issuer,
        is_active=token_record.is_active,
        last_used_at=token_record.last_used_at,
        created_at=token_record.created_at,
        token=plaintext,
    )


@router.get("/{tenant_id}/service-tokens",
            response_model=list[ServiceTokenRead])
async def list_service_tokens(
    tenant_id: int,
    db: AsyncSession = Depends(get_db),
    _: object = Depends(require_role("PLATFORM_ADMIN")),
) -> list:
    """List service tokens for a tenant. Token values are never returned."""
    result = await db.execute(
        select(ServiceToken).where(ServiceToken.tenant_id == tenant_id)
    )
    return result.scalars().all()


@router.delete("/{tenant_id}/service-tokens/{token_id}",
               status_code=status.HTTP_204_NO_CONTENT)
async def revoke_service_token(
    tenant_id: int,
    token_id: int,
    db: AsyncSession = Depends(get_db),
    _: object = Depends(require_role("PLATFORM_ADMIN")),
) -> None:
    """Deactivate a service token. The ingestion platform will get 401s."""
    token = await db.get(ServiceToken, token_id)
    if not token or token.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Token not found")
    token.is_active = False
    await db.commit()


@router.post("/{tenant_id}/provision-system-user", status_code=status.HTTP_200_OK)
async def provision_system_user(
    tenant_id: int,
    db: AsyncSession = Depends(get_db),
    _: object = Depends(require_role("PLATFORM_ADMIN")),
) -> dict:
    """
    Ensure the ingestion system service user exists for the given tenant.
    Safe to call multiple times - idempotent.

    The system user must live in the tenant's per-tenant DB so that
    /sync/timesheets/push (which now correctly routes per-tenant) can
    find it as the `approved_by` author. For non-isolated tenants this
    transparently falls back to the shared DB via tenant_session resolution.
    """
    from app.db_tenant import resolve_slug_for_tenant_id, tenant_session

    tenant = await get_tenant(db, tenant_id)
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")

    username = f"system_ingestion_{tenant_id}"
    email = f"system_ingestion_{tenant_id}@system.internal"

    async def _provision_in(session: AsyncSession) -> tuple[bool, int]:
        existing = (await session.execute(
            select(User).where(User.username == username)
        )).scalar_one_or_none()
        if existing:
            return False, existing.id
        new_user = User(
            tenant_id=tenant_id,
            email=email,
            username=username,
            full_name="Ingestion System",
            hashed_password=get_password_hash(secrets.token_urlsafe(48)),
            role=UserRole.EMPLOYEE,
            is_active=True,
            has_changed_password=True,
            can_review=False,
            is_external=False,
        )
        session.add(new_user)
        await session.commit()
        await session.refresh(new_user)
        return True, new_user.id

    try:
        slug = await resolve_slug_for_tenant_id(tenant_id)
        async with tenant_session(slug) as tenant_db:
            provisioned, uid = await _provision_in(tenant_db)
    except (LookupError, ValueError):
        provisioned, uid = await _provision_in(db)

    return {"provisioned": provisioned, "user_id": uid, "email": email}


# ============================================================================
# Feature flags
# ============================================================================


@router.get(
    "/mine/features",
    response_model=TenantFeaturesResponse,
)
async def get_my_tenant_features(
    current_user: User = Depends(get_current_user),
) -> dict:
    """Tenant admin reads its own feature flags.

    Used by the tenant's settings page to decide whether to render the
    SMTP form / template editor or the "Available on Pro plan" hint.
    """
    from app.services.tenant_features import get_features
    if current_user.tenant_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Platform admins must specify a tenant via /tenants/{id}/features.",
        )
    flags = await get_features(current_user.tenant_id)
    return {"tenant_id": current_user.tenant_id, **flags}


@router.get(
    "/{tenant_id}/features",
    response_model=TenantFeaturesResponse,
)
async def get_tenant_features(
    tenant_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role("PLATFORM_ADMIN")),
) -> dict:
    """Return all feature flags for a tenant.

    Tenant admins read flags via their own settings page which calls a
    different endpoint (their tenant_id is implicit from their JWT).
    This endpoint is the platform admin's cross-tenant view.
    """
    from app.services.tenant_features import get_features
    # Verify the tenant exists at all so we 404 instead of returning
    # the all-False default for a nonexistent id.
    target = await get_tenant(db, tenant_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")
    flags = await get_features(tenant_id)
    return {"tenant_id": tenant_id, **flags}


@router.patch(
    "/{tenant_id}/features",
    response_model=TenantFeaturesResponse,
)
async def update_tenant_features(
    tenant_id: int,
    body: TenantFeaturesUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role("PLATFORM_ADMIN")),
) -> dict:
    """Toggle feature flags for a tenant. Only the supplied keys are
    updated; omitted keys retain their current value.

    Writes an activity log entry (visible to tenant admin) so the
    tenant can see which features Acufy enabled/disabled and when.
    """
    from app.services.tenant_features import set_features
    target = await get_tenant(db, tenant_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")

    updates = body.model_dump(exclude_unset=True, exclude_none=True)
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide at least one flag to update.",
        )

    try:
        flags = await set_features(
            tenant_id,
            updates,
            actor_user_id=current_user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    # Audit: each flag flip gets its own activity event so tenant
    # admins see exactly which feature changed.
    events = []
    for flag, value in updates.items():
        events.append(build_activity_event(
            activity_type="TENANT_FEATURE_FLAG_CHANGED",
            visibility_scope=PLATFORM_ADMIN_ACTIVITY_SCOPE,
            tenant_id=tenant_id,
            # PA actor -- see note on tenant create above
            actor_user=None,
            actor_name_override=current_user.full_name,
            entity_type="tenant",
            entity_id=tenant_id,
            summary=(
                f"{current_user.full_name} {'enabled' if value else 'disabled'} "
                f"feature '{flag}' for {target.name}."
            ),
            route=f"/tenants/{tenant_id}/features",
            metadata={"flag": flag, "value": value},
        ))
    if events:
        await record_activity_events(db, events)

    # Mirror into the platform audit log so the /platform/audit page
    # surfaces each flag flip with its before/after value.
    async with AsyncControlSessionLocal() as control_db:
        for flag, value in updates.items():
            await record_platform_audit_event(
                control_db,
                category=PlatformAuditCategory.feature,
                event=f"tenant.feature.{flag}.{'enabled' if value else 'disabled'}",
                summary=(
                    f"Feature '{flag}' {'enabled' if value else 'disabled'} for {target.name}"
                ),
                actor=current_user,
                tenant_id=tenant_id,
                tenant_slug=target.slug,
                tenant_name=target.name,
                before_state=None,
                after_state={"flag": flag, "enabled": bool(value)},
                request=request,
            )
        await control_db.commit()

    return {"tenant_id": tenant_id, **flags}
