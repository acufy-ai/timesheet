"""H10 regression test: a user cannot approve or reject their own
time entry. The API layer already enforces this via the
``time_entry.approve`` permission; this test pins the CRUD-layer
guard so a future caller that forgets the API check can't bypass it.
"""
import pytest
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover - test shim
    return "JSON"


from datetime import date
from decimal import Decimal

from app.crud.time_entry import (
    approve_time_entries_batch,
    approve_time_entry,
    reject_time_entry,
)
from app.models.time_entry import TimeEntry, TimeEntryStatus


async def _make_submitted_entry(db_session, seeded_data, employee_id: int) -> TimeEntry:
    entry = TimeEntry(
        tenant_id=seeded_data["tenant"].id,
        user_id=employee_id,
        project_id=seeded_data["project"].id,
        entry_date=date.today(),
        hours=Decimal("4.00"),
        description="t",
        is_billable=True,
        status=TimeEntryStatus.SUBMITTED,
    )
    db_session.add(entry)
    await db_session.commit()
    await db_session.refresh(entry)
    return entry


@pytest.mark.asyncio
async def test_cannot_self_approve_single(db_session, seeded_data):
    employee = seeded_data["employee"]
    entry = await _make_submitted_entry(db_session, seeded_data, employee.id)

    with pytest.raises(ValueError, match="Cannot approve your own"):
        await approve_time_entry(
            db_session,
            entry.id,
            approved_by_id=employee.id,
            tenant_id=seeded_data["tenant"].id,
        )


@pytest.mark.asyncio
async def test_cannot_self_approve_batch(db_session, seeded_data):
    employee = seeded_data["employee"]
    entry = await _make_submitted_entry(db_session, seeded_data, employee.id)

    with pytest.raises(ValueError, match="Cannot approve your own"):
        await approve_time_entries_batch(
            db_session,
            [entry.id],
            approved_by_id=employee.id,
            tenant_id=seeded_data["tenant"].id,
        )


@pytest.mark.asyncio
async def test_cannot_self_reject(db_session, seeded_data):
    employee = seeded_data["employee"]
    entry = await _make_submitted_entry(db_session, seeded_data, employee.id)

    with pytest.raises(ValueError, match="Cannot reject your own"):
        await reject_time_entry(
            db_session,
            entry.id,
            approved_by_id=employee.id,
            rejection_reason="x",
            tenant_id=seeded_data["tenant"].id,
        )


@pytest.mark.asyncio
async def test_manager_approving_employee_entry_still_works(db_session, seeded_data):
    """Sanity: the guard rejects self-approval, not all approvals."""
    employee = seeded_data["employee"]
    manager = seeded_data["manager"]
    entry = await _make_submitted_entry(db_session, seeded_data, employee.id)

    result = await approve_time_entry(
        db_session,
        entry.id,
        approved_by_id=manager.id,
        tenant_id=seeded_data["tenant"].id,
    )
    assert result.status == TimeEntryStatus.APPROVED
    assert result.approved_by == manager.id
