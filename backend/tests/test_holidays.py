"""Tests for the holidays API + late-detection integration.

Covers:
- list returns tenant-scoped rows, sorted by date
- admin can create / patch / delete; non-admin cannot
- duplicate dates within a tenant return 409
- bulk-create silently skips dates that already exist
- holidays excuse a missed working day in the cadence-aware late signal
- suggestions endpoint returns python-holidays output for a country/year
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover
    return "JSON"


from app.api import holidays as holidays_api
from app.core.security import create_access_token, get_password_hash
from app.db import get_db
from app.core.deps import get_tenant_db
from app.models.base import Base
from app.models.holiday import Holiday, HolidayType
from app.models.tenant import Tenant, TenantStatus
from app.models.user import User, UserRole
from app.services.submission_period import SubmissionPeriod, is_user_late_for_period


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'holidays.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


def _make_app(db_session: AsyncSession) -> TestClient:
    app = FastAPI()
    app.include_router(holidays_api.router)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_tenant_db] = override_get_db
    return TestClient(app)


def _auth(user: User) -> dict:
    token = create_access_token({"sub": str(user.id), "tenant_id": user.tenant_id})
    return {"Authorization": f"Bearer {token}"}


async def _user(session, *, email, role, tenant_id, full_name=None) -> User:
    u = User(
        tenant_id=tenant_id,
        email=email,
        username=email.split("@")[0].replace(".", "-"),
        full_name=full_name or email,
        hashed_password=get_password_hash("password"),
        role=role,
        is_active=True,
        email_verified=True,
        has_changed_password=True,
    )
    session.add(u)
    await session.flush()
    return u


@pytest_asyncio.fixture
async def org(db_session: AsyncSession):
    t1 = Tenant(name="T1", slug="t1", status=TenantStatus.active)
    t2 = Tenant(name="T2", slug="t2", status=TenantStatus.active)
    db_session.add_all([t1, t2])
    await db_session.flush()
    admin = await _user(db_session, email="admin@t1.io", role=UserRole.ADMIN, tenant_id=t1.id)
    employee = await _user(db_session, email="emp@t1.io", role=UserRole.EMPLOYEE, tenant_id=t1.id)
    other_admin = await _user(db_session, email="admin@t2.io", role=UserRole.ADMIN, tenant_id=t2.id)
    await db_session.commit()
    return {"t1": t1, "t2": t2, "admin": admin, "employee": employee, "other_admin": other_admin}


# ─────────────────────────────────────────────────────────────────────────────
# List + tenant scoping
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_returns_tenant_scoped_rows_sorted_by_date(db_session, org):
    db_session.add(Holiday(tenant_id=org["t1"].id, date=date(2026, 7, 4),
                           name="Independence Day", holiday_type=HolidayType.PUBLIC))
    db_session.add(Holiday(tenant_id=org["t1"].id, date=date(2026, 5, 25),
                           name="Memorial Day", holiday_type=HolidayType.PUBLIC))
    # Other tenant row that must not appear.
    db_session.add(Holiday(tenant_id=org["t2"].id, date=date(2026, 1, 1),
                           name="New Year", holiday_type=HolidayType.PUBLIC))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/holidays", headers=_auth(org["employee"]))
    assert resp.status_code == 200
    body = resp.json()
    assert [h["name"] for h in body] == ["Memorial Day", "Independence Day"]


@pytest.mark.asyncio
async def test_list_country_filter_includes_org_wide_rows(db_session, org):
    """When ?country=US is passed, return rows where country='US' or
    country IS NULL (org-wide). The latter rule means manual
    additions show up regardless of the user's country preference."""
    db_session.add(Holiday(tenant_id=org["t1"].id, date=date(2026, 7, 4),
                           name="Independence Day", holiday_type=HolidayType.PUBLIC, country="US"))
    db_session.add(Holiday(tenant_id=org["t1"].id, date=date(2026, 8, 15),
                           name="Independence Day", holiday_type=HolidayType.PUBLIC, country="IN"))
    db_session.add(Holiday(tenant_id=org["t1"].id, date=date(2026, 6, 1),
                           name="Founders Day", holiday_type=HolidayType.COMPANY))  # country NULL
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/holidays?country=US", headers=_auth(org["employee"]))
    assert resp.status_code == 200
    names = sorted(h["name"] for h in resp.json())
    assert names == ["Founders Day", "Independence Day"]


@pytest.mark.asyncio
async def test_list_country_filter_excludes_other_countries(db_session, org):
    db_session.add(Holiday(tenant_id=org["t1"].id, date=date(2026, 7, 4),
                           name="US Day", holiday_type=HolidayType.PUBLIC, country="US"))
    db_session.add(Holiday(tenant_id=org["t1"].id, date=date(2026, 8, 15),
                           name="IN Day", holiday_type=HolidayType.PUBLIC, country="IN"))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/holidays?country=IN", headers=_auth(org["employee"]))
    assert resp.status_code == 200
    names = [h["name"] for h in resp.json()]
    assert names == ["IN Day"]


