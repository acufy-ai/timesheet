"""Regression: ingestion timesheet list search must match the resolved
employee's name and the resolved client's name, not only email-side fields.

Before this fix, list_ingestion_timesheets() searched llm_summary +
IngestedEmail.subject + IngestedEmail.sender_email. So any timesheet
whose employee name appeared NOWHERE in the email itself -- the typical
"someone forwards a teammate's timesheet" case -- was unfindable by the
employee's name in the inbox search bar. We hit this on 2026-06-04 with
a Webilent employee (Kalpana) whose timesheets were forwarded by Priya:
the row resolved to Kalpana as the employee, but searching "kalpana"
returned zero results.

This test fixture sets up the exact shape (employee resolved to a user
whose name is not in the email payload) and asserts the search now finds
it. It also covers the client-name and outer-join cases.
"""
from __future__ import annotations

from datetime import date, datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover
    return "JSON"


from app.crud.ingestion_timesheet import list_ingestion_timesheets
from app.models.base import Base
from app.models.client import Client
from app.models.ingested_email import IngestedEmail
from app.models.ingestion_timesheet import (
    IngestionTimesheet,
    IngestionTimesheetStatus,
)
from app.models.mailbox import Mailbox, MailboxAuthType, MailboxProtocol
from app.models.tenant import Tenant, TenantStatus
from app.models.user import User, UserRole


@pytest_asyncio.fixture
async def db_session(tmp_path):
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'ingestion_search.db'}"
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as session:
        yield session
    await engine.dispose()


@pytest_asyncio.fixture
async def seed(db_session: AsyncSession) -> dict:
    """Two tenants, one timesheet each.

    Tenant A: a forwarded-by-someone-else timesheet where the resolved
    employee's name ("Kalpana Puli") appears nowhere on the email itself.
    The email's sender + subject reference Priya, not Kalpana.

    Tenant B: an entirely unrelated timesheet to verify tenant isolation.
    """
    t_a = Tenant(name="Webilent", slug="webilent", status=TenantStatus.active)
    t_b = Tenant(name="Other", slug="other", status=TenantStatus.active)
    db_session.add_all([t_a, t_b])
    await db_session.flush()

    # IngestedEmail.mailbox_id is NOT NULL, so each tenant needs at least
    # one Mailbox row to anchor its emails to. The contents are irrelevant
    # to the search behavior under test; we just need a valid FK target.
    mbox_a = Mailbox(
        tenant_id=t_a.id, label="mbox-a",
        protocol=MailboxProtocol.imap, auth_type=MailboxAuthType.basic,
        is_active=True,
    )
    mbox_b = Mailbox(
        tenant_id=t_b.id, label="mbox-b",
        protocol=MailboxProtocol.imap, auth_type=MailboxAuthType.basic,
        is_active=True,
    )
    db_session.add_all([mbox_a, mbox_b])
    await db_session.flush()

    kalpana = User(
        tenant_id=t_a.id,
        email="kalpana@webilent.test",
        username="kalpana",
        full_name="Kalpana Puli",
        hashed_password="x",
        role=UserRole.EMPLOYEE,
        is_active=True,
    )
    # Unrelated employee in the same tenant to confirm we don't over-match.
    chris = User(
        tenant_id=t_a.id,
        email="chris@webilent.test",
        username="chris",
        full_name="Chris Other",
        hashed_password="x",
        role=UserRole.EMPLOYEE,
        is_active=True,
    )
    # Cross-tenant user with the same first name to verify tenant scope.
    other_kalpana = User(
        tenant_id=t_b.id,
        email="kalpana@other.test",
        username="kalpana-b",
        full_name="Kalpana Other",
        hashed_password="x",
        role=UserRole.EMPLOYEE,
        is_active=True,
    )
    client = Client(tenant_id=t_a.id, name="Acme Holdings")
    db_session.add_all([kalpana, chris, other_kalpana, client])
    await db_session.flush()

    forwarded_email = IngestedEmail(
        tenant_id=t_a.id,
        mailbox_id=mbox_a.id,
        message_id="msg-1",
        # The smoking-gun shape: nothing on the email mentions Kalpana.
        sender_email="priya@webilent.test",
        sender_name="Priya Janardhan",
        subject="Fwd: Regarding Jan 2026 Timesheets",
        body_text="Hi Team, please find attached.",
        received_at=datetime(2026, 1, 30, tzinfo=timezone.utc),
        fetched_at=datetime(2026, 1, 30, tzinfo=timezone.utc),
    )
    chris_email = IngestedEmail(
        tenant_id=t_a.id,
        mailbox_id=mbox_a.id,
        message_id="msg-2",
        sender_email="chris@webilent.test",
        sender_name="Chris Other",
        subject="Timesheet",
        body_text="Hours attached",
        received_at=datetime(2026, 1, 30, tzinfo=timezone.utc),
        fetched_at=datetime(2026, 1, 30, tzinfo=timezone.utc),
    )
    other_email = IngestedEmail(
        tenant_id=t_b.id,
        mailbox_id=mbox_b.id,
        message_id="msg-3",
        sender_email="kalpana@other.test",
        sender_name="Kalpana Other",
        subject="Cross-tenant decoy",
        body_text="Should never be returned for tenant A",
        received_at=datetime(2026, 1, 30, tzinfo=timezone.utc),
        fetched_at=datetime(2026, 1, 30, tzinfo=timezone.utc),
    )
    db_session.add_all([forwarded_email, chris_email, other_email])
    await db_session.flush()

    kalpana_ts = IngestionTimesheet(
        tenant_id=t_a.id,
        email_id=forwarded_email.id,
        employee_id=kalpana.id,
        client_id=client.id,
        status=IngestionTimesheetStatus.pending,
        period_start=date(2026, 1, 1),
        period_end=date(2026, 1, 31),
        llm_summary="Monthly timesheet summary",
        extracted_data={},
        submitted_at=forwarded_email.received_at,
    )
    chris_ts = IngestionTimesheet(
        tenant_id=t_a.id,
        email_id=chris_email.id,
        employee_id=chris.id,
        client_id=None,
        status=IngestionTimesheetStatus.pending,
        period_start=date(2026, 1, 1),
        period_end=date(2026, 1, 31),
        llm_summary="Other summary",
        extracted_data={},
        submitted_at=chris_email.received_at,
    )
    other_ts = IngestionTimesheet(
        tenant_id=t_b.id,
        email_id=other_email.id,
        employee_id=other_kalpana.id,
        client_id=None,
        status=IngestionTimesheetStatus.pending,
        period_start=date(2026, 1, 1),
        period_end=date(2026, 1, 31),
        llm_summary="cross",
        extracted_data={},
        submitted_at=other_email.received_at,
    )
    # Promoted-from-skip shape: no employee, no client yet, but the
    # search should still surface this row when other fields match.
    promoted_email = IngestedEmail(
        tenant_id=t_a.id,
        mailbox_id=mbox_a.id,
        message_id="msg-4",
        sender_email="anon@webilent.test",
        sender_name=None,
        subject="Mystery body-only timesheet",
        body_text="01/05 - 41.5 hrs",
        received_at=datetime(2026, 1, 30, tzinfo=timezone.utc),
        fetched_at=datetime(2026, 1, 30, tzinfo=timezone.utc),
    )
    db_session.add(promoted_email)
    await db_session.flush()
    promoted_ts = IngestionTimesheet(
        tenant_id=t_a.id,
        email_id=promoted_email.id,
        employee_id=None,
        client_id=None,
        status=IngestionTimesheetStatus.pending,
        period_start=date(2026, 1, 1),
        period_end=date(2026, 1, 31),
        llm_summary=None,
        extracted_data={"promoted_from_skip": True},
        submitted_at=promoted_email.received_at,
    )
    db_session.add_all([kalpana_ts, chris_ts, other_ts, promoted_ts])
    await db_session.commit()

    return {
        "tenant_a": t_a,
        "tenant_b": t_b,
        "kalpana_ts_id": kalpana_ts.id,
        "chris_ts_id": chris_ts.id,
        "other_ts_id": other_ts.id,
        "promoted_ts_id": promoted_ts.id,
    }


