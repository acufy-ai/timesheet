from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, get_tenant_db, require_role
from app.crud.task import (
    create_task,
    delete_task,
    get_task_assignee_ids,
    get_task_by_id,
    list_tasks_for_user,
    project_exists,
    set_task_assignees,
    update_task,
    validate_assignee_ids,
)
from app.crud.project import (
    get_project_by_id,
    get_project_manager_ids,
    get_project_resource_ids,
    set_project_managers,
    set_project_roster,
)
from app.models.assignments import TaskAssignee
from app.models.user import User, UserRole
from app.api._client_access import require_client_manager, assert_client_access, visible_client_ids
from app.api.users import _get_descendant_user_ids
from app.schemas import TaskCreate, TaskProgressUpdate, TaskResponse, TaskUpdate, TaskWithProject
from sqlalchemy.future import select
from sqlalchemy import or_


async def _attach_assignees(db: AsyncSession, tasks):
    """Attach assignee_ids + client_assignees (transient attrs read by
    TaskResponse.from_attributes) to one task or a list, in a few queries.

    client_assignees = client-side users (employee OR manager) who hold a client
    access grant on the task (directly, or inherited from a project grant) — so
    the internal side sees which client person is working on which task. We count
    managers too, so the row badge matches the task editor's Client access list
    (which lists every client person, not just employees)."""
    from app.models.client_access_grant import ClientAccessGrant
    from app.schemas import ClientAssigneeInfo

    single = not isinstance(tasks, list)
    items = [tasks] if single else tasks
    ids = [t.id for t in items]
    by_task: dict[int, list[int]] = {tid: [] for tid in ids}
    if ids:
        rows = (
            await db.execute(
                select(TaskAssignee.task_id, TaskAssignee.user_id).where(
                    TaskAssignee.task_id.in_(ids)
                )
            )
        ).all()
        for task_id, user_id in rows:
            by_task.setdefault(task_id, []).append(user_id)

    # Client-employee assignees: grants whose task_id is one of ours, OR whose
    # project_id owns one of our tasks. Resolve to CLIENT_EMPLOYEE users.
    client_by_task: dict[int, list[ClientAssigneeInfo]] = {tid: [] for tid in ids}
    if ids:
        proj_of_task = {t.id: t.project_id for t in items}
        proj_ids = set(proj_of_task.values())
        grants = (await db.execute(
            select(ClientAccessGrant).where(
                or_(
                    ClientAccessGrant.task_id.in_(ids),
                    ClientAccessGrant.project_id.in_(list(proj_ids) or [-1]),
                )
            )
        )).scalars().all()
        if grants:
            uid_set = {g.user_id for g in grants}
            emp_names = {uid: name for uid, name in (await db.execute(
                select(User.id, User.full_name).where(
                    User.id.in_(list(uid_set)),
                    User.role.in_([
                        UserRole.CLIENT_EMPLOYEE, UserRole.CLIENT_MANAGER, UserRole.CLIENT,
                    ]),
                )
            )).all()}
            for g in grants:
                if g.user_id not in emp_names:
                    continue
                info = ClientAssigneeInfo(user_id=g.user_id, full_name=emp_names[g.user_id])
                if g.task_id in client_by_task:
                    client_by_task[g.task_id].append(info)
                elif g.project_id is not None:
                    # Project grant inherits to every task under that project.
                    for tid, pid in proj_of_task.items():
                        if pid == g.project_id:
                            client_by_task[tid].append(info)

    for t in items:
        t.assignee_ids = by_task.get(t.id, [])
        # De-dup client assignees per task (a user could match via both paths).
        seen: set[int] = set()
        uniq: list = []
        for ci in client_by_task.get(t.id, []):
            if ci.user_id not in seen:
                seen.add(ci.user_id)
                uniq.append(ci)
        t.client_assignees = uniq
    return tasks
