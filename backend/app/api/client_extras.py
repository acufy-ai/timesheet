"""Client sub-entity CRUD (Phase C): contacts, role rates, notes.

All nested under a client. Admin writes; any tenant user reads. Each helper
scopes by tenant + client for isolation.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, get_tenant_db, require_role
from app.crud.client import get_client_by_id
from app.models.assignments import TaskAssignee
from app.models.client_extras import ClientContact, ClientNote, ClientRoleRate
from app.models.project import Project
from app.models.task import Task, TaskStatus
from app.models.user import User
from app.api._client_access import assert_client_access
from app.schemas import (
    ClientContactCreate, ClientContactResponse, ClientContactUpdate,
    ClientNoteCreate, ClientNoteResponse, ClientNoteUpdate,
    ClientRoleRateCreate, ClientRoleRateResponse, ClientRoleRateUpdate,
)

router = APIRouter(prefix="/clients/{client_id}", tags=["client-extras"])


async def _require_client(db: AsyncSession, client_id: int, tenant_id: int, user: User = None):
    client = await get_client_by_id(db, client_id, tenant_id=tenant_id)
    if not client:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Client not found")
    if user is not None:
        await assert_client_access(db, user, client_id)
    return client


async def _get_scoped(db, model, client_id, row_id, tenant_id, user=None):
    row = (
        await db.execute(
            select(model).where(
                model.id == row_id, model.client_id == client_id, model.tenant_id == tenant_id)
        )
    ).scalars().first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if user is not None:
        await assert_client_access(db, user, client_id)
    return row


# ── Contacts ────────────────────────────────────────────────────────────────
@router.get("/contacts2", response_model=list[ClientContactResponse])
async def list_contacts(
    client_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    await _require_client(db, client_id, current_user.tenant_id, current_user)
    rows = (
        await db.execute(
            select(ClientContact)
            .where(ClientContact.client_id == client_id, ClientContact.tenant_id == current_user.tenant_id)
            .order_by(ClientContact.id)
        )
    ).scalars().all()
    return rows


@router.post("/contacts2", response_model=ClientContactResponse, status_code=status.HTTP_201_CREATED)
async def create_contact(
    client_id: int,
    payload: ClientContactCreate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    await _require_client(db, client_id, current_user.tenant_id, current_user)
    row = ClientContact(
        tenant_id=current_user.tenant_id, client_id=client_id,
        name=payload.name, role=payload.role,
        emails=payload.emails or [], phones=payload.phones or [],
        is_primary=bool(payload.is_primary),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.put("/contacts2/{row_id}", response_model=ClientContactResponse)
async def update_contact(
    client_id: int, row_id: int, payload: ClientContactUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    row = await _get_scoped(db, ClientContact, client_id, row_id, current_user.tenant_id, current_user)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.delete("/contacts2/{row_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_contact(
    client_id: int, row_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    row = await _get_scoped(db, ClientContact, client_id, row_id, current_user.tenant_id, current_user)
    await db.delete(row)
    await db.commit()


# ── Role rates ────────────────────────────────────────────────────────────────
@router.get("/role-rates", response_model=list[ClientRoleRateResponse])
async def list_role_rates(
    client_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    await _require_client(db, client_id, current_user.tenant_id, current_user)
    rows = (
        await db.execute(
            select(ClientRoleRate)
            .where(ClientRoleRate.client_id == client_id, ClientRoleRate.tenant_id == current_user.tenant_id)
            .order_by(ClientRoleRate.id)
        )
    ).scalars().all()
    return rows


@router.post("/role-rates", response_model=ClientRoleRateResponse, status_code=status.HTTP_201_CREATED)
async def create_role_rate(
    client_id: int, payload: ClientRoleRateCreate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    await _require_client(db, client_id, current_user.tenant_id, current_user)
    row = ClientRoleRate(
        tenant_id=current_user.tenant_id, client_id=client_id,
        role=payload.role, rate=payload.rate,
        currency=payload.currency, effective_date=payload.effective_date,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.put("/role-rates/{row_id}", response_model=ClientRoleRateResponse)
async def update_role_rate(
    client_id: int, row_id: int, payload: ClientRoleRateUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    row = await _get_scoped(db, ClientRoleRate, client_id, row_id, current_user.tenant_id, current_user)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.delete("/role-rates/{row_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_role_rate(
    client_id: int, row_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    row = await _get_scoped(db, ClientRoleRate, client_id, row_id, current_user.tenant_id, current_user)
    await db.delete(row)
    await db.commit()


# ── Notes ────────────────────────────────────────────────────────────────────

async def _is_task_assignee(db: AsyncSession, user_id: int, task_id: int) -> bool:
    """True if the user is assigned to the task (mirrors the /tasks/{id}/progress
    assignee check). The authorization basis for a resource adding their own note."""
    return (await db.execute(
        select(TaskAssignee.user_id).where(
            TaskAssignee.task_id == task_id, TaskAssignee.user_id == user_id)
    )).first() is not None


async def _assert_note_write_access(db: AsyncSession, user: User, client_id: int, task_id) -> None:
    """Who may write a note: a client manager / PM / admin (full access, any
    note), OR a resource ASSIGNED to the target task (their own task note). The
    assignee path is gated on the specific task_id; the task's project/client
    link is validated separately by _resolve_note_link, so an assignee can't post
    to an arbitrary client. Raises 403 otherwise."""
    if task_id is not None and await _is_task_assignee(db, user.id, task_id):
        return
    await assert_client_access(db, user, client_id)


async def _resolve_note_link(db: AsyncSession, tenant_id: int, client_id: int,
                             project_id, task_id) -> tuple:
    """Validate the optional project/task link and return (project, task).

    A task implies a project. Both must belong to this tenant; the project to
    this client; the task to that project. Raises 422 on a mismatch so a note
    can't point at someone else's project/task. Either may be None.
    """
    project = task = None
    if project_id is not None:
        project = (await db.execute(
            select(Project).where(Project.id == project_id, Project.tenant_id == tenant_id)
        )).scalar_one_or_none()
        if project is None or project.client_id != client_id:
            raise HTTPException(status_code=422, detail="Project not found for this client.")
    if task_id is not None:
        if project_id is None:
            raise HTTPException(status_code=422, detail="A task note must also pick its project.")
        task = (await db.execute(
            select(Task).where(Task.id == task_id, Task.tenant_id == tenant_id)
        )).scalar_one_or_none()
        if task is None or task.project_id != project_id:
            raise HTTPException(status_code=422, detail="Task not found on the selected project.")
    return project, task


def _apply_note_to_task(task, body: str, task_status) -> None:
    """Apply a note's chosen status to the task, and map the note text into the
    task's blocked_reason ONLY when the chosen status is 'blocked' (a note is not
    always about why a task is blocked).

    - task_status given -> set the task's status to it.
    - status == blocked  -> the note body becomes the task's blocked_reason.
    - status != blocked  -> leave blocked_reason untouched (note is just attached).
    - task_status None   -> don't touch the task's status at all.
    """
    if task_status is None:
        return
    try:
        status_enum = TaskStatus(task_status)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid task status.")
    task.status = status_enum
    if status_enum == TaskStatus.blocked:
        task.blocked_reason = (body or "").strip() or None


async def _note_response(db: AsyncSession, row: ClientNote) -> dict:
    """ClientNote -> response dict with denormalized project/task display labels
    (so the note card + search can show/match project name, code, task name)."""
    project = await db.get(Project, row.project_id) if row.project_id else None
    task = await db.get(Task, row.task_id) if row.task_id else None
    # Prefer the author's LIVE name (resolved from author_user_id) so renames are
    # reflected; fall back to the stored snapshot when the user is gone or the
    # note was created without a user link.
    author = row.author
    if row.author_user_id is not None:
        author_user = await db.get(User, row.author_user_id)
        if author_user is not None and author_user.full_name:
            author = author_user.full_name
    return {
        "id": row.id, "client_id": row.client_id,
        "author": author, "author_user_id": row.author_user_id,
        "body": row.body, "note_date": row.note_date,
        "project_id": row.project_id, "task_id": row.task_id,
        "project_name": project.name if project else None,
        "project_code": project.code if project else None,
        "task_name": task.name if task else None,
        "created_at": row.created_at, "updated_at": row.updated_at,
    }


@router.get("/notes", response_model=list[ClientNoteResponse])
async def list_notes(
    client_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    await _require_client(db, client_id, current_user.tenant_id, current_user)
    rows = (
        await db.execute(
            select(ClientNote)
            .where(ClientNote.client_id == client_id, ClientNote.tenant_id == current_user.tenant_id)
            .order_by(ClientNote.note_date.desc().nullslast(), ClientNote.id.desc())
        )
    ).scalars().all()
    return [await _note_response(db, r) for r in rows]


# ── Notes history (per task / per project) ───────────────────────────────────
# A second router (no /clients prefix) for READ-ONLY note history scoped to one
# task or project, so the note modal's "Notes history" tab can show every note
# attached to it regardless of who/where it was authored. Authorized for the
# people who work on it (assignee / project roster) OR a client manager.

notes_router = APIRouter(tags=["notes-history"])


async def _on_project(db: AsyncSession, user_id: int, project_id: int) -> bool:
    """True if the user works on the project: on its roster, or assigned to any
    of its tasks. (The read basis for project note history.)"""
    from app.models.assignments import UserProjectAccess
    on_roster = (await db.execute(
        select(UserProjectAccess.user_id).where(
            UserProjectAccess.project_id == project_id, UserProjectAccess.user_id == user_id)
    )).first() is not None
    if on_roster:
        return True
    return (await db.execute(
        select(TaskAssignee.user_id)
        .join(Task, Task.id == TaskAssignee.task_id)
        .where(Task.project_id == project_id, TaskAssignee.user_id == user_id)
    )).first() is not None


@notes_router.get("/tasks/{task_id}/notes", response_model=list[ClientNoteResponse])
async def list_task_notes(
    task_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Every note attached to this task, any author/source. Read access: an
    assignee of the task, OR a manager of its client."""
    task = (await db.execute(
        select(Task).where(Task.id == task_id, Task.tenant_id == current_user.tenant_id)
    )).scalar_one_or_none()
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if not await _is_task_assignee(db, current_user.id, task_id):
        project = await db.get(Project, task.project_id)
        await assert_client_access(db, current_user, project.client_id)
    rows = (await db.execute(
        select(ClientNote)
        .where(ClientNote.task_id == task_id, ClientNote.tenant_id == current_user.tenant_id)
        .order_by(ClientNote.note_date.desc().nullslast(), ClientNote.id.desc())
    )).scalars().all()
    return [await _note_response(db, r) for r in rows]


