"""M9 regression test: the reminder worker must not re-notify a
recipient who already got the same window's reminder.

Without the dedup, a transient SMTP failure mid-loop on tick N caused
the next tick (15 minutes later) to re-notify every employee who DID
get the previous email — duplicates several times across the window.

We exercise the helper contract directly with an in-memory SQLite
session (matches the pattern other reminder tests use). The full
worker flow has too many side effects to integration-test here; the
helpers are what changed.
"""
from datetime import date, datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB

# SQLite JSONB shim used by other tests too.
@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover - shim
    return "JSON"


from app.models.base import Base
from app.models.sent_reminder import SentReminder  # noqa: F401 — registers table
from app.models.tenant import Tenant  # noqa: F401
from app.models.user import User  # noqa: F401
from app.workers.reminder_worker import _already_sent, _record_sent


@pytest_asyncio.fixture
async def db_session(tmp_path):
    db_file = tmp_path / "reminder_dedup.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_file}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    await engine.dispose()


@pytest.mark.asyncio
async def test_already_sent_returns_false_when_no_row(db_session):
    assert await _already_sent(
        db_session,
        tenant_id=1,
        user_id=2,
        period_start=date(2026, 5, 25),
        reminder_kind="internal_early",
    ) is False


@pytest.mark.asyncio
async def test_record_then_already_sent_returns_true(db_session):
    await _record_sent(
        db_session,
        tenant_id=1,
        user_id=2,
        period_start=date(2026, 5, 25),
        reminder_kind="internal_early",
    )
    assert await _already_sent(
        db_session,
        tenant_id=1,
        user_id=2,
        period_start=date(2026, 5, 25),
        reminder_kind="internal_early",
    ) is True


@pytest.mark.asyncio
async def test_different_kind_same_period_is_not_deduped(db_session):
    """An employee getting the *early* reminder must still be allowed to
    receive the *final* reminder later in the same week."""
    await _record_sent(
        db_session,
        tenant_id=1,
        user_id=2,
        period_start=date(2026, 5, 25),
        reminder_kind="internal_early",
    )
    assert await _already_sent(
        db_session,
        tenant_id=1,
        user_id=2,
        period_start=date(2026, 5, 25),
        reminder_kind="internal_final",
    ) is False


@pytest.mark.asyncio
async def test_different_period_same_kind_is_not_deduped(db_session):
    """Next week's reminder must fire even if last week's was sent."""
    await _record_sent(
        db_session,
        tenant_id=1,
        user_id=2,
        period_start=date(2026, 5, 18),
        reminder_kind="internal_early",
    )
    assert await _already_sent(
        db_session,
        tenant_id=1,
        user_id=2,
        period_start=date(2026, 5, 25),
        reminder_kind="internal_early",
    ) is False


@pytest.mark.asyncio
async def test_different_user_is_not_deduped(db_session):
    """Two employees in the same tenant get their own dedup state."""
    await _record_sent(
        db_session,
        tenant_id=1,
        user_id=2,
        period_start=date(2026, 5, 25),
        reminder_kind="internal_early",
    )
    assert await _already_sent(
        db_session,
        tenant_id=1,
        user_id=3,
        period_start=date(2026, 5, 25),
        reminder_kind="internal_early",
    ) is False


@pytest.mark.asyncio
async def test_different_tenant_is_not_deduped(db_session):
    """Same user_id across tenants (multi-tenant collision possible in
    legacy data) must still get reminders for each tenant separately."""
    await _record_sent(
        db_session,
        tenant_id=1,
        user_id=2,
        period_start=date(2026, 5, 25),
        reminder_kind="internal_early",
    )
    assert await _already_sent(
        db_session,
        tenant_id=99,
        user_id=2,
        period_start=date(2026, 5, 25),
        reminder_kind="internal_early",
    ) is False
