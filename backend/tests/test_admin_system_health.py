"""Tests for ``GET /admin/system-health``.

Coverage:
- 403 for non-admin roles (EMPLOYEE, MANAGER, VIEWER).
- 200 for ADMIN and PLATFORM_ADMIN.
- Database check returns "healthy" when SELECT 1 round-trips.
- Email-ingestion check classification:
    * No mailbox configured at all   → healthy ("No active mailboxes").
    * Active mailbox, never fetched  → attention.
    * Fetched recently (within 2x interval) → healthy.
    * Fetched outside the 2x window  → attention.
- Redis check is monkey-patched so the test runs without a live Redis.
"""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover - test shim
    return "JSON"


from app.api import admin as admin_api
from app.core.security import create_access_token, get_password_hash
from app.db import get_db
from app.core.deps import get_tenant_db
from app.models.base import Base
from app.models.mailbox import Mailbox, MailboxAuthType, MailboxProtocol
from app.models.tenant import Tenant, TenantStatus
from app.models.user import User, UserRole


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────────


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    db_file = tmp_path / "admin_system_health.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_file}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


def _make_app(db_session: AsyncSession) -> TestClient:
    app = FastAPI()
    app.include_router(admin_api.router)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_tenant_db] = override_get_db
    return TestClient(app)


def _auth_headers(user: User) -> dict:
    token = create_access_token({"sub": str(user.id), "tenant_id": user.tenant_id})
    return {"Authorization": f"Bearer {token}"}


async def _make_user(
    session: AsyncSession,
    *,
    email: str,
    role: UserRole,
    tenant_id: int | None,
) -> User:
    user = User(
        tenant_id=tenant_id,
        email=email,
        username=email.split("@")[0].replace(".", "-"),
        full_name=email,
        hashed_password=get_password_hash("password"),
        role=role,
        is_active=True,
        email_verified=True,
        has_changed_password=True,
    )
    session.add(user)
    await session.flush()
    return user


@pytest_asyncio.fixture
async def tenant(db_session: AsyncSession) -> Tenant:
    t = Tenant(name="T", slug="t", status=TenantStatus.active)
    db_session.add(t)
    await db_session.flush()
    return t


@pytest.fixture(autouse=True)
def stub_redis_check(monkeypatch):
    """Pin the Redis check to a deterministic 'healthy' result so tests
    don't depend on a live Redis. Individual tests can re-stub when they
    want to assert a different outcome."""
    async def _ok():
        return admin_api.SystemHealthCheck(
            key="redis", label="Redis", status="healthy", subtitle="Last ping 1ms",
        )
    monkeypatch.setattr(admin_api, "_check_redis", _ok)


# ─────────────────────────────────────────────────────────────────────────────
# Auth
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("role", [
    UserRole.EMPLOYEE,
    UserRole.MANAGER,
    UserRole.MANAGER,
    UserRole.VIEWER,
])
async def test_non_admin_roles_get_403(db_session, tenant, role):
    user = await _make_user(db_session, email=f"{role.value.lower()}@t.io", role=role, tenant_id=tenant.id)
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/admin/system-health", headers=_auth_headers(user))
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_admin_can_read(db_session, tenant):
    admin = await _make_user(db_session, email="admin@t.io", role=UserRole.ADMIN, tenant_id=tenant.id)
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/admin/system-health", headers=_auth_headers(admin))
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    keys = [item["key"] for item in body]
    assert "database" in keys
    assert "redis" in keys
    assert "email_ingestion" in keys


@pytest.mark.asyncio
async def test_platform_admin_can_read(db_session):
    pa = await _make_user(db_session, email="pa@platform.io", role=UserRole.PLATFORM_ADMIN, tenant_id=None)
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/admin/system-health", headers=_auth_headers(pa))
    assert resp.status_code == 200


# ─────────────────────────────────────────────────────────────────────────────
# Per-service classification
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_database_check_returns_healthy(db_session, tenant):
    admin = await _make_user(db_session, email="a@t.io", role=UserRole.ADMIN, tenant_id=tenant.id)
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/admin/system-health", headers=_auth_headers(admin))
    db_item = next(i for i in resp.json() if i["key"] == "database")
    assert db_item["status"] == "healthy"
    assert "Last query" in db_item["subtitle"]


@pytest.mark.asyncio
async def test_email_ingestion_no_mailboxes_is_healthy(db_session, tenant):
    """Tenants without ingestion configured should not show as degraded."""
    admin = await _make_user(db_session, email="a@t.io", role=UserRole.ADMIN, tenant_id=tenant.id)
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/admin/system-health", headers=_auth_headers(admin))
    item = next(i for i in resp.json() if i["key"] == "email_ingestion")
    assert item["status"] == "healthy"
    assert "No active mailboxes" in item["subtitle"]