from app.services.activity import (
    TENANT_ADMIN_ACTIVITY_SCOPE,
    build_activity_event,
    record_activity_events,
)

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.get("", response_model=list[TaskWithProject])
async def list_tasks(
    project_id: Optional[int] = Query(None),
    active_only: bool = Query(True),
    skip: int = Query(0, ge=0),
    limit: int = Query(500, ge=1, le=1000),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    tasks = await list_tasks_for_user(
        db,
        current_user,
        project_id=project_id,
        active_only=active_only,
        skip=skip,
        limit=limit,
    )
    # Managers only see tasks under clients they PM (admins: all). Only apply
    # this PM-client filter for managers: `visible_client_ids` is empty for an
    # EMPLOYEE/VIEWER and would wrongly drop every task. Employees are already
    # roster-scoped inside `list_tasks_for_user`.
    if current_user.role == UserRole.MANAGER:
        visible = await visible_client_ids(db, current_user)
        if visible is not None:
            tasks = [t for t in tasks if t.project and t.project.client_id in visible]
    return await _attach_assignees(db, tasks)


@router.get("/{task_id}", response_model=TaskWithProject)
async def get_task(
    task_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    task = await get_task_by_id(db, task_id, tenant_id=current_user.tenant_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    tasks = await list_tasks_for_user(
        db,
        current_user,
        project_id=task.project_id,
        active_only=False,
        skip=0,
        limit=1,
    )
    if not tasks and current_user.role not in (UserRole.ADMIN, UserRole.PLATFORM_ADMIN):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    # Managers may only read tasks under clients they manage (mirrors the list
    # endpoint's visible_client_ids post-filter).
    visible = await visible_client_ids(db, current_user)
    if visible is not None and (task.project is None or task.project.client_id not in visible):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    return await _attach_assignees(db, task)


@router.post("", response_model=TaskResponse, status_code=status.HTTP_201_CREATED)
async def create_task_endpoint(
    payload: TaskCreate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    require_client_manager(current_user)
    project = await get_project_by_id(db, payload.project_id, tenant_id=current_user.tenant_id)
    if not project:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Project not found")
    await assert_client_access(db, current_user, project.client_id)

    # A MANAGER may only assign people they manage (self + org-chain descendants),
    # never a peer's reports or anyone above them. Admins bypass (manage on behalf
    # of anyone). Only enforced when the manager would become the project PM
    # (i.e. the project has no PM yet) — assigning onto an already-staffed project
    # respects that project's existing roster instead.
    # A MANAGER may only assign themselves or people in their own org subtree —
    # never someone ABOVE them in the chain (e.g. their own manager). This holds
    # whether or not the project already has a PM; a staffed project does not
    # grant a manager reach over people outside their reports.
    if payload.assignee_ids and current_user.role == UserRole.MANAGER:
        allowed = await _get_descendant_user_ids(db, current_user.id, current_user.tenant_id)
        allowed.add(current_user.id)
        bad = [uid for uid in payload.assignee_ids if uid not in allowed]
        if bad:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You can only assign people you manage (yourself or your reports).",
            )

    # Validate assignees BEFORE create_task commits, so a bad assignee fails
    # the request cleanly (400) instead of leaving an orphan task behind.
    if payload.assignee_ids:
        try:
            await validate_assignee_ids(db, payload.assignee_ids, current_user.tenant_id)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    new_task = await create_task(
        db,
        project_id=payload.project_id,
        tenant_id=current_user.tenant_id,
        name=payload.name,
        code=payload.code,
        description=payload.description,
        is_active=payload.is_active,
        priority=payload.priority,
        status=payload.status,
    )
    if payload.assignee_ids is not None:
        await set_task_assignees(db, new_task, payload.assignee_ids)

    # Project propagation: when the project has no PM yet and a MANAGER creates a
    # task on it, auto-assign the acting manager as the project's PM and add the
    # task's assignees to the project roster (both additive). This lets a manager
    # staff a project straight from the task modal without a round-trip to the
    # project form. Admins don't auto-claim PM (they manage on behalf of others).
    existing_pms = await get_project_manager_ids(db, project.id)
    if not existing_pms and current_user.role == UserRole.MANAGER:
        await set_project_managers(db, project.id, [current_user.id], current_user.tenant_id)
        if not project.manager_id:
            project.manager_id = current_user.id
            db.add(project)
        if payload.assignee_ids:
            current_roster = set(await get_project_resource_ids(db, project.id))
            merged = sorted(current_roster | set(payload.assignee_ids))
            await set_project_roster(db, project.id, merged)
        await db.commit()

    if new_task.tenant_id is not None:
        await record_activity_events(
            db,
            [
                build_activity_event(
                    activity_type="TASK_CREATED",
                    visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                    tenant_id=new_task.tenant_id,
                    actor_user=current_user,
                    entity_type="task",
                    entity_id=new_task.id,
                    summary=f"{current_user.full_name} created task {new_task.name}.",
                    route="/tasks",
                    route_params={"taskId": new_task.id},
                    metadata={"task_name": new_task.name},
                )
            ],
        )
    return await _attach_assignees(db, new_task)


@router.put("/{task_id}", response_model=TaskResponse)
async def update_task_endpoint(
    task_id: int,
    payload: TaskUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    require_client_manager(current_user)
    task = await get_task_by_id(db, task_id, tenant_id=current_user.tenant_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    cur_project = await get_project_by_id(db, task.project_id, tenant_id=current_user.tenant_id)
    if cur_project:
        await assert_client_access(db, current_user, cur_project.client_id)

    if payload.project_id is not None:
        project = await get_project_by_id(db, payload.project_id, tenant_id=current_user.tenant_id)
        if not project:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Project not found")
        await assert_client_access(db, current_user, project.client_id)

    if payload.assignee_ids:
        try:
            await validate_assignee_ids(db, payload.assignee_ids, current_user.tenant_id)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    # Manager subtree guard: a MANAGER may only ADD people from their own subtree
    # (themselves + reports). Anyone already on the task stays (an admin may have
    # staffed an out-of-subtree specialist); we only block newly introduced ids.
    if payload.assignee_ids is not None and current_user.role == UserRole.MANAGER:
        current_assignees = set(await get_task_assignee_ids(db, task.id))
        added = [uid for uid in payload.assignee_ids if uid not in current_assignees]
        if added:
            allowed = await _get_descendant_user_ids(db, current_user.id, current_user.tenant_id)
            allowed.add(current_user.id)
            bad = [uid for uid in added if uid not in allowed]
            if bad:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="You can only assign people you manage (yourself or your reports).",
                )

    updated_task = await update_task(
        db,
        task,
        name=payload.name,
        code=payload.code,
        description=payload.description,
        is_active=payload.is_active,
        project_id=payload.project_id,
        priority=payload.priority,
        status=payload.status,
    )
    if payload.assignee_ids is not None:
        await set_task_assignees(db, updated_task, payload.assignee_ids)
    if updated_task.tenant_id is not None:
        await record_activity_events(
            db,
            [
                build_activity_event(
                    activity_type="TASK_UPDATED",
                    visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                    tenant_id=updated_task.tenant_id,
                    actor_user=current_user,
                    entity_type="task",
                    entity_id=updated_task.id,
                    summary=f"{current_user.full_name} updated task {updated_task.name}.",
                    route="/tasks",
                    route_params={"taskId": updated_task.id},
                    metadata={"task_name": updated_task.name},
                )
            ],
        )
    return await _attach_assignees(db, updated_task)


@router.patch("/{task_id}/progress")
async def update_task_progress(
    task_id: int,
    payload: TaskProgressUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Scoped task edit for an INTERNAL ASSIGNEE: status and/or description only.

    Mirrors the client-employee portal scope. The full task edit (PUT) is
    manager-only; this lets a regular employee move their own assigned task
    along without touching project/assignees/name. Authorized iff the caller is
    in this task's ``task_assignees``.
    """
    from app.models.task import TaskStatus

    task = await get_task_by_id(db, task_id, tenant_id=current_user.tenant_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    is_assignee = (await db.execute(
        select(TaskAssignee.user_id).where(
            TaskAssignee.task_id == task_id,
            TaskAssignee.user_id == current_user.id,
        )
    )).first() is not None
    if not is_assignee:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only update tasks assigned to you.",
        )

    if payload.status is not None:
        try:
            task.status = TaskStatus(payload.status)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid status")
    if payload.description is not None:
        task.description = payload.description.strip() or None
    db.add(task)

    if task.tenant_id is not None:
        await record_activity_events(
            db,
            [
                build_activity_event(
                    activity_type="TASK_UPDATED",
                    visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                    tenant_id=task.tenant_id,
                    actor_user=current_user,
                    entity_type="task",
                    entity_id=task.id,
                    summary=f"{current_user.full_name} updated task {task.name}.",
                    route="/tasks",
                    route_params={"taskId": task.id},
                    metadata={"task_name": task.name},
                )
            ],
        )
    await db.commit()
    return {
        "id": task.id,
        "status": task.status.value if hasattr(task.status, "value") else (str(task.status) if task.status else None),
        "description": task.description,
    }


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task_endpoint(
    task_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    require_client_manager(current_user)
    task = await get_task_by_id(db, task_id, tenant_id=current_user.tenant_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    t_project = await get_project_by_id(db, task.project_id, tenant_id=current_user.tenant_id)
    if t_project:
        await assert_client_access(db, current_user, t_project.client_id)

    task_name = task.name
    task_tenant_id = task.tenant_id
    task_id_local = task.id

    await delete_task(db, task)

    if task_tenant_id is not None:
        await record_activity_events(
            db,
            [
                build_activity_event(
                    activity_type="TASK_DELETED",
                    visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                    tenant_id=task_tenant_id,
                    actor_user=current_user,
                    entity_type="task",
                    entity_id=task_id_local,
                    summary=f"{current_user.full_name} deleted task {task_name}.",
                    route="/tasks",
                    route_params={"taskId": task_id_local},
                    metadata={"task_name": task_name},
                )
            ],
        )
