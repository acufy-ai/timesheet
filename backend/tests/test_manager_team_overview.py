"""Tests for ``GET /dashboard/manager-team-overview``.

Covers:
- 403 for EMPLOYEE / PLATFORM_ADMIN.
- 200 with empty team for a manager with no reports.
- Submitted-day counting against week-to-date entries.
- PTO classification: today, this week, next week, upcoming start.
- Repeatedly-late flag triggers when 2 of the last 3 working days were missed.
- Pending approvals + pending time-off + recent rejections aggregate correctly.
"""
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


from app.api import dashboard as dashboard_api
from app.core.security import create_access_token, get_password_hash
from app.db import get_db
from app.core.deps import get_tenant_db
from app.models.assignments import EmployeeManagerAssignment
from app.models.base import Base
from app.models.client import Client
from app.models.project import Project
from app.models.tenant import Tenant, TenantStatus
from app.models.time_entry import TimeEntry, TimeEntryStatus
from app.models.time_off_request import TimeOffRequest, TimeOffStatus
from app.models.user import User, UserRole


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    db_file = tmp_path / "manager_overview.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_file}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


def _make_app(db_session: AsyncSession) -> TestClient:
    app = FastAPI()
    app.include_router(dashboard_api.router)

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


def _monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


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
    manager = await _user(db_session, email="mgr@t.io", role=UserRole.MANAGER, tenant_id=tenant.id, full_name="Mgr One")
    await db_session.flush()
    # The manager runs this project (manager-project-health is scoped to projects
    # the manager owns via manager_id or a project_managers row).
    project.manager_id = manager.id
    db_session.add(project)
    await db_session.commit()
    return {"tenant": tenant, "project": project, "manager": manager}


async def _assign(session, *, manager: User, employee: User):
    session.add(EmployeeManagerAssignment(
        manager_id=manager.id,
        employee_id=employee.id,
    ))


# ─────────────────────────────────────────────────────────────────────────────
# Authorization
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_employee_gets_403(db_session, org):
    emp = await _user(db_session, email="emp@t.io", role=UserRole.EMPLOYEE, tenant_id=org["tenant"].id)
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-team-overview", headers=_auth(emp))
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_platform_admin_gets_403(db_session):
    pa = await _user(db_session, email="pa@p.io", role=UserRole.PLATFORM_ADMIN, tenant_id=None)
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-team-overview", headers=_auth(pa))
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_manager_with_no_reports_gets_empty(db_session, org):
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-team-overview", headers=_auth(org["manager"]))
    assert resp.status_code == 200
    body = resp.json()
    assert body["team_size"] == 0
    assert body["members"] == []
    assert body["pending_approvals_count"] == 0
    assert body["capacity_this_week"] == []


# ─────────────────────────────────────────────────────────────────────────────
# Roster: submitted-day counts
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_submitted_days_count_week_to_date(db_session, org):
    mgr = org["manager"]
    emp = await _user(db_session, email="alice@t.io", role=UserRole.EMPLOYEE, tenant_id=mgr.tenant_id, full_name="Alice")
    await _assign(db_session, manager=mgr, employee=emp)
    await db_session.commit()

    today = date.today()
    monday = _monday_of(today)
    # Two SUBMITTED entries this week, one APPROVED, both within week-to-date.
    for day_offset, status in [
        (0, TimeEntryStatus.SUBMITTED),
        (1, TimeEntryStatus.APPROVED),
    ]:
        d = monday + timedelta(days=day_offset)
        if d > today:
            continue
        db_session.add(TimeEntry(
            tenant_id=mgr.tenant_id,
            user_id=emp.id,
            project_id=org["project"].id,
            entry_date=d,
            hours=Decimal("8"),
            status=status,
            description="x",
        ))
    await db_session.commit()

    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-team-overview", headers=_auth(mgr))
    body = resp.json()
    assert body["team_size"] == 1
    member = body["members"][0]
    assert member["full_name"] == "Alice"
    # We expect both seeded days to count if they fell within today-or-earlier.
    expected = sum(1 for off in (0, 1) if monday + timedelta(days=off) <= today)
    assert member["submitted_days"] == expected


