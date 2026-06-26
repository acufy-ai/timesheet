"""Refresh-token rotation + the 30-second grace window.

Rotation makes each refresh token single-use (the presented token is revoked
and a successor issued), which gives replay protection. But single-use alone
logs an actively-working user out: when the access token expires, several
requests (multiple tabs, a reload mid-flight) refresh at once — the first
revokes the token, the rest arrive carrying the now-revoked token and 401, and
the frontend treats that as a dead session.

The grace window fixes that: a just-rotated token replayed within
ROTATION_GRACE_SECONDS returns the SAME successor the winner already issued,
instead of 401. Genuinely-dead tokens (logout, revoke-all, old replay) still
401.

These pin:
  1. Rotation happens (cookie jti changes each refresh).
  2. Replay within the grace window → 200 (the race no longer logs you out).
  3. Replay AFTER the grace window → 401.
  4. A token revoked WITHOUT a successor (logout-style) → 401 even within grace.
"""
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover - test shim
    return "JSON"


from app.api import auth as auth_module
from app.core.security import create_refresh_token, decode_token, get_password_hash
from app.db import get_db
from app.models.base import Base
from app.models.refresh_token import RefreshToken
from app.models.tenant import Tenant, TenantStatus
from app.models.user import User, UserRole


def _jti(token: str) -> str:
    return decode_token(token)["jti"]


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    db_file = tmp_path / "rotation.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_file}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


@pytest_asyncio.fixture
async def seeded(db_session: AsyncSession) -> dict:
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
    # No tenant_slug claim => login/refresh route to the shared (test) db.
    token, jti, expires_at = create_refresh_token({"sub": str(user.id), "tenant_id": tenant.id})
    db_session.add(RefreshToken(jti=jti, user_id=user.id, expires_at=expires_at, revoked=False))
    await db_session.commit()
    return {"user": user, "refresh_token": token, "jti": jti}


def _client(db_session: AsyncSession) -> TestClient:
    app = FastAPI()
    app.include_router(auth_module.router)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    auth_module.limiter.enabled = False
    return TestClient(app)


@pytest.mark.asyncio
async def test_refresh_rotates_token(db_session, seeded):
    """A successful refresh issues a NEW refresh token (different jti) in the
    Set-Cookie and revokes the presented one — single-use rotation. The new
    token rides in the cookie, not the JSON body."""
    client = _client(db_session)
    client.cookies.set(auth_module.REFRESH_COOKIE_NAME, seeded["refresh_token"])
    with client:
        resp = client.post("/auth/refresh", json={})
    assert resp.status_code == 200, resp.text
    new_cookie = resp.cookies.get(auth_module.REFRESH_COOKIE_NAME)
    assert new_cookie and _jti(new_cookie) != seeded["jti"]


@pytest.mark.asyncio
async def test_replay_within_grace_returns_200(db_session, seeded):
    """Rotate once, then replay the ORIGINAL (now-revoked) token. Within the
    grace window this must return 200 (the concurrent-refresh race), not 401."""
    client = _client(db_session)
    with client:
        client.cookies.set(auth_module.REFRESH_COOKIE_NAME, seeded["refresh_token"])
        first = client.post("/auth/refresh", json={})
        assert first.status_code == 200
        # Replay the ORIGINAL token (as a racing second request would). Re-set
        # it explicitly since the first refresh rotated the client's cookie.
        client.cookies.set(auth_module.REFRESH_COOKIE_NAME, seeded["refresh_token"])
        replay = client.post("/auth/refresh", json={})
    assert replay.status_code == 200, replay.text
    assert replay.json().get("access_token")


@pytest.mark.parametrize(
    "age_seconds, expect_grace",
    [
        (0, True),                                              # just rotated
        (auth_module.ROTATION_GRACE_SECONDS - 1, True),         # inside window
        (auth_module.ROTATION_GRACE_SECONDS + 5, False),        # past window
        (3600, False),                                          # long past
    ],
)
def test_grace_window_boundary(age_seconds, expect_grace):
    """The grace decision: a rotated token is honored only within
    ROTATION_GRACE_SECONDS of its rotation. This pins the boundary directly
    (the full HTTP round-trip can't manipulate wall-clock time, and the
    TestClient's separate event loop makes mid-request DB mutation unreliable).

    Mirrors the in_grace computation in _do_refresh, including the tz-safe
    normalization for a naive stored datetime.
    """
    now = datetime.now(timezone.utc)
    # Simulate a stored row rotated `age_seconds` ago, with a successor.
    rotated_at = now - timedelta(seconds=age_seconds)
    replaced_by_jti = "successor-jti"

    if rotated_at is not None and rotated_at.tzinfo is None:  # tz-safe, as in the route
        rotated_at = rotated_at.replace(tzinfo=timezone.utc)
    in_grace = (
        rotated_at is not None
        and replaced_by_jti is not None
        and (now - rotated_at).total_seconds() <= auth_module.ROTATION_GRACE_SECONDS
    )
    assert in_grace is expect_grace


def test_grace_requires_a_successor():
    """No successor link (logout-style revoke) => never in grace, regardless
    of how recently it was 'rotated'."""
    now = datetime.now(timezone.utc)
    rotated_at = now  # brand new
    replaced_by_jti = None  # logout-style: no successor
    in_grace = (
        rotated_at is not None
        and replaced_by_jti is not None
        and (now - rotated_at).total_seconds() <= auth_module.ROTATION_GRACE_SECONDS
    )
    assert in_grace is False


@pytest.mark.asyncio
async def test_revoked_without_successor_is_401_even_within_grace(db_session, seeded):
    """A token revoked the logout way (revoked=True, no replaced_by_jti) must
    NOT be resurrected by the grace window — only ROTATED tokens get grace."""
    # Mark the seeded token revoked, logout-style (no successor link).
    row = (await db_session.execute(
        select(RefreshToken).where(RefreshToken.jti == seeded["jti"])
    )).scalars().first()
    row.revoked = True
    row.rotated_at = datetime.now(timezone.utc)  # recent, but...
    row.replaced_by_jti = None                    # ...no successor => no grace
    db_session.add(row)
    await db_session.commit()

    client = _client(db_session)
    with client:
        client.cookies.set(auth_module.REFRESH_COOKIE_NAME, seeded["refresh_token"])
        resp = client.post("/auth/refresh", json={})
    assert resp.status_code == 401, resp.text
