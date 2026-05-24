"""Unit tests for the approve-time per-day expansion helpers.

The approval handler in ``app.api.ingestion`` orchestrates the wider
flow (overlap detection, audit logging, status flip); the helpers
tested here are the deterministic core that decides:

1. Which working days fall inside the period.
2. How a total-only timesheet's hours map to per-day rows.
3. How to pick / create a project for a client that has none yet.

A separate integration test would be needed to exercise the HTTP
endpoint, but the per-day math is the part that matters for the
month-boundary scoping the user actually reported.
"""
from __future__ import annotations

from datetime import date
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
from app.services.ingestion_entry_expansion import (
    SynthesizedDay,
    distribute_hours_evenly,
    resolve_default_project_for_client,
    working_days_between,
)


# ─── working_days_between ─────────────────────────────────────────────


def test_working_days_excludes_weekends():
    # Mon 2026-03-30 .. Sun 2026-04-05 = Mon, Tue, Wed, Thu, Fri (5).
    days = working_days_between(date(2026, 3, 30), date(2026, 4, 5))
    assert days == [
        date(2026, 3, 30),
        date(2026, 3, 31),
        date(2026, 4, 1),
        date(2026, 4, 2),
        date(2026, 4, 3),
    ]
    assert all(d.weekday() < 5 for d in days)


def test_working_days_empty_when_range_is_only_weekend():
    days = working_days_between(date(2026, 3, 28), date(2026, 3, 29))
    assert days == []


def test_working_days_handles_inverted_range():
    days = working_days_between(date(2026, 4, 5), date(2026, 3, 30))
    assert days == []


def test_working_days_full_month_march_2026():
    # March 2026: 31 days, 22 weekdays.
    days = working_days_between(date(2026, 3, 1), date(2026, 3, 31))
    assert len(days) == 22


# ─── distribute_hours_evenly ──────────────────────────────────────────


def test_distribute_evenly_exact_division():
    # 40h over 5 days = 8h each, no rounding drift.
    days = distribute_hours_evenly(40, date(2026, 3, 30), date(2026, 4, 3))
    assert [d.hours for d in days] == [Decimal("8.00")] * 5
    assert sum(d.hours for d in days) == Decimal("40.00")


def test_distribute_evenly_absorbs_rounding_drift_on_last_day():
    # 40h over 3 days -> 13.33 + 13.33 + 13.34 = 40.00 exactly.
    days = distribute_hours_evenly(40, date(2026, 3, 30), date(2026, 4, 1))
    assert [d.hours for d in days] == [Decimal("13.33"), Decimal("13.33"), Decimal("13.34")]
    assert sum(d.hours for d in days) == Decimal("40.00")


def test_distribute_evenly_returns_empty_for_weekend_only_range():
    days = distribute_hours_evenly(16, date(2026, 3, 28), date(2026, 3, 29))
    assert days == []


def test_distribute_evenly_full_march_2026():
    # 176h over 22 working days = 8h each.
    days = distribute_hours_evenly(176, date(2026, 3, 1), date(2026, 3, 31))
    assert len(days) == 22
    assert all(d.hours == Decimal("8.00") for d in days)
    assert sum(d.hours for d in days) == Decimal("176.00")


def test_distribute_evenly_crosses_month_boundary():
    """The motivating bug from the user. A 40h week starting Mon Mar 30
    and ending Fri Apr 3 must produce 16h in March (Mon, Tue) and 24h
    in April (Wed, Thu, Fri) once filtered by entry_date."""
    days = distribute_hours_evenly(40, date(2026, 3, 30), date(2026, 4, 3))
    march = [d for d in days if d.work_date.month == 3]
    april = [d for d in days if d.work_date.month == 4]
    assert sum(d.hours for d in march) == Decimal("16.00")
    assert sum(d.hours for d in april) == Decimal("24.00")
    assert sum(d.hours for d in days) == Decimal("40.00")


