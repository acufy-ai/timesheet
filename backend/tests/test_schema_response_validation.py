"""Regression + hardening tests for the response-schema validator trap.

Prod bug (2026-06-30): a write-time validator ("end_time must be after
start_time") lived on `TimeEntryBase`, which `TimeEntryResponse` /
`TimeEntryWithUser` also inherit. One stored entry with a reversed/midnight
block (id 1324: 10:00 -> 00:00) failed validation on the RESPONSE path, so
`GET /approvals/pending` raised ResponseValidationError and 500'd the whole
list for the affected manager.

Fix: input-only validators (time block, status/enum allowlists) belong on the
`*Create` / `*Update` schemas, never on a `*Base` shared with a `*Response`.
A response must faithfully serialize whatever is stored, even a legacy/odd row.

These tests pin that contract across all four hardened schemas (TimeEntry,
Client, Project, Task) and probe edges that could hide the same class of bug.

Handler-level tests call the route directly (not via TestClient) because the
SQLite conftest seed doesn't set verified-email users — same approach as
test_approvals_pending_no_truncation.py.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB
from pydantic import ValidationError


# SQLite shim — every backend test in this repo declares it.
@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover
    return "JSON"


from app.schemas import (  # noqa: E402
    TimeEntryBase, TimeEntryCreate, TimeEntryResponse, TimeEntryWithUser,
    ClientBase, ClientCreate, ClientUpdate, ClientResponse,
    ProjectCreate, ProjectUpdate, ProjectResponse,
    TaskCreate, TaskUpdate, TaskResponse,
    UserResponse,
)
from app.models.user import UserRole  # noqa: E402
from app.crud.time_entry import list_pending_approvals  # noqa: E402
from app.models.time_entry import TimeEntry, TimeEntryStatus  # noqa: E402


# ════════════════════════════════════════════════════════════════════════════
#  TimeEntry — the original bug
# ════════════════════════════════════════════════════════════════════════════
def _stored_entry_kwargs(**over):
    """A response-shaped dict mirroring a stored row (all required fields)."""
    base = dict(
        id=1324, user_id=20, project_id=5, task_id=None,
        entry_date=date(2026, 6, 16),
        start_time=time(10, 0), end_time=time(0, 0),  # reversed/midnight block
        hours=Decimal("2.00"), description="x", notes=None, is_billable=True,
        status=TimeEntryStatus.SUBMITTED, submitted_at=None,
        approved_by=None, approved_by_name=None, created_by=None, updated_by=None,
        approved_at=None, rejection_reason=None,
        quickbooks_time_activity_id=None, ingestion_timesheet_id=None,
        last_edit_reason=None, last_history_summary=None,
        created_at=datetime(2026, 6, 16, 9, 0), updated_at=datetime(2026, 6, 16, 9, 0),
    )
    base.update(over)
    return base


def test_response_serializes_reversed_time_block():
    """The exact prod row (10:00 -> 00:00) must serialize on the response path."""
    r = TimeEntryResponse(**_stored_entry_kwargs())
    assert r.end_time == time(0, 0)
    assert r.start_time == time(10, 0)


def test_response_serializes_equal_start_end():
    """Zero-length block (start == end) is also write-invalid but read-safe."""
    r = TimeEntryResponse(**_stored_entry_kwargs(start_time=time(9, 0), end_time=time(9, 0)))
    assert r.start_time == r.end_time == time(9, 0)


def test_create_rejects_reversed_block():
    with pytest.raises(ValidationError):
        TimeEntryCreate(
            project_id=5, entry_date=date(2026, 6, 16),
            start_time=time(10, 0), end_time=time(0, 0),
            hours=Decimal("2"), description="x",
        )


def test_create_rejects_equal_block():
    with pytest.raises(ValidationError):
        TimeEntryCreate(
            project_id=5, entry_date=date(2026, 6, 16),
            start_time=time(9, 0), end_time=time(9, 0),
            hours=Decimal("2"), description="x",
        )


def test_create_accepts_valid_block_and_hours_only():
    # Forward block is fine.
    TimeEntryCreate(
        project_id=5, entry_date=date(2026, 6, 16),
        start_time=time(9, 0), end_time=time(17, 0),
        hours=Decimal("8"), description="x",
    )
    # Hours-only (no block) is fine.
    TimeEntryCreate(
        project_id=5, entry_date=date(2026, 6, 16),
        hours=Decimal("8"), description="x",
    )


def test_base_has_no_response_breaking_validator():
    """Structural guard: TimeEntryBase must not carry the block validator, else
    it re-leaks onto TimeEntryResponse. We assert the base accepts a reversed
    block (the response path), proving the validator isn't on the base."""
    # TimeEntryBase requires the write fields; a reversed block must NOT raise.
    TimeEntryBase(
        project_id=5, entry_date=date(2026, 6, 16),
        start_time=time(10, 0), end_time=time(0, 0),
        hours=Decimal("2"), description="x",
    )


