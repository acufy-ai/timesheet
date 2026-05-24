"""Regression tests for the /users/me/preferences endpoint.

The schema lets the frontend send arbitrary preference keys (extra:
allow + known keys declared). A real user-visible bug landed when
``holiday_calendar_country`` got silently dropped because it wasn't
declared on ``UserPreferencesUpdate`` — these tests pin the contract
so it doesn't recur.
"""
from __future__ import annotations

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


from app.api import users as users_api
from app.core.security import create_access_token, get_password_hash
from app.db import get_db
from app.core.deps import get_tenant_db
from app.models.base import Base
from app.models.tenant import Tenant, TenantStatus
from app.models.user import User, UserRole


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'prefs.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


def _make_app(db_session: AsyncSession) -> TestClient:
    app = FastAPI()
    app.include_router(users_api.router)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_tenant_db] = override_get_db
    return TestClient(app)


def _auth(user: User) -> dict:
    token = create_access_token({"sub": str(user.id), "tenant_id": user.tenant_id})
    return {"Authorization": f"Bearer {token}"}


@pytest_asyncio.fixture
async def user(db_session: AsyncSession) -> User:
    tenant = Tenant(name="T", slug="t", status=TenantStatus.active)
    db_session.add(tenant)
    await db_session.flush()
    u = User(
        tenant_id=tenant.id, email="u@t.io", username="u", full_name="U",
        hashed_password=get_password_hash("password"),
        role=UserRole.EMPLOYEE, is_active=True, email_verified=True,
        has_changed_password=True,
    )
    db_session.add(u)
    await db_session.commit()
    return u


@pytest.mark.asyncio
async def test_patch_holiday_calendar_country_persists(db_session, user):
    """The exact scenario that broke in the UI: select 'US' in the
    calendar's country dropdown, refresh, see 'US' selected."""
    with _make_app(db_session) as client:
        patch = client.patch(
            "/users/me/preferences",
            json={"holiday_calendar_country": "US"},
            headers=_auth(user),
        )
        assert patch.status_code == 200, patch.text
        assert patch.json().get("holiday_calendar_country") == "US"

        get = client.get("/users/me/preferences", headers=_auth(user))
        assert get.status_code == 200
        assert get.json().get("holiday_calendar_country") == "US"


@pytest.mark.asyncio
async def test_patch_null_holiday_calendar_country_clears_the_preference(db_session, user):
    """Selecting 'All locations' (value=None) must remove the key
    from the stored dict, not write the literal string 'None'."""
    with _make_app(db_session) as client:
        client.patch(
            "/users/me/preferences",
            json={"holiday_calendar_country": "US"},
            headers=_auth(user),
        )
        clear = client.patch(
            "/users/me/preferences",
            json={"holiday_calendar_country": None},
            headers=_auth(user),
        )
        assert clear.status_code == 200, clear.text
        body = clear.json()
        # The server may either omit the key OR return it as null;
        # both mean "no preference". Pin both shapes so a future
        # response-schema change doesn't reintroduce the stale-value
        # bug from the read endpoint side.
        assert body.get("holiday_calendar_country") in (None, ""), body


@pytest.mark.asyncio
async def test_unknown_preference_key_is_passed_through(db_session, user):
    """``extra: 'allow'`` on the update schema means the next UI
    preference can flow through without a schema bump. Pin that
    behaviour so a future tightening doesn't silently break a
    different feature like the holiday country bug did."""
    with _make_app(db_session) as client:
        resp = client.patch(
            "/users/me/preferences",
            json={"some_future_key": "value"},
            headers=_auth(user),
        )
        assert resp.status_code == 200
        assert resp.json().get("some_future_key") == "value"


@pytest.mark.asyncio
async def test_patching_one_key_does_not_drop_others(db_session, user):
    """Sanity check on the merge logic: setting a new preference must
    leave existing ones intact."""
    with _make_app(db_session) as client:
        client.patch(
            "/users/me/preferences",
            json={"inbox_view_mode": "cards"},
            headers=_auth(user),
        )
        client.patch(
            "/users/me/preferences",
            json={"holiday_calendar_country": "IN"},
            headers=_auth(user),
        )
        final = client.get("/users/me/preferences", headers=_auth(user)).json()
        assert final.get("inbox_view_mode") == "cards"
        assert final.get("holiday_calendar_country") == "IN"
