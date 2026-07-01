import re

from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload
from app.models.project import Project
from app.models.task import Task
from app.models.user import User, UserRole
from app.models.assignments import UserProjectAccess, UserTaskAccess, ProjectManager
from app.schemas import ProjectCreate, ProjectUpdate
from typing import Optional

# Auto project code: "PR" + zero-padded sequence (PR0001, PR0002, ...).
PROJECT_CODE_PREFIX = "PR"
PROJECT_CODE_PAD = 4
_PROJECT_CODE_RE = re.compile(r"^PR0*(\d+)$")


async def next_project_code(db: AsyncSession, tenant_id: int) -> str:
    """The next sequential project code for a tenant, e.g. PR0037.

    Derived from max(highest existing PR#### suffix, project count) + 1 so the
    sequence keeps climbing and never re-issues a code after a project is
    deleted (codes aren't unique-constrained, so we avoid collisions ourselves).
    """
    count = await db.scalar(
        select(func.count(Project.id)).where(Project.tenant_id == tenant_id)
    ) or 0
    codes = (await db.execute(
        select(Project.code).where(
            Project.tenant_id == tenant_id, Project.code.is_not(None))
    )).scalars().all()
    max_suffix = 0
    for c in codes:
        m = _PROJECT_CODE_RE.match((c or "").strip())
        if m:
            max_suffix = max(max_suffix, int(m.group(1)))
    nxt = max(max_suffix, count) + 1
    return f"{PROJECT_CODE_PREFIX}{nxt:0{PROJECT_CODE_PAD}d}"


async def get_project_by_id(db: AsyncSession, project_id: int, tenant_id: Optional[int] = None) -> Optional[Project]:
    """Get project by ID, scoped to a tenant. Pass tenant_id=None only for PLATFORM_ADMIN."""
    query = select(Project).where(Project.id == project_id)
    if tenant_id is not None:
        query = query.where(Project.tenant_id == tenant_id)
    query = query.options(selectinload(Project.client))
    result = await db.execute(query)
    return result.scalars().first()


async def create_project(db: AsyncSession, project_create: ProjectCreate, tenant_id: int) -> Project:
    """Create a new project. resource_ids/manager_ids (not columns) seed the
    roster and the PM list."""
    data = project_create.model_dump()
    resource_ids = data.pop("resource_ids", None)
    manager_ids = data.pop("manager_ids", None)
    # Keep the single manager_id column as the first PM for back-compat.
    if manager_ids:
        data["manager_id"] = manager_ids[0]
    # Auto-assign a sequential code (PR####) when none was supplied, so the
    # client never has to invent one. A code the caller did send is respected.
    if not (data.get("code") or "").strip():
        data["code"] = await next_project_code(db, tenant_id)
    db_project = Project(**data, tenant_id=tenant_id)
    db.add(db_project)
    try:
        await db.commit()
        await db.refresh(db_project)
    except IntegrityError:
        await db.rollback()
        raise
    if resource_ids is not None:
        await set_project_roster(db, db_project.id, resource_ids)
    if manager_ids is not None:
        await set_project_managers(db, db_project.id, manager_ids, tenant_id)
    return await get_project_by_id(db, db_project.id, tenant_id=tenant_id)


async def update_project(db: AsyncSession, project: Project, project_update: ProjectUpdate) -> Project:
    """Update project fields. resource_ids/manager_ids (when present) replace
    the roster / PM list."""
    update_data = project_update.model_dump(exclude_unset=True)
    resource_ids = update_data.pop("resource_ids", None)
    manager_ids = update_data.pop("manager_ids", None)
    # Normalize an explicit "" client_health back to NULL (hidden from client).
    if update_data.get("client_health") == "":
        update_data["client_health"] = None
    # When PMs are supplied, mirror the first into the single manager_id column.
    if manager_ids is not None:
        update_data["manager_id"] = manager_ids[0] if manager_ids else None
    for field, value in update_data.items():
        setattr(project, field, value)

    db.add(project)
    await db.commit()
    await db.refresh(project)
    if resource_ids is not None:
        await set_project_roster(db, project.id, resource_ids)
    if manager_ids is not None:
        await set_project_managers(db, project.id, manager_ids, project.tenant_id)
    return await get_project_by_id(db, project.id, tenant_id=project.tenant_id)


async def get_project_manager_ids(db: AsyncSession, project_id: int) -> list[int]:
    result = await db.execute(
        select(ProjectManager.user_id).where(ProjectManager.project_id == project_id)
    )
    return list(result.scalars().all())


