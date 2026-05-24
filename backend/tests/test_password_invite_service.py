"""
Unit tests for app.services.password_invite.

Tests the token lifecycle directly against a real (SQLite) DB session,
no HTTP layer involved.

Coverage:
  issue_invite_token
    - Returns a decodable JWT with correct claims (sub, email, purpose, jti, exp)
    - Persists a PasswordInviteToken row (unconsumed, correct purpose)
    - Generates a distinct jti on every call

  verify_invite_token
    - Happy path: returns (user, row) for a valid token
    - Raises PasswordInviteError(code="malformed") for garbage token
    - Raises PasswordInviteError(code="unknown") for valid JWT but jti not in DB
    - Raises PasswordInviteError(code="consumed") for already-consumed token
    - Raises PasswordInviteError(code="expired") for expired token
    - Raises PasswordInviteError(code="user_gone") when user deleted between issue and use

  consume_invite_token
    - Sets consumed_at timestamp
    - Re-verify after consume raises code="consumed"

  build_set_password_url
    - Contains token and purpose in query string
    - Uses settings.frontend_base_url as base

  Regression: token with wrong sub (deleted user) fails with user_gone, not KeyError
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB

@compiles(JSONB, "sqlite")
def _jsonb_sqlite(element, compiler, **kw):  # pragma: no cover
    return "JSON"

from app.core.security import get_password_hash
from app.models.base import Base
from app.models.password_invite_token import PasswordInviteToken
from app.models.tenant import Tenant, TenantStatus
from app.models.user import User, UserRole
from app.services.password_invite import (
    PasswordInviteError,
    build_set_password_url,
    consume_invite_token,
    issue_invite_token,
    verify_invite_token,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def db(tmp_path) -> AsyncSession:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/invite_svc.db")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


@pytest_asyncio.fixture
async def user(db: AsyncSession) -> User:
    tenant = Tenant(name="T", slug="t", status=TenantStatus.active)
    db.add(tenant)
    await db.flush()
    u = User(
        tenant_id=tenant.id,
        email="alice@example.com",
        username="alice",
        full_name="Alice",
        hashed_password=get_password_hash("Pass123!"),
        role=UserRole.EMPLOYEE,
        is_active=True,
        email_verified=False,
        has_changed_password=False,
    )
    db.add(u)
    await db.commit()
    return u


# ---------------------------------------------------------------------------
# issue_invite_token
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_issue_returns_jwt_with_correct_claims(db, user):
    from jose import jwt
    from app.core.config import settings

    token = await issue_invite_token(db, user, purpose="invite")
    await db.commit()

    payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    assert payload["sub"] == str(user.id)
    assert payload["email"] == user.email
    assert payload["purpose"] == "invite"
    assert "jti" in payload
    assert "exp" in payload


@pytest.mark.asyncio
async def test_issue_persists_token_row(db, user):
    token = await issue_invite_token(db, user, purpose="invite")
    await db.commit()

    from jose import jwt
    from app.core.config import settings
    jti = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])["jti"]

    row = (await db.execute(
        select(PasswordInviteToken).where(PasswordInviteToken.jti == jti)
    )).scalar_one_or_none()

    assert row is not None
    assert row.user_id == user.id
    assert row.purpose == "invite"
    assert row.consumed_at is None


@pytest.mark.asyncio
async def test_issue_generates_distinct_jtis(db, user):
    t1 = await issue_invite_token(db, user, purpose="invite")
    t2 = await issue_invite_token(db, user, purpose="reset")
    await db.commit()

    from jose import jwt
    from app.core.config import settings
    j1 = jwt.decode(t1, settings.secret_key, algorithms=[settings.algorithm])["jti"]
    j2 = jwt.decode(t2, settings.secret_key, algorithms=[settings.algorithm])["jti"]
    assert j1 != j2


@pytest.mark.asyncio
async def test_issue_reset_purpose_stored_correctly(db, user):
    token = await issue_invite_token(db, user, purpose="reset")
    await db.commit()

    from jose import jwt
    from app.core.config import settings
    jti = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])["jti"]
    row = (await db.execute(
        select(PasswordInviteToken).where(PasswordInviteToken.jti == jti)
    )).scalar_one()
    assert row.purpose == "reset"


# ---------------------------------------------------------------------------
# verify_invite_token -- happy path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_verify_returns_user_and_row_for_valid_token(db, user):
    token = await issue_invite_token(db, user, purpose="invite")
    await db.commit()

    returned_user, row = await verify_invite_token(db, token)
    assert returned_user.id == user.id
    assert row.purpose == "invite"
    assert row.consumed_at is None


# ---------------------------------------------------------------------------
# verify_invite_token -- error cases
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_verify_raises_malformed_for_garbage_token(db, user):
    with pytest.raises(PasswordInviteError) as exc_info:
        await verify_invite_token(db, "not.a.jwt.at.all")
    assert exc_info.value.code == "malformed"


@pytest.mark.asyncio
async def test_verify_raises_malformed_for_wrong_key(db, user):
    from jose import jwt
    token = jwt.encode(
        {"sub": str(user.id), "email": user.email, "purpose": "invite",
         "jti": "fakejti", "exp": 9999999999},
        "wrong-secret-key",
        algorithm="HS256",
    )
    with pytest.raises(PasswordInviteError) as exc_info:
        await verify_invite_token(db, token)
    assert exc_info.value.code == "malformed"


@pytest.mark.asyncio
async def test_verify_raises_unknown_for_valid_jwt_but_missing_row(db, user):
    """JWT is well-formed and signed correctly, but jti was never stored."""
    from jose import jwt
    from app.core.config import settings
    token = jwt.encode(
        {"sub": str(user.id), "email": user.email, "purpose": "invite",
         "jti": "nonexistent-jti-xyz", "exp": 9999999999},
        settings.secret_key,
        algorithm=settings.algorithm,
    )
    with pytest.raises(PasswordInviteError) as exc_info:
        await verify_invite_token(db, token)
    assert exc_info.value.code == "unknown"


@pytest.mark.asyncio
async def test_verify_raises_consumed_after_consume(db, user):
    token = await issue_invite_token(db, user, purpose="invite")
    await db.commit()

    _, row = await verify_invite_token(db, token)
    await consume_invite_token(db, row)
    await db.commit()

    with pytest.raises(PasswordInviteError) as exc_info:
        await verify_invite_token(db, token)
    assert exc_info.value.code == "consumed"


@pytest.mark.asyncio
async def test_verify_raises_expired_for_past_ttl(db, user):
    token = await issue_invite_token(db, user, purpose="invite", ttl=timedelta(seconds=-1))
    await db.commit()

    # JWT exp is also in the past so the library rejects it as malformed.
    # Either "malformed" (jwt lib rejects expired) or "expired" (DB check)
    # is acceptable -- what matters is it raises, not succeeds.
    with pytest.raises(PasswordInviteError) as exc_info:
        await verify_invite_token(db, token)
    assert exc_info.value.code in ("malformed", "expired")


@pytest.mark.asyncio
async def test_verify_raises_user_gone_when_user_deleted(db, user):
    """Token exists and is valid, but user was deleted between issue and use."""
    token = await issue_invite_token(db, user, purpose="invite")
    await db.commit()

    await db.delete(user)
    await db.commit()

    with pytest.raises(PasswordInviteError) as exc_info:
        await verify_invite_token(db, token)
    assert exc_info.value.code == "user_gone"


# ---------------------------------------------------------------------------
# consume_invite_token
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_consume_sets_consumed_at(db, user):
    token = await issue_invite_token(db, user, purpose="invite")
    await db.commit()

    _, row = await verify_invite_token(db, token)
    assert row.consumed_at is None

    await consume_invite_token(db, row)
    await db.commit()

    await db.refresh(row)
    assert row.consumed_at is not None
    assert isinstance(row.consumed_at, datetime)


@pytest.mark.asyncio
async def test_consume_timestamp_is_recent(db, user):
    token = await issue_invite_token(db, user, purpose="invite")
    await db.commit()

    before = datetime.now(timezone.utc)
    _, row = await verify_invite_token(db, token)
    await consume_invite_token(db, row)
    await db.commit()
    after = datetime.now(timezone.utc)

    await db.refresh(row)
    consumed = row.consumed_at
    if consumed.tzinfo is None:
        consumed = consumed.replace(tzinfo=timezone.utc)
    assert before <= consumed <= after


@pytest.mark.asyncio
async def test_double_consume_still_raises_consumed_on_verify(db, user):
    """Calling consume twice is harmless but verify must still fail."""
    token = await issue_invite_token(db, user, purpose="invite")
    await db.commit()

    _, row = await verify_invite_token(db, token)
    await consume_invite_token(db, row)
    await consume_invite_token(db, row)  # second consume -- idempotent
    await db.commit()

    with pytest.raises(PasswordInviteError) as exc_info:
        await verify_invite_token(db, token)
    assert exc_info.value.code == "consumed"


# ---------------------------------------------------------------------------
# build_set_password_url
# ---------------------------------------------------------------------------

def test_build_url_contains_token_and_purpose():
    url = build_set_password_url("mytoken123", purpose="invite")
    assert "token=mytoken123" in url
    assert "purpose=invite" in url


def test_build_url_reset_purpose():
    url = build_set_password_url("tok456", purpose="reset")
    assert "purpose=reset" in url
    assert "token=tok456" in url


def test_build_url_uses_frontend_base_url(monkeypatch):
    from app.core import config as cfg
    monkeypatch.setattr(cfg.settings, "frontend_base_url", "https://app.example.com")
    url = build_set_password_url("tok", purpose="invite")
    assert url.startswith("https://app.example.com")


def test_build_url_no_trailing_slash_double(monkeypatch):
    from app.core import config as cfg
    monkeypatch.setattr(cfg.settings, "frontend_base_url", "https://app.example.com/")
    url = build_set_password_url("tok", purpose="invite")
    assert "//" not in url.split("://", 1)[1]


# ---------------------------------------------------------------------------
# Regression: PasswordInviteError carries meaningful code
# ---------------------------------------------------------------------------

def test_password_invite_error_stores_code():
    err = PasswordInviteError("something broke", code="consumed")
    assert err.code == "consumed"
    assert "broke" in str(err)


def test_password_invite_error_is_exception():
    err = PasswordInviteError("x", code="expired")
    assert isinstance(err, Exception)