@pytest.mark.asyncio
async def test_list_country_filter_is_uppercased(db_session, org):
    db_session.add(Holiday(tenant_id=org["t1"].id, date=date(2026, 7, 4),
                           name="US Day", holiday_type=HolidayType.PUBLIC, country="US"))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/holidays?country=us", headers=_auth(org["employee"]))
    assert resp.status_code == 200
    assert [h["name"] for h in resp.json()] == ["US Day"]


@pytest.mark.asyncio
async def test_countries_endpoint_returns_distinct_sorted_country_codes(db_session, org):
    db_session.add_all([
        Holiday(tenant_id=org["t1"].id, date=date(2026, 7, 4), name="A",
                holiday_type=HolidayType.PUBLIC, country="US"),
        Holiday(tenant_id=org["t1"].id, date=date(2027, 7, 4), name="A2",
                holiday_type=HolidayType.PUBLIC, country="US"),
        Holiday(tenant_id=org["t1"].id, date=date(2026, 8, 15), name="B",
                holiday_type=HolidayType.PUBLIC, country="IN"),
        Holiday(tenant_id=org["t1"].id, date=date(2026, 6, 1), name="C",
                holiday_type=HolidayType.COMPANY, country=None),
        # Other tenant — must not appear.
        Holiday(tenant_id=org["t2"].id, date=date(2026, 1, 1), name="D",
                holiday_type=HolidayType.PUBLIC, country="GB"),
    ])
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/holidays/countries", headers=_auth(org["employee"]))
    assert resp.status_code == 200
    assert resp.json() == ["IN", "US"]


@pytest.mark.asyncio
async def test_list_respects_date_range(db_session, org):
    db_session.add(Holiday(tenant_id=org["t1"].id, date=date(2026, 1, 1), name="A", holiday_type=HolidayType.PUBLIC))
    db_session.add(Holiday(tenant_id=org["t1"].id, date=date(2026, 6, 1), name="B", holiday_type=HolidayType.COMPANY))
    db_session.add(Holiday(tenant_id=org["t1"].id, date=date(2026, 12, 25), name="C", holiday_type=HolidayType.PUBLIC))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get(
            "/holidays?start_date=2026-05-01&end_date=2026-07-01",
            headers=_auth(org["employee"]),
        )
    assert resp.status_code == 200
    assert [h["name"] for h in resp.json()] == ["B"]


# ─────────────────────────────────────────────────────────────────────────────
# Authorization
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_employee_cannot_create_holiday(db_session, org):
    with _make_app(db_session) as client:
        resp = client.post(
            "/holidays",
            json={"date": "2026-12-25", "name": "Christmas", "holiday_type": "PUBLIC"},
            headers=_auth(org["employee"]),
        )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_admin_can_create_and_delete_holiday(db_session, org):
    with _make_app(db_session) as client:
        resp = client.post(
            "/holidays",
            json={"date": "2026-12-25", "name": "Christmas", "holiday_type": "PUBLIC"},
            headers=_auth(org["admin"]),
        )
        assert resp.status_code == 201
        hid = resp.json()["id"]

        resp = client.delete(f"/holidays/{hid}", headers=_auth(org["admin"]))
        assert resp.status_code == 204

        resp = client.get("/holidays", headers=_auth(org["admin"]))
        assert resp.json() == []


@pytest.mark.asyncio
async def test_duplicate_date_in_same_tenant_returns_409(db_session, org):
    with _make_app(db_session) as client:
        a = client.post(
            "/holidays",
            json={"date": "2026-07-04", "name": "Independence Day", "holiday_type": "PUBLIC"},
            headers=_auth(org["admin"]),
        )
        assert a.status_code == 201
        b = client.post(
            "/holidays",
            json={"date": "2026-07-04", "name": "Different Name", "holiday_type": "COMPANY"},
            headers=_auth(org["admin"]),
        )
        assert b.status_code == 409


@pytest.mark.asyncio
async def test_admin_cannot_delete_other_tenants_holiday(db_session, org):
    foreign = Holiday(tenant_id=org["t2"].id, date=date(2026, 1, 1),
                      name="Foreign", holiday_type=HolidayType.PUBLIC)
    db_session.add(foreign)
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.delete(f"/holidays/{foreign.id}", headers=_auth(org["admin"]))
    assert resp.status_code == 404


# ─────────────────────────────────────────────────────────────────────────────
# Bulk import
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bulk_create_skips_existing_dates(db_session, org):
    db_session.add(Holiday(tenant_id=org["t1"].id, date=date(2026, 7, 4),
                           name="Existing Indep Day", holiday_type=HolidayType.PUBLIC))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.post(
            "/holidays/bulk",
            json={
                "holidays": [
                    {"date": "2026-07-04", "name": "Independence Day", "holiday_type": "PUBLIC"},
                    {"date": "2026-12-25", "name": "Christmas Day", "holiday_type": "PUBLIC"},
                ]
            },
            headers=_auth(org["admin"]),
        )
    assert resp.status_code == 201
    body = resp.json()
    # Only the new (12-25) row should be returned; the duplicate is skipped.
    assert len(body) == 1
    assert body[0]["date"] == "2026-12-25"