def test_distribute_evenly_quarterly_invoice():
    """Periods longer than a month are not special — working-day count
    is from the actual range, and month filters slice on entry_date."""
    # Apr 1 .. Jun 30 inclusive; sanity-check totals and that hours
    # land in the expected months.
    days = distribute_hours_evenly(440, date(2026, 4, 1), date(2026, 6, 30))
    assert len(days) > 60
    assert sum(d.hours for d in days) == Decimal("440.00")
    april = [d for d in days if d.work_date.month == 4]
    assert len(april) > 0  # not just May/June


# ─── resolve_default_project_for_client ───────────────────────────────


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'expansion.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


@pytest_asyncio.fixture
async def tenant_with_client(db_session: AsyncSession):
    tenant = Tenant(name="T", slug="t", status=TenantStatus.active)
    db_session.add(tenant)
    await db_session.flush()
    client = Client(name="Kaleidoscope", tenant_id=tenant.id)
    db_session.add(client)
    await db_session.commit()
    return {"tenant": tenant, "client": client}


@pytest.mark.asyncio
async def test_resolver_returns_existing_active_project(db_session, tenant_with_client):
    tenant = tenant_with_client["tenant"]
    client = tenant_with_client["client"]
    existing = Project(
        tenant_id=tenant.id, client_id=client.id, name="Real Work",
        billable_rate=Decimal("100"), is_active=True,
    )
    db_session.add(existing)
    await db_session.commit()

    project = await resolve_default_project_for_client(
        db_session, tenant.id, client.id
    )
    assert project.id == existing.id
    assert project.name == "Real Work"


@pytest.mark.asyncio
async def test_resolver_creates_default_when_none_exists(db_session, tenant_with_client):
    tenant = tenant_with_client["tenant"]
    client = tenant_with_client["client"]

    project = await resolve_default_project_for_client(
        db_session, tenant.id, client.id
    )
    await db_session.commit()

    assert project.client_id == client.id
    assert project.tenant_id == tenant.id
    assert project.is_active is True
    assert "Kaleidoscope" in project.name  # auto-named after the client


@pytest.mark.asyncio
async def test_resolver_returns_same_default_on_repeat_calls(db_session, tenant_with_client):
    """Idempotency: a second approval against the same client must
    reuse the previously-created default, not spawn duplicates."""
    tenant = tenant_with_client["tenant"]
    client = tenant_with_client["client"]

    first = await resolve_default_project_for_client(
        db_session, tenant.id, client.id
    )
    await db_session.commit()
    second = await resolve_default_project_for_client(
        db_session, tenant.id, client.id
    )
    await db_session.commit()

    assert first.id == second.id


@pytest.mark.asyncio
async def test_resolver_picks_oldest_when_multiple_active_projects(db_session, tenant_with_client):
    """Deterministic: when several active projects exist, pick the
    oldest (smallest id). Reviewers who want a specific project must
    set ``line_item.project_id`` upstream."""
    tenant = tenant_with_client["tenant"]
    client = tenant_with_client["client"]
    p1 = Project(tenant_id=tenant.id, client_id=client.id, name="A",
                 billable_rate=Decimal("100"), is_active=True)
    p2 = Project(tenant_id=tenant.id, client_id=client.id, name="B",
                 billable_rate=Decimal("100"), is_active=True)
    db_session.add_all([p1, p2])
    await db_session.commit()

    project = await resolve_default_project_for_client(
        db_session, tenant.id, client.id
    )
    assert project.id == min(p1.id, p2.id)


@pytest.mark.asyncio
async def test_resolver_rejects_cross_tenant_client_lookup(db_session, tenant_with_client):
    """Defense in depth: passing a client_id that belongs to a
    different tenant raises rather than leaking access."""
    other_tenant = Tenant(name="X", slug="x", status=TenantStatus.active)
    db_session.add(other_tenant)
    await db_session.commit()

    with pytest.raises(ValueError):
        await resolve_default_project_for_client(
            db_session,
            tenant_id=other_tenant.id,
            client_id=tenant_with_client["client"].id,
        )
