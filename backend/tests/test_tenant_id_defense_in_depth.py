"""M2: rows in three child tables now carry their own tenant_id for
defense-in-depth. These tests pin the model-level contract: a fresh
schema build (e.g. test DB or new tenant DB) has the column NOT NULL,
and inserts that forget to set it fail at the ORM layer rather than
silently writing NULLs.
"""
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
import pytest_asyncio
from sqlalchemy.exc import IntegrityError, StatementError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover - shim
    return "JSON"


from app.models.base import Base
from app.models.ingestion_timesheet import (
    IngestionAuditLog,
    IngestionTimesheet,
    IngestionTimesheetLineItem,
    IngestionTimesheetStatus,
)
from app.models.tenant import Tenant, TenantStatus
from app.models.time_entry import TimeEntry, TimeEntryEditHistory, TimeEntryStatus
from app.models.user import User, UserRole
from app.models.client import Client
from app.models.project import Project
from app.models.ingested_email import IngestedEmail
from app.models.mailbox import Mailbox, MailboxAuthType, MailboxProtocol


@pytest_asyncio.fixture
async def db(tmp_path):
    f = tmp_path / "m2.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{f}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sf = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with sf() as session:
        yield session
    await engine.dispose()


async def _seed_tenant_and_user(db):
    tenant = Tenant(name="T", slug="t", status=TenantStatus.active)
    user = User(
        tenant=tenant,
        email="u@example.com",
        username="u",
        full_name="U",
        hashed_password="x",
        role=UserRole.EMPLOYEE,
        is_active=True,
    )
    db.add_all([tenant, user])
    await db.flush()
    return tenant, user


async def _seed_ingestion_timesheet(db):
    tenant, user = await _seed_tenant_and_user(db)
    mailbox = Mailbox(
        tenant_id=tenant.id,
        label="m",
        protocol=MailboxProtocol.imap,
        auth_type=MailboxAuthType.basic,
    )
    db.add(mailbox)
    await db.flush()
    email = IngestedEmail(
        tenant_id=tenant.id,
        mailbox_id=mailbox.id,
        # message_id is NOT NULL on the model. Any unique string works
        # for tests that don't care about idempotency.
        message_id="<test@example.com>",
        subject="s",
        sender_email="s@example.com",
        received_at=datetime.now(timezone.utc),
        # raw_payload was renamed to raw_headers; both are nullable JSON
        # on the current model, so we can simply omit them.
    )
    db.add(email)
    await db.flush()
    ts = IngestionTimesheet(
        tenant_id=tenant.id,
        email_id=email.id,
        status=IngestionTimesheetStatus.pending,
    )
    db.add(ts)
    await db.flush()
    return tenant, user, ts


@pytest.mark.asyncio
async def test_edit_history_requires_tenant_id(db):
    tenant, user = await _seed_tenant_and_user(db)
    client = Client(tenant_id=tenant.id, name="C")
    db.add(client)
    await db.flush()
    project = Project(
        tenant_id=tenant.id,
        client_id=client.id,
        name="P",
        # billable_rate is NOT NULL on the model; default to 0 since
        # this test doesn't care about billing math, only the
        # tenant_id NOT NULL contract on the child tables below.
        billable_rate=Decimal("0.00"),
    )
    db.add(project)
    await db.flush()
    entry = TimeEntry(
        tenant_id=tenant.id,
        user_id=user.id,
        project_id=project.id,
        entry_date=date(2026, 5, 1),
        hours=Decimal("4.00"),
        description="d",
        is_billable=True,
        status=TimeEntryStatus.DRAFT,
    )
    db.add(entry)
    await db.flush()

    # Missing tenant_id raises at flush.
    bad = TimeEntryEditHistory(
        time_entry_id=entry.id,
        edited_by=user.id,
        edited_at=datetime.now(timezone.utc),
        edit_reason="r",
        history_summary="s",
        previous_project_id=project.id,
        previous_entry_date=entry.entry_date,
        previous_hours=entry.hours,
        previous_description=entry.description,
    )
    db.add(bad)
    with pytest.raises((IntegrityError, StatementError)):
        await db.flush()
    await db.rollback()

    # With tenant_id, the row inserts cleanly.
    ok = TimeEntryEditHistory(
        tenant_id=tenant.id,
        time_entry_id=entry.id,
        edited_by=user.id,
        edited_at=datetime.now(timezone.utc),
        edit_reason="r",
        history_summary="s",
        previous_project_id=project.id,
        previous_entry_date=entry.entry_date,
        previous_hours=entry.hours,
        previous_description=entry.description,
    )
    db.add(ok)
    await db.flush()


@pytest.mark.asyncio
async def test_line_item_requires_tenant_id(db):
    tenant, user, ts = await _seed_ingestion_timesheet(db)

    bad = IngestionTimesheetLineItem(
        ingestion_timesheet_id=ts.id,
        work_date=date(2026, 5, 1),
        hours=Decimal("4.00"),
    )
    db.add(bad)
    with pytest.raises((IntegrityError, StatementError)):
        await db.flush()
    await db.rollback()


@pytest.mark.asyncio
async def test_audit_log_requires_tenant_id(db):
    tenant, user, ts = await _seed_ingestion_timesheet(db)

    bad = IngestionAuditLog(
        ingestion_timesheet_id=ts.id,
        user_id=user.id,
        action="x",
    )
    db.add(bad)
    with pytest.raises((IntegrityError, StatementError)):
        await db.flush()
    await db.rollback()


@pytest.mark.asyncio
async def test_write_audit_log_helper_requires_tenant_id_kwarg(db):
    """The crud helper enforces tenant_id as a keyword-only required
    argument. Callers that forget it fail at call time (TypeError),
    not later at the schema level."""
    tenant, user, ts = await _seed_ingestion_timesheet(db)
    from app.crud.ingestion_timesheet import write_audit_log

    with pytest.raises(TypeError):
        await write_audit_log(db, ts.id, user.id, "x")  # missing tenant_id


@pytest.mark.asyncio
async def test_write_audit_log_helper_persists_tenant_id(db):
    tenant, user, ts = await _seed_ingestion_timesheet(db)
    from app.crud.ingestion_timesheet import write_audit_log

    await write_audit_log(
        db, ts.id, user.id, "field_updated", tenant_id=tenant.id,
    )
    await db.flush()
    row = (await db.execute(
        IngestionAuditLog.__table__.select().where(
            IngestionAuditLog.__table__.c.ingestion_timesheet_id == ts.id
        )
    )).first()
    assert row is not None
    assert row.tenant_id == tenant.id
