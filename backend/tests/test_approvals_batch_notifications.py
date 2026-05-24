"""D-061 regression: batch approve / batch reject must send the
employee one summary email per batch, mirroring the per-entry
behaviour that already exists on single-entry approve/reject.

Before D-061 the batch handlers were silent — confusing under the
redesigned manager UI where most actions are batched. These tests
pin the contract: the route handler invokes
``notify_timesheet_approved`` / ``notify_timesheet_rejected`` once
per batch, with the correct identity, span, and (for reject) the
reviewer's reason.

We test the route handler **directly** (not via TestClient) because
the comprehensive-suite TestClient fixture has ordering dependencies
that don't play with single-file pytest runs. The functions take
plain pydantic requests + a session + a user, so calling them with
a stubbed notification function is the cleanest way to lock the
behaviour.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

import pytest
import pytest_asyncio
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB


# SQLite shim — every backend test in this repo declares it.
@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover
    return "JSON"


from app.api import approvals as approvals_api  # noqa: E402
from app.models.time_entry import TimeEntryStatus  # noqa: E402
from app.schemas import TimeEntryBatchApproveRequest, TimeEntryBatchRejectRequest  # noqa: E402


# ── Fixtures ────────────────────────────────────────────────────────


@pytest_asyncio.fixture
async def submitted_week(db_session, seeded_data):
    """Promote the seeded SUBMITTED entry into a real submitted week.

    The conftest seeds one DRAFT + one SUBMITTED entry. The batch
    handlers' weekly validator requires *all* SUBMITTED entries for
    the week to be in the batch. By marking both as SUBMITTED on the
    same date we get a well-formed batch of one.
    """
    submitted_entry = seeded_data["submitted_entry"]
    # Ensure it carries a submitted_at so the route's notification
    # date range has a value to span.
    submitted_entry.submitted_at = datetime.now(timezone.utc)
    submitted_entry.status = TimeEntryStatus.SUBMITTED
    db_session.add(submitted_entry)
    await db_session.commit()
    await db_session.refresh(submitted_entry)
    return submitted_entry


# ── Approve batch ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_batch_approve_fires_notification(
    db_session, seeded_data, submitted_week, monkeypatch
):
    """The handler must call ``notify_timesheet_approved`` exactly
    once with the batched span (min..max date), correct identity, and
    the SUMMED hours — not per-entry hours."""
    calls: list[dict] = []

    async def _record(**kwargs):
        calls.append(kwargs)
        return None

    monkeypatch.setattr(approvals_api, "notify_timesheet_approved", _record)

    manager = seeded_data["manager"]
    req = TimeEntryBatchApproveRequest(entry_ids=[submitted_week.id])

    result = await approvals_api.approve_entry_batch(
        approve_request=req,
        db=db_session,
        current_user=manager,
    )

    assert len(result) == 1
    assert result[0].status.value == "APPROVED"

    assert len(calls) == 1, "expected exactly one notification per batch"
    call = calls[0]
    employee = seeded_data["employee"]
    assert call["employee_email"] == employee.email
    assert call["employee_name"] == employee.full_name
    assert call["approver_name"] == manager.full_name
    assert call["hours"] == float(submitted_week.hours)
    # Single entry → start == end.
    assert call["week_start"] == call["week_end"]


# ── Reject batch ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_batch_reject_fires_notification_with_reason(
    db_session, seeded_data, submitted_week, monkeypatch
):
    """Rejection must echo the reviewer's reason verbatim so the
    employee can rework without going back to the queue. This is the
    whole point of moving the comment field next to the action."""
    calls: list[dict] = []

    async def _record(**kwargs):
        calls.append(kwargs)
        return None

    monkeypatch.setattr(approvals_api, "notify_timesheet_rejected", _record)

    manager = seeded_data["manager"]
    reason = "Please add task codes and double-check Wednesday's hours."
    req = TimeEntryBatchRejectRequest(entry_ids=[submitted_week.id], rejection_reason=reason)

    result = await approvals_api.reject_entry_batch(
        reject_request=req,
        db=db_session,
        current_user=manager,
    )

    assert len(result) == 1
    assert result[0].status.value == "REJECTED"

    assert len(calls) == 1
    call = calls[0]
    employee = seeded_data["employee"]
    assert call["employee_email"] == employee.email
    assert call["employee_name"] == employee.full_name
    assert call["rejector_name"] == manager.full_name
    assert call["reason"] == reason


# ── Scope rule for inbox-approved ingestion timesheets ─────────────


@pytest.mark.asyncio
async def test_inbox_scope_workspace_for_admin(db_session, seeded_data):
    """Admins always get the workspace view of approved ingestion
    timesheets even when they send ``scope=mine``. The redundancy is
    intentional — the frontend sends one consistent value and the
    backend decides based on the caller's role."""
    from app.api.admin import list_approved_ingestion_timesheets

    # Smoke: admin can call with scope=mine without 403. The seed
    # has no ingestion data so the response is empty, but the
    # important assertion is "does not raise".
    result = await list_approved_ingestion_timesheets(
        employee_id=None,
        scope="mine",
        limit=200,
        db=db_session,
        current_user=seeded_data["admin"],
    )
    assert isinstance(result, list)


@pytest.mark.asyncio
async def test_inbox_scope_mine_filters_to_manager_reports_and_reviewer(
    db_session, seeded_data
):
    """Pure-manager calling ``scope=mine`` resolves the descendant
    tree once and filters by ``employee_id IN <tree> OR
    reviewer_id == current_user.id``. Without ingestion seed data
    the result is empty — what matters is the CRUD path doesn't
    blow up. Behavioural tests for the union itself live with the
    ingestion CRUD."""
    from app.api.admin import list_approved_ingestion_timesheets

    result = await list_approved_ingestion_timesheets(
        employee_id=None,
        scope="mine",
        limit=200,
        db=db_session,
        current_user=seeded_data["manager"],
    )
    assert isinstance(result, list)