# ─────────────────────────────────────────────────────────────────────────────
# Late-detection integration
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_holiday_excuses_missed_working_day_in_late_check(db_session, org):
    """A pre-existing employee with no entries for the period should
    be marked late by default — but adding a holiday on every working
    day of that period covers them and clears the flag."""
    user = await _user(db_session, email="late@t1.io", role=UserRole.EMPLOYEE, tenant_id=org["t1"].id)
    user.created_at = datetime.now(timezone.utc) - timedelta(days=60)
    await db_session.commit()

    period_start = date.today() - timedelta(days=date.today().weekday() + 14)
    period = SubmissionPeriod(
        start=period_start,
        end=period_start + timedelta(days=6),
        deadline_at=datetime.now(timezone.utc) - timedelta(days=7),
        cadence="weekly",
    )

    # Without holidays: late.
    assert await is_user_late_for_period(db_session, user, period) is True

    # Stamp a holiday on every working day of the period.
    cursor = period.start
    while cursor <= period.end:
        if cursor.weekday() < 5:
            db_session.add(Holiday(
                tenant_id=org["t1"].id, date=cursor,
                name=f"Holiday {cursor.isoformat()}", holiday_type=HolidayType.COMPANY,
            ))
        cursor += timedelta(days=1)
    await db_session.commit()

    # With holidays covering every working day: not late.
    assert await is_user_late_for_period(db_session, user, period) is False


@pytest.mark.asyncio
async def test_holiday_partial_coverage_still_leaves_user_late(db_session, org):
    user = await _user(db_session, email="part@t1.io", role=UserRole.EMPLOYEE, tenant_id=org["t1"].id)
    user.created_at = datetime.now(timezone.utc) - timedelta(days=60)
    await db_session.commit()

    period_start = date.today() - timedelta(days=date.today().weekday() + 14)
    period = SubmissionPeriod(
        start=period_start,
        end=period_start + timedelta(days=6),
        deadline_at=datetime.now(timezone.utc) - timedelta(days=7),
        cadence="weekly",
    )

    # One holiday Monday, nothing else: Tue-Fri still uncovered.
    db_session.add(Holiday(
        tenant_id=org["t1"].id, date=period.start,
        name="One day", holiday_type=HolidayType.COMPANY,
    ))
    await db_session.commit()
    assert await is_user_late_for_period(db_session, user, period) is True


@pytest.mark.asyncio
async def test_other_tenants_holiday_does_not_excuse(db_session, org):
    """The user is in t1, but a holiday was set in t2 only. Must not
    excuse the t1 user."""
    user = await _user(db_session, email="iso@t1.io", role=UserRole.EMPLOYEE, tenant_id=org["t1"].id)
    user.created_at = datetime.now(timezone.utc) - timedelta(days=60)
    period_start = date.today() - timedelta(days=date.today().weekday() + 14)
    period = SubmissionPeriod(
        start=period_start,
        end=period_start + timedelta(days=6),
        deadline_at=datetime.now(timezone.utc) - timedelta(days=7),
        cadence="weekly",
    )
    cursor = period.start
    while cursor <= period.end:
        if cursor.weekday() < 5:
            db_session.add(Holiday(
                tenant_id=org["t2"].id, date=cursor,
                name="Foreign tenant holiday", holiday_type=HolidayType.COMPANY,
            ))
        cursor += timedelta(days=1)
    await db_session.commit()

    assert await is_user_late_for_period(db_session, user, period) is True


# ─────────────────────────────────────────────────────────────────────────────
# Suggestions endpoint
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_suggestions_returns_public_holidays_for_country_year(db_session, org):
    with _make_app(db_session) as client:
        resp = client.get(
            "/holidays/suggestions?country=US&year=2026",
            headers=_auth(org["admin"]),
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["country"] == "US"
    assert body["year"] == 2026
    # A few specific US 2026 dates that the library reliably returns.
    by_date = {h["date"]: h["name"] for h in body["holidays"]}
    assert "2026-07-04" in by_date or "2026-07-03" in by_date  # observed
    assert "2026-12-25" in by_date


@pytest.mark.asyncio
async def test_suggestions_unsupported_country_returns_400(db_session, org):
    with _make_app(db_session) as client:
        resp = client.get(
            "/holidays/suggestions?country=ZZ&year=2026",
            headers=_auth(org["admin"]),
        )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_employee_cannot_call_suggestions(db_session, org):
    with _make_app(db_session) as client:
        resp = client.get(
            "/holidays/suggestions?country=US&year=2026",
            headers=_auth(org["employee"]),
        )
    assert resp.status_code == 403
