"""
Regression + unit tests for POST /users/{user_id}/reset-password.

Coverage matrix:
  Access control
    - Non-admin roles (EMPLOYEE, MANAGER, VIEWER) → 403
    - Admin within own tenant → 200
    - Admin cannot reset own password → 400
    - Admin cannot reset user from different tenant → 403
    - PLATFORM_ADMIN can reset users in any tenant → 200

  Password validation
    - Blank password → 422
    - Too-short password → 400
    - Valid strong password accepted

  Auth0 sync (new behaviour added 2026-05-13)
    - User with auth0_sub: set_user_password called before local write
    - User without auth0_sub: local-only write, Auth0 never called
    - Auth0 policy rejection surfaces as 400, local state NOT committed
    - Auth0 unreachable surfaces as 400, local state NOT committed

  State mutations
    - hashed_password updated after successful reset
    - has_changed_password flipped to False after successful reset
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB

@compiles(JSONB, "sqlite")
def _jsonb_sqlite(element, compiler, **kw):  # pragma: no cover
    return "JSON"

from app.api import users as users_api
from app.core.security import create_access_token, get_password_hash, verify_password
from app.core.deps import get_tenant_db
from app.db import get_db
from app.models.base import Base
from app.models.tenant import Tenant, TenantStatus
from app.models.user import User, UserRole


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/reset_pw.db")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


def _make_app(db_session: AsyncSession) -> TestClient:
    app = FastAPI()
    app.include_router(users_api.router)

    async def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    app.dependency_overrides[get_tenant_db] = _override
    return TestClient(app)


def _token(user: User) -> dict:
    tok = create_access_token({"sub": str(user.id), "tenant_id": user.tenant_id})
    return {"Authorization": f"Bearer {tok}"}


async def _make_user(
    session: AsyncSession,
    *,
    tenant: Tenant | None,
    role: UserRole = UserRole.EMPLOYEE,
    email: str,
    auth0_sub: str | None = None,
    has_changed_password: bool = True,
) -> User:
    u = User(
        tenant_id=tenant.id if tenant else None,
        email=email,
        username=email.replace("@", "-at-").replace(".", "-"),
        full_name=email,
        hashed_password=get_password_hash("OldPass123!"),
        role=role,
        is_active=True,
        email_verified=True,
        has_changed_password=has_changed_password,
        auth0_sub=auth0_sub,
    )
    session.add(u)
    await session.flush()
    return u


@pytest_asyncio.fixture
async def setup(db_session: AsyncSession) -> dict:
    t1 = Tenant(name="TenantA", slug="tenant-a", status=TenantStatus.active)
    t2 = Tenant(name="TenantB", slug="tenant-b", status=TenantStatus.active)
    db_session.add_all([t1, t2])
    await db_session.flush()

    admin    = await _make_user(db_session, tenant=t1, role=UserRole.ADMIN,    email="admin@a.io")
    employee = await _make_user(db_session, tenant=t1, role=UserRole.EMPLOYEE, email="emp@a.io",
                                auth0_sub="auth0|emp123", has_changed_password=True)
    employee_no_sub = await _make_user(db_session, tenant=t1, role=UserRole.EMPLOYEE,
                                       email="legacy@a.io", auth0_sub=None)
    other_tenant_user = await _make_user(db_session, tenant=t2, role=UserRole.EMPLOYEE,
                                         email="emp@b.io")
    platform_admin = await _make_user(db_session, tenant=None, role=UserRole.PLATFORM_ADMIN,
                                      email="pa@platform.io")
    manager  = await _make_user(db_session, tenant=t1, role=UserRole.MANAGER,  email="mgr@a.io")
    viewer   = await _make_user(db_session, tenant=t1, role=UserRole.VIEWER,   email="vw@a.io")

    await db_session.commit()
    return dict(
        t1=t1, t2=t2,
        admin=admin,
        employee=employee,
        employee_no_sub=employee_no_sub,
        other_tenant_user=other_tenant_user,
        platform_admin=platform_admin,
        manager=manager,
        viewer=viewer,
    )


_VALID_PW = "NewValid1!"
_NO_AUTH0 = patch("app.services.auth0_mgmt.set_user_password", new_callable=AsyncMock)


# ---------------------------------------------------------------------------
# Access control
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("role_key", ["manager", "viewer", "employee"])
@pytest.mark.asyncio
async def test_non_admin_cannot_reset_password(db_session, setup, role_key):
    actor = setup[role_key]
    target = setup["employee"] if role_key != "employee" else setup["employee_no_sub"]
    with _make_app(db_session) as client, _NO_AUTH0:
        resp = client.post(
            f"/users/{target.id}/reset-password",
            headers=_token(actor),
            json={"new_password": _VALID_PW},
        )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_admin_can_reset_employee_password(db_session, setup):
    admin = setup["admin"]
    emp   = setup["employee"]
    with _make_app(db_session) as client:
        with patch("app.services.auth0_mgmt.set_user_password", new_callable=AsyncMock):
            resp = client.post(
                f"/users/{emp.id}/reset-password",
                headers=_token(admin),
                json={"new_password": _VALID_PW},
            )
    assert resp.status_code == 200
    assert "reset" in resp.json()["message"].lower()


@pytest.mark.asyncio
async def test_admin_cannot_reset_own_password(db_session, setup):
    admin = setup["admin"]
    with _make_app(db_session) as client, _NO_AUTH0:
        resp = client.post(
            f"/users/{admin.id}/reset-password",
            headers=_token(admin),
            json={"new_password": _VALID_PW},
        )
    assert resp.status_code == 400
    assert "own" in resp.json()["detail"].lower() or "yourself" in resp.json()["detail"].lower() or "change password" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_admin_cannot_reset_user_in_other_tenant(db_session, setup):
    admin = setup["admin"]
    other = setup["other_tenant_user"]
    with _make_app(db_session) as client, _NO_AUTH0:
        resp = client.post(
            f"/users/{other.id}/reset-password",
            headers=_token(admin),
            json={"new_password": _VALID_PW},
        )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_platform_admin_can_reset_cross_tenant_user(db_session, setup):
    pa    = setup["platform_admin"]
    other = setup["other_tenant_user"]
    with _make_app(db_session) as client:
        with patch("app.services.auth0_mgmt.set_user_password", new_callable=AsyncMock):
            resp = client.post(
                f"/users/{other.id}/reset-password",
                headers=_token(pa),
                json={"new_password": _VALID_PW},
            )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_reset_nonexistent_user_returns_404(db_session, setup):
    admin = setup["admin"]
    with _make_app(db_session) as client, _NO_AUTH0:
        resp = client.post(
            "/users/99999/reset-password",
            headers=_token(admin),
            json={"new_password": _VALID_PW},
        )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Password validation
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_blank_password_rejected(db_session, setup):
    admin = setup["admin"]
    emp   = setup["employee"]
    with _make_app(db_session) as client, _NO_AUTH0:
        resp = client.post(
            f"/users/{emp.id}/reset-password",
            headers=_token(admin),
            json={"new_password": ""},
        )
    assert resp.status_code in (400, 422)


@pytest.mark.asyncio
async def test_too_short_password_rejected(db_session, setup):
    admin = setup["admin"]
    emp   = setup["employee"]
    with _make_app(db_session) as client, _NO_AUTH0:
        resp = client.post(
            f"/users/{emp.id}/reset-password",
            headers=_token(admin),
            json={"new_password": "Ab1!"},
        )
    assert resp.status_code in (400, 422)


# ---------------------------------------------------------------------------
# Auth0 sync behaviour
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_auth0_set_password_called_for_user_with_sub(db_session, setup):
    """Auth0 sync must happen for users with auth0_sub set."""
    admin = setup["admin"]
    emp   = setup["employee"]  # has auth0_sub="auth0|emp123"

    mock_set_pw = AsyncMock()
    with _make_app(db_session) as client:
        with patch("app.services.auth0_mgmt.set_user_password", mock_set_pw):
            resp = client.post(
                f"/users/{emp.id}/reset-password",
                headers=_token(admin),
                json={"new_password": _VALID_PW},
            )

    assert resp.status_code == 200
    mock_set_pw.assert_awaited_once()
    call_kwargs = mock_set_pw.await_args.kwargs
    assert call_kwargs["sub"] == "auth0|emp123"
    assert call_kwargs["password"] == _VALID_PW


@pytest.mark.asyncio
async def test_auth0_not_called_for_user_without_sub(db_session, setup):
    """Legacy users without auth0_sub get local-only reset; Auth0 is never called."""
    admin = setup["admin"]
    legacy = setup["employee_no_sub"]  # auth0_sub=None

    mock_set_pw = AsyncMock()
    with _make_app(db_session) as client:
        with patch("app.services.auth0_mgmt.set_user_password", mock_set_pw):
            resp = client.post(
                f"/users/{legacy.id}/reset-password",
                headers=_token(admin),
                json={"new_password": _VALID_PW},
            )

    assert resp.status_code == 200
    mock_set_pw.assert_not_awaited()


@pytest.mark.asyncio
async def test_auth0_policy_rejection_returns_400_without_committing(db_session, setup):
    """If Auth0 rejects the password (policy violation), we must:
    - Return HTTP 400 to the caller
    - NOT commit the new local hash (partial-state safety)
    """
    from app.services.auth0_mgmt import Auth0MgmtError

    admin = setup["admin"]
    emp   = setup["employee"]

    original_hash = emp.hashed_password

    with _make_app(db_session) as client:
        with patch(
            "app.services.auth0_mgmt.set_user_password",
            side_effect=Auth0MgmtError("Password too weak", status_code=400),
        ):
            resp = client.post(
                f"/users/{emp.id}/reset-password",
                headers=_token(admin),
                json={"new_password": _VALID_PW},
            )

    assert resp.status_code == 400
    assert "weak" in resp.json()["detail"].lower() or "password" in resp.json()["detail"].lower()

    # Verify local hash was NOT changed.
    await db_session.refresh(emp)
    assert emp.hashed_password == original_hash


@pytest.mark.asyncio
async def test_auth0_unreachable_returns_400_without_committing(db_session, setup):
    """Network failure to Auth0 must surface as 400, not 500, and must not
    corrupt local state."""
    from app.services.auth0_mgmt import Auth0MgmtError

    admin = setup["admin"]
    emp   = setup["employee"]
    original_hash = emp.hashed_password

    with _make_app(db_session) as client:
        with patch(
            "app.services.auth0_mgmt.set_user_password",
            side_effect=Auth0MgmtError("Auth0 unreachable"),
        ):
            resp = client.post(
                f"/users/{emp.id}/reset-password",
                headers=_token(admin),
                json={"new_password": _VALID_PW},
            )

    assert resp.status_code == 400
    await db_session.refresh(emp)
    assert emp.hashed_password == original_hash


# ---------------------------------------------------------------------------
# State mutations after success
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_successful_reset_updates_hashed_password(db_session, setup):
    admin = setup["admin"]
    emp   = setup["employee"]
    old_hash = emp.hashed_password

    with _make_app(db_session) as client:
        with patch("app.services.auth0_mgmt.set_user_password", new_callable=AsyncMock):
            client.post(
                f"/users/{emp.id}/reset-password",
                headers=_token(admin),
                json={"new_password": _VALID_PW},
            )

    await db_session.refresh(emp)
    assert emp.hashed_password != old_hash
    assert verify_password(_VALID_PW, emp.hashed_password)


@pytest.mark.asyncio
async def test_successful_reset_flips_has_changed_password_to_false(db_session, setup):
    """After an admin reset the user should be forced to change password on next login."""
    admin = setup["admin"]
    emp   = setup["employee"]
    assert emp.has_changed_password is True  # was True before reset

    with _make_app(db_session) as client:
        with patch("app.services.auth0_mgmt.set_user_password", new_callable=AsyncMock):
            client.post(
                f"/users/{emp.id}/reset-password",
                headers=_token(admin),
                json={"new_password": _VALID_PW},
            )

    await db_session.refresh(emp)
    assert emp.has_changed_password is False


@pytest.mark.asyncio
async def test_local_only_reset_updates_password_hash(db_session, setup):
    """Legacy user (no auth0_sub): local hash must still be updated."""
    admin  = setup["admin"]
    legacy = setup["employee_no_sub"]
    old_hash = legacy.hashed_password

    with _make_app(db_session) as client:
        with patch("app.services.auth0_mgmt.set_user_password", new_callable=AsyncMock):
            resp = client.post(
                f"/users/{legacy.id}/reset-password",
                headers=_token(admin),
                json={"new_password": _VALID_PW},
            )

    assert resp.status_code == 200
    await db_session.refresh(legacy)
    assert legacy.hashed_password != old_hash
    assert verify_password(_VALID_PW, legacy.hashed_password)
