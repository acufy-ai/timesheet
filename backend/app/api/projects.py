from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status, Query
from sqlalchemy.ext.asyncio import AsyncSession
from app.schemas import ProjectResponse, ProjectCreate, ProjectUpdate, ProjectWithClient
from app.crud.project import (
    get_project_by_id, create_project, update_project, delete_project,
    list_projects_for_user, validate_project_manager_ids, next_project_code,
)
from app.crud.client import get_client_by_id
from app.crud.time_entry import count_protected_entries_for_project
from app.crud.task import validate_assignee_ids as validate_user_ids_in_tenant
from app.core.deps import get_current_user, get_tenant_db, require_role
from app.models.assignments import UserProjectAccess, ProjectManager
from app.models.user import User, UserRole
from app.api._client_access import (
    require_client_manager, assert_client_access, visible_client_ids,
)
from sqlalchemy.future import select


async def _attach_roster(db: AsyncSession, projects):
    """Attach resource_ids + manager_ids (read by ProjectResponse) to one
    project or a list, in two batched queries."""
    single = not isinstance(projects, list)
    items = [projects] if single else projects
    ids = [p.id for p in items]
    roster: dict[int, list[int]] = {pid: [] for pid in ids}
    managers: dict[int, list[int]] = {pid: [] for pid in ids}
    if ids:
        for project_id, user_id in (
            await db.execute(
                select(UserProjectAccess.project_id, UserProjectAccess.user_id).where(
                    UserProjectAccess.project_id.in_(ids))
            )
        ).all():
            roster.setdefault(project_id, []).append(user_id)
        for project_id, user_id in (
            await db.execute(
                select(ProjectManager.project_id, ProjectManager.user_id).where(
                    ProjectManager.project_id.in_(ids))
            )
        ).all():
            managers.setdefault(project_id, []).append(user_id)
    for p in items:
        p.resource_ids = roster.get(p.id, [])
        p.manager_ids = managers.get(p.id, [])
    return projects