@pytest.mark.asyncio
async def test_search_finds_by_employee_full_name(db_session, seed):
    """The bug we're fixing: search by Kalpana's full name returns her
    timesheet even though her name appears nowhere on the email."""
    results = await list_ingestion_timesheets(
        session=db_session,
        tenant_id=seed["tenant_a"].id,
        search="kalpana",
    )
    ids = {r.id for r in results}
    assert seed["kalpana_ts_id"] in ids, (
        "search by employee first name must match the resolved employee"
    )
    assert seed["chris_ts_id"] not in ids, (
        "unrelated employee in the same tenant must not be returned"
    )


@pytest.mark.asyncio
async def test_search_finds_by_employee_email(db_session, seed):
    """Same bug surface: searching by the resolved user's email must work
    even when that email isn't the email's sender."""
    results = await list_ingestion_timesheets(
        session=db_session,
        tenant_id=seed["tenant_a"].id,
        search="kalpana@webilent.test",
    )
    assert {r.id for r in results} == {seed["kalpana_ts_id"]}


@pytest.mark.asyncio
async def test_search_finds_by_client_name(db_session, seed):
    """New capability that falls out of the JOIN: searching by client name."""
    results = await list_ingestion_timesheets(
        session=db_session,
        tenant_id=seed["tenant_a"].id,
        search="Acme",
    )
    assert {r.id for r in results} == {seed["kalpana_ts_id"]}


@pytest.mark.asyncio
async def test_search_preserves_existing_subject_match(db_session, seed):
    """Existing behavior must still work after the JOIN change."""
    results = await list_ingestion_timesheets(
        session=db_session,
        tenant_id=seed["tenant_a"].id,
        search="Mystery",
    )
    # Promoted-from-skip row has employee_id=None, client_id=None.
    # Outer joins are required so this row still surfaces on a
    # subject match -- inner join would drop it.
    assert {r.id for r in results} == {seed["promoted_ts_id"]}


@pytest.mark.asyncio
async def test_search_tenant_isolated(db_session, seed):
    """Tenant scope still holds with the new JOINs: searching 'kalpana'
    in tenant A must not return tenant B's Kalpana."""
    a_results = await list_ingestion_timesheets(
        session=db_session,
        tenant_id=seed["tenant_a"].id,
        search="kalpana",
    )
    b_results = await list_ingestion_timesheets(
        session=db_session,
        tenant_id=seed["tenant_b"].id,
        search="kalpana",
    )
    assert seed["other_ts_id"] not in {r.id for r in a_results}
    assert {r.id for r in b_results} == {seed["other_ts_id"]}