@pytest.mark.asyncio
async def test_draft_entries_do_not_count_as_submitted(db_session, org):
    mgr = org["manager"]
    emp = await _user(db_session, email="b@t.io", role=UserRole.EMPLOYEE, tenant_id=mgr.tenant_id, full_name="Bob")
    await _assign(db_session, manager=mgr, employee=emp)
    today = date.today()
    monday = _monday_of(today)
    db_session.add(TimeEntry(
        tenant_id=mgr.tenant_id, user_id=emp.id, project_id=org["project"].id,
        entry_date=monday, hours=Decimal("8"),
        status=TimeEntryStatus.DRAFT, description="x",
    ))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-team-overview", headers=_auth(mgr))
    member = resp.json()["members"][0]
    assert member["submitted_days"] == 0


# ─────────────────────────────────────────────────────────────────────────────
# PTO classification
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_pto_today_and_this_week_flagged(db_session, org):
    mgr = org["manager"]
    emp = await _user(db_session, email="c@t.io", role=UserRole.EMPLOYEE, tenant_id=mgr.tenant_id, full_name="Carol")
    await _assign(db_session, manager=mgr, employee=emp)
    today = date.today()
    db_session.add(TimeOffRequest(
        tenant_id=mgr.tenant_id, user_id=emp.id, request_date=today,
        hours=Decimal("8"), leave_type="vacation", reason="vacay",
        status=TimeOffStatus.APPROVED,
    ))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-team-overview", headers=_auth(mgr))
    body = resp.json()
    member = body["members"][0]
    assert member["is_on_pto_today"] is True
    assert member["is_on_pto_this_week"] is True
    assert len(body["capacity_this_week"]) == 1
    assert body["capacity_this_week"][0]["leave_type"] == "vacation"
    assert body["capacity_this_week"][0]["days_in_window"] == 1


@pytest.mark.asyncio
async def test_pto_next_week_separates_into_capacity_next_week(db_session, org):
    mgr = org["manager"]
    emp = await _user(db_session, email="d@t.io", role=UserRole.EMPLOYEE, tenant_id=mgr.tenant_id, full_name="Dan")
    await _assign(db_session, manager=mgr, employee=emp)
    today = date.today()
    monday = _monday_of(today)
    next_monday = monday + timedelta(days=7)
    db_session.add(TimeOffRequest(
        tenant_id=mgr.tenant_id, user_id=emp.id, request_date=next_monday,
        hours=Decimal("8"), leave_type="sick", reason="x",
        status=TimeOffStatus.SUBMITTED,
    ))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-team-overview", headers=_auth(mgr))
    body = resp.json()
    assert body["capacity_this_week"] == []
    assert len(body["capacity_next_week"]) == 1
    member = body["members"][0]
    # Today is not the PTO date, so flag stays off; upcoming start is set.
    assert member["is_on_pto_today"] is False
    assert member["upcoming_pto_starts_at"] == next_monday.isoformat()


@pytest.mark.asyncio
async def test_draft_pto_does_not_consume_capacity(db_session, org):
    """DRAFT time-off requests don't claim capacity yet — they're not
    real commitments. Only SUBMITTED + APPROVED show up in the panel."""
    mgr = org["manager"]
    emp = await _user(db_session, email="e@t.io", role=UserRole.EMPLOYEE, tenant_id=mgr.tenant_id, full_name="Eve")
    await _assign(db_session, manager=mgr, employee=emp)
    today = date.today()
    db_session.add(TimeOffRequest(
        tenant_id=mgr.tenant_id, user_id=emp.id, request_date=today,
        hours=Decimal("8"), leave_type="personal", reason="x",
        status=TimeOffStatus.DRAFT,
    ))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-team-overview", headers=_auth(mgr))
    body = resp.json()
    assert body["members"][0]["is_on_pto_today"] is False
    assert body["capacity_this_week"] == []


# ─────────────────────────────────────────────────────────────────────────────
# Pattern: late for last closed submission period (cadence-aware)
# ─────────────────────────────────────────────────────────────────────────────


def _last_week_range(today: date) -> tuple[date, date]:
    """Returns (period_start_monday, period_end_friday) for the week
    immediately before this week. Used as the "closed weekly period"
    when the run-time today is past Monday."""
    this_monday = today - timedelta(days=today.weekday())
    last_monday = this_monday - timedelta(days=7)
    return last_monday, last_monday + timedelta(days=4)


