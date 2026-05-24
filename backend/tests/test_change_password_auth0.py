"""Tests for the change-password endpoint's Auth0 vs bcrypt dispatch.

Both ``POST /auth/change-password`` (the self-service form) and
``POST /users/me/password`` (the post-verification first-password
set) need to:

- For users with ``auth0_sub`` set, verify the current password via
  Auth0's password-realm grant and PATCH the new password through
  the Management API. Local hash is never compared.
- For users without ``auth0_sub`` (legacy bcrypt), verify against
  the local hash and write the new hash locally.

These tests monkeypatch the two Auth0 helpers so the dispatch can
be exercised without touching the network.
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


from app.api import auth as auth_api
from app.api import users as users_api
from app.core.deps import get_tenant_db
from app.core.security import (
    Auth0PasswordError,
    create_access_token,
    get_password_hash,
)
from app.db import get_db
from app.models.base import Base
from app.models.tenant import Tenant, TenantStatus
from app.models.user import User, UserRole


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'cp.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


def _make_app(db_session: AsyncSession) -> TestClient:
    app = FastAPI()
    app.include_router(auth_api.router)
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
async def bcrypt_user(db_session: AsyncSession) -> User:
    tenant = Tenant(name="T", slug="t", status=TenantStatus.active)
    db_session.add(tenant)
    await db_session.flush()
    u = User(
        tenant_id=tenant.id,
        email="legacy@t.io",
        username="legacy",
        full_name="Legacy User",
        hashed_password=get_password_hash("OldPass!1"),
        role=UserRole.EMPLOYEE,
        is_active=True,
        email_verified=True,
        has_changed_password=True,
        auth0_sub=None,  # bcrypt-only
    )
    db_session.add(u)
    await db_session.commit()
    return u


@pytest_asyncio.fixture
async def auth0_user(db_session: AsyncSession) -> User:
    tenant = Tenant(name="T2", slug="t2", status=TenantStatus.active)
    db_session.add(tenant)
    await db_session.flush()
    u = User(
        tenant_id=tenant.id,
        email="auth0@t2.io",
        username="auth0",
        full_name="Auth0 User",
        # The local hash for an Auth0 user is intentionally stale.
        # bcrypt verification against it must NEVER succeed for the
        # Auth0 code path.
        hashed_password=get_password_hash("STALE_BCRYPT_HASH_NEVER_USED"),
        role=UserRole.EMPLOYEE,
        is_active=True,
        email_verified=True,
        has_changed_password=True,
        auth0_sub="auth0|abc123",
    )
    db_session.add(u)
    await db_session.commit()
    return u


# ─── /auth/change-password ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bcrypt_user_legacy_path_unchanged(db_session, bcrypt_user):
    """Legacy user without auth0_sub: bcrypt verify + bcrypt write,
    Auth0 helpers untouched."""
    with _make_app(db_session) as client:
        # wrong current password -> 401
        wrong = client.post(
            "/auth/change-password",
            json={"current_password": "Nope!", "new_password": "BrandNew@9x"},
            headers=_auth(bcrypt_user),
        )
        assert wrong.status_code == 401, wrong.text
        assert "incorrect" in wrong.json()["detail"].lower()

        # correct current password -> 200, local hash updated
        ok = client.post(
            "/auth/change-password",
            json={"current_password": "OldPass!1", "new_password": "BrandNew@9x"},
            headers=_auth(bcrypt_user),
        )
        assert ok.status_code == 200, ok.text


@pytest.mark.asyncio
async def test_auth0_user_proxies_through_management_api(db_session, auth0_user, monkeypatch):
    """Auth0 user: current password verified via password-realm grant,
    new password pushed via Management API. Local bcrypt hash on the
    user is irrelevant — we deliberately seeded it with a value that
    never matches."""
    grant_calls: list[tuple[str, str]] = []
    set_calls: list[dict] = []

    async def fake_grant(email: str, password: str) -> str:
        grant_calls.append((email, password))
        return "fake-access-token"

    async def fake_set(*, sub: str, password: str, mark_email_verified: bool = True) -> None:
        set_calls.append({"sub": sub, "password": password})

    monkeypatch.setattr("app.api.auth.auth0_password_grant", fake_grant)
    monkeypatch.setattr("app.services.auth0_mgmt.set_user_password", fake_set)

    with _make_app(db_session) as client:
        ok = client.post(
            "/auth/change-password",
            json={"current_password": "RealAuth0Pass!", "new_password": "BrandNew@9x"},
            headers=_auth(auth0_user),
        )
        assert ok.status_code == 200, ok.text

    assert grant_calls == [("auth0@t2.io", "RealAuth0Pass!")]
    assert len(set_calls) == 1
    assert set_calls[0]["sub"] == "auth0|abc123"
    assert set_calls[0]["password"] == "BrandNew@9x"


@pytest.mark.asyncio
async def test_auth0_user_wrong_current_password_returns_401(db_session, auth0_user, monkeypatch):
    """Auth0 returns ``invalid_grant`` for wrong passwords; the
    endpoint must translate that to 401 with the same UX text as
    the bcrypt path."""

    async def fake_grant(email: str, password: str) -> str:
        raise Auth0PasswordError("invalid grant", code="invalid_grant")

    monkeypatch.setattr("app.api.auth.auth0_password_grant", fake_grant)

    with _make_app(db_session) as client:
        resp = client.post(
            "/auth/change-password",
            json={"current_password": "WrongAuth0Pass!", "new_password": "BrandNew@9x"},
            headers=_auth(auth0_user),
        )
    assert resp.status_code == 401
    assert "incorrect" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_auth0_user_unreachable_returns_503_not_fallback(db_session, auth0_user, monkeypatch):
    """When Auth0 is unreachable we must NOT silently fall back to
    the stale local bcrypt hash. The whole point of the proxy is
    that the local hash isn't authoritative. Surface 503 instead."""

    async def fake_grant(email: str, password: str) -> str:
        raise Auth0PasswordError("Auth0 unreachable")  # no code

    monkeypatch.setattr("app.api.auth.auth0_password_grant", fake_grant)

    with _make_app(db_session) as client:
        resp = client.post(
            "/auth/change-password",
            json={"current_password": "RealAuth0Pass!", "new_password": "BrandNew@9x"},
            headers=_auth(auth0_user),
        )
    assert resp.status_code == 503
    assert "unreachable" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_auth0_set_password_rejected_surfaces_as_400(db_session, auth0_user, monkeypatch):
    """Auth0 may reject the new password (too weak per the
    connection's policy). Surface the policy text as 400 so the
    user can fix it."""
    async def fake_grant(email: str, password: str) -> str:
        return "fake-access-token"

    async def fake_set(*, sub: str, password: str, mark_email_verified: bool = True) -> None:
        from app.services.auth0_mgmt import Auth0MgmtError
        raise Auth0MgmtError(
            "Password contained a user identifier (e.g. email or name).",
            code="PasswordStrengthError",
        )

    monkeypatch.setattr("app.api.auth.auth0_password_grant", fake_grant)
    monkeypatch.setattr("app.services.auth0_mgmt.set_user_password", fake_set)

    with _make_app(db_session) as client:
        resp = client.post(
            "/auth/change-password",
            json={"current_password": "RealAuth0Pass!", "new_password": "auth0@t2.io"},  # weak
            headers=_auth(auth0_user),
        )
    assert resp.status_code == 400
    assert "password" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_auth0_user_local_hash_is_replaced_with_throwaway(db_session, auth0_user, monkeypatch):
    """After a successful Auth0 password change, the local hash must
    no longer match the bcrypt of any known password. This is the
    security property: a future Auth0-disabled fallback can't reuse
    the stale value."""
    from app.core.security import verify_password

    async def fake_grant(email: str, password: str) -> str:
        return "fake-access-token"

    async def fake_set(*, sub: str, password: str, mark_email_verified: bool = True) -> None:
        return None

    monkeypatch.setattr("app.api.auth.auth0_password_grant", fake_grant)
    monkeypatch.setattr("app.services.auth0_mgmt.set_user_password", fake_set)

    original_hash = auth0_user.hashed_password

    with _make_app(db_session) as client:
        ok = client.post(
            "/auth/change-password",
            json={"current_password": "RealAuth0Pass!", "new_password": "BrandNew@9x"},
            headers=_auth(auth0_user),
        )
        assert ok.status_code == 200

    await db_session.refresh(auth0_user)
    assert auth0_user.hashed_password != original_hash
    # Neither the new nor the old plaintext should validate against
    # the throwaway.
    assert not verify_password("BrandNew@9x", auth0_user.hashed_password)
    assert not verify_password("RealAuth0Pass!", auth0_user.hashed_password)
