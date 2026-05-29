"""
Regression test: POST /auth/refresh with an empty body ({}) must NOT
return 422.

The HttpOnly refresh-token cookie rollout left the frontend sending
``{}`` as request body when sessionStorage has no legacy token. The
backend's body model used to be ``refresh_token: str`` (required),
which caused FastAPI to 422 on the empty body BEFORE the route's
cookie-fallback logic ran. The user-visible effect was a logout after
the access token expired (~15 minutes), because every refresh attempt
422'd and the axios interceptor force-logged-out.

Pinning two shapes:
  1. Empty body + cookie containing a valid refresh token → 200
  2. Empty body + no cookie → 401 (clean "no token") not 422
"""
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

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
from app.core.security import create_refresh_token, get_password_hash
from app.db import get_db
from app.models.base import Base
from app.models.refresh_token import RefreshToken
from app.models.tenant import Tenant, TenantStatus
from app.models.user import User, UserRole


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    db_file = tmp_path / "auth_refresh.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_file}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    await engine.dispose()


@pytest_asyncio.fixture
async def seeded_user(db_session: AsyncSession) -> dict:
    tenant = Tenant(name="T", slug="t", status=TenantStatus.active)
    db_session.add(tenant)
    await db_session.flush()
    user = User(
        tenant_id=tenant.id, email="u@t.example", username="user01", full_name="User",
        hashed_password=get_password_hash("password"), role=UserRole.EMPLOYEE,
        is_active=True, has_changed_password=True, email_verified=True,
    )
    db_session.add(user)
    await db_session.flush()

    # Mint a refresh token and persist its jti row, matching what login does.
    token, jti, expires_at = create_refresh_token({"sub": str(user.id), "tenant_id": tenant.id})
    rt = RefreshToken(
        jti=jti,
        user_id=user.id,
        expires_at=expires_at,
        revoked=False,
    )
    db_session.add(rt)
    await db_session.commit()
    return {"tenant": tenant, "user": user, "refresh_token": token}


def _make_app(db_session: AsyncSession) -> TestClient:
    app = FastAPI()
    app.include_router(auth_module.router)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    # Disable rate limiting in tests — the limiter sometimes 429s on
    # rapid back-to-back calls and would mask the real validation we
    # care about here.
    auth_module.limiter.enabled = False
    return TestClient(app)


@pytest.mark.asyncio
async def test_refresh_with_empty_body_and_cookie_returns_200(
    db_session: AsyncSession, seeded_user: dict
):
    """The rollout case: client sends ``{}`` body but has the cookie set.
    Must NOT 422; must use the cookie path and return 200."""
    client = _make_app(db_session)
    with client:
        resp = client.post(
            "/auth/refresh",
            json={},  # empty body, exactly what the frontend sends post-rollout
            cookies={auth_module.REFRESH_COOKIE_NAME: seeded_user["refresh_token"]},
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "access_token" in body
    assert "refresh_token" in body


@pytest.mark.asyncio
async def test_refresh_with_empty_body_and_no_cookie_returns_401_not_422(
    db_session: AsyncSession, seeded_user: dict
):
    """No cookie, empty body → clean 401, not 422.

    Either status would log the user out client-side, but 422 means
    we're failing at body validation BEFORE the route runs (the bug
    that caused the 15-min logout). 401 is the correct ``no creds``
    response that the route itself returns.
    """
    client = _make_app(db_session)
    with client:
        resp = client.post("/auth/refresh", json={})
    assert resp.status_code == 401, resp.text


@pytest.mark.asyncio
async def test_refresh_with_legacy_body_token_still_works(
    db_session: AsyncSession, seeded_user: dict
):
    """Backwards compat: pre-rollout clients send the token in the body.
    That path must still work so old tabs survive the rollout."""
    client = _make_app(db_session)
    with client:
        resp = client.post(
            "/auth/refresh",
            json={"refresh_token": seeded_user["refresh_token"]},
        )
    assert resp.status_code == 200, resp.text
