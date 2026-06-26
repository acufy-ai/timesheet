import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status, Query
from pydantic import BaseModel as PydanticBaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from app.schemas import ClientResponse, ClientCreate, ClientUpdate, ClientTeamMember
from app.crud.client import get_client_by_id, get_client_by_name, create_client, update_client, delete_client, list_clients
from app.crud.time_entry import count_protected_entries_for_client
from app.core.deps import get_current_user, get_tenant_db, require_role, require_can_review
from app.models.client import Client
from app.models.client_email_domain import ClientEmailDomain
from app.models.ingested_email import IngestedEmail
from app.models.ingestion_timesheet import IngestionTimesheet, IngestionTimesheetStatus
from app.models.user import User, UserRole
from app.models.user_client_assignment import UserClientAssignment, ClientAssignmentRole
from app.api._client_access import (
    require_client_manager, assert_client_access, visible_client_ids, add_creator_as_pm, is_admin,
)
from app.services.ingestion_pipeline import (
    PERSONAL_EMAIL_DOMAINS,
    _domain_of,
    is_personal_email_domain,
)
from app.services.ingestion_sync import _send_outbound_webhook
from app.services.activity import (
    TENANT_ADMIN_ACTIVITY_SCOPE,
    build_activity_event,
    record_activity_events,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/clients", tags=["clients"])


async def _require_admin_or_reviewer(
    current_user: User = Depends(get_current_user),
) -> User:
    """Allow ADMIN/PLATFORM_ADMIN (full client management) or any user with
    can_review=True (ingestion reviewers who need to create clients inline)."""
    from app.models.user import UserRole
    if current_user.role in (UserRole.ADMIN, UserRole.PLATFORM_ADMIN):
        return current_user
    if current_user.can_review:
        return current_user
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Admin or reviewer role required to create clients.",
    )


async def _try_outbound_webhook(**kwargs) -> None:
    """Best-effort outbound webhook delivery.

    Silent ``pass`` was a real audit finding: when the webhook target
    was down the failure was invisible, so operators had no way to
    learn that ingestion-platform sync was diverging. We now log a
    warning (with event_type and local_id when available) so the
    delivery loss surfaces in the same logs as everything else. The
    handler still does not raise — webhook delivery is not on the
    request's critical path.
    """
    try:
        await _send_outbound_webhook(**kwargs)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "outbound webhook delivery failed: event_type=%s local_id=%s error=%s",
            kwargs.get("event_type"),
            kwargs.get("local_id"),
            exc,
        )


