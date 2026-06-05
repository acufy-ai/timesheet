"""Body-only timesheet extraction (added 2026-06-04).

When the LLM classifier identifies a submission AND there are no
candidate attachments, the pipeline runs extract_timesheet_data on
the email body directly and creates IngestionTimesheet rows. This
is the case Kalpana's forwarded January 2026 month exposed -- the
body has weekly date ranges paired with hour totals but no PDF.

These tests are structural. They lock the branch shape so:
  - The body-extract helper produces IngestionTimesheet rows with
    the expected line items, attachment_id=None, employee_id=None.
  - Empty extraction returns 0 (no IngestionTimesheet row created;
    email still skipped so the Promote button is the manual override).
  - The attachment path is untouched by the new code: emails with
    attachments still take the existing attachment loop.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover
    return "JSON"


from app.models.base import Base
from app.models.ingested_email import IngestedEmail
from app.models.ingestion_timesheet import (
    IngestionTimesheet,
    IngestionTimesheetLineItem,
    IngestionTimesheetStatus,
)
from app.models.mailbox import Mailbox, MailboxAuthType, MailboxProtocol
from app.models.tenant import Tenant, TenantStatus
from app.services import ingestion_pipeline


@pytest_asyncio.fixture
async def db_session(tmp_path):
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'body_only.db'}"
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
async def fixtures(db_session: AsyncSession) -> dict:
    """A tenant + one mailbox + one already-fetched email shell that
    the body-only helper will write timesheet rows against."""
    tenant = Tenant(name="T", slug="t", status=TenantStatus.active)
    db_session.add(tenant)
    await db_session.flush()

    mailbox = Mailbox(
        tenant_id=tenant.id, label="mbox",
        protocol=MailboxProtocol.imap, auth_type=MailboxAuthType.basic,
        is_active=True,
    )
    db_session.add(mailbox)
    await db_session.flush()

    email = IngestedEmail(
        tenant_id=tenant.id,
        mailbox_id=mailbox.id,
        message_id="msg-body-only-test",
        sender_email="forwarder@example.com",
        sender_name="Forwarder",
        subject="Fwd: Regarding Jan 2026 Timesheets",
        body_text="Hi Team,\n01/05/2026 to 01/11/2026 - 41.5 hrs\n01/12 - 01/18 - 40 hrs\n",
        received_at=datetime(2026, 1, 30, tzinfo=timezone.utc),
        fetched_at=datetime(2026, 1, 30, tzinfo=timezone.utc),
    )
    db_session.add(email)
    await db_session.commit()

    return {"tenant_id": tenant.id, "email_id": email.id, "email": email}


@pytest.mark.asyncio
async def test_body_only_extract_creates_timesheet_and_line_items(db_session, fixtures):
    """Happy path: LLM returns one timesheet with two line items; helper
    creates one IngestionTimesheet row + two IngestionTimesheetLineItem
    rows, leaves employee_id/client_id/attachment_id all NULL."""
    fake_extracted = [
        {
            "employee_name": "Kalpana Puli",
            "period_start": "2026-01-05",
            "period_end": "2026-01-18",
            "total_hours": 81.5,
            "line_items": [
                {"work_date": "2026-01-05", "hours": 41.5, "description": "Week 1"},
                {"work_date": "2026-01-12", "hours": 40.0, "description": "Week 2"},
            ],
            "extraction_confidence": 0.9,
            "uncertain_fields": [],
        }
    ]
    with patch(
        "app.services.ingestion_pipeline.extract_timesheet_data",
        new_callable=AsyncMock,
    ) as mock_extract:
        mock_extract.return_value = fake_extracted
        count = await ingestion_pipeline._process_body_only_timesheet(
            body_text=fixtures["email"].body_text,
            email_record=fixtures["email"],
            tenant_id=fixtures["tenant_id"],
            session=db_session,
            now=datetime(2026, 1, 30, tzinfo=timezone.utc),
        )
    assert count == 1, "exactly one IngestionTimesheet row should be created"

    rows = (await db_session.execute(
        select(IngestionTimesheet).where(IngestionTimesheet.email_id == fixtures["email_id"])
    )).scalars().all()
    assert len(rows) == 1
    ts = rows[0]
    assert ts.attachment_id is None, "body-only row must not point at an attachment"
    assert ts.employee_id is None, "employee resolution is the reviewer's job"
    assert ts.client_id is None, "client resolution is the reviewer's job"
    assert ts.status == IngestionTimesheetStatus.pending
    assert ts.total_hours == Decimal("81.50")
    assert ts.extracted_data.get("source") == "email_body"

    items = (await db_session.execute(
        select(IngestionTimesheetLineItem).where(
            IngestionTimesheetLineItem.ingestion_timesheet_id == ts.id
        )
    )).scalars().all()
    assert len(items) == 2
    hours = sorted(float(i.hours) for i in items)
    assert hours == [40.0, 41.5]


@pytest.mark.asyncio
async def test_body_only_extract_returns_zero_when_llm_yields_nothing(db_session, fixtures):
    """When the LLM returns an empty list (or returns timesheets with no
    parseable line items), the helper creates NO rows and returns 0.
    The caller falls through to the existing skip-on-zero behavior."""
    with patch(
        "app.services.ingestion_pipeline.extract_timesheet_data",
        new_callable=AsyncMock,
    ) as mock_extract:
        mock_extract.return_value = []
        count = await ingestion_pipeline._process_body_only_timesheet(
            body_text=fixtures["email"].body_text,
            email_record=fixtures["email"],
            tenant_id=fixtures["tenant_id"],
            session=db_session,
            now=datetime(2026, 1, 30, tzinfo=timezone.utc),
        )
    assert count == 0
    rows = (await db_session.execute(
        select(IngestionTimesheet).where(IngestionTimesheet.email_id == fixtures["email_id"])
    )).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_body_only_extract_skips_timesheet_with_no_line_items(db_session, fixtures):
    """The LLM sometimes returns a 'header-only' timesheet (employee +
    period but no line_items). We don't create a row for those -- the
    reviewer would just delete it. Same skip-as-no-extraction
    semantics: count=0, no row inserted."""
    with patch(
        "app.services.ingestion_pipeline.extract_timesheet_data",
        new_callable=AsyncMock,
    ) as mock_extract:
        mock_extract.return_value = [
            {
                "employee_name": "Header Only",
                "period_start": "2026-01-05",
                "period_end": "2026-01-11",
                "line_items": [],
            }
        ]
        count = await ingestion_pipeline._process_body_only_timesheet(
            body_text=fixtures["email"].body_text,
            email_record=fixtures["email"],
            tenant_id=fixtures["tenant_id"],
            session=db_session,
            now=datetime(2026, 1, 30, tzinfo=timezone.utc),
        )
    assert count == 0
    rows = (await db_session.execute(
        select(IngestionTimesheet).where(IngestionTimesheet.email_id == fixtures["email_id"])
    )).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_body_only_extract_handles_llm_exception(db_session, fixtures):
    """If extract_timesheet_data raises (network blip, OpenAI 5xx), the
    helper swallows the error, logs, and returns 0. Pipeline falls
    through to the existing skip-on-zero gate; user-facing behavior
    is identical to a body that simply had no extractable content."""
    with patch(
        "app.services.ingestion_pipeline.extract_timesheet_data",
        new_callable=AsyncMock,
    ) as mock_extract:
        mock_extract.side_effect = RuntimeError("simulated OpenAI 502")
        count = await ingestion_pipeline._process_body_only_timesheet(
            body_text=fixtures["email"].body_text,
            email_record=fixtures["email"],
            tenant_id=fixtures["tenant_id"],
            session=db_session,
            now=datetime(2026, 1, 30, tzinfo=timezone.utc),
        )
    assert count == 0
    rows = (await db_session.execute(
        select(IngestionTimesheet).where(IngestionTimesheet.email_id == fixtures["email_id"])
    )).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_body_only_extract_filters_invalid_line_items(db_session, fixtures):
    """Line items with no work_date, zero hours, or non-numeric hours
    are dropped. The row is still created if at least one valid line
    item survives."""
    with patch(
        "app.services.ingestion_pipeline.extract_timesheet_data",
        new_callable=AsyncMock,
    ) as mock_extract:
        mock_extract.return_value = [
            {
                "line_items": [
                    {"work_date": "2026-01-05", "hours": 8.0, "description": "valid"},
                    {"work_date": None, "hours": 8.0, "description": "no date"},
                    {"work_date": "2026-01-07", "hours": 0, "description": "zero hours"},
                    {"work_date": "2026-01-08", "hours": "garbage", "description": "bad hours"},
                ],
            }
        ]
        count = await ingestion_pipeline._process_body_only_timesheet(
            body_text=fixtures["email"].body_text,
            email_record=fixtures["email"],
            tenant_id=fixtures["tenant_id"],
            session=db_session,
            now=datetime(2026, 1, 30, tzinfo=timezone.utc),
        )
    assert count == 1
    items = (await db_session.execute(
        select(IngestionTimesheetLineItem)
    )).scalars().all()
    assert len(items) == 1, "only the valid line item should be inserted"
    assert items[0].description == "valid"