async def set_project_managers(db: AsyncSession, project_id: int, user_ids: list[int], tenant_id: int) -> None:
    """Replace a project's manager list (project_managers)."""
    target = set(user_ids)
    rows = (
        await db.execute(
            select(ProjectManager).where(ProjectManager.project_id == project_id)
        )
    ).scalars().all()
    existing = {r.user_id for r in rows}
    for row in rows:
        if row.user_id not in target:
            await db.delete(row)
    for uid in target - existing:
        db.add(ProjectManager(project_id=project_id, user_id=uid, tenant_id=tenant_id))
    await db.commit()


async def validate_project_manager_ids(
    db: AsyncSession, user_ids: list[int], tenant_id: int
) -> None:
    """Raise ValueError unless every id is a MANAGER or ADMIN in this tenant.
    A project manager must actually be able to manage; assigning an EMPLOYEE
    or VIEWER as PM is nonsensical and breaks the approval chain."""
    if not user_ids:
        return
    wanted = set(user_ids)
    rows = (
        await db.execute(
            select(User.id, User.role).where(
                User.id.in_(wanted), User.tenant_id == tenant_id
            )
        )
    ).all()
    found = {uid for uid, _ in rows}
    missing = sorted(wanted - found)
    if missing:
        raise ValueError(f"Unknown or out-of-tenant manager ids: {missing}")
    bad = sorted(
        uid for uid, role in rows
        if role not in (UserRole.MANAGER, UserRole.ADMIN)
    )
    if bad:
        raise ValueError(
            f"Project managers must have the MANAGER or ADMIN role; "
            f"these user ids do not: {bad}"
        )


async def get_project_resource_ids(db: AsyncSession, project_id: int) -> list[int]:
    result = await db.execute(
        select(UserProjectAccess.user_id).where(
            UserProjectAccess.project_id == project_id)
    )
    return list(result.scalars().all())


async def set_project_roster(
    db: AsyncSession, project_id: int, user_ids: list[int],
    roles: Optional[dict[int, Optional[str]]] = None,
) -> None:
    """Replace a project's roster (user_project_access) with user_ids. When
    ``roles`` is given, it sets each resource's per-project billing role (the
    role they play on THIS project, which drives the client rate card). A user
    absent from ``roles`` keeps their current role; pass None to clear it."""
    target = set(user_ids)
    roles = roles or {}
    rows = (
        await db.execute(
            select(UserProjectAccess).where(UserProjectAccess.project_id == project_id)
        )
    ).scalars().all()
    existing = {r.user_id: r for r in rows}
    for row in rows:
        if row.user_id not in target:
            await db.delete(row)
        elif row.user_id in roles:
            row.role = (roles[row.user_id] or None)
    for uid in target - set(existing):
        db.add(UserProjectAccess(user_id=uid, project_id=project_id, role=roles.get(uid) or None))
    await db.commit()


async def delete_project(db: AsyncSession, project_id: int, tenant_id: Optional[int] = None) -> bool:
    """Delete project by ID, scoped to a tenant."""
    project = await get_project_by_id(db, project_id, tenant_id=tenant_id)
    if project:
        await db.delete(project)
        await db.commit()
        return True
    return False


async def list_projects(db: AsyncSession, tenant_id: int, skip: int = 0, limit: int = 100) -> list[Project]:
    """List all projects for a tenant with pagination."""
    query = select(Project).options(selectinload(Project.client))
    query = query.where(Project.tenant_id == tenant_id)
    query = query.offset(skip).limit(limit)
    result = await db.execute(query)
    return result.scalars().all()


async def get_assigned_project_ids(db: AsyncSession, user_id: int) -> list[int]:
    result = await db.execute(
        select(UserProjectAccess.project_id).where(
            UserProjectAccess.user_id == user_id)
    )
    return list(result.scalars().all())


async def get_task_access_project_ids(db: AsyncSession, user_id: int) -> list[int]:
    """Projects a user reaches via PER-TASK access (user_task_access → task's
    project). A task grant must let the user see and log time on that task's
    project, WITHOUT granting the whole-project roster (which would expose every
    task in the project). Used alongside get_assigned_project_ids."""
    result = await db.execute(
        select(Task.project_id)
        .join(UserTaskAccess, UserTaskAccess.task_id == Task.id)
        .where(UserTaskAccess.user_id == user_id)
    )
    return list({pid for pid in result.scalars().all()})


