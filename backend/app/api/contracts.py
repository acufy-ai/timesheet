"""Client contracts (Phase B of the Clients-redesign port).

CRUD for a client's agreements plus signed-document upload / download / delete
via the shared storage service. Admin-only writes; any tenant user may read.
"""
import logging
from decimal import Decimal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, get_tenant_db, require_role
from app.crud.client import get_client_by_id
from app.models.contract import Contract
from app.models.project import Project
from app.models.time_entry import TimeEntry, TimeEntryStatus
from app.models.user import User
from app.api._client_access import require_client_manager, assert_client_access
from app.schemas import ContractCreate, ContractResponse, ContractUpdate
from app.services import storage
from app.services.billing_rates import entry_billed_amount

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/clients/{client_id}/contracts", tags=["contracts"])

# Document size cap (10 MB) — generous for a PDF/DOCX agreement.
_MAX_DOC_BYTES = 10 * 1024 * 1024


def _serialize(c: Contract) -> ContractResponse:
    return ContractResponse(
        id=c.id,
        client_id=c.client_id,
        title=c.title,
        kind=c.kind,
        start_date=c.start_date,
        end_date=c.end_date,
        value=c.value,
        status=c.status.value if hasattr(c.status, "value") else str(c.status),
        document_name=c.document_name,
        document_size=c.document_size,
        has_document=bool(c.document_key),
        created_at=c.created_at,
        updated_at=c.updated_at,
    )


async def _get_contract(db: AsyncSession, client_id: int, contract_id: int, tenant_id: int, user: User = None) -> Contract:
    row = (
        await db.execute(
            select(Contract).where(
                Contract.id == contract_id,
                Contract.client_id == client_id,
                Contract.tenant_id == tenant_id,
            )
        )
    ).scalars().first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contract not found")
    if user is not None:
        await assert_client_access(db, user, client_id)
    return row


async def _require_client(db: AsyncSession, client_id: int, tenant_id: int, user: User = None):
    client = await get_client_by_id(db, client_id, tenant_id=tenant_id)
    if not client:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Client not found")
    if user is not None:
        await assert_client_access(db, user, client_id)
    return client


