from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy import or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy.orm import selectinload

from app.models.assignments import TaskAssignee, UserProjectAccess, UserTaskAccess
from app.models.project import Project
from app.models.task import Task
from app.models.user import User, UserRole
from app.crud.project import get_assigned_project_ids


async def get_task_assignee_ids(db: AsyncSession, task_id: int) -> list[int]:
    result = await db.execute(
        select(TaskAssignee.user_id).where(TaskAssignee.task_id == task_id)
    )
    return [r for r in result.scalars().all()]


async def validate_assignee_ids(
    db: AsyncSession, user_ids: list[int], tenant_id: int
) -> None:
    """Raise ValueError if any user id is not a user in this tenant. Call this
    BEFORE creating the task so a bad assignee fails the request up front
    instead of leaving an orphan task behind (create_task commits, and a later
    FK failure in set_task_assignees can't roll the task back)."""
    if not user_ids:
        return
    wanted = set(user_ids)
    found = set(
        (
            await db.execute(
                select(User.id).where(
                    User.id.in_(wanted), User.tenant_id == tenant_id
                )
            )
        ).scalars().all()
    )
    missing = sorted(wanted - found)
    if missing:
        raise ValueError(f"Unknown or out-of-tenant assignee ids: {missing}")


async def set_task_assignees(
    db: AsyncSession, task: Task, user_ids: list[int]
) -> None:
    """Replace a task's assignees with `user_ids`. Anyone newly assigned who is
    not already on the project roster is auto-added (user_project_access)."""
    target = set(user_ids)
    # Existing assignee rows for this task.
    existing_rows = (
        await db.execute(select(TaskAssignee).where(TaskAssignee.task_id == task.id))
    ).scalars().all()
    existing = {r.user_id for r in existing_rows}

    for row in existing_rows:
        if row.user_id not in target:
            await db.delete(row)

    for uid in target - existing:
        db.add(TaskAssignee(task_id=task.id, user_id=uid, tenant_id=task.tenant_id))

    # Assigning an INTERNAL teammate to a task makes them part of the project:
    # auto-add each new assignee to the project roster (user_project_access) so
    # they appear in the project's Team members and get whole-project access.
    # (This is the Client-Management task editor's "Assign to". Granular per-task
    # CLIENT grants go through a different path — _sync_user_assignments — which
    # stays task-scoped, so a single client task grant never expands to all
    # tasks.) Only add roster rows that don't already exist.
    if target:
        rostered = set((
            await db.execute(
                select(UserProjectAccess.user_id).where(
                    UserProjectAccess.project_id == task.project_id
                )
            )
        ).scalars().all())
        for uid in target - rostered:
            db.add(UserProjectAccess(user_id=uid, project_id=task.project_id))

    await db.commit()


async def list_tasks_for_user(
    db: AsyncSession,
    user: User,
    project_id: Optional[int] = None,
    active_only: bool = True,
    skip: int = 0,
    limit: int = 500,
) -> list[Task]:
    query = select(Task).options(selectinload(Task.project))

    # Always scope to the user's tenant (PLATFORM_ADMIN sees all tenants)
    if user.role != UserRole.PLATFORM_ADMIN:
        query = query.where(Task.tenant_id == user.tenant_id)

    if project_id is not None:
        query = query.where(Task.project_id == project_id)

    if active_only:
        query = query.where(Task.is_active.is_(True))

    # Only EMPLOYEE is restricted to their project roster. MANAGER task
    # visibility mirrors list_projects_for_user: managers see all tenant tasks
    # here, and the /tasks endpoint then post-filters to the clients they manage
    # (visible_client_ids). Restricting managers by roster here was wrong: a PM
    # on a client could not see tasks on that client's projects unless they were
    # also rostered on each project.
    if user.role == UserRole.EMPLOYEE:
        # Task-aware scoping: an employee sees a task when its PROJECT is in their
        # project roster (whole-project access) OR the TASK itself is granted
        # per-task (user_task_access). A per-task grant must NOT expand to every
        # task in the project, and an employee with no grants at all sees none.
        assigned_project_ids = await get_assigned_project_ids(db, user.id)
        assigned_task_ids = list((await db.execute(
            select(UserTaskAccess.task_id).where(UserTaskAccess.user_id == user.id)
        )).scalars().all())
        # -1 is an impossible id, so an empty list matches nothing (instead of
        # the old behavior where no project access meant "see every task").
        query = query.where(
            or_(
                Task.project_id.in_(assigned_project_ids or [-1]),
                Task.id.in_(assigned_task_ids or [-1]),
            )
        )

    query = query.offset(skip).limit(limit)
    result = await db.execute(query)
    return list(result.scalars().all())


