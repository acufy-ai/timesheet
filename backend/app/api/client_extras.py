"""Client sub-entity CRUD (Phase C): contacts, role rates, notes.

All nested under a client. Admin writes; any tenant user reads. Each helper
scopes by tenant + client for isolation.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, get_tenant_db, require_role
from app.crud.client import get_client_by_id
from app.models.client_extras import ClientContact, ClientNote, ClientRoleRate
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
    return rows


@router.post("/notes", response_model=ClientNoteResponse, status_code=status.HTTP_201_CREATED)
async def create_note(
    client_id: int, payload: ClientNoteCreate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    await _require_client(db, client_id, current_user.tenant_id, current_user)
    row = ClientNote(
        tenant_id=current_user.tenant_id, client_id=client_id,
        author=payload.author or current_user.full_name,
        body=payload.body, note_date=payload.note_date,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.put("/notes/{row_id}", response_model=ClientNoteResponse)
async def update_note(
    client_id: int, row_id: int, payload: ClientNoteUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    row = await _get_scoped(db, ClientNote, client_id, row_id, current_user.tenant_id, current_user)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.delete("/notes/{row_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_note(
    client_id: int, row_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    row = await _get_scoped(db, ClientNote, client_id, row_id, current_user.tenant_id, current_user)
    await db.delete(row)
    await db.commit()