@pytest.mark.asyncio
async def test_email_ingestion_active_but_never_fetched_with_autofetch_enabled_is_attention(db_session, tenant):
    """A configured mailbox that has never fetched WHILE auto-fetch is
    enabled IS a real issue — the cron should have ticked by now."""
    from app.models.tenant_settings import TenantSettings

    admin = await _make_user(db_session, email="a@t.io", role=UserRole.ADMIN, tenant_id=tenant.id)
    db_session.add(Mailbox(
        tenant_id=tenant.id,
        label="Ingestion",
        protocol=MailboxProtocol.imap,
        auth_type=MailboxAuthType.basic,
        host="imap.example.com",
        port=993,
        username="ingest@t.io",
        password_enc="enc",
        is_active=True,
        last_fetched_at=None,
    ))
    # Enable auto-fetch with a wide-open window so the test isn't time-of-day brittle.
    for key, value in [
        ("fetch_emails_enabled", '"true"'),
        ("fetch_emails_days", '"mon,tue,wed,thu,fri,sat,sun"'),
        ("fetch_emails_start_time", '"00:00"'),
        ("fetch_emails_end_time", '"23:59"'),
    ]:
        db_session.add(TenantSettings(tenant_id=tenant.id, key=key, value=value))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/admin/system-health", headers=_auth_headers(admin))
    item = next(i for i in resp.json() if i["key"] == "email_ingestion")
    assert item["status"] == "attention"
    assert "never" in item["subtitle"].lower() or "no mailbox" in item["subtitle"].lower()


@pytest.mark.asyncio
async def test_email_ingestion_active_but_never_fetched_with_autofetch_off_is_healthy(db_session, tenant):
    """A mailbox that has never fetched and where auto-fetch is OFF is not
    a degraded state — it's just sitting waiting for a manual fetch or
    for an admin to flip the toggle."""
    admin = await _make_user(db_session, email="a@t.io", role=UserRole.ADMIN, tenant_id=tenant.id)
    db_session.add(Mailbox(
        tenant_id=tenant.id,
        label="Ingestion",
        protocol=MailboxProtocol.imap,
        auth_type=MailboxAuthType.basic,
        host="imap.example.com",
        port=993,
        username="ingest@t.io",
        password_enc="enc",
        is_active=True,
        last_fetched_at=None,
    ))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/admin/system-health", headers=_auth_headers(admin))
    item = next(i for i in resp.json() if i["key"] == "email_ingestion")
    assert item["status"] == "healthy"
    assert "auto-fetch disabled" in item["subtitle"].lower()


@pytest.mark.asyncio
async def test_email_ingestion_recent_fetch_is_healthy(db_session, tenant):
    """Recent fetch with auto-fetch enabled: healthy with a 'Last fetch …'
    subtitle. Configure auto-fetch explicitly so the test exercises the
    in-window path rather than the 'Auto-fetch disabled' fallback."""
    from app.models.tenant_settings import TenantSettings

    admin = await _make_user(db_session, email="a@t.io", role=UserRole.ADMIN, tenant_id=tenant.id)
    db_session.add(Mailbox(
        tenant_id=tenant.id,
        label="Ingestion",
        protocol=MailboxProtocol.imap,
        auth_type=MailboxAuthType.basic,
        host="imap.example.com",
        port=993,
        username="ingest@t.io",
        password_enc="enc",
        is_active=True,
        last_fetched_at=datetime.now(timezone.utc) - timedelta(minutes=5),
    ))
    for key, value in [
        ("fetch_emails_enabled", '"true"'),
        ("fetch_emails_days", '"mon,tue,wed,thu,fri,sat,sun"'),
        ("fetch_emails_start_time", '"00:00"'),
        ("fetch_emails_end_time", '"23:59"'),
    ]:
        db_session.add(TenantSettings(tenant_id=tenant.id, key=key, value=value))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/admin/system-health", headers=_auth_headers(admin))
    item = next(i for i in resp.json() if i["key"] == "email_ingestion")
    assert item["status"] == "healthy"
    assert "Last fetch" in item["subtitle"]


@pytest.mark.asyncio
async def test_email_ingestion_stale_fetch_is_attention(db_session, tenant):
    """Past 2x the configured fetch interval, with auto-fetch enabled and
    inside the window: surface as attention with the expected interval in
    the subtitle so the admin knows what cadence is broken."""
    from app.models.tenant_settings import TenantSettings

    admin = await _make_user(db_session, email="a@t.io", role=UserRole.ADMIN, tenant_id=tenant.id)
    db_session.add(Mailbox(
        tenant_id=tenant.id,
        label="Ingestion",
        protocol=MailboxProtocol.imap,
        auth_type=MailboxAuthType.basic,
        host="imap.example.com",
        port=993,
        username="ingest@t.io",
        password_enc="enc",
        is_active=True,
        # 4 hours ago is far past 2x default 15-minute interval.
        last_fetched_at=datetime.now(timezone.utc) - timedelta(hours=4),
    ))
    for key, value in [
        ("fetch_emails_enabled", '"true"'),
        ("fetch_emails_days", '"mon,tue,wed,thu,fri,sat,sun"'),
        ("fetch_emails_start_time", '"00:00"'),
        ("fetch_emails_end_time", '"23:59"'),
    ]:
        db_session.add(TenantSettings(tenant_id=tenant.id, key=key, value=value))
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/admin/system-health", headers=_auth_headers(admin))
    item = next(i for i in resp.json() if i["key"] == "email_ingestion")
    assert item["status"] == "attention"
    assert "expected every" in item["subtitle"]