# ── Handler-level: the real /approvals/pending serialization path ────────────
@pytest.mark.asyncio
async def test_pending_approvals_serializes_bad_block_end_to_end(db_session, seeded_data):
    """A stored reversed-block entry in a manager's queue must NOT 500 the list.
    We run the CRUD the handler runs, then push every row through the route's
    response_model (TimeEntryWithUser) exactly as FastAPI would."""
    tenant = seeded_data["tenant"]
    employee = seeded_data["employee"]
    project = seeded_data["project"]

    # A reversed-block SUBMITTED entry, like prod entry 1324.
    db_session.add(TimeEntry(
        tenant_id=tenant.id, user_id=employee.id, project_id=project.id,
        entry_date=date.today() - timedelta(days=2),
        start_time=time(10, 0), end_time=time(0, 0),
        hours=Decimal("2.00"), description="reversed block", is_billable=True,
        status=TimeEntryStatus.SUBMITTED,
    ))
    await db_session.commit()

    rows = await list_pending_approvals(
        db_session, employee_ids=[employee.id], tenant_id=tenant.id,
        sort_by="entry_date", sort_order="desc", skip=0, limit=1000,
    )
    assert rows, "expected pending rows including the reversed-block entry"

    # This is what raised ResponseValidationError before the fix.
    serialized = [TimeEntryWithUser.model_validate(r) for r in rows]
    assert any(s.end_time == time(0, 0) for s in serialized), \
        "the reversed-block entry must be present in the serialized response"


# ════════════════════════════════════════════════════════════════════════════
#  Client — status / client_type allowlist
# ════════════════════════════════════════════════════════════════════════════
def test_client_response_serializes_retired_status():
    """A stored client whose status predates the current allowlist must read."""
    r = ClientResponse(
        id=1, name="X", client_type="external", status="archived",
        client_self_manage_enabled=False,
        created_at=datetime.now(), updated_at=datetime.now(),
    )
    assert r.status == "archived"


def test_client_response_serializes_unknown_client_type():
    r = ClientResponse(
        id=1, name="X", client_type="partner-legacy", status="active",
        client_self_manage_enabled=False,
        created_at=datetime.now(), updated_at=datetime.now(),
    )
    assert r.client_type == "partner-legacy"


def test_client_create_rejects_bad_status_and_type():
    with pytest.raises(ValidationError):
        ClientCreate(name="X", client_type="external", status="archived")
    with pytest.raises(ValidationError):
        ClientCreate(name="X", client_type="bogus", status="active")


def test_client_update_rejects_bad_status_and_type():
    with pytest.raises(ValidationError):
        ClientUpdate(status="archived")
    with pytest.raises(ValidationError):
        ClientUpdate(client_type="bogus")


# ════════════════════════════════════════════════════════════════════════════
#  Project — status / revenue_recognition
# ════════════════════════════════════════════════════════════════════════════
def test_project_response_serializes_retired_status_and_revrec():
    r = ProjectResponse(
        id=1, name="P", client_id=1, billable_rate=Decimal("1"),
        revenue_recognition="legacy_mode", status="archived_status",
        is_active=True, created_at=datetime.now(), updated_at=datetime.now(),
    )
    assert r.status == "archived_status"
    assert r.revenue_recognition == "legacy_mode"


def test_project_create_rejects_bad_status_and_revrec():
    with pytest.raises(ValidationError):
        ProjectCreate(name="P", client_id=1, billable_rate=Decimal("1"), status="nope")
    with pytest.raises(ValidationError):
        ProjectCreate(name="P", client_id=1, billable_rate=Decimal("1"), revenue_recognition="nope")


def test_project_update_rejects_bad_status_and_revrec():
    """ProjectUpdate previously validated status but NOT revenue_recognition —
    the fix closed that gap. Both must reject now."""
    with pytest.raises(ValidationError):
        ProjectUpdate(status="nope")
    with pytest.raises(ValidationError):
        ProjectUpdate(revenue_recognition="nope")


def test_project_update_allows_none_passthrough():
    """A partial update that omits status/revrec must be accepted (None is the
    'unchanged' sentinel, not an invalid value)."""
    u = ProjectUpdate(name="renamed")
    assert u.status is None and u.revenue_recognition is None


# ════════════════════════════════════════════════════════════════════════════
#  Task — status
# ════════════════════════════════════════════════════════════════════════════
def test_task_response_serializes_retired_status():
    r = TaskResponse(
        id=1, project_id=1, name="T", status="archived_old",
        is_active=True, priority="medium",
        created_at=datetime.now(), updated_at=datetime.now(),
    )
    assert r.status == "archived_old"


def test_task_create_rejects_bad_status():
    with pytest.raises(ValidationError):
        TaskCreate(project_id=1, name="T", status="nope")


def test_task_update_rejects_bad_status():
    with pytest.raises(ValidationError):
        TaskUpdate(status="nope")


# ════════════════════════════════════════════════════════════════════════════
#  User — preferences (JSONB with no shape guarantee)
# ════════════════════════════════════════════════════════════════════════════
#  Latent bug found during this hardening pass: UserResponse.preferences is the
#  only remaining Response-schema validator. Its coercer handled None but NOT a
#  non-dict stored value (a JSON string or list), which would 500 /auth/me and
#  every user list for that row. Hardened to coerce any non-dict -> {}.
def _user_response(prefs):
    return UserResponse(
        id=1, email="a@b.com", username="a", full_name="A", role=UserRole.EMPLOYEE,
        tenant_id=1, has_changed_password=True, email_verified=True,
        preferences=prefs, created_at=datetime.now(), updated_at=datetime.now(),
    )


def test_user_preferences_none_coerced_to_dict():
    assert _user_response(None).preferences == {}


def test_user_preferences_dict_passes_through():
    assert _user_response({"inbox_view_mode": "compact"}).preferences == {"inbox_view_mode": "compact"}


def test_user_preferences_malformed_string_degrades_not_500():
    """A legacy/corrupt row storing preferences as a JSON string must read as {},
    not raise — otherwise it 500s every endpoint returning that user."""
    assert _user_response('{"x": 1}').preferences == {}


def test_user_preferences_malformed_list_degrades_not_500():
    assert _user_response(["a", "b"]).preferences == {}
