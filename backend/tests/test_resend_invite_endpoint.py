"""
Regression + integration tests for POST /users/{user_id}/resend-invite.

Coverage matrix:
  Access control
    - Non-admin (EMPLOYEE, MANAGER, VIEWER) → 403
    - Admin within own tenant → 200
    - Admin cannot resend invite to user in other tenant → 403
    - PLATFORM_ADMIN can resend invite cross-tenant → 200

  Guard conditions (all must return 400)
    - Inactive user
    - External user (is_external=True)
    - User with @local.invalid placeholder email
    - User without auth0_sub (not Auth0-provisioned) → 400 with descriptive message

  Happy path
    - Active, internal, Auth0-provisioned user → 200
    - invite email is sent exactly once
    - A PasswordInviteToken row is persisted in the DB
    - Resending a second time issues a fresh token (old one is now redundant but not consumed)

  Regression: external employees must not see resend-invite option
    - Confirmed by 400 guard in backend (frontend hides it too, but belt-and-suspenders)
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB

@compiles(JSONB, "sqlite")
def _jsonb_sqlite(element, compiler, **kw):  # pragma: no cover
    return "JSON"

from app.api import users as users_api
from app.core.security import create_access_token, get_password_hash
from app.core.deps import get_tenant_db
from app.db import get_db
from app.models.base import Base
from app.models.password_invite_token import PasswordInviteToken
from app.models.tenant import Tenant, TenantStatus
from app.models.user import User, UserRole


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/resend_invite.db")
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
    auth0_sub: str | None = "auth0|default",
    is_active: bool = True,
    is_external: bool = False,
    email_verified: bool = False,
) -> User:
    u = User(
        tenant_id=tenant.id if tenant else None,
        email=email,
        username=email.replace("@", "-at-").replace(".", "-"),
        full_name=email,
        hashed_password=get_password_hash("Pass123!"),
        role=role,
        is_active=is_active,
        is_external=is_external,
        email_verified=email_verified,
        has_changed_password=False,
        auth0_sub=auth0_sub,
    )
    session.add(u)
    await session.flush()
    return u


# Patch targets used throughout
_SMTP  = patch("app.api.platform_settings.get_effective_smtp_config", new_callable=AsyncMock, return_value=None)
_EMAIL = patch("app.services.email_verification.send_local_invitation_email", new_callable=AsyncMock)


@pytest_asyncio.fixture
async def setup(db_session: AsyncSession) -> dict:
    t1 = Tenant(name="Alpha", slug="alpha", status=TenantStatus.active)
    t2 = Tenant(name="Beta",  slug="beta",  status=TenantStatus.active)
    db_session.add_all([t1, t2])
    await db_session.flush()

    admin    = await _make_user(db_session, tenant=t1, role=UserRole.ADMIN,
                                email="admin@alpha.io", email_verified=True,
                                auth0_sub="auth0|admin")
    emp      = await _make_user(db_session, tenant=t1, email="emp@alpha.io",
                                auth0_sub="auth0|emp1")
    inactive = await _make_user(db_session, tenant=t1, email="off@alpha.io",
                                is_active=False, auth0_sub="auth0|off1")
    external = await _make_user(db_session, tenant=t1, email="ext@alpha.io",
                                is_external=True, auth0_sub="auth0|ext1")
    no_sub   = await _make_user(db_session, tenant=t1, email="legacy@alpha.io",
                                auth0_sub=None)
    placeholder = await _make_user(db_session, tenant=t1,
                                   email="noemail@local.invalid", auth0_sub="auth0|ph1")
    cross    = await _make_user(db_session, tenant=t2, email="cross@beta.io",
                                auth0_sub="auth0|cross1")
    pa       = await _make_user(db_session, tenant=None, role=UserRole.PLATFORM_ADMIN,
                                email="pa@platform.io", auth0_sub="auth0|pa1",
                                email_verified=True)
    manager  = await _make_user(db_session, tenant=t1, role=UserRole.MANAGER,
                                email="mgr@alpha.io", auth0_sub="auth0|mgr1",
                                email_verified=True)
    viewer   = await _make_user(db_session, tenant=t1, role=UserRole.VIEWER,
                                email="vw@alpha.io",  auth0_sub="auth0|vw1",
                                email_verified=True)

    await db_session.commit()
    return dict(
        t1=t1, t2=t2,
        admin=admin, emp=emp, inactive=inactive, external=external,
        no_sub=no_sub, placeholder=placeholder, cross=cross,
        pa=pa, manager=manager, viewer=viewer,
    )


# ---------------------------------------------------------------------------
# Access control
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("role_key", ["manager", "viewer"])
@pytest.mark.asyncio
async def test_non_admin_cannot_resend_invite(db_session, setup, role_key):
    actor = setup[role_key]
    target = setup["emp"]
    with _make_app(db_session) as client, _SMTP, _EMAIL:
        resp = client.post(f"/users/{target.id}/resend-invite", headers=_token(actor))
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_employee_cannot_resend_invite(db_session, setup):
    emp = setup["emp"]
    with _make_app(db_session) as client, _SMTP, _EMAIL:
        resp = client.post(f"/users/{emp.id}/resend-invite", headers=_token(emp))
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_admin_cannot_resend_invite_cross_tenant(db_session, setup):
    admin = setup["admin"]
    cross = setup["cross"]
    with _make_app(db_session) as client, _SMTP, _EMAIL:
        resp = client.post(f"/users/{cross.id}/resend-invite", headers=_token(admin))
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_platform_admin_can_resend_invite_cross_tenant(db_session, setup):
    pa    = setup["pa"]
    cross = setup["cross"]
    with _make_app(db_session) as client, _SMTP, _EMAIL:
        resp = client.post(f"/users/{cross.id}/resend-invite", headers=_token(pa))
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Guard conditions
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_resend_invite_rejected_for_inactive_user(db_session, setup):
    admin    = setup["admin"]
    inactive = setup["inactive"]
    with _make_app(db_session) as client, _SMTP, _EMAIL:
        resp = client.post(f"/users/{inactive.id}/resend-invite", headers=_token(admin))
    assert resp.status_code == 400
    assert "inactive" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_resend_invite_rejected_for_external_user(db_session, setup):
    """External employees cannot log in -- sending them an invite makes no sense."""
    admin    = setup["admin"]
    external = setup["external"]
    with _make_app(db_session) as client, _SMTP, _EMAIL:
        resp = client.post(f"/users/{external.id}/resend-invite", headers=_token(admin))
    assert resp.status_code == 400
    assert "external" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_resend_invite_rejected_for_placeholder_email(db_session, setup):
    admin       = setup["admin"]
    placeholder = setup["placeholder"]
    with _make_app(db_session) as client, _SMTP, _EMAIL:
        resp = client.post(f"/users/{placeholder.id}/resend-invite", headers=_token(admin))
    assert resp.status_code == 400
    assert "email" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_resend_invite_rejected_without_auth0_sub(db_session, setup):
    """User not yet provisioned in Auth0 must get a descriptive 400, not a silent failure."""
    admin  = setup["admin"]
    no_sub = setup["no_sub"]
    with _make_app(db_session) as client, _SMTP, _EMAIL:
        resp = client.post(f"/users/{no_sub.id}/resend-invite", headers=_token(admin))
    assert resp.status_code == 400
    # Must tell the admin to use resend-verification instead
    detail = resp.json()["detail"].lower()
    assert "auth0" in detail or "provisioned" in detail or "verification" in detail


@pytest.mark.asyncio
async def test_resend_invite_404_for_unknown_user(db_session, setup):
    admin = setup["admin"]
    with _make_app(db_session) as client, _SMTP, _EMAIL:
        resp = client.post("/users/99999/resend-invite", headers=_token(admin))
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_resend_invite_returns_200_and_sends_email(db_session, setup):
    admin    = setup["admin"]
    emp      = setup["emp"]
    mock_send = AsyncMock()
    with _make_app(db_session) as client, _SMTP:
        with patch("app.services.email_verification.send_local_invitation_email", mock_send):
            resp = client.post(f"/users/{emp.id}/resend-invite", headers=_token(admin))

    assert resp.status_code == 200
    assert emp.email in resp.json()["message"]
    mock_send.assert_awaited_once()


@pytest.mark.asyncio
async def test_resend_invite_persists_token_in_db(db_session, setup):
    """A PasswordInviteToken row must be created so the one-time-use check works."""
    admin = setup["admin"]
    emp   = setup["emp"]

    with _make_app(db_session) as client, _SMTP, _EMAIL:
        resp = client.post(f"/users/{emp.id}/resend-invite", headers=_token(admin))

    assert resp.status_code == 200
    rows = (await db_session.execute(
        select(PasswordInviteToken).where(PasswordInviteToken.user_id == emp.id)
    )).scalars().all()
    assert len(rows) >= 1
    row = rows[-1]
    assert row.purpose == "invite"
    assert row.consumed_at is None


@pytest.mark.asyncio
async def test_resend_invite_twice_creates_fresh_token(db_session, setup):
    """Each resend issues a new JTI. Both tokens exist; neither is consumed."""
    admin = setup["admin"]
    emp   = setup["emp"]

    with _make_app(db_session) as client, _SMTP, _EMAIL:
        client.post(f"/users/{emp.id}/resend-invite", headers=_token(admin))
        client.post(f"/users/{emp.id}/resend-invite", headers=_token(admin))

    rows = (await db_session.execute(
        select(PasswordInviteToken).where(PasswordInviteToken.user_id == emp.id)
    )).scalars().all()
    assert len(rows) == 2
    jtis = {r.jti for r in rows}
    assert len(jtis) == 2  # distinct tokens


@pytest.mark.asyncio
async def test_resend_invite_send_called_with_correct_user(db_session, setup):
    """The invite email must be addressed to the target user, not the admin."""
    admin     = setup["admin"]
    emp       = setup["emp"]
    mock_send = AsyncMock()

    with _make_app(db_session) as client, _SMTP:
        with patch("app.services.email_verification.send_local_invitation_email", mock_send):
            client.post(f"/users/{emp.id}/resend-invite", headers=_token(admin))

    called_user = mock_send.await_args.args[0]
    assert called_user.id == emp.id
    assert called_user.email == emp.email