from app.services.ingestion_sync import _send_outbound_webhook
from app.services.activity import (
    TENANT_ADMIN_ACTIVITY_SCOPE,
    build_activity_event,
    record_activity_events,
)

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("", response_model=list[ProjectWithClient])
async def list_all_projects(
    client_id: int = Query(None),
    active_only: bool = Query(False),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> list:
    """
    List all projects with optional filtering.
    Any authenticated user can view projects within their tenant.
    """
    projects = await list_projects_for_user(
        db,
        current_user,
        client_id=client_id,
        active_only=active_only,
        skip=skip,
        limit=limit,
    )
    # Managers only see projects under clients they PM (admins: all). This
    # client-visibility filter is a MANAGER scoping rule — `visible_client_ids`
    # returns the user's PM-client set, which is empty for an EMPLOYEE/VIEWER and
    # would wrongly drop every project. Employees are already scoped to their
    # assigned projects inside `list_projects_for_user`, so only apply the PM
    # filter for managers.
    if current_user.role == UserRole.MANAGER:
        visible = await visible_client_ids(db, current_user)
        if visible is not None:
            projects = [p for p in projects if p.client_id in visible]
    return await _attach_roster(db, list(projects))


@router.get("/next-code")
async def get_next_project_code(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """The next auto project code (PR####) for the New project form. Managers
    and admins only — this surface is the client-management create flow.

    Declared before /{project_id} so 'next-code' isn't parsed as an id."""
    require_client_manager(current_user)
    code = await next_project_code(db, current_user.tenant_id)
    return {"code": code}


@router.get("/{project_id}", response_model=ProjectWithClient)
async def get_project(
    project_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """
    Get a specific project by ID.
    """
    project = await get_project_by_id(db, project_id, tenant_id=current_user.tenant_id)
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    # Managers only when they PM the project's client (admins: any).
    visible = await visible_client_ids(db, current_user)
    if visible is not None and project.client_id not in visible:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    return await _attach_roster(db, project)


@router.post("", response_model=ProjectWithClient, status_code=status.HTTP_201_CREATED)
async def create_new_project(
    project_create: ProjectCreate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """
    Create a project. Admins, or managers who PM the target client.
    """
    require_client_manager(current_user)
    client = await get_client_by_id(db, project_create.client_id, tenant_id=current_user.tenant_id)
    if not client:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Client not found")
    await assert_client_access(db, current_user, project_create.client_id)

    # Validate PM / roster user ids up front so a ghost or out-of-tenant id
    # fails cleanly (400) instead of 500-ing after create_project commits.
    # PMs are additionally role-checked (MANAGER/ADMIN only).
    try:
        await validate_project_manager_ids(
            db, project_create.manager_ids or [], current_user.tenant_id
        )
        if project_create.resource_ids:
            await validate_user_ids_in_tenant(
                db, project_create.resource_ids, current_user.tenant_id
            )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    new_project = await create_project(db, project_create, tenant_id=current_user.tenant_id)
    if new_project.tenant_id is not None:
        await record_activity_events(
            db,
            [
                build_activity_event(
                    activity_type="PROJECT_CREATED",
                    visibility_scope=TENANT_ADMIN_ACTIVITY_SCOPE,
                    tenant_id=new_project.tenant_id,
                    actor_user=current_user,
                    entity_type="project",
                    entity_id=new_project.id,
                    summary=f"{current_user.full_name} created project {new_project.name}.",
                    route="/client-management",
                    route_params={"clientId": new_project.client_id, "projectId": new_project.id},
                    metadata={"project_name": new_project.name, "client_id": new_project.client_id},
                )
            ],
        )
    return await _attach_roster(db, new_project)


@router.put("/{project_id}", response_model=ProjectWithClient)
async def update_project_endpoint(
    project_id: int,
    project_update: ProjectUpdate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """
    Update a project. Admins, or managers who PM the project's client.
    """
    require_client_manager(current_user)
    project = await get_project_by_id(db, project_id, tenant_id=current_user.tenant_id)
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    await assert_client_access(db, current_user, project.client_id)

    if project_update.client_id:
        client = await get_client_by_id(db, project_update.client_id, tenant_id=current_user.tenant_id)
        if not client:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Client not found")
        # Can't move a project to a client you don't manage.
        await assert_client_access(db, current_user, project_update.client_id)

    # Validate PM / roster ids before update_project commits them.
    try:
        if project_update.manager_ids is not None:
            await validate_project_manager_ids(
                db, project_update.manager_ids, current_user.tenant_id
            )
        if project_update.resource_ids:
            await validate_user_ids_in_tenant(
                db, project_update.resource_ids, current_user.tenant_id
            )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    # Build changed_fields before updating (for outbound webhook)
    changed_fields = {}
    update_data = project_update.model_dump(exclude_unset=True)
    for field, new_val in update_data.items():
        old_val = getattr(project, field, None)
        if old_val != new_val:
            changed_fields[field] = {"old": old_val, "new": new_val}

    updated_project = await update_project(db, project, project_update)

    if project.ingestion_project_id and changed_fields:
        background_tasks.add_task(
            _send_outbound_webhook,
            tenant_id=current_user.tenant_id,
            event_type="project.updated",
            local_id=project.id,
            ingestion_id=project.ingestion_project_id,
            changed_fields=changed_fields,
            changed_by_name=current_user.full_name,
            session=db,
        )

    return await _attach_roster(db, updated_project)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project_endpoint(
    project_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> None:
    """
    Delete a project. Admins, or managers who PM the project's client.
    """
    require_client_manager(current_user)
    project = await get_project_by_id(db, project_id, tenant_id=current_user.tenant_id)
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    await assert_client_access(db, current_user, project.client_id)

    protected = await count_protected_entries_for_project(
        db, project_id, tenant_id=current_user.tenant_id
    )
    if protected:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Cannot delete this project: it has {protected} submitted, "
                "approved, or rejected time entries. Archive it instead, or "
                "reassign those entries first."
            ),
        )

    ingestion_project_id = project.ingestion_project_id
    project_id_local = project.id

    success = await delete_project(db, project_id, tenant_id=current_user.tenant_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    if ingestion_project_id:
        background_tasks.add_task(
            _send_outbound_webhook,
            tenant_id=current_user.tenant_id,
            event_type="project.deleted",
            local_id=project_id_local,
            ingestion_id=ingestion_project_id,
            changed_fields={},
            changed_by_name=current_user.full_name,
            session=db,
        )