@router.get("", response_model=list[ContractResponse])
async def list_contracts(
    client_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> list:
    await _require_client(db, client_id, current_user.tenant_id, current_user)
    rows = (
        await db.execute(
            select(Contract)
            .where(Contract.client_id == client_id, Contract.tenant_id == current_user.tenant_id)
            .order_by(Contract.created_at.desc())
        )
    ).scalars().all()
    return [_serialize(c) for c in rows]


@router.get("/{contract_id}/burn")
async def contract_burn(
    client_id: int,
    contract_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Contract value burn: consumed billable value (approved entries on the
    contract's projects) vs the contract value. Uses each entry's frozen
    billed_rate where present, else the live project rate."""
    contract = await _get_contract(db, client_id, contract_id, current_user.tenant_id, current_user)

    projects = (await db.execute(
        select(Project).where(
            Project.contract_id == contract_id,
            Project.tenant_id == current_user.tenant_id,
        )
    )).scalars().all()
    project_by_id = {p.id: p for p in projects}
    project_ids = list(project_by_id.keys())

    consumed = Decimal("0")
    approved_hours = Decimal("0")
    if project_ids:
        entries = (await db.execute(
            select(TimeEntry).where(
                TimeEntry.project_id.in_(project_ids),
                TimeEntry.tenant_id == current_user.tenant_id,
                TimeEntry.status == TimeEntryStatus.APPROVED,
            )
        )).scalars().all()
        for e in entries:
            consumed += entry_billed_amount(e, project_by_id.get(e.project_id))
            if e.is_billable:
                approved_hours += (e.hours or Decimal("0"))

    value = contract.value
    remaining = (value - consumed) if value is not None else None
    pct = (
        float(min(consumed / value, 1) * 100)
        if value is not None and value > 0
        else None
    )
    return {
        "contract_id": contract_id,
        "value": value,
        "consumed": consumed,
        "remaining": remaining,
        "percent_used": pct,
        "approved_hours": approved_hours,
        "project_ids": project_ids,
        "project_count": len(project_ids),
    }


@router.post("", response_model=ContractResponse, status_code=status.HTTP_201_CREATED)
async def create_contract(
    client_id: int,
    payload: ContractCreate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> ContractResponse:
    await _require_client(db, client_id, current_user.tenant_id, current_user)
    contract = Contract(
        tenant_id=current_user.tenant_id,
        client_id=client_id,
        title=payload.title,
        kind=payload.kind,
        start_date=payload.start_date,
        end_date=payload.end_date,
        value=payload.value,
        status=payload.status,
    )
    db.add(contract)
    await db.commit()
    await db.refresh(contract)
    return _serialize(contract)


@router.put("/{contract_id}", response_model=ContractResponse)
async def update_contract(
    client_id: int,
    contract_id: int,
    payload: ContractUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> ContractResponse:
    contract = await _get_contract(db, client_id, contract_id, current_user.tenant_id, current_user)
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(contract, field, value)
    db.add(contract)
    await db.commit()
    await db.refresh(contract)
    return _serialize(contract)


@router.delete("/{contract_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_contract(
    client_id: int,
    contract_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> None:
    contract = await _get_contract(db, client_id, contract_id, current_user.tenant_id, current_user)
    key = contract.document_key
    await db.delete(contract)
    await db.commit()
    if key:
        try:
            await storage.delete_file(key)
        except Exception as exc:  # noqa: BLE001 - best-effort cleanup
            logger.warning("contract document cleanup failed key=%s error=%s", key, exc)


@router.post("/{contract_id}/document", response_model=ContractResponse)
async def upload_contract_document(
    client_id: int,
    contract_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> ContractResponse:
    contract = await _get_contract(db, client_id, contract_id, current_user.tenant_id, current_user)
    content = await file.read()
    if len(content) > _MAX_DOC_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Document exceeds the 10 MB limit.",
        )
    # Replace any existing document.
    old_key = contract.document_key
    new_key = await storage.save_file(content, file.filename or "document")
    contract.document_key = new_key
    contract.document_name = file.filename or "document"
    contract.document_size = len(content)
    db.add(contract)
    await db.commit()
    await db.refresh(contract)
    if old_key and old_key != new_key:
        try:
            await storage.delete_file(old_key)
        except Exception as exc:  # noqa: BLE001
            logger.warning("old contract document cleanup failed key=%s error=%s", old_key, exc)
    return _serialize(contract)


@router.get("/{contract_id}/document")
async def download_contract_document(
    client_id: int,
    contract_id: int,
    disposition: str = "attachment",
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Serve the attached document.

    disposition=attachment (default) → the browser saves it (the Download button).
    disposition=inline → the browser renders it in-tab when it can (PDF/image
    preview); the real content type is inferred from the filename so previewable
    types display instead of downloading.
    """
    import mimetypes

    contract = await _get_contract(db, client_id, contract_id, current_user.tenant_id, current_user)
    if not contract.document_key:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No document attached")
    content = await storage.read_file(contract.document_key)
    filename = contract.document_name or "document"

    inline = disposition == "inline"
    media_type = "application/octet-stream"
    if inline:
        guessed, _ = mimetypes.guess_type(filename)
        # Only hand the browser a real type when we can preview it; otherwise keep
        # the generic type so it falls back to its download prompt.
        media_type = guessed or "application/octet-stream"

    dispo = "inline" if inline else "attachment"
    return StreamingResponse(
        iter([content]),
        media_type=media_type,
        headers={"Content-Disposition": f'{dispo}; filename="{filename}"'},
    )


@router.delete("/{contract_id}/document", response_model=ContractResponse)
async def delete_contract_document(
    client_id: int,
    contract_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> ContractResponse:
    contract = await _get_contract(db, client_id, contract_id, current_user.tenant_id, current_user)
    key = contract.document_key
    contract.document_key = None
    contract.document_name = None
    contract.document_size = None
    db.add(contract)
    await db.commit()
    await db.refresh(contract)
    if key:
        try:
            await storage.delete_file(key)
        except Exception as exc:  # noqa: BLE001
            logger.warning("contract document cleanup failed key=%s error=%s", key, exc)
    return _serialize(contract)