@router.get("", response_model=list[ClientResponse])
async def list_all_clients(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> list:
    """
    List clients within the current user's tenant. Admins see all; managers
    see only clients they are a PM on; other roles see none.
    """
    visible = await visible_client_ids(db, current_user)
    rows = await list_clients(db, tenant_id=current_user.tenant_id, skip=skip, limit=limit)
    if visible is None:
        return rows
    return [c for c in rows if c.id in visible]


@router.get("/{client_id}", response_model=ClientResponse)
async def get_client(
    client_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """
    Get a specific client by ID.
    """
    client = await get_client_by_id(db, client_id, tenant_id=current_user.tenant_id)
    if not client:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Client not found")
    await assert_client_access(db, current_user, client_id)
    return client


class ClientCreateWithTeam(ClientCreate):
    """Create body that can carry the initial team so the client + its roster are
    written in one request (no follow-up PUT /team that would re-check access)."""
    pm_ids: list[int] = Field(default_factory=list)
    member_ids: list[int] = Field(default_factory=list)


@router.post("", response_model=ClientResponse, status_code=status.HTTP_201_CREATED)
async def create_new_client(
    client_create: ClientCreateWithTeam,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """
    Create a new client. Admins, ingestion reviewers, and managers may create
    clients. A manager who creates one is auto-added as its PM so they retain
    access (managers only see clients they PM).
    """
    # Admin / reviewer / manager gate.
    if not (is_admin(current_user) or current_user.can_review or current_user.role == UserRole.MANAGER):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin, reviewer, or manager role required to create clients.",
        )
    # Strip the team fields before creating the client row itself.
    base = ClientCreate(**client_create.model_dump(exclude={"pm_ids", "member_ids"}))
    # A duplicate client name hits a DB unique constraint. Check up front for a
    # clean 409 with an actionable message; the IntegrityError catch below is a
    # backstop for races and any other constraint so we never leak a raw 500.
    if base.name and await get_client_by_name(db, base.name.strip(), current_user.tenant_id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A client named '{base.name.strip()}' already exists.",
        )
    try:
        new_client = await create_client(db, base, tenant_id=current_user.tenant_id)
    except IntegrityError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A client named '{base.name.strip()}' already exists.",
        )
    await add_creator_as_pm(db, current_user, new_client.id)
    # Set the initial team in THIS request (the creator can always staff a client
    # they just made). Doing it here — rather than a follow-up PUT /team that
    # re-checks access — avoids a 403 when a role-switched admin's active role
    # isn't recognized as a PM yet, and avoids a duplicate-name 500 on retry.
    if client_create.pm_ids or client_create.member_ids:
        await _write_client_roster(
            db, new_client.id, current_user.tenant_id,
            pm_ids=client_create.pm_ids, member_ids=client_create.member_ids,
            replace=False)
        await db.commit()
    if new_client.tenant_id is not None:
        await record_activity_events(
            db,
            [
                build_activity_event(
                    activity_type="CLIENT_CREATED",
                    visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                    tenant_id=new_client.tenant_id,
                    actor_user=current_user,
                    entity_type="client",
                    entity_id=new_client.id,
                    summary=f"{current_user.full_name} created client {new_client.name}.",
                    route="/client-management",
                    route_params={"clientId": new_client.id},
                    metadata={"client_name": new_client.name},
                )
            ],
        )
    return new_client


class CreateClientFromDomainRequest(PydanticBaseModel):
    """Body for POST /clients/from-domain.

    The reviewer typed a name in the inline-popover and confirmed; the
    backend creates the client, registers the domain mapping, and cascades
    the assignment to every pending ingestion timesheet from that domain
    in the tenant's queue.
    """
    name: str = Field(min_length=1, max_length=255, description="Client display name.")
    domain: str = Field(min_length=3, max_length=255, description="Email domain (e.g. 'dxc.com').")


class CreateClientFromDomainResponse(PydanticBaseModel):
    client: ClientResponse
    domain: str
    cascaded_count: int = Field(
        description="Number of pending ingestion timesheets that had their client_id set as a side-effect."
    )


def _email_domains_for_ingestion_timesheet(ts: IngestionTimesheet, email: IngestedEmail) -> set[str]:
    """All domains we'd consider for client resolution on a single timesheet.

    Mirrors the precedence used by the live resolver (forwarded-from →
    body emails → outer sender), but without the LLM-extracted name path
    since the cascade is strictly domain-based.
    """
    candidates: list[str] = []
    if email.forwarded_from_email:
        candidates.append(email.forwarded_from_email)
    if email.sender_email:
        candidates.append(email.sender_email)
    extracted = ts.extracted_data or {}
    body_emails = extracted.get("contact_emails") or []
    if isinstance(body_emails, list):
        candidates.extend(str(e) for e in body_emails if e)
    chain = email.chain_senders or []
    if isinstance(chain, list):
        for entry in chain:
            if isinstance(entry, dict) and entry.get("email"):
                candidates.append(str(entry["email"]))
    return {_domain_of(c) for c in candidates if c} - {""}


@router.post(
    "/from-domain",
    response_model=CreateClientFromDomainResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_client_from_domain(
    body: CreateClientFromDomainRequest,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(_require_admin_or_reviewer),
) -> dict:
    """
    Create a client whose email domain is registered, then cascade the
    assignment to every pending ingestion timesheet in the tenant's queue
    whose sender/forwarded/body email domain matches.

    Refuses personal email domains (gmail, outlook, etc.) — those are never
    legitimate client identities. Returns 409 with the existing client info
    if the domain is already mapped, so the frontend can offer a 'link to
    that client' alternative.
    """
    if current_user.tenant_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="PLATFORM_ADMIN must operate within a tenant context for this action.",
        )
    tenant_id = current_user.tenant_id

    name = body.name.strip()
    domain = body.domain.strip().lower()
    if "@" in domain:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="domain must be the bare domain (e.g. 'dxc.com'), not an email address.",
        )
    if not name:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="name is required.",
        )
    if is_personal_email_domain(domain):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"'{domain}' is a personal email provider and cannot be mapped to a client. "
                "Pick an existing client manually for emails from this domain."
            ),
        )

    # Reject if domain is already mapped in this tenant — return existing
    # client info so the UI can offer 'link to it instead'.
    existing_q = await db.execute(
        select(ClientEmailDomain.client_id, Client.name)
        .join(Client, Client.id == ClientEmailDomain.client_id)
        .where(
            (ClientEmailDomain.tenant_id == tenant_id)
            & (ClientEmailDomain.domain == domain)
        )
    )
    existing_row = existing_q.first()
    if existing_row is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "domain_already_mapped",
                "message": f"Domain '{domain}' is already mapped to client '{existing_row.name}'.",
                "existing_client_id": existing_row.client_id,
                "existing_client_name": existing_row.name,
            },
        )

    # Create the Client + domain mapping in one transaction. Inlined
    # rather than calling crud.create_client because that helper commits
    # eagerly, which would leave a Client row orphaned if the cascade
    # below failed.
    new_client = Client(name=name, tenant_id=tenant_id)
    db.add(new_client)
    try:
        await db.flush()  # populates new_client.id without committing
    except Exception as exc:
        await db.rollback()
        # Most likely a duplicate name — the unique constraint
        # (tenant_id, name) on Client surfaces here.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A client named '{name}' already exists in this tenant.",
        ) from exc

    # Register the domain mapping.
    db.add(ClientEmailDomain(
        tenant_id=tenant_id,
        client_id=new_client.id,
        domain=domain,
    ))

    # Cascade: find pending ingestion timesheets in this tenant with
    # client_id IS NULL whose linked email's domain matches, and assign
    # the new client. Done in Python because the candidate domain may
    # come from JSON fields (extracted_data.contact_emails, chain_senders).
    pending_q = await db.execute(
        select(IngestionTimesheet, IngestedEmail)
        .join(IngestedEmail, IngestedEmail.id == IngestionTimesheet.email_id)
        .where(
            (IngestionTimesheet.tenant_id == tenant_id)
            & (IngestionTimesheet.client_id.is_(None))
            & (IngestionTimesheet.status == IngestionTimesheetStatus.pending)
        )
    )
    matched_ids: list[int] = []
    for ts, email in pending_q.all():
        if domain in _email_domains_for_ingestion_timesheet(ts, email):
            matched_ids.append(ts.id)

    if matched_ids:
        await db.execute(
            update(IngestionTimesheet)
            .where(IngestionTimesheet.id.in_(matched_ids))
            .values(client_id=new_client.id)
        )
        # Mirror the cascade onto the user_client_assignments table for
        # every timesheet whose employee is already resolved. The User
        # Management surface treats clients as a multi-value list, so we
        # only ADD assignments here (duplicates are swallowed).
        from app.crud.user_client_assignment import add_assignment as _add_user_client_assignment
        emp_q = await db.execute(
            select(IngestionTimesheet.employee_id)
            .where(IngestionTimesheet.id.in_(matched_ids))
            .where(IngestionTimesheet.employee_id.isnot(None))
        )
        seen_user_ids: set[int] = set()
        for (emp_id,) in emp_q.all():
            if emp_id is None or emp_id in seen_user_ids:
                continue
            seen_user_ids.add(emp_id)
            try:
                await _add_user_client_assignment(
                    db,
                    user_id=emp_id,
                    client_id=new_client.id,
                    tenant_id=tenant_id,
                )
            except Exception:  # noqa: BLE001 - cascade is best-effort
                pass

    await record_activity_events(
        db,
        [
            build_activity_event(
                activity_type="CLIENT_CREATED",
                visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                tenant_id=tenant_id,
                actor_user=current_user,
                entity_type="client",
                entity_id=new_client.id,
                summary=(
                    f"{current_user.full_name} created client {new_client.name} "
                    f"from domain {domain} (cascaded to {len(matched_ids)} pending email"
                    f"{'' if len(matched_ids) == 1 else 's'})."
                ),
                route="/client-management",
                route_params={"clientId": new_client.id},
                metadata={
                    "client_name": new_client.name,
                    "domain": domain,
                    "cascaded_count": len(matched_ids),
                },
            )
        ],
    )
    await db.commit()
    await db.refresh(new_client)

    return {
        "client": new_client,
        "domain": domain,
        "cascaded_count": len(matched_ids),
    }