async def get_task_by_id(db: AsyncSession, task_id: int, tenant_id: Optional[int] = None) -> Optional[Task]:
    """Get task by ID, scoped to a tenant. Pass tenant_id=None only for PLATFORM_ADMIN."""
    query = select(Task).options(selectinload(Task.project)).where(Task.id == task_id)
    if tenant_id is not None:
        query = query.where(Task.tenant_id == tenant_id)
    result = await db.execute(query)
    return result.scalars().first()


async def task_belongs_to_project(
    db: AsyncSession,
    task_id: int,
    project_id: int,
    require_active: bool = True,
) -> bool:
    query = select(Task.id).where(
        (Task.id == task_id) &
        (Task.project_id == project_id)
    )
    if require_active:
        query = query.where(Task.is_active.is_(True))

    result = await db.execute(query)
    return result.scalars().first() is not None


# Sentinel for update_task: distinguishes "field omitted" from an explicit
# clear-to-NULL on the nullable Phase 2 columns (estimate / dates / blocker).
_UNSET = object()


async def create_task(
    db: AsyncSession,
    project_id: int,
    tenant_id: int,
    name: str,
    code: Optional[str] = None,
    description: Optional[str] = None,
    is_active: bool = True,
    priority: Optional[str] = None,
    status: Optional[str] = None,
    estimated_hours: Optional[Decimal] = None,
    start_date: Optional[date] = None,
    due_date: Optional[date] = None,
    blocked_reason: Optional[str] = None,
) -> Task:
    task = Task(
        project_id=project_id,
        tenant_id=tenant_id,
        name=name,
        code=code,
        description=description,
        is_active=is_active,
        estimated_hours=estimated_hours,
        start_date=start_date,
        due_date=due_date,
        blocked_reason=(blocked_reason.strip() or None) if blocked_reason else None,
    )
    if priority is not None:
        task.priority = priority
    if status is not None:
        task.status = status
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return task


async def update_task(
    db: AsyncSession,
    task: Task,
    name: Optional[str] = None,
    code: Optional[str] = None,
    description: Optional[str] = None,
    is_active: Optional[bool] = None,
    project_id: Optional[int] = None,
    priority: Optional[str] = None,
    status: Optional[str] = None,
    estimated_hours=_UNSET,
    start_date=_UNSET,
    due_date=_UNSET,
    blocked_reason=_UNSET,
) -> Task:
    if name is not None:
        task.name = name
    if code is not None:
        task.code = code
    if description is not None:
        task.description = description
    if is_active is not None:
        task.is_active = is_active
    if project_id is not None:
        task.project_id = project_id
    if priority is not None:
        task.priority = priority
    if status is not None:
        task.status = status
    # Phase 2 nullable fields use the _UNSET sentinel so an explicit None from
    # the caller CLEARS the value (e.g. removing a due date) while an omitted
    # field leaves it untouched.
    if estimated_hours is not _UNSET:
        task.estimated_hours = estimated_hours
    if start_date is not _UNSET:
        task.start_date = start_date
    if due_date is not _UNSET:
        task.due_date = due_date
    if blocked_reason is not _UNSET:
        task.blocked_reason = (
            blocked_reason.strip() or None
        ) if isinstance(blocked_reason, str) else blocked_reason

    db.add(task)
    await db.commit()
    await db.refresh(task)
    return task


async def delete_task(db: AsyncSession, task: Task) -> None:
    await db.delete(task)
    await db.commit()


async def project_exists(db: AsyncSession, project_id: int, tenant_id: Optional[int] = None) -> bool:
    query = select(Project.id).where(Project.id == project_id)
    if tenant_id is not None:
        query = query.where(Project.tenant_id == tenant_id)
    result = await db.execute(query)
    return result.scalars().first() is not None