def _is_in_post_deadline_grace_window(today: date) -> bool:
    """The cadence-aware late check requires today to be past the
    most recent deadline + grace. For a Friday deadline with a 1
    business-day grace, that means today must be Monday or later of
    *this* week (or any later day before next Friday). The exception
    is Friday itself, where the test of whether *this week* is the
    closed period depends on time-of-day, which we can't pin in a
    unit test. So we skip when today is Friday or weekend."""
    return today.weekday() in (0, 1, 2, 3)  # Mon-Thu inclusive


@pytest.mark.asyncio
async def test_late_flag_triggers_when_last_week_unsubmitted(db_session, org):
    """An employee who existed before last week and submitted nothing
    for that week's working days should be flagged late once the
    deadline + grace has passed."""
    today = date.today()
    if not _is_in_post_deadline_grace_window(today):
        pytest.skip("Test only deterministic Mon-Thu; skipping due to today's weekday.")

    mgr = org["manager"]
    emp = await _user(db_session, email="f@t.io", role=UserRole.EMPLOYEE, tenant_id=mgr.tenant_id, full_name="Frank")
    # Backdate created_at so the user existed before last week.
    emp.created_at = datetime.now(timezone.utc) - timedelta(days=30)
    await _assign(db_session, manager=mgr, employee=emp)
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-team-overview", headers=_auth(mgr))
    member = resp.json()["members"][0]
    assert member["is_repeatedly_late"] is True


@pytest.mark.asyncio
async def test_late_flag_clear_for_brand_new_user(db_session, org):
    """The Yaswanth case: a user created today (or after last week
    started) is never flagged late for a period that predates their
    account, even if backdated entries exist in the data."""
    mgr = org["manager"]
    emp = await _user(db_session, email="new@t.io", role=UserRole.EMPLOYEE, tenant_id=mgr.tenant_id, full_name="Brand New")
    # created_at defaults to "now"; explicitly set to today to make
    # the intent obvious.
    emp.created_at = datetime.now(timezone.utc)
    await _assign(db_session, manager=mgr, employee=emp)
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-team-overview", headers=_auth(mgr))
    member = resp.json()["members"][0]
    assert member["is_repeatedly_late"] is False


@pytest.mark.asyncio
async def test_late_flag_clear_when_last_period_was_submitted(db_session, org):
    """A pre-existing user with SUBMITTED entries covering every
    working day of the last closed week is not flagged."""
    today = date.today()
    if not _is_in_post_deadline_grace_window(today):
        pytest.skip("Test only deterministic Mon-Thu; skipping due to today's weekday.")

    mgr = org["manager"]
    emp = await _user(db_session, email="g@t.io", role=UserRole.EMPLOYEE, tenant_id=mgr.tenant_id, full_name="Gina")
    emp.created_at = datetime.now(timezone.utc) - timedelta(days=30)
    await _assign(db_session, manager=mgr, employee=emp)
    period_start, period_end = _last_week_range(today)
    cursor = period_start
    while cursor <= period_end:
        db_session.add(TimeEntry(
            tenant_id=mgr.tenant_id, user_id=emp.id, project_id=org["project"].id,
            entry_date=cursor, hours=Decimal("8"),
            status=TimeEntryStatus.SUBMITTED, description="x",
        ))
        cursor += timedelta(days=1)
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-team-overview", headers=_auth(mgr))
    member = resp.json()["members"][0]
    assert member["is_repeatedly_late"] is False


@pytest.mark.asyncio
async def test_late_flag_clear_when_approved_pto_covers_last_period(db_session, org):
    """APPROVED time-off counts as covering a working day, just like
    a SUBMITTED time entry."""
    today = date.today()
    if not _is_in_post_deadline_grace_window(today):
        pytest.skip("Test only deterministic Mon-Thu; skipping due to today's weekday.")

    mgr = org["manager"]
    emp = await _user(db_session, email="pto@t.io", role=UserRole.EMPLOYEE, tenant_id=mgr.tenant_id, full_name="Penny")
    emp.created_at = datetime.now(timezone.utc) - timedelta(days=30)
    await _assign(db_session, manager=mgr, employee=emp)
    period_start, period_end = _last_week_range(today)
    cursor = period_start
    while cursor <= period_end:
        db_session.add(TimeOffRequest(
            tenant_id=mgr.tenant_id, user_id=emp.id,
            request_date=cursor, hours=Decimal("8"),
            leave_type="vacation", reason="vac",
            status=TimeOffStatus.APPROVED,
        ))
        cursor += timedelta(days=1)
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-team-overview", headers=_auth(mgr))
    member = resp.json()["members"][0]
    assert member["is_repeatedly_late"] is False


