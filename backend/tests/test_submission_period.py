"""Tests for ``app.services.submission_period`` — cadence-aware
late detection.

The helpers are stateless except for the DB query that loads entries
and time-off rows; the cadence + deadline values come from tenant
settings, which we leave unset here. The defensive ``_get`` fallback
lets the helpers run without a seeded catalog and use the documented
defaults (weekly Friday 17:00 internal, monthly day-28 17:00 external,
1 business-day grace).
"""
from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover
    return "JSON"


from app.models.base import Base
from app.models.client import Client
from app.models.project import Project
from app.models.tenant import Tenant, TenantStatus
from app.models.time_entry import TimeEntry, TimeEntryStatus
from app.models.time_off_request import TimeOffRequest, TimeOffStatus
from app.models.user import User, UserRole
from app.services.submission_period import (
    SubmissionPeriod,
    is_user_late_for_period,
    latest_closed_period,
)


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'period.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


@pytest_asyncio.fixture
async def org(db_session: AsyncSession):
    tenant = Tenant(name="T", slug="t", status=TenantStatus.active)
    db_session.add(tenant)
    await db_session.flush()
    client = Client(name="C", tenant_id=tenant.id)
    db_session.add(client)
    await db_session.flush()
    project = Project(
        tenant_id=tenant.id, client_id=client.id, name="P",
        billable_rate=Decimal("100"), is_active=True,
    )
    db_session.add(project)
    await db_session.flush()
    await db_session.commit()
    return {"tenant": tenant, "project": project}


async def _make_user(session, *, tenant_id: int, is_external: bool, created_days_ago: int, full_name: str = "U") -> User:
    u = User(
        tenant_id=tenant_id,
        email=f"{full_name.lower()}@t.io",
        username=full_name.lower().replace(" ", "-"),
        full_name=full_name,
        hashed_password="x",
        role=UserRole.EMPLOYEE,
        is_active=True,
        email_verified=True,
        has_changed_password=True,
        is_external=is_external,
    )
    session.add(u)
    await session.flush()
    u.created_at = datetime.now(timezone.utc) - timedelta(days=created_days_ago)
    await session.commit()
    return u


# ─────────────────────────────────────────────────────────────────────────────
# latest_closed_period: shape of the returned window
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_weekly_period_is_monday_through_sunday(db_session, org):
    """For an internal user the closed weekly period spans Mon-Sun."""
    user = await _make_user(db_session, tenant_id=org["tenant"].id, is_external=False, created_days_ago=30)
    today = date.today()
    if today.weekday() not in (0, 1, 2, 3):
        pytest.skip("Deterministic only Mon-Thu; weekday-specific edge cases covered elsewhere.")
    period = await latest_closed_period(db_session, org["tenant"].id, user, today)
    assert period is not None
    assert period.cadence == "weekly"
    assert period.start.weekday() == 0
    assert period.end == period.start + timedelta(days=6)


@pytest.mark.asyncio
async def test_monthly_period_for_external_user(db_session, org):
    """External users default to monthly cadence; the closed period
    is a calendar month and ends on its last day."""
    user = await _make_user(db_session, tenant_id=org["tenant"].id, is_external=True, created_days_ago=90)
    today = date.today()
    # Skip when today is right around the month-end deadline window —
    # the resolved month depends on whether the default day-28 17:00
    # has passed in the current month.
    period = await latest_closed_period(db_session, org["tenant"].id, user, today)
    if period is None:
        pytest.skip("Before grace cutoff; monthly period not yet considered closed.")
    assert period.cadence == "monthly"
    assert period.start.day == 1
    last_day = calendar.monthrange(period.start.year, period.start.month)[1]
    assert period.end.day == last_day


# ─────────────────────────────────────────────────────────────────────────────
# is_user_late_for_period: covered vs. uncovered working days
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_user_late_when_period_completely_empty(db_session, org):
    user = await _make_user(db_session, tenant_id=org["tenant"].id, is_external=False, created_days_ago=30)
    # Synthetic fully-past weekly period (Mon-Sun two weeks ago).
    today = date.today()
    period_start = today - timedelta(days=today.weekday() + 14)
    period = SubmissionPeriod(
        start=period_start,
        end=period_start + timedelta(days=6),
        deadline_at=datetime.now(timezone.utc) - timedelta(days=7),
        cadence="weekly",
    )
    assert await is_user_late_for_period(db_session, user, period) is True


@pytest.mark.asyncio
async def test_user_not_late_when_every_working_day_submitted(db_session, org):
    user = await _make_user(db_session, tenant_id=org["tenant"].id, is_external=False, created_days_ago=30)
    today = date.today()
    period_start = today - timedelta(days=today.weekday() + 14)
    period = SubmissionPeriod(
        start=period_start,
        end=period_start + timedelta(days=6),
        deadline_at=datetime.now(timezone.utc) - timedelta(days=7),
        cadence="weekly",
    )
    cursor = period.start
    while cursor <= period.end:
        if cursor.weekday() < 5:
            db_session.add(TimeEntry(
                tenant_id=org["tenant"].id, user_id=user.id, project_id=org["project"].id,
                entry_date=cursor, hours=Decimal("8"),
                status=TimeEntryStatus.SUBMITTED, description="x",
            ))
        cursor += timedelta(days=1)
    await db_session.commit()
    assert await is_user_late_for_period(db_session, user, period) is False