@router.put("/{client_id}", response_model=ClientResponse)
async def update_client_endpoint(
    client_id: int,
    client_update: ClientUpdate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """
    Update a client. Admins, or managers who are a PM on this client.
    """
    require_client_manager(current_user)
    client = await get_client_by_id(db, client_id, tenant_id=current_user.tenant_id)
    if not client:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Client not found")
    await assert_client_access(db, current_user, client_id)

    # Build changed_fields before updating (for outbound webhook)
    changed_fields = {}
    update_data = client_update.model_dump(exclude_unset=True)
    for field, new_val in update_data.items():
        old_val = getattr(client, field, None)
        if old_val != new_val:
            changed_fields[field] = {"old": old_val, "new": new_val}

    updated_client = await update_client(db, client, client_update)

    if client.ingestion_client_id and changed_fields:
        background_tasks.add_task(
            _try_outbound_webhook,
            tenant_id=current_user.tenant_id,
            event_type="client.updated",
            local_id=client.id,
            ingestion_id=client.ingestion_client_id,
            changed_fields=changed_fields,
            changed_by_name=current_user.full_name,
            session=db,
        )

    return updated_client


class BulkDeleteClientsRequest(PydanticBaseModel):
    client_ids: list[int]


@router.post("/bulk-delete")
async def bulk_delete_clients(
    body: BulkDeleteClientsRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    require_client_manager(current_user)
    deleted = 0
    skipped_protected: list[int] = []
    for client_id in body.client_ids:
        client = await get_client_by_id(db, client_id, tenant_id=current_user.tenant_id)
        if not client:
            continue
        # Managers may only delete clients they PM; silently skip others.
        if not is_admin(current_user):
            try:
                await assert_client_access(db, current_user, client_id)
            except HTTPException:
                continue
        # Same delete-protection as the single-delete endpoint: never cascade
        # away a client whose projects carry submitted/approved/rejected time
        # entries. Skip it (partial-safe bulk op) and report it back.
        protected = await count_protected_entries_for_client(
            db, client_id, tenant_id=current_user.tenant_id
        )
        if protected:
            skipped_protected.append(client_id)
            continue
        ingestion_client_id = client.ingestion_client_id
        client_id_local = client.id
        success = await delete_client(db, client_id, tenant_id=current_user.tenant_id)
        if not success:
            continue
        deleted += 1
        if ingestion_client_id:
            background_tasks.add_task(
                _try_outbound_webhook,
                tenant_id=current_user.tenant_id,
                event_type="client.deleted",
                local_id=client_id_local,
                ingestion_id=ingestion_client_id,
                changed_fields={},
                changed_by_name=current_user.full_name,
                session=db,
            )
    return {"deleted": deleted, "skipped_protected": skipped_protected}


@router.delete("/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_client_endpoint(
    client_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> None:
    """
    Delete a client. Admins, or managers who are a PM on this client.
    """
    require_client_manager(current_user)
    client = await get_client_by_id(db, client_id, tenant_id=current_user.tenant_id)
    if not client:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Client not found")
    await assert_client_access(db, current_user, client_id)

    protected = await count_protected_entries_for_client(
        db, client_id, tenant_id=current_user.tenant_id
    )
    if protected:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Cannot delete this client: its projects have {protected} "
                "submitted, approved, or rejected time entries. Archive it "
                "instead, or reassign those entries first."
            ),
        )

    ingestion_client_id = client.ingestion_client_id
    client_id_local = client.id
    client_name = client.name
    client_tenant_id = client.tenant_id

    success = await delete_client(db, client_id, tenant_id=current_user.tenant_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Client not found")

    # Audit the deletion (cascades to the client's projects + tasks) so the
    # destructive action is attributable in the activity trail, not just creates.
    if client_tenant_id is not None:
        await record_activity_events(
            db,
            [
                build_activity_event(
                    activity_type="CLIENT_DELETED",
                    visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                    tenant_id=client_tenant_id,
                    actor_user=current_user,
                    entity_type="client",
                    entity_id=client_id_local,
                    summary=f"{current_user.full_name} deleted client {client_name}.",
                    route="/client-management",
                    metadata={"client_name": client_name},
                    severity="warning",
                )
            ],
        )

    if ingestion_client_id:
        background_tasks.add_task(
            _try_outbound_webhook,
            tenant_id=current_user.tenant_id,
            event_type="client.deleted",
            local_id=client_id_local,
            ingestion_id=ingestion_client_id,
            changed_fields={},
            changed_by_name=current_user.full_name,
            session=db,
        )


# ── Client team roster (PMs + members) ──────────────────────────────────────
# The redesigned client form assigns PMs and team members to a client. Both are
# rows in user_client_assignments distinguished by assignment_role ('pm' |
# 'member'). The project PM dropdown reads the 'pm' rows; task assignee pickers
# read the 'member' rows.

class ClientTeamUpdate(PydanticBaseModel):
    # extra="forbid": a mistyped key (e.g. "members" instead of "member_ids")
    # must 422, not be silently dropped — silently dropping it left `desired`
    # empty and wiped the entire roster.
    model_config = {"extra": "forbid"}
    pm_ids: list[int] = Field(default_factory=list)
    member_ids: list[int] = Field(default_factory=list)


@router.get("/{client_id}/team", response_model=list[ClientTeamMember])
async def get_client_team(
    client_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> list:
    """The client's assigned team (PMs + members), with each person's org role
    and their assignment_role on this client."""
    client = await get_client_by_id(db, client_id, tenant_id=current_user.tenant_id)
    if not client:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Client not found")
    await assert_client_access(db, current_user, client_id)
    rows = (
        await db.execute(
            select(UserClientAssignment, User)
            .join(User, User.id == UserClientAssignment.user_id)
            .where(UserClientAssignment.client_id == client_id)
            .where(UserClientAssignment.tenant_id == current_user.tenant_id)
        )
    ).all()
    return [
        ClientTeamMember(
            user_id=u.id,
            full_name=u.full_name,
            role=u.role.value if hasattr(u.role, "value") else str(u.role),
            assignment_role=a.assignment_role.value if hasattr(a.assignment_role, "value") else str(a.assignment_role),
        )
        for a, u in rows
    ]


async def _write_client_roster(
    db: AsyncSession, client_id: int, tenant_id: int,
    *, pm_ids: list[int], member_ids: list[int], replace: bool = True,
) -> None:
    """Set a client's roster: pm_ids -> 'pm', member_ids -> 'member' (PM wins on
    overlap). When replace=True, removes anyone no longer listed (the edit-team
    semantics); when False, only adds/promotes (the create semantics, so the
    auto-added creator-PM isn't wiped). Caller commits."""
    desired: dict[int, ClientAssignmentRole] = {}
    for uid in member_ids:
        desired[uid] = ClientAssignmentRole.member
    for uid in pm_ids:
        desired[uid] = ClientAssignmentRole.pm

    existing = (
        await db.execute(
            select(UserClientAssignment)
            .where(UserClientAssignment.client_id == client_id)
            .where(UserClientAssignment.tenant_id == tenant_id)
        )
    ).scalars().all()
    by_user = {row.user_id: row for row in existing}

    if replace:
        for row in existing:
            if row.user_id not in desired:
                await db.delete(row)
    for uid, role in desired.items():
        row = by_user.get(uid)
        if row is None:
            db.add(UserClientAssignment(
                tenant_id=tenant_id, user_id=uid, client_id=client_id, assignment_role=role))
        elif row.assignment_role != role:
            row.assignment_role = role
            db.add(row)


@router.put("/{client_id}/team", response_model=list[ClientTeamMember])
async def set_client_team(
    client_id: int,
    body: ClientTeamUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> list:
    """Replace the client's roster. pm_ids -> assignment_role 'pm',
    member_ids -> 'member'. A user appearing in both is treated as a PM."""
    require_client_manager(current_user)
    client = await get_client_by_id(db, client_id, tenant_id=current_user.tenant_id)
    if not client:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Client not found")
    await assert_client_access(db, current_user, client_id)
    await _write_client_roster(
        db, client_id, current_user.tenant_id,
        pm_ids=body.pm_ids, member_ids=body.member_ids, replace=True)
    await db.commit()
    return await get_client_team(client_id, db=db, current_user=current_user)


# ─────────────────────────────────────────────────────────────────────────────
# Bulk import: clients + projects + tasks + assignments from an XLSX/CSV.
# Three-step (preview → commit) mirroring the user-import flow. Admin-gated.
# ─────────────────────────────────────────────────────────────────────────────
from fastapi import UploadFile, File  # noqa: E402
from fastapi.responses import Response  # noqa: E402
from app.services import client_import as _ci  # noqa: E402


@router.get("/import/template")
async def download_client_import_template(
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
):
    """Download a pre-formatted XLSX template (Clients/Projects/Tasks/Assignments
    tabs with the expected columns + one example row each)."""
    import io
    import openpyxl

    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    examples = {
        "clients": ["Acme Health", "Acme Corporation LLC", "external", "active",
                    "Jane Doe", "jane@acme.com", "+1 555 000 0000", "2026-01-01"],
        "projects": ["Acme Health", "Website redesign", "WEB-01", "150", "100000",
                     "USD", "planning", "2026-02-01", "2026-08-01", "pm@example.com"],
        "tasks": ["Acme Health", "Website redesign", "Design mockups", "medium",
                  "to_do", "Initial mockups for the homepage"],
        "assignments": ["Acme Health", "Website redesign", "Design mockups",
                        "employee@example.com"],
    }
    for sheet_key, cols in _ci.SHEETS.items():
        ws = wb.create_sheet(title=sheet_key.capitalize())
        ws.append(cols)
        ws.append(examples[sheet_key])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="client-import-template.xlsx"'},
    )


@router.post("/import/preview")
async def import_clients_preview(
    file: UploadFile = File(...),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
    db: AsyncSession = Depends(get_tenant_db),
) -> dict:
    """Parse + validate the upload (no writes). Returns counts, errors, warnings,
    and the parsed data (echoed back so commit needn't re-upload the file)."""
    content = await file.read()
    try:
        data = _ci.parse_workbook(file.filename or "upload.xlsx", content)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return await _ci.build_preview(db, data, current_user.tenant_id)


class _ClientImportCommitBody(PydanticBaseModel):
    data: dict


@router.post("/import/commit")
async def import_clients_commit(
    body: _ClientImportCommitBody,
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
    db: AsyncSession = Depends(get_tenant_db),
) -> dict:
    """Create clients → projects → tasks → assignments from the previewed data."""
    return await _ci.commit_import(db, body.data, current_user.tenant_id)
