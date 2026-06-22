"""Client Portal Access API.

Two surfaces:

  /client-portal/*   — the CLIENT user's own view. Allowlisted in get_current_user
                       so a CLIENT can reach these (and nothing else). Every
                       endpoint re-checks the tenant kill switch + that the grant
                       still covers the resource + the required capability.

  /client-grants/*   — PM/admin grant management (create/list/revoke grants,
                       toggle a project's client_access_enabled). Gated by
                       require_client_manager + assert_client_access, so a CLIENT
                       can't reach it (not allowlisted) AND a manager can only
                       touch their own clients' projects.

Two gates guard the whole feature:
  1. Tenant kill switch  — client_portal_enabled (tenant setting). Off => the
     CLIENT side 403s and grants are inert.
  2. Per-project toggle  — projects.client_access_enabled. A grant is only
     effective on a project that's switched on.
A capability ("create"/"read"/"update"/"delete") must be present on the grant
for the matching verb.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, get_tenant_db
from app.core.tenant_settings import get_setting
from app.models.user import User, UserRole
from app.models.project import Project
from app.models.task import Task
from app.models.client import Client
from app.models.client_access_grant import ClientAccessGrant
from app.api._client_access import require_client_manager, assert_client_access, visible_client_ids
from app.schemas import (
    ClientGrantCreate, ClientGrantUpdate, ClientGrantResponse,
    ProjectClientAccessToggle, PortalProject, PortalTask,
    ClientInviteRequest, ClientInviteResponse, UserCreate, ClientPortalUser,
    PortalTaskUpdate, PortalTaskCreate, PortalProjectUpdate,
)

router = APIRouter(tags=["client-portal"])


def _status_str(v) -> Optional[str]:
    if v is None:
        return None
    return v.value if hasattr(v, "value") else str(v)


async def _require_portal_enabled(db: AsyncSession, tenant_id: int) -> None:
    enabled = await get_setting(db, tenant_id, "client_portal_enabled")
    if not enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The client portal is disabled for this workspace.",
        )


async def _load_grants(db: AsyncSession, user: User) -> list[ClientAccessGrant]:
    rows = await db.execute(
        select(ClientAccessGrant)
        .where(ClientAccessGrant.user_id == user.id)
        .where(ClientAccessGrant.tenant_id == user.tenant_id)
    )
    return list(rows.scalars().all())


# ════════════════════════════════════════════════════════════════════════════
#  CLIENT side — /client-portal/*  (allowlisted for the CLIENT role)
# ════════════════════════════════════════════════════════════════════════════
@router.get("/client-portal/projects", response_model=list[PortalProject])
async def my_portal_projects(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """The granted projects/tasks for the calling CLIENT user, capability-tagged.

    Only projects with client_access_enabled=true surface here, even if a grant
    exists (the per-project toggle gates the grant)."""
    if current_user.role != UserRole.CLIENT:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Client portal is for client accounts.")
    await _require_portal_enabled(db, current_user.tenant_id)

    grants = await _load_grants(db, current_user)
    if not grants:
        return []

    proj_caps: dict[int, list[str]] = {}
    task_caps: dict[int, list[str]] = {}
    for g in grants:
        if g.project_id is not None:
            proj_caps[g.project_id] = sorted(set(proj_caps.get(g.project_id, []) + list(g.capabilities or [])))
        elif g.task_id is not None:
            task_caps[g.task_id] = sorted(set(task_caps.get(g.task_id, []) + list(g.capabilities or [])))

    # Resolve which projects to show: directly-granted projects + the projects
    # owning any task-granted tasks.
    task_project = {}
    if task_caps:
        trows = await db.execute(
            select(Task.id, Task.project_id).where(
                Task.id.in_(list(task_caps.keys())), Task.tenant_id == current_user.tenant_id)
        )
        task_project = {tid: pid for tid, pid in trows.all()}
    project_ids = set(proj_caps.keys()) | set(task_project.values())
    if not project_ids:
        return []

    # Exposure is decided by the grant itself (+ the tenant kill switch above);
    # there is no separate per-project gate.
    prows = await db.execute(
        select(Project).where(
            Project.id.in_(list(project_ids)),
            Project.tenant_id == current_user.tenant_id,
        )
    )
    projects = {p.id: p for p in prows.scalars().all()}
    if not projects:
        return []

    # Client names for display.
    crows = await db.execute(select(Client.id, Client.name).where(Client.tenant_id == current_user.tenant_id))
    client_name = {cid: name for cid, name in crows.all()}

    # All tasks for the visible projects.
    all_tasks_rows = await db.execute(
        select(Task).where(Task.project_id.in_(list(projects.keys())), Task.tenant_id == current_user.tenant_id)
    )
    tasks_by_project: dict[int, list[Task]] = {}
    for t in all_tasks_rows.scalars().all():
        tasks_by_project.setdefault(t.project_id, []).append(t)

    out: list[PortalProject] = []
    for pid, p in projects.items():
        pcaps = proj_caps.get(pid, [])
        portal_tasks: list[PortalTask] = []
        for t in tasks_by_project.get(pid, []):
            # A task is visible if the project is granted (inherit) OR the task
            # itself is granted. Capabilities = project caps for inherited, else
            # the task's own caps.
            if pcaps:
                portal_tasks.append(PortalTask(id=t.id, project_id=pid, name=t.name, description=t.description, status=_status_str(t.status), capabilities=pcaps))
            elif t.id in task_caps:
                portal_tasks.append(PortalTask(id=t.id, project_id=pid, name=t.name, description=t.description, status=_status_str(t.status), capabilities=task_caps[t.id]))
        out.append(PortalProject(
            id=p.id, name=p.name, code=p.code, client_id=p.client_id,
            client_name=client_name.get(p.client_id), status=_status_str(p.status),
            description=p.description, capabilities=pcaps, tasks=portal_tasks,
        ))
    return out


async def _capability_for_task(db: AsyncSession, user: User, task: Task) -> set[str]:
    """The capabilities the CLIENT user holds on this task (project grant inherited
    or a direct task grant). Empty = no access. Exposure = the grant itself."""
    project = await db.get(Project, task.project_id)
    if project is None or project.tenant_id != user.tenant_id:
        return set()
    grants = await _load_grants(db, user)
    caps: set[str] = set()
    for g in grants:
        if g.project_id == task.project_id or g.task_id == task.id:
            caps |= set(g.capabilities or [])
    return caps


async def _capability_for_project(db: AsyncSession, user: User, project: Project) -> set[str]:
    """Capabilities the CLIENT holds at the PROJECT level (a project-scoped grant
    — task-only grants do NOT confer project-level create/delete). Empty = none."""
    if project is None or project.tenant_id != user.tenant_id:
        return set()
    caps: set[str] = set()
    for g in await _load_grants(db, user):
        if g.project_id == project.id:
            caps |= set(g.capabilities or [])
    return caps


def _require_client(user: User) -> None:
    if user.role != UserRole.CLIENT:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Client portal is for client accounts.")


@router.patch("/client-portal/tasks/{task_id}")
async def portal_update_task(
    task_id: int,
    payload: PortalTaskUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Capability-gated task edit by a CLIENT: status and/or description.
    Requires UPDATE on the task (inherited from a project grant or a task grant)."""
    _require_client(current_user)
    await _require_portal_enabled(db, current_user.tenant_id)
    task = await db.get(Task, task_id)
    if task is None or task.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    caps = await _capability_for_task(db, current_user, task)
    if "update" not in caps:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't have edit access to this task.")
    if payload.status is not None:
        from app.models.task import TaskStatus
        try:
            task.status = TaskStatus(payload.status)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid status")
    if payload.description is not None:
        task.description = payload.description.strip() or None
    db.add(task)
    await db.commit()
    return {"id": task.id, "status": _status_str(task.status), "description": task.description}


