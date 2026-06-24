"""Client Portal Access API.

Two surfaces:

  /client-portal/*   — the CLIENT user's own view. Allowlisted in get_current_user
                       so a CLIENT can reach these (and nothing else). Every
                       endpoint re-checks the tenant kill switch + that the grant
                       still covers the resource + the required capability.

  /client-grants/*   — PM/admin grant management (create/list/revoke grants).
                       Gated by require_client_manager + assert_client_access,
                       so a CLIENT can't reach it (not allowlisted) AND a manager
                       can only touch their own clients' projects.

Access is governed by the grant alone, plus one tenant-wide kill switch:
  - Tenant kill switch — client_portal_enabled (tenant setting). Off => the
    CLIENT side 403s and grants are inert.
  - The grant itself is the access: a CLIENT sees a project/task only if a grant
    covers it, and a capability ("create"/"read"/"update"/"delete") must be
    present on that grant for the matching verb.
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
from app.models.client_employee_link import ClientEmployeeLink
from app.models.client_task_review import ClientTaskReview
from app.models.user_client_assignment import UserClientAssignment, ClientAssignmentRole
from app.schemas import (
    ClientGrantCreate, ClientGrantUpdate, ClientGrantResponse,
    PortalProject, PortalTask,
    ClientInviteRequest, ClientInviteResponse, UserCreate, ClientPortalUser,
    PortalTaskUpdate, PortalTaskCreate, PortalProjectUpdate,
    ClientManagerContext, ClientEmployeeSummary, ClientEmployeeInvite,
    ClientEmployeeAssign, ClientReviewItem, ClientReviewAction,
    PortalContext, PortalContactInfo,
)

router = APIRouter(tags=["client-portal"])

# Client-side roles. CLIENT is the legacy flat role; CLIENT_MANAGER is the
# senior client person who receives our grants and delegates to their own
# CLIENT_EMPLOYEEs. All three view the portal; only CLIENT/CLIENT_MANAGER hold
# top-level grants from our side.
_CLIENT_VIEW_ROLES = (UserRole.CLIENT, UserRole.CLIENT_MANAGER, UserRole.CLIENT_EMPLOYEE)
# Roles that may hold a ClientAccessGrant (i.e. valid grant targets). Includes
# CLIENT_EMPLOYEE so an internal PM/admin can grant a client employee scoped task
# access directly (e.g. from the task editor's "Client access" section), not only
# the client manager via the portal.
_CLIENT_GRANTEE_ROLES = (UserRole.CLIENT, UserRole.CLIENT_MANAGER, UserRole.CLIENT_EMPLOYEE)


def _is_client_side(user: User) -> bool:
    return user.role in _CLIENT_VIEW_ROLES


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

    A project/task surfaces here iff a grant covers it (the grant is the gate)."""
    if not _is_client_side(current_user):
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

    # Exposure is decided entirely by the grant (plus the tenant kill switch
    # above). There is no separate per-project gate — the grant is the access.
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


_ROLE_LABELS = {
    UserRole.CLIENT: "Client",
    UserRole.CLIENT_MANAGER: "Client manager",
    UserRole.CLIENT_EMPLOYEE: "Client employee",
}


async def _client_ids_for_user(db: AsyncSession, user: User) -> set[int]:
    """The client orgs this client-side user touches (via their grants)."""
    grants = await _load_grants(db, user)
    proj_ids = {g.project_id for g in grants if g.project_id is not None}
    task_ids = {g.task_id for g in grants if g.task_id is not None}
    if task_ids:
        trows = await db.execute(
            select(Task.project_id).where(Task.id.in_(list(task_ids)), Task.tenant_id == user.tenant_id))
        proj_ids |= set(trows.scalars().all())
    if not proj_ids:
        return set()
    crows = await db.execute(
        select(Project.client_id).where(Project.id.in_(list(proj_ids)), Project.tenant_id == user.tenant_id))
    return set(crows.scalars().all())


