"""Tests for the recall flow: SUBMITTED -> DRAFT under the user's
own steam, with race-protection against manager approval.

These exercise the CRUD function directly (``recall_time_entries``)
rather than the HTTP route, matching the style of
``test_time_entry_crud.py``. The HTTP wrapper is a thin pass-through
that only translates the "already actioned" ValueError into a 409 —
that translation is covered by inspection of the route, not by
spinning up the full app per test.
"""
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB


# Test harness uses SQLite; JSONB has no native compiler there. Shim
# it to JSON so tables containing JSONB columns (e.g. setting_definitions)
# can be created during conftest setup. Matches the pattern in every
# other backend test file.
@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover - test shim
    return "JSON"


from app.crud.time_entry import (
    approve_time_entry,
    recall_time_entries,
    reject_time_entry,
    submit_time_entries,
)
from app.models.time_entry import (
    TimeEntry,
    TimeEntryEditHistory,
    TimeEntryStatus,
)


# ── Happy path ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_recall_submitted_entry_flips_back_to_draft(db_session, seeded_data):
    """The basic case the UI needs: a user who submitted by mistake
    pulls it back, edits, and resubmits. Submitted_at must clear so
    the supervisor's queue no longer surfaces it."""
    submitted_entry = seeded_data["submitted_entry"]
    # The seed fixture leaves submitted_at unset; give it a value so we
    # can verify it actually gets cleared on recall.
    submitted_entry.submitted_at = datetime.now(timezone.utc)
    await db_session.commit()

    employee = seeded_data["employee"]
    recalled = await recall_time_entries(db_session, employee.id, [submitted_entry.id])

    assert len(recalled) == 1
    assert recalled[0].id == submitted_entry.id
    assert recalled[0].status == TimeEntryStatus.DRAFT
    assert recalled[0].submitted_at is None
    assert recalled[0].last_edit_reason == "Recalled by user"


@pytest.mark.asyncio
async def test_recall_writes_edit_history_row(db_session, seeded_data):
    """Recall is a lifecycle event; it must leave a fingerprint in
    TimeEntryEditHistory so finance can reconstruct the timeline."""
    submitted_entry = seeded_data["submitted_entry"]
    submitted_entry.submitted_at = datetime.now(timezone.utc)
    await db_session.commit()

    await recall_time_entries(
        db_session, seeded_data["employee"].id, [submitted_entry.id]
    )

    rows = (await db_session.execute(
        select(TimeEntryEditHistory).where(
            TimeEntryEditHistory.time_entry_id == submitted_entry.id
        )
    )).scalars().all()
    assert len(rows) == 1
    assert rows[0].edit_reason == "Recalled by user"
    assert rows[0].edited_by == seeded_data["employee"].id
    assert rows[0].previous_hours == submitted_entry.hours


# ── Refusal cases ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_recall_refuses_already_approved_entry(db_session, seeded_data):
    """Race condition the UI must lose cleanly: between the user
    seeing the Recall button and clicking it, the manager hit Approve.
    The recall has to error out — silently letting it through would
    drop an approved entry back to DRAFT and break the manager's
    history view."""
    submitted_entry = seeded_data["submitted_entry"]
    submitted_entry.submitted_at = datetime.now(timezone.utc)
    await db_session.commit()

    # Manager approves first.
    await approve_time_entry(db_session, submitted_entry.id, seeded_data["manager"].id)

    with pytest.raises(ValueError, match="already been approved or rejected"):
        await recall_time_entries(
            db_session, seeded_data["employee"].id, [submitted_entry.id]
        )

    # Entry must remain APPROVED — no partial state change.
    await db_session.refresh(submitted_entry)
    assert submitted_entry.status == TimeEntryStatus.APPROVED


@pytest.mark.asyncio
async def test_recall_refuses_already_rejected_entry(db_session, seeded_data):
    """Same shape as the approved race: a manager rejection in flight
    also blocks recall. The user should follow the standard rework
    flow (the entry is already in DRAFT-via-rejection after the
    manager acts, so the recall button shouldn't even be visible —
    this is the belt-and-suspenders backend guard)."""
    submitted_entry = seeded_data["submitted_entry"]
    submitted_entry.submitted_at = datetime.now(timezone.utc)
    await db_session.commit()

    await reject_time_entry(
        db_session, submitted_entry.id, seeded_data["manager"].id, "Needs detail"
    )

    with pytest.raises(ValueError, match="already been approved or rejected"):
        await recall_time_entries(
            db_session, seeded_data["employee"].id, [submitted_entry.id]
        )


@pytest.mark.asyncio
async def test_recall_refuses_cross_user_attempt(db_session, seeded_data):
    """An employee cannot recall another employee's entries. The CRUD
    layer scopes the query by user_id so a foreign id silently returns
    an empty set; we surface that as a ValueError rather than letting
    the caller think the no-op succeeded."""
    submitted_entry = seeded_data["submitted_entry"]  # belongs to employee
    other = seeded_data["unassigned_employee"]

    with pytest.raises(ValueError, match="No entries found to recall"):
        await recall_time_entries(db_session, other.id, [submitted_entry.id])


@pytest.mark.asyncio
async def test_recall_refuses_when_entry_is_still_draft(db_session, seeded_data):
    """Drafts are already editable; recall is a no-op for them. If
    the UI sends a draft id (likely a bug or stale state), the CRUD
    refuses rather than treating it as a successful idempotent call —
    we want the bug to be loud."""
    draft_entry = seeded_data["draft_entry"]
    with pytest.raises(ValueError, match="No submitted entries to recall"):
        await recall_time_entries(
            db_session, seeded_data["employee"].id, [draft_entry.id]
        )


@pytest.mark.asyncio
async def test_recall_refuses_empty_entry_list(db_session, seeded_data):
    """Empty payload is a frontend bug; reject it at the CRUD seam so
    we don't run a SELECT IN () that some DBs treat as 'all rows'."""
    with pytest.raises(ValueError, match="No entries provided to recall"):
        await recall_time_entries(db_session, seeded_data["employee"].id, [])


# ── Mixed batch ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_recall_partial_batch_with_actioned_entry_aborts_whole_batch(
    db_session, seeded_data
):
    """If the user selects a week's worth of entries and one was
    already approved, we don't recall the rest and leave them in a
    weird half-recalled state. All-or-nothing matches the user's
    mental model of 'recall this week' as a single action."""
    employee = seeded_data["employee"]
    tenant_id = seeded_data["tenant"].id
    project = seeded_data["project"]

    # Existing submitted_entry (still pending) + a second entry we'll
    # mark approved ahead of the recall attempt.
    other = TimeEntry(
        tenant_id=tenant_id,
        user_id=employee.id,
        project_id=project.id,
        entry_date=seeded_data["submitted_entry"].entry_date,
        hours=Decimal("2.00"),
        description="Sibling entry, already approved",
        status=TimeEntryStatus.SUBMITTED,
        submitted_at=datetime.now(timezone.utc),
    )
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)
    await approve_time_entry(db_session, other.id, seeded_data["manager"].id)

    submitted_entry = seeded_data["submitted_entry"]
    submitted_entry.submitted_at = datetime.now(timezone.utc)
    await db_session.commit()

    with pytest.raises(ValueError, match="already been approved or rejected"):
        await recall_time_entries(
            db_session, employee.id, [submitted_entry.id, other.id]
        )

    # The still-pending entry must remain SUBMITTED, not flipped to
    # DRAFT.
    await db_session.refresh(submitted_entry)
    assert submitted_entry.status == TimeEntryStatus.SUBMITTED