@router.post("/client-portal/tasks", status_code=status.HTTP_201_CREATED)
async def portal_create_task(
    payload: PortalTaskCreate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Client adds a task to a project they hold CREATE on (project-scoped)."""
    _require_client(current_user)
    await _require_portal_enabled(db, current_user.tenant_id)
    project = await db.get(Project, payload.project_id)
    if project is None or project.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    if "create" not in await _capability_for_project(db, current_user, project):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't have create access on this project.")
    task = Task(
        tenant_id=current_user.tenant_id, project_id=project.id,
        name=payload.name.strip(), description=(payload.description or "").strip() or None,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return {"id": task.id, "project_id": task.project_id, "name": task.name, "status": _status_str(task.status)}


@router.delete("/client-portal/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def portal_delete_task(
    task_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Client deletes a task they hold DELETE on."""
    _require_client(current_user)
    await _require_portal_enabled(db, current_user.tenant_id)
    task = await db.get(Task, task_id)
    if task is None or task.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    if "delete" not in await _capability_for_task(db, current_user, task):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't have delete access to this task.")
    await db.delete(task)
    await db.commit()


@router.patch("/client-portal/projects/{project_id}")
async def portal_update_project(
    project_id: int,
    payload: PortalProjectUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Client edits a project DESCRIPTION (only) they hold UPDATE on. Name,
    status, billing stay manager-owned."""
    _require_client(current_user)
    await _require_portal_enabled(db, current_user.tenant_id)
    project = await db.get(Project, project_id)
    if project is None or project.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    if "update" not in await _capability_for_project(db, current_user, project):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't have edit access to this project.")
    if payload.description is not None:
        project.description = payload.description.strip() or None
    db.add(project)
    await db.commit()
    return {"id": project.id, "description": project.description}


# ════════════════════════════════════════════════════════════════════════════
#  PM / admin side — /client-grants/*  (NOT allowlisted; CLIENT can't reach)
# ════════════════════════════════════════════════════════════════════════════
async def _assert_grant_project_access(db: AsyncSession, user: User, *, project_id=None, task_id=None) -> int:
    """Resolve the project for a grant scope and assert the PM/admin may manage
    its client. Returns the project_id."""
    if project_id is not None:
        project = await db.get(Project, project_id)
    elif task_id is not None:
        task = await db.get(Task, task_id)
        if task is None or task.tenant_id != user.tenant_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
        project = await db.get(Project, task.project_id)
    else:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A project_id or task_id is required.")
    if project is None or project.tenant_id != user.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    await assert_client_access(db, user, project.client_id)
    return project.id


@router.post("/client-grants/invite", response_model=ClientInviteResponse, status_code=status.HTTP_201_CREATED)
async def invite_client(
    payload: ClientInviteRequest,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Create a CLIENT-role user and email them a set-password invite link.
    Optionally attaches a first grant. The created user is external (no internal
    surface) but — unlike ingestion externals — CAN log in to the client portal.
    """
    require_client_manager(current_user)
    # Normalize to a list of (project_id, task_id, caps) scopes. Prefer the
    # per-scope `grants` form (each project/task with its own caps); fall back
    # to the legacy flat `project_ids` + one shared cap set.
    scopes: list[tuple[Optional[int], Optional[int], list[str]]] = []
    if payload.grants:
        for g in payload.grants:
            if (g.project_id is None) == (g.task_id is None):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="Each grant needs exactly one of project_id or task_id.")
            scopes.append((g.project_id, g.task_id, sorted(set([*(g.capabilities or []), "read"]))))
    else:
        caps = sorted(set([*(payload.capabilities or []), "read"]))
        for pid in sorted(set(payload.project_ids or [])):
            scopes.append((pid, None, caps))

    # Validate every scope up front (PM must manage each project/task's client).
    for project_id, task_id, _ in scopes:
        await _assert_grant_project_access(db, current_user, project_id=project_id, task_id=task_id)

    # Create the CLIENT user via the shared CRUD (handles legacy login mirror).
    from app.crud.user import create_user
    uc = UserCreate(
        full_name=payload.full_name,
        email=payload.email,
        is_external=True,          # external person…
        role=UserRole.CLIENT,      # …but a real login as CLIENT
        title=payload.label or "Client",
        is_active=True,
        tenant_id=current_user.tenant_id,
    )
    try:
        new_user, _temp_pw, _auth0 = await create_user(db, uc)
    except Exception as exc:  # noqa: BLE001
        msg = getattr(getattr(exc, "orig", None), "args", None) or str(exc)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Could not create client user: {msg}")

    # Attach one grant per requested scope (each with its own capabilities).
    if scopes:
        for project_id, task_id, caps in scopes:
            db.add(ClientAccessGrant(
                tenant_id=current_user.tenant_id, user_id=new_user.id,
                project_id=project_id, task_id=task_id,
                capabilities=caps, created_by=current_user.id,
            ))
        await db.commit()

    # Email the set-password invite link (reuse the invitation service). We do
    # this for CLIENTs even though they're external, because they DO log in.
    invited = False
    try:
        from app.services.password_invite import issue_invite_token, build_set_password_url
        from app.services.email_verification import send_local_invitation_email
        from app.api.platform_settings import get_effective_smtp_config
        from app.crud.tenant import get_tenant
        token = await issue_invite_token(db, new_user, purpose="invite")
        await db.commit()
        invite_url = build_set_password_url(token, purpose="invite")
        smtp_config = await get_effective_smtp_config(db)
        tenant = await get_tenant(db, current_user.tenant_id) if current_user.tenant_id else None
        await send_local_invitation_email(new_user, invite_url, smtp_config, tenant.name if tenant else None, current_user.tenant_id)
        invited = True
    except Exception:  # noqa: BLE001 - user is created; invite can be resent
        logger_msg = "client invite email failed; resend from the grant UI"
        return ClientInviteResponse(user_id=new_user.id, email=new_user.email, invited=False, message=logger_msg)

    return ClientInviteResponse(user_id=new_user.id, email=new_user.email, invited=invited,
                                message=f"Invite sent to {new_user.email}.")


@router.get("/client-grants/user/{user_id}", response_model=list[ClientGrantResponse])
async def list_user_grants(
    user_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    require_client_manager(current_user)
    rows = await db.execute(
        select(ClientAccessGrant)
        .where(ClientAccessGrant.user_id == user_id)
        .where(ClientAccessGrant.tenant_id == current_user.tenant_id)
    )
    grants = list(rows.scalars().all())

    # Scope to clients the caller may manage. visible_client_ids returns None
    # for admins (see everything); for a manager it's the set of clients they
    # PM. Without this filter any manager could enumerate any client user's
    # grants (project/task ids + capabilities) for clients they don't manage.
    allowed_clients = await visible_client_ids(db, current_user)
    if allowed_clients is None:
        return grants

    visible: list[ClientAccessGrant] = []
    for g in grants:
        try:
            await _assert_grant_project_access(
                db, current_user, project_id=g.project_id, task_id=g.task_id
            )
        except HTTPException:
            continue
        visible.append(g)
    return visible


@router.get("/client-grants/client/{client_id}", response_model=list[ClientPortalUser])
async def list_client_portal_users(
    client_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Client-side people scoped to THIS client: only users whose grants land on
    a project belonging to client_id. Fixes the cross-client leak where every
    CLIENT user showed under every client."""
    require_client_manager(current_user)
    await assert_client_access(db, current_user, client_id)

    # Project ids owned by this client.
    proj_ids = set((await db.execute(
        select(Project.id).where(Project.client_id == client_id, Project.tenant_id == current_user.tenant_id)
    )).scalars().all())
    if not proj_ids:
        return []

    # Tasks under those projects (so task-scoped grants also count).
    task_ids = set((await db.execute(
        select(Task.id).where(Task.project_id.in_(list(proj_ids)), Task.tenant_id == current_user.tenant_id)
    )).scalars().all())

    grants = (await db.execute(
        select(ClientAccessGrant).where(ClientAccessGrant.tenant_id == current_user.tenant_id)
    )).scalars().all()
    # Keep only grants that touch this client's projects/tasks.
    relevant = [g for g in grants if (g.project_id in proj_ids) or (g.task_id in task_ids)]
    if not relevant:
        return []

    user_ids = {g.user_id for g in relevant}
    users = (await db.execute(
        select(User).where(User.id.in_(list(user_ids)), User.tenant_id == current_user.tenant_id)
    )).scalars().all()
    user_by_id = {u.id: u for u in users}

    out: list[ClientPortalUser] = []
    for uid in user_ids:
        u = user_by_id.get(uid)
        if u is None:
            continue
        out.append(ClientPortalUser(
            user_id=u.id, full_name=u.full_name, email=u.email, label=u.title,
            grants=[g for g in relevant if g.user_id == uid],
        ))
    return out


@router.post("/client-grants", response_model=ClientGrantResponse, status_code=status.HTTP_201_CREATED)
async def create_grant(
    payload: ClientGrantCreate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    require_client_manager(current_user)
    if (payload.project_id is None) == (payload.task_id is None):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Provide exactly one of project_id or task_id.")
    # Target must be a CLIENT user in this tenant.
    target = await db.get(User, payload.user_id)
    if target is None or target.tenant_id != current_user.tenant_id or target.role != UserRole.CLIENT:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Client user not found.")
    await _assert_grant_project_access(db, current_user, project_id=payload.project_id, task_id=payload.task_id)
    grant = ClientAccessGrant(
        tenant_id=current_user.tenant_id, user_id=payload.user_id,
        project_id=payload.project_id, task_id=payload.task_id,
        capabilities=payload.capabilities, created_by=current_user.id,
    )
    db.add(grant)
    await db.commit()
    await db.refresh(grant)
    return grant


@router.put("/client-grants/{grant_id}", response_model=ClientGrantResponse)
async def update_grant(
    grant_id: int,
    payload: ClientGrantUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    require_client_manager(current_user)
    grant = await db.get(ClientAccessGrant, grant_id)
    if grant is None or grant.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Grant not found")
    await _assert_grant_project_access(db, current_user, project_id=grant.project_id, task_id=grant.task_id)
    grant.capabilities = payload.capabilities
    db.add(grant)
    await db.commit()
    await db.refresh(grant)
    return grant


@router.delete("/client-grants/{grant_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_grant(
    grant_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    require_client_manager(current_user)
    grant = await db.get(ClientAccessGrant, grant_id)
    if grant is None or grant.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Grant not found")
    await _assert_grant_project_access(db, current_user, project_id=grant.project_id, task_id=grant.task_id)
    await db.delete(grant)
    await db.commit()


@router.patch("/client-grants/project/{project_id}/toggle")
async def toggle_project_client_access(
    project_id: int,
    payload: ProjectClientAccessToggle,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """PM/admin flips whether a project may be shared with client accounts."""
    require_client_manager(current_user)
    project = await db.get(Project, project_id)
    if project is None or project.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    await assert_client_access(db, current_user, project.client_id)
    project.client_access_enabled = payload.client_access_enabled
    db.add(project)
    await db.commit()
    return {"id": project.id, "client_access_enabled": project.client_access_enabled}