# ─────────────────────────────────────────────────────────────────────────────
# Priority counts
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_priority_counts_aggregate_correctly(db_session, org):
    mgr = org["manager"]
    emp = await _user(db_session, email="h@t.io", role=UserRole.EMPLOYEE, tenant_id=mgr.tenant_id, full_name="Hank")
    await _assign(db_session, manager=mgr, employee=emp)
    today = date.today()
    monday = _monday_of(today)
    # 2 pending approvals
    for off in (0, 1):
        d = monday + timedelta(days=off)
        if d > today:
            continue
        db_session.add(TimeEntry(
            tenant_id=mgr.tenant_id, user_id=emp.id, project_id=org["project"].id,
            entry_date=d, hours=Decimal("8"),
            status=TimeEntryStatus.SUBMITTED, description="x",
        ))
    # 1 rejected this week
    if monday <= today:
        db_session.add(TimeEntry(
            tenant_id=mgr.tenant_id, user_id=emp.id, project_id=org["project"].id,
            entry_date=monday, hours=Decimal("4"),
            status=TimeEntryStatus.REJECTED, description="x",
        ))
    # 1 pending time-off
    db_session.add(TimeOffRequest(
        tenant_id=mgr.tenant_id, user_id=emp.id, request_date=today + timedelta(days=14),
        hours=Decimal("8"), leave_type="vacation", reason="x",
        status=TimeOffStatus.SUBMITTED,
    ))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-team-overview", headers=_auth(mgr))
    body = resp.json()
    # Pending approvals: at most 2 depending on what fits in week-to-date
    expected_approvals = sum(1 for off in (0, 1) if monday + timedelta(days=off) <= today)
    assert body["pending_approvals_count"] == expected_approvals
    expected_rejected = 1 if monday <= today else 0
    assert body["rejected_recent_count"] == expected_rejected
    assert body["pending_time_off_count"] == 1


# ─────────────────────────────────────────────────────────────────────────────
# Pending approval ages
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_oldest_and_avg_pending_approval_age_compute(db_session, org):
    """submitted_at takes precedence; fall back to created_at when unset."""
    mgr = org["manager"]
    emp = await _user(db_session, email="age@t.io", role=UserRole.EMPLOYEE, tenant_id=mgr.tenant_id, full_name="Age")
    await _assign(db_session, manager=mgr, employee=emp)
    today = date.today()
    monday = _monday_of(today)
    now = datetime.now(timezone.utc)
    # 1 entry submitted ~30h ago, 1 submitted ~6h ago → oldest 30, avg 18.
    db_session.add(TimeEntry(
        tenant_id=mgr.tenant_id, user_id=emp.id, project_id=org["project"].id,
        entry_date=monday, hours=Decimal("8"),
        status=TimeEntryStatus.SUBMITTED, description="x",
        submitted_at=now - timedelta(hours=30),
    ))
    db_session.add(TimeEntry(
        tenant_id=mgr.tenant_id, user_id=emp.id, project_id=org["project"].id,
        entry_date=monday + timedelta(days=1), hours=Decimal("8"),
        status=TimeEntryStatus.SUBMITTED, description="x",
        submitted_at=now - timedelta(hours=6),
    ))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-team-overview", headers=_auth(mgr))
    body = resp.json()
    assert body["pending_approvals_count"] == 2
    assert body["pending_approvals_oldest_hours"] in (29, 30)  # rounding tolerance
    assert body["pending_approvals_avg_hours"] in (17, 18)


@pytest.mark.asyncio
async def test_pending_approval_ages_null_when_queue_empty(db_session, org):
    mgr = org["manager"]
    emp = await _user(db_session, email="empty@t.io", role=UserRole.EMPLOYEE, tenant_id=mgr.tenant_id, full_name="Empty")
    await _assign(db_session, manager=mgr, employee=emp)
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-team-overview", headers=_auth(mgr))
    body = resp.json()
    assert body["pending_approvals_count"] == 0
    assert body["pending_approvals_oldest_hours"] is None
    assert body["pending_approvals_avg_hours"] is None