# ─────────────────────────────────────────────────────────────────────────────
# Settings-decoding regression: tenant_settings rows are written as JSON
# (set_setting does ``json.dumps(value)``), so a string "08:00" round-trips
# as the 6-character literal ``"08:00"`` with quotes included. The fetch-
# window readers must JSON-decode, otherwise the cron's time parser fails
# silently and auto-fetch never runs.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_fetch_window_decodes_json_encoded_settings(db_session, tenant):
    """Regression for the silent-skip bug: when fetch_emails_start_time is
    stored as the JSON literal ``"08:00"`` (quotes included), the widget
    must still classify a recently-fetched mailbox as healthy. Before the
    fix, the time parser threw ValueError and the widget either lied
    ("expected every Nm") or treated the window as malformed."""
    from app.models.tenant_settings import TenantSettings

    admin = await _make_user(db_session, email="a@t.io", role=UserRole.ADMIN, tenant_id=tenant.id)
    db_session.add(Mailbox(
        tenant_id=tenant.id,
        label="Ingestion",
        protocol=MailboxProtocol.imap,
        auth_type=MailboxAuthType.basic,
        host="imap.example.com",
        port=993,
        username="ingest@t.io",
        password_enc="enc",
        is_active=True,
        last_fetched_at=datetime.now(timezone.utc) - timedelta(minutes=3),
    ))
    # JSON-encoded values as set_setting writes them.
    for key, value in [
        ("fetch_emails_enabled", '"true"'),
        ("fetch_emails_interval_minutes", "5"),
        ("fetch_emails_days", '"mon,tue,wed,thu,fri,sat,sun"'),
        ("fetch_emails_start_time", '"00:00"'),
        ("fetch_emails_end_time", '"23:59"'),
    ]:
        db_session.add(TenantSettings(tenant_id=tenant.id, key=key, value=value))
    await db_session.commit()

    with _make_app(db_session) as client:
        resp = client.get("/admin/system-health", headers=_auth_headers(admin))
    item = next(i for i in resp.json() if i["key"] == "email_ingestion")
    assert item["status"] == "healthy", (
        f"Healthy mailbox misclassified due to JSON-encoded settings: {item}"
    )


@pytest.mark.asyncio
async def test_should_fetch_now_handles_quoted_time_strings():
    """Direct unit check on the cron predicate: JSON-quoted time strings
    must not silently disable auto-fetch."""
    from app.workers.email_fetch import _should_fetch_now

    now = datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc)  # Tue noon
    settings_dict = {
        "fetch_emails_interval_minutes": "5",
        "fetch_emails_days": '"mon,tue,wed,thu,fri"',  # quoted
        "fetch_emails_start_time": '"08:00"',          # quoted
        "fetch_emails_end_time": '"22:00"',            # quoted
    }
    assert _should_fetch_now(settings_dict, now) is True


@pytest.mark.asyncio
async def test_should_fetch_now_returns_false_outside_window():
    from app.workers.email_fetch import _should_fetch_now

    now_before = datetime(2026, 5, 19, 6, 0, tzinfo=timezone.utc)  # Tue 6am
    settings_dict = {
        "fetch_emails_interval_minutes": "5",
        "fetch_emails_days": "mon,tue,wed,thu,fri",
        "fetch_emails_start_time": "08:00",
        "fetch_emails_end_time": "22:00",
    }
    assert _should_fetch_now(settings_dict, now_before) is False


@pytest.mark.asyncio
async def test_redis_check_attention_when_ping_fails(db_session, tenant, monkeypatch):
    """When Redis is unreachable we still get a 200 with the rest of the
    services intact — failures are isolated, never propagate."""
    async def _failing():
        return admin_api.SystemHealthCheck(
            key="redis", label="Redis", status="attention", subtitle="Ping failed",
        )
    monkeypatch.setattr(admin_api, "_check_redis", _failing)

    admin = await _make_user(db_session, email="a@t.io", role=UserRole.ADMIN, tenant_id=tenant.id)
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/admin/system-health", headers=_auth_headers(admin))
    assert resp.status_code == 200
    redis_item = next(i for i in resp.json() if i["key"] == "redis")
    assert redis_item["status"] == "attention"
    # Other services remain reportable.
    assert any(i["key"] == "database" for i in resp.json())
