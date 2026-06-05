"""Regression: /approvals/pending must return the manager's WHOLE pending
backlog, not silently cap at the old default of 100.

The bug (prod, 2026-06-05): the manager dashboard showed 321 pending
(an unbounded COUNT) while the Approvals page showed only 100 — the
`/approvals/pending` route defaulted to `limit=100` and, sorted
entry_date DESC, dropped the oldest weeks. Managers couldn't see or
approve the earliest pending timesheets.

Fix: the pending queue is a finite review worklist, so the route now
defaults to a high limit (returns the full backlog). This test pins
that contract.

We exercise the route handler + CRUD directly (not via TestClient)
because this repo's TestClient login fixture requires verified-email
users that the SQLite conftest seed doesn't set — the same reason
test_approvals_batch_notifications.py tests the handler directly.
"""
from __future__ import annotations

import inspect
from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB


# SQLite shim — every backend test in this repo declares it.
@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover
    return "JSON"


from app.api import approvals as approvals_api  # noqa: E402
from app.crud.time_entry import list_pending_approvals  # noqa: E402
from app.models.time_entry import TimeEntry, TimeEntryStatus  # noqa: E402


PENDING_COUNT = 120  # > the old 100 cap, spanning ~17 weeks (1/day)


async def _seed_pending_backlog(db_session, seeded_data, n: int) -> None:
    """Add n SUBMITTED entries for the assigned employee, one per day
    walking backwards, so the oldest land beyond the old cap when sorted
    entry_date DESC."""
    tenant = seeded_data["tenant"]
    employee = seeded_data["employee"]
    project = seeded_data["project"]
    start = date.today()
    db_session.add_all([
        TimeEntry(
            tenant_id=tenant.id,
            user_id=employee.id,
            project_id=project.id,
            entry_date=start - timedelta(days=i),
            hours=Decimal("8.00"),
            description=f"Pending backlog entry {i}",
            is_billable=True,
            status=TimeEntryStatus.SUBMITTED,
        )
        for i in range(n)
    ])
    await db_session.commit()


def test_route_default_limit_is_not_the_old_cap():
    """The /pending route's default limit must be well above 100 so the
    manager worklist isn't silently truncated. Guards against a future
    edit reintroducing limit=100."""
    sig = inspect.signature(approvals_api.get_pending_approvals)
    limit_param = sig.parameters["limit"]
    # FastAPI wraps the default in a Query(...) object; its .default holds
    # the value.
    query_obj = limit_param.default
    assert getattr(query_obj, "default", None) == 1000, (
        "pending route default limit regressed — should return the full backlog"
    )


@pytest.mark.asyncio
async def test_crud_returns_full_backlog_with_high_limit(db_session, seeded_data):
    """With the route's default (1000), every pending entry comes back —
    including the oldest week that used to fall off at 100."""
    await _seed_pending_backlog(db_session, seeded_data, PENDING_COUNT)
    tenant = seeded_data["tenant"]
    employee = seeded_data["employee"]

    rows = await list_pending_approvals(
        db_session,
        employee_ids=[employee.id],
        tenant_id=tenant.id,
        sort_by="entry_date",
        sort_order="desc",
        skip=0,
        limit=1000,  # the new route default
    )

    # Seed already had 1 SUBMITTED entry for this employee + our backlog.
    assert len(rows) > 100, f"truncated to {len(rows)} — earlier weeks dropped"
    assert len(rows) >= PENDING_COUNT

    # The oldest entry (furthest back) must be present.
    oldest = date.today() - timedelta(days=PENDING_COUNT - 1)
    returned_dates = {r.entry_date for r in rows}
    assert oldest in returned_dates, "oldest pending week is missing"


@pytest.mark.asyncio
async def test_crud_still_honours_explicit_smaller_limit(db_session, seeded_data):
    """The fix only changes the DEFAULT — an explicit limit still pages."""
    await _seed_pending_backlog(db_session, seeded_data, PENDING_COUNT)
    rows = await list_pending_approvals(
        db_session,
        employee_ids=[seeded_data["employee"].id],
        tenant_id=seeded_data["tenant"].id,
        limit=10,
    )
    assert len(rows) == 10