@router.get("/client-portal/context", response_model=PortalContext)
async def portal_context(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Orienting context for the calling client-side user: their client org(s),
    role, their client manager (if an employee), and the account team (our PMs)."""
    if not _is_client_side(current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Client portal is for client accounts.")
    await _require_portal_enabled(db, current_user.tenant_id)

    client_ids = await _client_ids_for_user(db, current_user)
    client_names: list[str] = []
    if client_ids:
        crows = await db.execute(
            select(Client.name).where(Client.id.in_(list(client_ids)), Client.tenant_id == current_user.tenant_id))
        client_names = sorted(crows.scalars().all())

    # The employee's client manager (if any).
    manager_info: Optional[PortalContactInfo] = None
    if current_user.role == UserRole.CLIENT_EMPLOYEE:
        link = (await db.execute(
            select(ClientEmployeeLink).where(
                ClientEmployeeLink.employee_user_id == current_user.id,
                ClientEmployeeLink.tenant_id == current_user.tenant_id,
            )
        )).scalars().first()
        if link is not None:
            mgr = await db.get(User, link.manager_user_id)
            if mgr is not None:
                manager_info = PortalContactInfo(name=mgr.full_name, title=mgr.title, email=mgr.email)

    # The account team: our internal PMs assigned to these clients.
    account_team: list[PortalContactInfo] = []
    if client_ids:
        pm_user_ids = set((await db.execute(
            select(UserClientAssignment.user_id).where(
                UserClientAssignment.client_id.in_(list(client_ids)),
                UserClientAssignment.tenant_id == current_user.tenant_id,
                UserClientAssignment.assignment_role == ClientAssignmentRole.pm,
            )
        )).scalars().all())
        if pm_user_ids:
            pms = (await db.execute(
                select(User).where(User.id.in_(list(pm_user_ids)), User.tenant_id == current_user.tenant_id)
            )).scalars().all()
            account_team = [
                PortalContactInfo(name=u.full_name, title=u.title, email=u.email)
                for u in sorted(pms, key=lambda x: x.full_name)
            ]

    return PortalContext(
        role=current_user.role.value,
        role_label=_ROLE_LABELS.get(current_user.role, "Client"),
        client_names=client_names,
        manager=manager_info,
        account_team=account_team,
    )


async def _capability_for_task(db: AsyncSession, user: User, task: Task) -> set[str]:
    """The capabilities the CLIENT user holds on this task (project grant inherited
    or a direct task grant). Empty = no access. The grant is the sole gate."""
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
    if not _is_client_side(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Client portal is for client accounts.")


def _forbid_employee_mutation(user: User) -> None:
    """A CLIENT_EMPLOYEE may never create or delete, regardless of grant caps.
    Their portal is read+update only."""
    if user.role == UserRole.CLIENT_EMPLOYEE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Client employees can view and update assigned tasks, but cannot create or delete.",
        )


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

    # When a CLIENT_EMPLOYEE updates a task, flag it for their manager's review
    # (upsert one pending review per task+employee; the latest update resets it).
    if current_user.role == UserRole.CLIENT_EMPLOYEE:
        await _upsert_employee_review(db, current_user, task)

    await db.commit()
    return {"id": task.id, "status": _status_str(task.status), "description": task.description}


async def _upsert_employee_review(db: AsyncSession, employee: User, task: Task) -> None:
    """Create or reset a pending review row when an employee updates a task. The
    manager is the employee's linked client manager."""
    from datetime import datetime, timezone

    link = (await db.execute(
        select(ClientEmployeeLink).where(
            ClientEmployeeLink.employee_user_id == employee.id,
            ClientEmployeeLink.tenant_id == employee.tenant_id,
        )
    )).scalars().first()
    manager_id = link.manager_user_id if link else None

    review = (await db.execute(
        select(ClientTaskReview).where(
            ClientTaskReview.task_id == task.id,
            ClientTaskReview.employee_user_id == employee.id,
            ClientTaskReview.tenant_id == employee.tenant_id,
        )
    )).scalars().first()
    now = datetime.now(timezone.utc)
    if review is None:
        review = ClientTaskReview(
            tenant_id=employee.tenant_id, task_id=task.id,
            employee_user_id=employee.id, manager_user_id=manager_id,
            status="pending", submitted_at=now,
        )
    else:
        review.status = "pending"
        review.submitted_at = now
        review.reviewed_at = None
        review.manager_user_id = manager_id
    db.add(review)


@router.post("/client-portal/tasks", status_code=status.HTTP_201_CREATED)
async def portal_create_task(
    payload: PortalTaskCreate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Client adds a task to a project they hold CREATE on (project-scoped)."""
    _require_client(current_user)
    _forbid_employee_mutation(current_user)
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
    _forbid_employee_mutation(current_user)
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
#  CLIENT_MANAGER side — /client-portal/manage/*  (allowlisted; the client
#  manager delegates to their own employees, bounded by their own grant set)
# ════════════════════════════════════════════════════════════════════════════
def _require_client_manager_role(user: User) -> None:
    if user.role != UserRole.CLIENT_MANAGER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This action is for client managers.",
        )


async def _manager_grant_scope(db: AsyncSession, manager: User) -> tuple[set[int], set[int], set[int]]:
    """The manager's delegatable scope, derived from their OWN grants:
      - project_ids they hold (whole-project grants)
      - task_ids they hold (direct task grants)
      - client_ids those projects/tasks belong to (the clients they manage)
    A manager can only assign employees within this scope."""
    grants = await _load_grants(db, manager)
    proj_ids = {g.project_id for g in grants if g.project_id is not None}
    task_ids = {g.task_id for g in grants if g.task_id is not None}

    # Resolve the client ids for those projects + the projects owning the tasks.
    client_ids: set[int] = set()
    all_proj_ids = set(proj_ids)
    if task_ids:
        trows = await db.execute(
            select(Task.id, Task.project_id).where(
                Task.id.in_(list(task_ids)), Task.tenant_id == manager.tenant_id)
        )
        for _tid, pid in trows.all():
            all_proj_ids.add(pid)
    if all_proj_ids:
        prows = await db.execute(
            select(Project.id, Project.client_id).where(
                Project.id.in_(list(all_proj_ids)), Project.tenant_id == manager.tenant_id)
        )
        for _pid, cid in prows.all():
            client_ids.add(cid)
    return proj_ids, task_ids, client_ids


async def _client_self_manage_on(db: AsyncSession, tenant_id: int, client_id: int) -> bool:
    """Whether a client has the self-manage toggle on (client manager may invite
    + assign their own employees). When off, only the internal account team
    (PM/admin) does that."""
    return bool((await db.execute(
        select(Client.client_self_manage_enabled).where(
            Client.id == client_id, Client.tenant_id == tenant_id)
    )).scalar_one_or_none())


async def _client_of_scope(db: AsyncSession, tenant_id: int, *, project_id=None, task_id=None) -> Optional[int]:
    """Resolve the owning client id for a project- or task-scoped grant."""
    pid = project_id
    if pid is None and task_id is not None:
        task = await db.get(Task, task_id)
        pid = task.project_id if task else None
    if pid is None:
        return None
    return (await db.execute(
        select(Project.client_id).where(Project.id == pid, Project.tenant_id == tenant_id)
    )).scalar_one_or_none()


async def _require_self_manage_for_scope(
    db: AsyncSession, manager: User, *, project_id=None, task_id=None
) -> None:
    """403 unless the client owning this scope has self-manage on. Gates a client
    manager's assign/unassign — when off, the internal account team handles it."""
    client_id = await _client_of_scope(db, manager.tenant_id, project_id=project_id, task_id=task_id)
    if client_id is None or not await _client_self_manage_on(db, manager.tenant_id, client_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Assigning work to employees is turned off for your client. "
                "Your account team handles assignments."
            ),
        )


async def _manager_can_delegate(db: AsyncSession, manager: User, *, project_id=None, task_id=None) -> bool:
    """Whether the manager may delegate this scope to an employee.

    Delegation is bounded to the manager's WHOLE-PROJECT grants: a project they
    hold, or a task that sits UNDER a project they hold. A task the manager holds
    only via a direct TASK grant (their own personal assignment) is NOT
    delegatable — that's their own work, not theirs to hand out."""
    proj_ids, _task_ids, _ = await _manager_grant_scope(db, manager)
    if project_id is not None:
        return project_id in proj_ids
    if task_id is not None:
        task = await db.get(Task, task_id)
        return bool(task and task.project_id in proj_ids)
    return False


async def _manager_employee_ids(db: AsyncSession, manager: User) -> list[int]:
    rows = await db.execute(
        select(ClientEmployeeLink.employee_user_id)
        .where(ClientEmployeeLink.manager_user_id == manager.id)
        .where(ClientEmployeeLink.tenant_id == manager.tenant_id)
    )
    return list(rows.scalars().all())


async def _client_manager_ids_for_client(db: AsyncSession, tenant_id: int, client_id: int) -> list[int]:
    """CLIENT_MANAGER users who hold a grant on a project belonging to client_id
    (i.e. the client's managers). Used to auto-link/choose an employee's manager."""
    proj_ids = set((await db.execute(
        select(Project.id).where(Project.client_id == client_id, Project.tenant_id == tenant_id)
    )).scalars().all())
    if not proj_ids:
        return []
    task_ids = set((await db.execute(
        select(Task.id).where(Task.project_id.in_(list(proj_ids)), Task.tenant_id == tenant_id)
    )).scalars().all())
    grant_rows = (await db.execute(
        select(ClientAccessGrant.user_id, ClientAccessGrant.project_id, ClientAccessGrant.task_id)
        .where(ClientAccessGrant.tenant_id == tenant_id)
    )).all()
    candidate_uids = {
        uid for uid, pid, tid in grant_rows
        if (pid in proj_ids) or (tid in task_ids)
    }
    if not candidate_uids:
        return []
    mgr_rows = (await db.execute(
        select(User.id).where(
            User.id.in_(list(candidate_uids)),
            User.tenant_id == tenant_id,
            User.role == UserRole.CLIENT_MANAGER,
        )
    )).scalars().all()
    return list(mgr_rows)


@router.get("/client-portal/manage/me", response_model=ClientManagerContext)
async def manager_context(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _require_client_manager_role(current_user)
    await _require_portal_enabled(db, current_user.tenant_id)
    _, _, client_ids = await _manager_grant_scope(db, current_user)
    names: list[str] = []
    can_invite = False
    if client_ids:
        crows = await db.execute(
            select(Client.id, Client.name, Client.client_self_manage_enabled)
            .where(Client.id.in_(list(client_ids)), Client.tenant_id == current_user.tenant_id)
        )
        for _cid, name, self_manage in crows.all():
            names.append(name)
            if self_manage:
                can_invite = True
    emp_ids = await _manager_employee_ids(db, current_user)
    return ClientManagerContext(
        client_ids=sorted(client_ids), client_names=sorted(names),
        can_invite_employees=can_invite, employee_count=len(emp_ids),
    )


@router.get("/client-portal/manage/employees", response_model=list[ClientEmployeeSummary])
async def manager_list_employees(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _require_client_manager_role(current_user)
    await _require_portal_enabled(db, current_user.tenant_id)
    emp_ids = await _manager_employee_ids(db, current_user)
    if not emp_ids:
        return []
    users = (await db.execute(
        select(User).where(User.id.in_(emp_ids), User.tenant_id == current_user.tenant_id)
    )).scalars().all()
    # Each employee's grants = their assignments. Resolve project/task names so
    # the manager sees WHAT they're working on, not just a count.
    grants = (await db.execute(
        select(ClientAccessGrant)
        .where(ClientAccessGrant.user_id.in_(emp_ids))
        .where(ClientAccessGrant.tenant_id == current_user.tenant_id)
    )).scalars().all()
    proj_ids = {g.project_id for g in grants if g.project_id is not None}
    task_ids = {g.task_id for g in grants if g.task_id is not None}
    proj_name = {pid: name for pid, name in (await db.execute(
        select(Project.id, Project.name).where(Project.id.in_(list(proj_ids) or [-1]))
    )).all()}
    task_rows = (await db.execute(
        select(Task.id, Task.name, Task.project_id).where(Task.id.in_(list(task_ids) or [-1]))
    )).all()
    task_name = {tid: name for tid, name, _ in task_rows}
    task_proj = {tid: pid for tid, _, pid in task_rows}
    # task names may need their project name too
    for _tid, _n, pid in task_rows:
        if pid not in proj_name:
            row = (await db.execute(select(Project.name).where(Project.id == pid))).scalar_one_or_none()
            if row:
                proj_name[pid] = row

    from app.schemas import ClientEmployeeAssignmentInfo
    by_user: dict[int, list[ClientEmployeeAssignmentInfo]] = {}
    for g in grants:
        if g.project_id is not None:
            info = ClientEmployeeAssignmentInfo(
                grant_id=g.id, scope="project", project_id=g.project_id,
                project_name=proj_name.get(g.project_id), capabilities=list(g.capabilities or []))
        else:
            pid = task_proj.get(g.task_id)
            info = ClientEmployeeAssignmentInfo(
                grant_id=g.id, scope="task", task_id=g.task_id,
                task_name=task_name.get(g.task_id), project_id=pid,
                project_name=proj_name.get(pid) if pid else None,
                capabilities=list(g.capabilities or []))
        by_user.setdefault(g.user_id, []).append(info)

    return [
        ClientEmployeeSummary(
            user_id=u.id, full_name=u.full_name, email=u.email, label=u.title,
            email_verified=bool(u.email_verified),
            assignment_count=len(by_user.get(u.id, [])),
            assignments=by_user.get(u.id, []),
        )
        for u in users
    ]


@router.get("/client-portal/manage/assignable", response_model=list[PortalProject])
async def manager_assignable_scope(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """The work a manager can DELEGATE to their employees: only the projects they
    hold a WHOLE-PROJECT grant on, with all of those projects' tasks.

    Deliberately excludes the manager's direct TASK grants — a task granted to
    the manager personally is their own assignment, not something they hand out.
    (The manager's own work lives on the "My work" tab; this list is purely the
    pool they can staff their team onto.)"""
    _require_client_manager_role(current_user)
    await _require_portal_enabled(db, current_user.tenant_id)

    grants = await _load_grants(db, current_user)
    # Whole-project grants only — these are what the manager may delegate.
    proj_caps: dict[int, list[str]] = {}
    for g in grants:
        if g.project_id is not None:
            proj_caps[g.project_id] = sorted(set(proj_caps.get(g.project_id, []) + list(g.capabilities or [])))
    if not proj_caps:
        return []

    prows = await db.execute(
        select(Project).where(
            Project.id.in_(list(proj_caps.keys())),
            Project.tenant_id == current_user.tenant_id,
        )
    )
    projects = {p.id: p for p in prows.scalars().all()}
    if not projects:
        return []

    crows = await db.execute(
        select(Client.id, Client.name).where(Client.tenant_id == current_user.tenant_id))
    client_name = {cid: name for cid, name in crows.all()}

    trows = await db.execute(
        select(Task).where(
            Task.project_id.in_(list(projects.keys())),
            Task.tenant_id == current_user.tenant_id,
        )
    )
    tasks_by_project: dict[int, list[Task]] = {}
    for t in trows.scalars().all():
        tasks_by_project.setdefault(t.project_id, []).append(t)

    out: list[PortalProject] = []
    for pid, p in projects.items():
        pcaps = proj_caps.get(pid, [])
        portal_tasks = [
            PortalTask(
                id=t.id, project_id=pid, name=t.name, description=t.description,
                status=_status_str(t.status), capabilities=pcaps,
            )
            for t in tasks_by_project.get(pid, [])
        ]
        out.append(PortalProject(
            id=p.id, name=p.name, code=p.code, client_id=p.client_id,
            client_name=client_name.get(p.client_id), status=_status_str(p.status),
            description=p.description, capabilities=pcaps, tasks=portal_tasks,
        ))
    return out


@router.post("/client-portal/manage/assign", status_code=status.HTTP_201_CREATED)
async def manager_assign_employee(
    payload: ClientEmployeeAssign,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Assign one of the manager's employees to a task (or whole project) the
    manager holds. Creates a child ClientAccessGrant for the employee, capped to
    read/update."""
    _require_client_manager_role(current_user)
    await _require_portal_enabled(db, current_user.tenant_id)
    if (payload.project_id is None) == (payload.task_id is None):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="Provide exactly one of project_id or task_id.")
    # The employee must be one of the manager's own employees.
    if payload.employee_user_id not in set(await _manager_employee_ids(db, current_user)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not one of your client employees.")
    # The scope must be within what the manager holds.
    if not await _manager_can_delegate(db, current_user, project_id=payload.project_id, task_id=payload.task_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="You can only assign work that has been shared with you.")
    # Self-manage toggle: a client manager may only assign when their client has
    # self-manage on; otherwise the internal account team does assignments.
    await _require_self_manage_for_scope(db, current_user, project_id=payload.project_id, task_id=payload.task_id)
    # Avoid duplicate grant for the same scope.
    existing = (await db.execute(
        select(ClientAccessGrant).where(
            ClientAccessGrant.user_id == payload.employee_user_id,
            ClientAccessGrant.tenant_id == current_user.tenant_id,
            ClientAccessGrant.project_id == payload.project_id,
            ClientAccessGrant.task_id == payload.task_id,
        )
    )).scalars().first()
    if existing is not None:
        existing.capabilities = payload.capabilities
        db.add(existing)
        await db.commit()
        await db.refresh(existing)
        return {"id": existing.id, "updated": True}
    grant = ClientAccessGrant(
        tenant_id=current_user.tenant_id, user_id=payload.employee_user_id,
        project_id=payload.project_id, task_id=payload.task_id,
        capabilities=payload.capabilities, created_by=current_user.id,
    )
    db.add(grant)
    await db.commit()
    await db.refresh(grant)
    return {"id": grant.id, "updated": False}


@router.delete("/client-portal/manage/assign/{grant_id}", status_code=status.HTTP_204_NO_CONTENT)
async def manager_unassign_employee(
    grant_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Remove an employee assignment. Only grants the manager created, for their
    own employees, can be removed here."""
    _require_client_manager_role(current_user)
    await _require_portal_enabled(db, current_user.tenant_id)
    grant = await db.get(ClientAccessGrant, grant_id)
    if grant is None or grant.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Assignment not found")
    if grant.user_id not in set(await _manager_employee_ids(db, current_user)):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your employee's assignment.")
    # Self-manage toggle gates unassign too (symmetric with assign).
    await _require_self_manage_for_scope(db, current_user, project_id=grant.project_id, task_id=grant.task_id)
    await db.delete(grant)
    await db.commit()


@router.post("/client-portal/manage/employees/invite", response_model=ClientInviteResponse, status_code=status.HTTP_201_CREATED)
async def manager_invite_employee(
    payload: ClientEmployeeInvite,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """A CLIENT_MANAGER creates one of their own client employees + emails a
    set-password invite. Allowed only when a managed client has self-manage on."""
    _require_client_manager_role(current_user)
    await _require_portal_enabled(db, current_user.tenant_id)

    _, _, client_ids = await _manager_grant_scope(db, current_user)
    if not client_ids:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't manage any clients yet.")
    # Find a self-manage-enabled client to attach the employee to.
    enabled_client = (await db.execute(
        select(Client.id).where(
            Client.id.in_(list(client_ids)),
            Client.tenant_id == current_user.tenant_id,
            Client.client_self_manage_enabled.is_(True),
        ).limit(1)
    )).scalars().first()
    if enabled_client is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Self-managing employees is turned off for your client. Ask your account team to enable it.",
        )

    from app.crud.user import create_user, get_user_by_email
    from sqlalchemy.exc import IntegrityError

    existing = await get_user_by_email(db, payload.email)
    if existing is not None and existing.tenant_id == current_user.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{payload.email} already belongs to a user in this workspace.",
        )

    uc = UserCreate(
        full_name=payload.full_name, email=payload.email,
        is_external=True, role=UserRole.CLIENT_EMPLOYEE,
        title=payload.label or "Client employee", is_active=True,
        tenant_id=current_user.tenant_id,
    )
    try:
        new_user, _pw, _auth0 = await create_user(db, uc)
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail=f"A user with the email {payload.email} already exists.")
    except Exception:  # noqa: BLE001
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Could not create the employee. Please check the details and try again.")

    # Link the employee to this manager + client.
    db.add(ClientEmployeeLink(
        tenant_id=current_user.tenant_id, employee_user_id=new_user.id,
        manager_user_id=current_user.id, client_id=enabled_client,
    ))
    await db.commit()

    # Email the set-password invite (client-portal framing).
    try:
        from app.services.password_invite import issue_invite_token, build_set_password_url
        from app.services.email_verification import send_client_portal_invitation_email
        from app.api.platform_settings import get_effective_smtp_config
        from app.crud.tenant import get_tenant
        token = await issue_invite_token(db, new_user, purpose="invite")
        await db.commit()
        invite_url = build_set_password_url(token, purpose="invite")
        smtp_config = await get_effective_smtp_config(db)
        tenant = await get_tenant(db, current_user.tenant_id) if current_user.tenant_id else None
        await send_client_portal_invitation_email(new_user, invite_url, smtp_config, tenant.name if tenant else None, current_user.tenant_id)
    except Exception:  # noqa: BLE001
        return ClientInviteResponse(user_id=new_user.id, email=new_user.email, invited=False,
                                    message="Employee created; invite email failed, resend later.")
    return ClientInviteResponse(user_id=new_user.id, email=new_user.email, invited=True,
                                message=f"Invite sent to {new_user.email}.")


@router.delete("/client-portal/manage/employees/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def manager_remove_employee(
    user_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Remove an employee from the manager's team: unlinks them and revokes all
    their grants. The user row is left (deactivated) for audit."""
    _require_client_manager_role(current_user)
    await _require_portal_enabled(db, current_user.tenant_id)
    link = (await db.execute(
        select(ClientEmployeeLink).where(
            ClientEmployeeLink.employee_user_id == user_id,
            ClientEmployeeLink.manager_user_id == current_user.id,
            ClientEmployeeLink.tenant_id == current_user.tenant_id,
        )
    )).scalars().first()
    if link is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not your client employee.")
    # Revoke their grants and deactivate.
    grants = (await db.execute(
        select(ClientAccessGrant).where(
            ClientAccessGrant.user_id == user_id,
            ClientAccessGrant.tenant_id == current_user.tenant_id,
        )
    )).scalars().all()
    for g in grants:
        await db.delete(g)
    target = await db.get(User, user_id)
    if target is not None:
        target.is_active = False
        db.add(target)
    await db.delete(link)
    await db.commit()


@router.get("/client-portal/manage/review", response_model=list[ClientReviewItem])
async def manager_review_feed(
    status_filter: Optional[str] = None,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """The manager's review feed: their employees' task updates. Defaults to
    pending; pass status_filter=approved|rejected|all to widen."""
    _require_client_manager_role(current_user)
    await _require_portal_enabled(db, current_user.tenant_id)
    q = (
        select(ClientTaskReview)
        .where(ClientTaskReview.manager_user_id == current_user.id)
        .where(ClientTaskReview.tenant_id == current_user.tenant_id)
    )
    if status_filter in ("pending", "approved", "rejected"):
        q = q.where(ClientTaskReview.status == status_filter)
    elif status_filter != "all":
        q = q.where(ClientTaskReview.status == "pending")
    reviews = (await db.execute(q.order_by(ClientTaskReview.submitted_at.desc().nullslast()))).scalars().all()
    if not reviews:
        return []

    task_ids = {r.task_id for r in reviews}
    emp_ids = {r.employee_user_id for r in reviews}
    tasks = {t.id: t for t in (await db.execute(
        select(Task).where(Task.id.in_(list(task_ids)), Task.tenant_id == current_user.tenant_id)
    )).scalars().all()}
    proj_ids = {t.project_id for t in tasks.values()}
    proj_names = {pid: name for pid, name in (await db.execute(
        select(Project.id, Project.name).where(Project.id.in_(list(proj_ids)))
    )).all()}
    emp_names = {uid: name for uid, name in (await db.execute(
        select(User.id, User.full_name).where(User.id.in_(list(emp_ids)))
    )).all()}

    out: list[ClientReviewItem] = []
    for r in reviews:
        t = tasks.get(r.task_id)
        out.append(ClientReviewItem(
            review_id=r.id, task_id=r.task_id,
            task_name=t.name if t else f"Task #{r.task_id}",
            project_name=proj_names.get(t.project_id) if t else None,
            employee_user_id=r.employee_user_id,
            employee_name=emp_names.get(r.employee_user_id, f"#{r.employee_user_id}"),
            status=r.status, note=r.note,
            task_status=_status_str(t.status) if t else None,
            submitted_at=r.submitted_at, reviewed_at=r.reviewed_at,
        ))
    return out


async def _act_on_review(db: AsyncSession, manager: User, review_id: int, new_status: str, note: Optional[str]):
    from datetime import datetime, timezone
    review = await db.get(ClientTaskReview, review_id)
    if review is None or review.tenant_id != manager.tenant_id or review.manager_user_id != manager.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Review item not found.")
    review.status = new_status
    review.note = (note or "").strip() or None
    review.reviewed_at = datetime.now(timezone.utc)
    db.add(review)
    await db.commit()
    return {"review_id": review.id, "status": review.status}


@router.post("/client-portal/manage/review/{review_id}/approve")
async def manager_approve_review(
    review_id: int,
    payload: ClientReviewAction,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _require_client_manager_role(current_user)
    await _require_portal_enabled(db, current_user.tenant_id)
    return await _act_on_review(db, current_user, review_id, "approved", payload.note)


@router.post("/client-portal/manage/review/{review_id}/reject")
async def manager_reject_review(
    review_id: int,
    payload: ClientReviewAction,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _require_client_manager_role(current_user)
    await _require_portal_enabled(db, current_user.tenant_id)
    return await _act_on_review(db, current_user, review_id, "rejected", payload.note)


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

    # Resolve the role to create. "employee" => CLIENT_EMPLOYEE, linked to the
    # client's manager (auto when there's one; PM-chosen when several). Anything
    # else => CLIENT_MANAGER (the default).
    as_employee = (payload.portal_role or "manager").lower() == "employee"
    new_role = UserRole.CLIENT_EMPLOYEE if as_employee else UserRole.CLIENT_MANAGER
    resolved_manager_id: Optional[int] = None
    resolved_client_id: Optional[int] = None
    if as_employee:
        # Determine the client from the first grant scope.
        if not scopes:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="A client employee must be invited with at least one project or task to work on.")
        first_pid, first_tid, _ = scopes[0]
        owning_project_id = await _assert_grant_project_access(
            db, current_user, project_id=first_pid, task_id=first_tid)
        owning_project = await db.get(Project, owning_project_id)
        resolved_client_id = owning_project.client_id if owning_project else None
        if resolved_client_id is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Could not resolve the client.")
        # Find the client's managers (CLIENT_MANAGERs with a grant on this client).
        manager_ids = await _client_manager_ids_for_client(db, current_user.tenant_id, resolved_client_id)
        if not manager_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Add a client manager for this client before adding client employees.")
        if payload.manager_user_id is not None:
            if payload.manager_user_id not in manager_ids:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Chosen manager doesn't manage this client.")
            resolved_manager_id = payload.manager_user_id
        elif len(manager_ids) == 1:
            resolved_manager_id = manager_ids[0]
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This client has multiple managers. Choose which one this employee reports to.")

    # Create the CLIENT user via the shared CRUD (handles legacy login mirror).
    from app.crud.user import create_user, get_user_by_email
    from sqlalchemy.exc import IntegrityError

    # Pre-check the email so a collision returns a clear message instead of a
    # raw DB unique-constraint error. The email may already belong to an
    # internal user (can't reuse it) or another client (grant them instead).
    if payload.email:
        existing = await get_user_by_email(db, payload.email)
        if existing is not None and existing.tenant_id == current_user.tenant_id:
            if existing.role in _CLIENT_GRANTEE_ROLES:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        f"{payload.email} is already a client account. Add the "
                        "projects to their existing access instead of inviting "
                        "them again."
                    ),
                )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"{payload.email} already belongs to a {existing.role.value.lower()} "
                    "user in this workspace, so it can't be used for a client "
                    "account. Use a different email address."
                ),
            )

    uc = UserCreate(
        full_name=payload.full_name,
        email=payload.email,
        is_external=True,                  # external person…
        role=new_role,                     # …CLIENT_MANAGER or CLIENT_EMPLOYEE
        title=payload.label or ("Client employee" if as_employee else "Client"),
        is_active=True,
        tenant_id=current_user.tenant_id,
        # Durable client association so the account always shows under its client
        # even with zero grants (revoking all access must not hide the account).
        default_client_id=resolved_client_id,
    )
    try:
        new_user, _temp_pw, _auth0 = await create_user(db, uc)
    except IntegrityError:
        # Race / legacy-index collision the pre-check didn't catch.
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A user with the email {payload.email} already exists in this workspace.",
        )
    except Exception:  # noqa: BLE001 — don't leak DB internals; roll back cleanly
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not create the client account. Please check the details and try again.",
        )

    # Attach one grant per requested scope (each with its own capabilities). For
    # an employee, clamp caps to read/update (they can never create/delete).
    if scopes:
        for project_id, task_id, caps in scopes:
            grant_caps = [c for c in caps if c in ("read", "update")] if as_employee else caps
            if as_employee and "read" not in grant_caps:
                grant_caps.append("read")
            db.add(ClientAccessGrant(
                tenant_id=current_user.tenant_id, user_id=new_user.id,
                project_id=project_id, task_id=task_id,
                capabilities=sorted(set(grant_caps)), created_by=current_user.id,
            ))
        await db.commit()

    # Link a new employee to their client manager.
    if as_employee and resolved_manager_id is not None and resolved_client_id is not None:
        db.add(ClientEmployeeLink(
            tenant_id=current_user.tenant_id, employee_user_id=new_user.id,
            manager_user_id=resolved_manager_id, client_id=resolved_client_id,
        ))
        await db.commit()

    # Email the set-password invite link. CLIENTs log in too, but they get
    # CLIENT-PORTAL framing — not the internal "Welcome to Acufy Timesheet"
    # account email.
    invited = False
    try:
        from app.services.password_invite import issue_invite_token, build_set_password_url
        from app.services.email_verification import send_client_portal_invitation_email
        from app.api.platform_settings import get_effective_smtp_config
        from app.crud.tenant import get_tenant
        token = await issue_invite_token(db, new_user, purpose="invite")
        await db.commit()
        invite_url = build_set_password_url(token, purpose="invite")
        smtp_config = await get_effective_smtp_config(db)
        tenant = await get_tenant(db, current_user.tenant_id) if current_user.tenant_id else None
        await send_client_portal_invitation_email(new_user, invite_url, smtp_config, tenant.name if tenant else None, current_user.tenant_id)
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

    # The list is the UNION of every client user associated with this client,
    # regardless of grants — an invited client account must ALWAYS show here so
    # you can re-grant or remove it even after all its access is revoked. Sources:
    #   (a) people with a grant on this client's projects/tasks,
    #   (b) people associated via client_employee_links (managers + employees),
    #   (c) people whose durable home is this client (users.default_client_id),
    #       which is the invite-time signal that survives zero grants/links.
    link_rows = (await db.execute(
        select(ClientEmployeeLink.manager_user_id, ClientEmployeeLink.employee_user_id)
        .where(
            ClientEmployeeLink.client_id == client_id,
            ClientEmployeeLink.tenant_id == current_user.tenant_id,
        )
    )).all()
    linked_ids: set[int] = set()
    for mgr_id, emp_id in link_rows:
        if mgr_id is not None:
            linked_ids.add(mgr_id)
        if emp_id is not None:
            linked_ids.add(emp_id)

    home_ids = set((await db.execute(
        select(User.id).where(
            User.default_client_id == client_id,
            User.tenant_id == current_user.tenant_id,
            User.role.in_([UserRole.CLIENT, UserRole.CLIENT_MANAGER, UserRole.CLIENT_EMPLOYEE]),
        )
    )).scalars().all())

    user_ids = {g.user_id for g in relevant} | linked_ids | home_ids
    if not user_ids:
        return []

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
            email_verified=bool(u.email_verified),
            grants=[g for g in relevant if g.user_id == uid],
        ))
    return out


@router.post("/client-grants/user/{user_id}/resend-invite")
async def resend_client_invite(
    user_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Re-send the client-portal set-password invite to a CLIENT user who hasn't
    accepted yet. Uses the client-portal email (not the internal one), and the
    internal resend endpoint rejects external users — so clients need this one."""
    require_client_manager(current_user)
    target = await db.get(User, user_id)
    if target is None or target.tenant_id != current_user.tenant_id or target.role not in _CLIENT_GRANTEE_ROLES:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Client user not found.")
    # The caller must manage at least one client this user has a grant on.
    grants = (await db.execute(
        select(ClientAccessGrant).where(
            ClientAccessGrant.user_id == user_id,
            ClientAccessGrant.tenant_id == current_user.tenant_id,
        )
    )).scalars().all()
    if not grants:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No grants for this client user.")
    allowed = await visible_client_ids(db, current_user)
    if allowed is not None:
        ok = False
        for g in grants:
            try:
                await _assert_grant_project_access(db, current_user, project_id=g.project_id, task_id=g.task_id)
                ok = True
                break
            except HTTPException:
                continue
        if not ok:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You don't manage this client.")

    from app.services.password_invite import issue_invite_token, build_set_password_url
    from app.services.email_verification import send_client_portal_invitation_email
    from app.api.platform_settings import get_effective_smtp_config
    from app.crud.tenant import get_tenant
    token = await issue_invite_token(db, target, purpose="invite")
    await db.commit()
    invite_url = build_set_password_url(token, purpose="invite")
    smtp_config = await get_effective_smtp_config(db)
    tenant = await get_tenant(db, current_user.tenant_id) if current_user.tenant_id else None
    await send_client_portal_invitation_email(
        target, invite_url, smtp_config, tenant.name if tenant else None, current_user.tenant_id)
    return {"message": f"Invite re-sent to {target.email}."}


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
    if target is None or target.tenant_id != current_user.tenant_id or target.role not in _CLIENT_GRANTEE_ROLES:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Client user not found.")
    await _assert_grant_project_access(
        db, current_user, project_id=payload.project_id, task_id=payload.task_id)
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
