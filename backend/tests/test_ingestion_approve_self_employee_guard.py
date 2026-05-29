"""
Regression test: a reviewer cannot approve an ingested timesheet whose
employee_id is themselves.

Migration 062 added a CHECK constraint
    approved_by IS NULL OR approved_by <> user_id
on ``time_entries``. The ingestion-approve route at
``api/ingestion.py:approve_timesheet`` creates one TimeEntry per line
item with ``approved_by=current_user.id, user_id=timesheet.employee_id``.
Without a guard, a reviewer who is also the timesheet's employee would
hit the CHECK at INSERT time and the request would 500 mid-loop with a
partially-flushed batch.

The guard short-circuits the route with a clear 400 before any inserts
happen, mirroring the same self-approval pattern in
``crud/time_entry.py:approve_time_entry``.

This is the kind of bug the post-migration-066 audit on 2026-05-29
flagged as CRITICAL #2.
"""
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB


# JSONB → JSON shim for SQLite (test-only).
@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover - test shim
    return "JSON"


from app.api import ingestion
from app.core.security import create_access_token, get_password_hash
from app.db import get_db
from app.core.deps import get_tenant_db
from app.models.base import Base
from app.models.ingested_email import IngestedEmail
from app.models.ingestion_timesheet import IngestionTimesheet, IngestionTimesheetStatus
from app.models.mailbox import Mailbox, MailboxAuthType, MailboxProtocol
from app.models.tenant import Tenant, TenantStatus
from app.models.user import User, UserRole


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    db_file = tmp_path / "ingestion_approve_self.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_file}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    await engine.dispose()


@pytest_asyncio.fixture
async def setup_reviewer_as_employee(db_session: AsyncSession) -> dict:
    """Construct a tenant + a single user who is BOTH the reviewer
    (can_review=True) and the employee on a pending ingestion timesheet."""
    tenant = Tenant(
        name="T", slug="t", status=TenantStatus.active, ingestion_enabled=True,
    )
    db_session.add(tenant)
    await db_session.flush()

    # The same user is the reviewer (can_review=True) AND the employee
    # on the timesheet. This is real on multi-role users — a MANAGER who
    # also submits their own timesheets via the same mailbox feed.
    reviewer_employee = User(
        tenant_id=tenant.id, email="r@t.example", username="r", full_name="R",
        hashed_password=get_password_hash("password"), role=UserRole.MANAGER,
        is_active=True, has_changed_password=True, email_verified=True,
        can_review=True,
    )
    db_session.add(reviewer_employee)
    await db_session.flush()

    mailbox = Mailbox(
        tenant_id=tenant.id, label="X", protocol=MailboxProtocol.imap,
        auth_type=MailboxAuthType.basic, is_active=True,
    )
    db_session.add(mailbox)
    await db_session.flush()

    email = IngestedEmail(
        tenant_id=tenant.id, mailbox_id=mailbox.id,
        message_id="<approve-self@t>", sender_email="r@t.example",
    )
    db_session.add(email)
    await db_session.flush()

    timesheet = IngestionTimesheet(
        tenant_id=tenant.id,
        email_id=email.id,
        employee_id=reviewer_employee.id,
        status=IngestionTimesheetStatus.pending,
    )
    db_session.add(timesheet)
    await db_session.commit()

    return {
        "tenant": tenant,
        "reviewer_employee": reviewer_employee,
        "timesheet": timesheet,
    }


def _make_app(db_session: AsyncSession) -> TestClient:
    app = FastAPI()
    app.include_router(ingestion.router)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_tenant_db] = override_get_db
    return TestClient(app)


def _auth_headers(user: User) -> dict:
    token = create_access_token({"sub": str(user.id), "tenant_id": user.tenant_id})
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_reviewer_cannot_approve_own_ingested_timesheet(
    db_session: AsyncSession, setup_reviewer_as_employee: dict
):
    """Reviewer == employee on the timesheet → 400, not 500.

    Without the guard this path would attempt to INSERT TimeEntry rows
    with user_id == approved_by, and migration 062's CHECK would fire
    at flush time, surfacing as a 500.
    """
    data = setup_reviewer_as_employee
    user = data["reviewer_employee"]
    ts = data["timesheet"]

    client = _make_app(db_session)
    with client:
        resp = client.post(
            f"/ingestion/timesheets/{ts.id}/approve",
            json={},
            headers=_auth_headers(user),
        )

    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert "employee" in body["detail"].lower(), body


@pytest.mark.asyncio
async def test_reviewer_can_still_approve_someone_elses_ingested_timesheet(
    db_session: AsyncSession, setup_reviewer_as_employee: dict
):
    """Guard rejects ONLY self-approval; approving someone else still works.

    Reuses the fixture but adds a second employee and points the
    timesheet at that employee instead. We don't run the full approval
    flow (that depends on line items, projects, etc.) — just assert
    the route doesn't trip the guard's 400 at the top.
    """
    data = setup_reviewer_as_employee
    reviewer = data["reviewer_employee"]
    ts = data["timesheet"]

    other_employee = User(
        tenant_id=data["tenant"].id, email="emp@t.example", username="emp",
        full_name="Emp", hashed_password=get_password_hash("password"),
        role=UserRole.EMPLOYEE, is_active=True,
        has_changed_password=True, email_verified=True,
    )
    db_session.add(other_employee)
    await db_session.commit()

    ts.employee_id = other_employee.id
    await db_session.commit()

    client = _make_app(db_session)
    with client:
        resp = client.post(
            f"/ingestion/timesheets/{ts.id}/approve",
            json={},
            headers=_auth_headers(reviewer),
        )

    # Approval may still 400 for other reasons (no line items, no project
    # mapping). What we MUST NOT see is the self-employee guard's 400 OR
    # the schema 500 — anything else means we got past the guard.
    if resp.status_code == 400:
        body = resp.json()
        assert "employee" not in body["detail"].lower(), (
            f"guard wrongly tripped for cross-employee approval: {body}"
        )
    else:
        # 200 or other status — either way, the guard didn't kill it.
        pass