@pytest.mark.asyncio
async def test_user_not_late_when_pto_covers_every_working_day(db_session, org):
    user = await _make_user(db_session, tenant_id=org["tenant"].id, is_external=False, created_days_ago=30)
    today = date.today()
    period_start = today - timedelta(days=today.weekday() + 14)
    period = SubmissionPeriod(
        start=period_start,
        end=period_start + timedelta(days=6),
        deadline_at=datetime.now(timezone.utc) - timedelta(days=7),
        cadence="weekly",
    )
    cursor = period.start
    while cursor <= period.end:
        if cursor.weekday() < 5:
            db_session.add(TimeOffRequest(
                tenant_id=org["tenant"].id, user_id=user.id,
                request_date=cursor, hours=Decimal("8"),
                leave_type="vacation", reason="vac",
                status=TimeOffStatus.APPROVED,
            ))
        cursor += timedelta(days=1)
    await db_session.commit()
    assert await is_user_late_for_period(db_session, user, period) is False


@pytest.mark.asyncio
async def test_user_late_when_only_some_days_submitted(db_session, org):
    """One Monday submission doesn't cover the rest of the week."""
    user = await _make_user(db_session, tenant_id=org["tenant"].id, is_external=False, created_days_ago=30)
    today = date.today()
    period_start = today - timedelta(days=today.weekday() + 14)
    period = SubmissionPeriod(
        start=period_start,
        end=period_start + timedelta(days=6),
        deadline_at=datetime.now(timezone.utc) - timedelta(days=7),
        cadence="weekly",
    )
    db_session.add(TimeEntry(
        tenant_id=org["tenant"].id, user_id=user.id, project_id=org["project"].id,
        entry_date=period.start, hours=Decimal("8"),
        status=TimeEntryStatus.SUBMITTED, description="x",
    ))
    await db_session.commit()
    assert await is_user_late_for_period(db_session, user, period) is True


@pytest.mark.asyncio
async def test_user_late_ignored_for_draft_entries(db_session, org):
    """DRAFT entries are not "covered" — they haven't been submitted
    so they don't excuse a missing-period day."""
    user = await _make_user(db_session, tenant_id=org["tenant"].id, is_external=False, created_days_ago=30)
    today = date.today()
    period_start = today - timedelta(days=today.weekday() + 14)
    period = SubmissionPeriod(
        start=period_start,
        end=period_start + timedelta(days=6),
        deadline_at=datetime.now(timezone.utc) - timedelta(days=7),
        cadence="weekly",
    )
    cursor = period.start
    while cursor <= period.end:
        if cursor.weekday() < 5:
            db_session.add(TimeEntry(
                tenant_id=org["tenant"].id, user_id=user.id, project_id=org["project"].id,
                entry_date=cursor, hours=Decimal("8"),
                status=TimeEntryStatus.DRAFT, description="x",
            ))
        cursor += timedelta(days=1)
    await db_session.commit()
    assert await is_user_late_for_period(db_session, user, period) is True


# ─────────────────────────────────────────────────────────────────────────────
# Brand-new user exemption (the Yaswanth case)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_brand_new_user_exempt_from_late_flag(db_session, org):
    """A user created on or after the period start is not late for
    that period, even if backdated entries exist that would otherwise
    fail the gate."""
    user = await _make_user(db_session, tenant_id=org["tenant"].id, is_external=False, created_days_ago=0)
    today = date.today()
    period_start = today - timedelta(days=today.weekday() + 14)
    period = SubmissionPeriod(
        start=period_start,
        end=period_start + timedelta(days=6),
        deadline_at=datetime.now(timezone.utc) - timedelta(days=7),
        cadence="weekly",
    )
    # No coverage at all — but the user didn't exist for the period.
    assert await is_user_late_for_period(db_session, user, period) is False


@pytest.mark.asyncio
async def test_user_created_exactly_at_period_start_is_exempt(db_session, org):
    """Boundary: created_at == period.start → exempt."""
    user = await _make_user(db_session, tenant_id=org["tenant"].id, is_external=False, created_days_ago=14)
    today = date.today()
    # Construct a period whose start matches the user's created_date
    # (within a few hours, depending on test wall-clock; close enough).
    period = SubmissionPeriod(
        start=user.created_at.astimezone(timezone.utc).date(),
        end=user.created_at.astimezone(timezone.utc).date() + timedelta(days=6),
        deadline_at=datetime.now(timezone.utc) - timedelta(days=1),
        cadence="weekly",
    )
    assert await is_user_late_for_period(db_session, user, period) is False