async def user_has_project_access(db: AsyncSession, user: User, project_id: int) -> bool:
    if user.role in (UserRole.ADMIN, UserRole.PLATFORM_ADMIN):
        return True

    assigned_project_ids = await get_assigned_project_ids(db, user.id)

    # EMPLOYEE access is scoped to explicit assignments and must fail CLOSED:
    # an employee with no assignments has access to nothing (this mirrors the
    # read filter in list_projects_for_user, which also scopes EMPLOYEE only).
    # Previously this returned True when the list was empty, which silently let
    # any unassigned employee write time against every project in the tenant.
    # Per-task access also confers access to the task's project (so a task-only
    # assignee can log time on that task) without granting the whole roster.
    if user.role == UserRole.EMPLOYEE:
        if project_id in assigned_project_ids:
            return True
        return project_id in await get_task_access_project_ids(db, user.id)

    # Broader roles (MANAGER, VIEWER) are not project-scoped for their own
    # time; an empty assignment list does not restrict them.
    if not assigned_project_ids:
        return True

    return project_id in assigned_project_ids


async def list_projects_for_user(
    db: AsyncSession,
    user: User,
    client_id: Optional[int] = None,
    active_only: bool = False,
    skip: int = 0,
    limit: int = 100,
) -> list[Project]:
    query = select(Project).options(selectinload(Project.client))

    # Always scope to the user's tenant (PLATFORM_ADMIN sees all tenants)
    if user.role != UserRole.PLATFORM_ADMIN:
        query = query.where(Project.tenant_id == user.tenant_id)

    if client_id is not None:
        query = query.where(Project.client_id == client_id)

    if active_only:
        query = query.where(Project.is_active.is_(True))

    if user.role == UserRole.EMPLOYEE:
        # Roster access OR per-task access (a task grant surfaces its project so
        # the user can log time on that task). Fail CLOSED: an employee with no
        # access sees no projects (the impossible -1 id matches nothing).
        assigned_project_ids = await get_assigned_project_ids(db, user.id)
        task_project_ids = await get_task_access_project_ids(db, user.id)
        visible = set(assigned_project_ids) | set(task_project_ids)
        query = query.where(Project.id.in_(visible or {-1}))

    query = query.offset(skip).limit(limit)
    result = await db.execute(query)
    return result.scalars().all()


async def list_loggable_projects_for_user(
    db: AsyncSession,
    user: User,
    active_only: bool = True,
) -> list[Project]:
    """Projects the user may actually LOG TIME against — the read-side mirror of
    `user_has_project_access`. Used by the My Time editor so its project picker
    never offers a project the create endpoint would reject with a 403.

    ADMIN/PLATFORM_ADMIN: everything. EMPLOYEE: roster + per-task project grants
    (fails closed — empty access means no projects). MANAGER/VIEWER: their
    assigned set, or everything when they have no assignments (matching the
    write check, which doesn't project-scope these roles when unassigned).
    """
    query = select(Project).options(selectinload(Project.client))
    if user.role != UserRole.PLATFORM_ADMIN:
        query = query.where(Project.tenant_id == user.tenant_id)
    if active_only:
        query = query.where(Project.is_active.is_(True))

    if user.role in (UserRole.ADMIN, UserRole.PLATFORM_ADMIN):
        result = await db.execute(query)
        return result.scalars().all()

    assigned = set(await get_assigned_project_ids(db, user.id))

    if user.role == UserRole.EMPLOYEE:
        visible = assigned | set(await get_task_access_project_ids(db, user.id))
        query = query.where(Project.id.in_(visible or {-1}))
    elif assigned:
        # MANAGER/VIEWER are scoped to their assignments only when they have any.
        query = query.where(Project.id.in_(assigned))

    result = await db.execute(query)
    return result.scalars().all()


async def list_projects_by_client(db: AsyncSession, client_id: int, tenant_id: Optional[int] = None) -> list[Project]:
    """List projects by client ID, scoped to a tenant."""
    query = select(Project).where(Project.client_id == client_id)
    if tenant_id is not None:
        query = query.where(Project.tenant_id == tenant_id)
    query = query.options(selectinload(Project.client))
    result = await db.execute(query)
    return result.scalars().all()


async def list_active_projects(db: AsyncSession, tenant_id: int, skip: int = 0, limit: int = 100) -> list[Project]:
    """List all active projects for a tenant with pagination."""
    query = select(Project).where(Project.is_active == True, Project.tenant_id == tenant_id)
    query = query.options(selectinload(Project.client))
    query = query.offset(skip).limit(limit)
    result = await db.execute(query)
    return result.scalars().all()
