"""Per-tab refresh-cookie scoping: two different accounts in two tabs of the
same browser keep independent sessions.

The refresh token lives in an HttpOnly cookie, and a browser has one cookie jar
per origin shared by every tab. So without scoping, logging into account B in a
second tab overwrites account A's cookie, and A's next refresh adopts B (and the
frontend logs A out). Scoping the cookie name per tab (refresh_token__<tabId>,
from the X-Tab-Id header) gives each tab its own cookie so they don't collide.

We exercise /auth/refresh and /auth/logout directly (minting the refresh tokens
the way login does), so the tests don't depend on the control-plane Postgres
that /auth/login probes for platform admins.

Pins:
  1. Each tab's refresh, with both cookies in the jar, returns ITS OWN account.
  2. Logging out one tab does not kill the other.
  3. No tab id => legacy single-cookie behavior still works.
"""
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


from app.api import auth as auth_module
from app.core.security import create_access_token, create_refresh_token, get_password_hash
from app.db import get_db
from app.models.base import Base
from app.models.refresh_token import RefreshToken
from app.models.tenant import Tenant, TenantStatus
from app.models.user import User, UserRole

TAB_A = "tabAAA"
TAB_B = "tabBBB"
COOKIE = auth_module.REFRESH_COOKIE_NAME
NAME_A = f"{COOKIE}__{TAB_A}"
NAME_B = f"{COOKIE}__{TAB_B}"


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    db_file = tmp_path / "pertab.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_file}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


async def _mk_user(db, tenant_id, email, username, role) -> dict:
    user = User(
        tenant_id=tenant_id, email=email, username=username, full_name=username.title(),
        hashed_password=get_password_hash("password"), role=role,
        is_active=True, has_changed_password=True, email_verified=True,
    )
    db.add(user)
    await db.flush()
    payload = {"sub": str(user.id), "tenant_id": tenant_id}
    refresh, jti, expires_at = create_refresh_token(payload)
    db.add(RefreshToken(jti=jti, user_id=user.id, expires_at=expires_at, revoked=False))
    access = create_access_token(payload)
    return {"user": user, "refresh": refresh, "access": access, "jti": jti}


@pytest_asyncio.fixture
async def two_users(db_session: AsyncSession) -> dict:
    tenant = Tenant(name="T", slug="t", status=TenantStatus.active)
    db_session.add(tenant)
    await db_session.flush()
    a = await _mk_user(db_session, tenant.id, "a@t.example", "alice", UserRole.MANAGER)
    b = await _mk_user(db_session, tenant.id, "b@t.example", "bob", UserRole.ADMIN)
    await db_session.commit()
    return {"a": a, "b": b}


def _client(db_session: AsyncSession) -> TestClient:
    app = FastAPI()
    app.include_router(auth_module.router)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    auth_module.limiter.enabled = False
    return TestClient(app)


@pytest.mark.asyncio
async def test_each_tab_refreshes_its_own_account(db_session, two_users):
    """Both per-tab cookies in one jar; each tab's refresh returns its own
    user — neither clobbers the other."""
    client = _client(db_session)
    # One browser jar holding BOTH tabs' cookies.
    client.cookies.set(NAME_A, two_users["a"]["refresh"])
    client.cookies.set(NAME_B, two_users["b"]["refresh"])
    with client:
        ra = client.post("/auth/refresh", json={}, headers={"X-Tab-Id": TAB_A})
        rb = client.post("/auth/refresh", json={}, headers={"X-Tab-Id": TAB_B})
    assert ra.status_code == 200, ra.text
    assert rb.status_code == 200, rb.text
    assert ra.json()["user"]["email"] == "a@t.example"
    assert rb.json()["user"]["email"] == "b@t.example"


@pytest.mark.asyncio
async def test_logout_one_tab_leaves_the_other(db_session, two_users):
    client = _client(db_session)
    client.cookies.set(NAME_A, two_users["a"]["refresh"])
    client.cookies.set(NAME_B, two_users["b"]["refresh"])
    with client:
        # Tab A logs out (its access token authorizes the call, its tab id scopes it).
        logout = client.post(
            "/auth/logout", json={},
            headers={"Authorization": f"Bearer {two_users['a']['access']}", "X-Tab-Id": TAB_A},
        )
        assert logout.status_code == 200, logout.text

        # Re-set A's cookie (logout cleared it from the jar) to prove the SERVER
        # side revoked it, not just the cookie deletion.
        client.cookies.set(NAME_A, two_users["a"]["refresh"])
        ra = client.post("/auth/refresh", json={}, headers={"X-Tab-Id": TAB_A})
        rb = client.post("/auth/refresh", json={}, headers={"X-Tab-Id": TAB_B})
    assert ra.status_code == 401, ra.text
    assert rb.status_code == 200, rb.text
    assert rb.json()["user"]["email"] == "b@t.example"


@pytest.mark.asyncio
async def test_no_tab_id_uses_legacy_cookie(db_session, two_users):
    """A client that sends no X-Tab-Id keeps the legacy single-cookie flow."""
    client = _client(db_session)
    client.cookies.set(COOKIE, two_users["a"]["refresh"])
    with client:
        r = client.post("/auth/refresh", json={})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["email"] == "a@t.example"


@pytest.mark.asyncio
async def test_tab_cookie_read_prefers_scoped_then_legacy(db_session, two_users):
    """With a tab id present, the scoped cookie wins over a legacy cookie in
    the same jar — so an upgraded session uses the right per-tab token."""
    client = _client(db_session)
    # Legacy cookie belongs to B; scoped tab-A cookie belongs to A.
    client.cookies.set(COOKIE, two_users["b"]["refresh"])
    client.cookies.set(NAME_A, two_users["a"]["refresh"])
    with client:
        ra = client.post("/auth/refresh", json={}, headers={"X-Tab-Id": TAB_A})
    assert ra.status_code == 200, ra.text
    # Scoped A cookie must win, not the legacy B cookie.
    assert ra.json()["user"]["email"] == "a@t.example"