@notes_router.get("/projects/{project_id}/notes", response_model=list[ClientNoteResponse])
async def list_project_notes(
    project_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Every note attached to this project (project-level + any of its tasks).
    Read access: someone who works on the project, OR a manager of its client."""
    project = (await db.execute(
        select(Project).where(Project.id == project_id, Project.tenant_id == current_user.tenant_id)
    )).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if not await _on_project(db, current_user.id, project_id):
        await assert_client_access(db, current_user, project.client_id)
    rows = (await db.execute(
        select(ClientNote)
        .where(ClientNote.project_id == project_id, ClientNote.tenant_id == current_user.tenant_id)
        .order_by(ClientNote.note_date.desc().nullslast(), ClientNote.id.desc())
    )).scalars().all()
    return [await _note_response(db, r) for r in rows]


@router.post("/notes", response_model=ClientNoteResponse, status_code=status.HTTP_201_CREATED)
async def create_note(
    client_id: int, payload: ClientNoteCreate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    # Client must exist (404). Access is checked by _assert_note_write_access
    # below (manager/PM/admin OR an assignee of the target task) rather than the
    # client-manager-only gate, so resources can add notes on their own tasks.
    await _require_client(db, client_id, current_user.tenant_id, None)
    await _assert_note_write_access(db, current_user, client_id, payload.task_id)
    _, task = await _resolve_note_link(
        db, current_user.tenant_id, client_id, payload.project_id, payload.task_id)
    # Authorship is stamped from the logged-in user; never caller-supplied.
    row = ClientNote(
        tenant_id=current_user.tenant_id, client_id=client_id,
        author=current_user.full_name, author_user_id=current_user.id,
        body=payload.body, note_date=payload.note_date,
        project_id=payload.project_id, task_id=payload.task_id,
    )
    db.add(row)
    if task is not None:
        _apply_note_to_task(task, payload.body, payload.task_status)
        db.add(task)
    await db.commit()
    await db.refresh(row)
    return await _note_response(db, row)


@router.put("/notes/{row_id}", response_model=ClientNoteResponse)
async def update_note(
    client_id: int, row_id: int, payload: ClientNoteUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    row = await _get_scoped(db, ClientNote, client_id, row_id, current_user.tenant_id, None)
    sent = payload.model_dump(exclude_unset=True)
    # task_status is transient (drives the linked task, not a column on the note).
    task_status = sent.pop("task_status", None)
    # Write access: a manager/PM/admin, OR an assignee of the note's task (its
    # existing task before any patch, so an assignee can't re-target to a task
    # they're not on). Checked against the pre-patch task_id.
    await _assert_note_write_access(db, current_user, client_id, row.task_id)
    for field, value in sent.items():
        setattr(row, field, value)
    # Validate the (possibly new) link and apply status/reason to the task. Use
    # the row's effective values after applying the patch.
    _, task = await _resolve_note_link(
        db, current_user.tenant_id, client_id, row.project_id, row.task_id)
    db.add(row)
    if task is not None:
        _apply_note_to_task(task, row.body, task_status)
        db.add(task)
    await db.commit()
    await db.refresh(row)
    return await _note_response(db, row)


@router.delete("/notes/{row_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_note(
    client_id: int, row_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    row = await _get_scoped(db, ClientNote, client_id, row_id, current_user.tenant_id, current_user)
    await db.delete(row)
    await db.commit()