# ─────────────────────────────────────────────────────────────────────────────
# Project health endpoint
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_project_health_403_for_employee(db_session, org):
    emp = await _user(db_session, email="emp@p.io", role=UserRole.EMPLOYEE, tenant_id=org["tenant"].id)
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-project-health", headers=_auth(emp))
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_project_health_shows_owned_project_even_with_no_team(db_session, org):
    # A manager who owns a project sees it even with no direct reports / no time
    # logged — it surfaces as 'not-started' (widget shows all managed projects).
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-project-health", headers=_auth(org["manager"]))
    assert resp.status_code == 200
    rows = resp.json()["rows"]
    assert len(rows) == 1
    assert rows[0]["health"] == "not-started"


@pytest.mark.asyncio
async def test_project_health_includes_only_projects_with_recent_entries(db_session, org):
    mgr = org["manager"]
    emp = await _user(db_session, email="ph@t.io", role=UserRole.EMPLOYEE, tenant_id=mgr.tenant_id, full_name="PH")
    await _assign(db_session, manager=mgr, employee=emp)
    # Add a second project the team has *not* logged to. Should not appear.
    other = Project(
        tenant_id=mgr.tenant_id, client_id=org["project"].client_id, name="Other",
        billable_rate=Decimal("100"), is_active=True,
    )
    db_session.add(other)
    await db_session.flush()
    today = date.today()
    monday = _monday_of(today)
    db_session.add(TimeEntry(
        tenant_id=mgr.tenant_id, user_id=emp.id, project_id=org["project"].id,
        entry_date=monday, hours=Decimal("8"),
        status=TimeEntryStatus.SUBMITTED, description="x",
    ))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-project-health", headers=_auth(mgr))
    body = resp.json()
    project_names = [r["project_name"] for r in body["rows"]]
    assert "P" in project_names
    assert "Other" not in project_names


@pytest.mark.asyncio
async def test_project_health_classifies_over_budget_as_critical(db_session, org):
    mgr = org["manager"]
    emp = await _user(db_session, email="ob@t.io", role=UserRole.EMPLOYEE, tenant_id=mgr.tenant_id, full_name="OB")
    await _assign(db_session, manager=mgr, employee=emp)
    # Dollar budget $1000; bill rate $100/h. Log 12 approved billable hours =
    # $1200 revenue = 120% of budget -> critical (the classifier uses the dollar
    # budget burn, not estimated_hours).
    org["project"].budget_amount = Decimal("1000")
    db_session.add(org["project"])
    today = date.today()
    monday = _monday_of(today)
    db_session.add(TimeEntry(
        tenant_id=mgr.tenant_id, user_id=emp.id, project_id=org["project"].id,
        entry_date=monday, hours=Decimal("12"), is_billable=True,
        status=TimeEntryStatus.APPROVED, description="x",
    ))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-project-health", headers=_auth(mgr))
    row = resp.json()["rows"][0]
    assert row["health"] == "critical"
    assert row["budget_pct"] == 120


@pytest.mark.asyncio
async def test_project_health_not_set_when_no_budget_and_no_end_date(db_session, org):
    mgr = org["manager"]
    emp = await _user(db_session, email="ns@t.io", role=UserRole.EMPLOYEE, tenant_id=mgr.tenant_id, full_name="NS")
    await _assign(db_session, manager=mgr, employee=emp)
    today = date.today()
    monday = _monday_of(today)
    db_session.add(TimeEntry(
        tenant_id=mgr.tenant_id, user_id=emp.id, project_id=org["project"].id,
        entry_date=monday, hours=Decimal("3"),
        status=TimeEntryStatus.SUBMITTED, description="x",
    ))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-project-health", headers=_auth(mgr))
    row = resp.json()["rows"][0]
    assert row["health"] == "not-set"
    assert row["budget_pct"] is None


@pytest.mark.asyncio
async def test_project_health_not_started_when_no_time_logged(db_session, org):
    """An active project the manager owns with NO time logged ever surfaces as
    'not-started' (the widget now shows all managed projects, started or not)."""
    mgr = org["manager"]
    # No time entries at all on org["project"].
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-project-health", headers=_auth(mgr))
    rows = resp.json()["rows"]
    assert len(rows) == 1
    assert rows[0]["project_id"] == org["project"].id
    assert rows[0]["health"] == "not-started"


@pytest.mark.asyncio
async def test_project_health_excludes_archived_project(db_session, org):
    """An archived (is_active=False) managed project does NOT appear."""
    mgr = org["manager"]
    org["project"].is_active = False
    db_session.add(org["project"])
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/dashboard/manager-project-health", headers=_auth(mgr))
    assert resp.json()["rows"] == []
