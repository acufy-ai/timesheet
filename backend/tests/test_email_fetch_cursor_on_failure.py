"""
Regression test: a failed IMAP fetch must NOT advance the mailbox
cursor.

Before the fix, ``_prefetch_mailbox_messages`` caught fetch_messages()
exceptions (incl. asyncio.TimeoutError after the 120s IMAP cap) and
appended ``(mailbox, [])`` — an empty list — to the work queue.
Downstream, ``_process_mailbox`` couldn't distinguish "fetch succeeded
with 0 new messages" from "fetch failed, here's an empty stub", and in
both cases it called ``update_last_fetched_at`` to advance the cursor
to now().

In practice this silently undid every refetch-rewind: rewind cursor
→ click Fetch → IMAP times out → cursor advances to now → the emails
we wanted to re-pull are now permanently older than the cursor and
never come back.

The fix passes ``None`` (not []) for failed mailboxes, and
``_process_mailbox`` early-returns on None without touching the
cursor.
"""
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB

# JSONB → JSON shim for SQLite (test-only).
@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover - test shim
    return "JSON"


from app.models.base import Base
from app.models.mailbox import Mailbox, MailboxAuthType, MailboxProtocol
from app.models.tenant import Tenant, TenantStatus
from app.workers.email_fetch import _process_mailbox


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    db_file = tmp_path / "fetch_cursor.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_file}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    await engine.dispose()


@pytest_asyncio.fixture
async def mailbox_with_cursor(db_session: AsyncSession) -> Mailbox:
    tenant = Tenant(
        name="T", slug="t", status=TenantStatus.active, ingestion_enabled=True,
    )
    db_session.add(tenant)
    await db_session.flush()

    # An old, deliberate cursor — if the bug were still here, a failed
    # fetch would advance this to ~now() and we'd see the change.
    pinned = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
    mailbox = Mailbox(
        tenant_id=tenant.id, label="X", protocol=MailboxProtocol.imap,
        auth_type=MailboxAuthType.basic, is_active=True,
        last_fetched_at=pinned,
    )
    db_session.add(mailbox)
    await db_session.commit()
    return mailbox


@pytest.mark.asyncio
async def test_failed_fetch_does_not_advance_cursor(
    db_session: AsyncSession, mailbox_with_cursor: Mailbox
):
    """messages=None (the new "fetch failed" signal) must leave the
    cursor untouched."""
    mailbox = mailbox_with_cursor
    pinned = mailbox.last_fetched_at

    result = await _process_mailbox(
        mailbox=mailbox,
        messages=None,
        tenant_id=mailbox.tenant_id,
        session=db_session,
    )

    assert result["success"] is False
    assert result["error"] == "imap_fetch_failed"
    await db_session.refresh(mailbox)
    assert mailbox.last_fetched_at.replace(tzinfo=None) == pinned.replace(tzinfo=None)


@pytest.mark.asyncio
async def test_empty_successful_fetch_does_advance_cursor(
    db_session: AsyncSession, mailbox_with_cursor: Mailbox
):
    """messages=[] is the "fetch succeeded, zero new messages" case and
    SHOULD advance the cursor to now()."""
    mailbox = mailbox_with_cursor
    before = datetime.now(timezone.utc)

    result = await _process_mailbox(
        mailbox=mailbox,
        messages=[],
        tenant_id=mailbox.tenant_id,
        session=db_session,
    )

    assert result["success"] is True
    await db_session.refresh(mailbox)
    # Cursor should be at or after the moment we called _process_mailbox.
    assert mailbox.last_fetched_at.replace(tzinfo=None) >= before.replace(tzinfo=None)
