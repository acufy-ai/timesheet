"""Unit tests for ``_apply_alias_emails`` — the helper that turns CSV
``extra_email_*`` columns into ``user_email_aliases`` rows.

Pre-fix, the import flow had two related gaps:

1. The overwrite branch never called the alias-add logic at all, so
   re-importing a roster with new alias columns silently dropped them.
2. The create branch's alias check used ``get_user_by_email``, which
   considers the just-created user's own alias as "already owned"
   and skipped without warning. Confusing edges around own-aliases
   vs cross-user aliases.

The helper consolidates both branches and produces actionable
warnings instead of silent drops.
"""
from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover
    return "JSON"


from app.api.users import _apply_alias_emails
from app.core.security import get_password_hash
from app.models.base import Base
from app.models.tenant import Tenant, TenantStatus
from app.models.user import User, UserRole
from app.models.user_email_alias import UserEmailAlias


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'imp.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


async def _user(session, *, email, full_name="User", tenant_id) -> User:
    u = User(
        tenant_id=tenant_id,
        email=email,
        username=email.split("@")[0].replace(".", "-"),
        full_name=full_name,
        hashed_password=get_password_hash("password"),
        role=UserRole.EMPLOYEE,
        is_active=True,
        email_verified=True,
        has_changed_password=True,
    )
    session.add(u)
    await session.flush()
    return u


async def _aliases_for(session, user_id) -> list[str]:
    rows = await session.execute(
        select(UserEmailAlias.email).where(UserEmailAlias.user_id == user_id)
    )
    return sorted(row[0] for row in rows.all())


@pytest_asyncio.fixture
async def tenant_with_user(db_session):
    t = Tenant(name="T", slug="t", status=TenantStatus.active)
    db_session.add(t)
    await db_session.flush()
    user = await _user(db_session, email="alice@example.com", full_name="Alice", tenant_id=t.id)
    await db_session.commit()
    return {"tenant": t, "user": user}


# ─── happy path ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_adds_two_new_aliases_no_warnings(db_session, tenant_with_user):
    user = tenant_with_user["user"]
    warnings = await _apply_alias_emails(
        db_session, user, ["alice.work@example.com", "alice.personal@example.com"]
    )
    await db_session.commit()
    assert warnings == []
    assert await _aliases_for(db_session, user.id) == [
        "alice.personal@example.com",
        "alice.work@example.com",
    ]


@pytest.mark.asyncio
async def test_skips_alias_that_equals_primary_silently(db_session, tenant_with_user):
    """If a CSV row mistakenly puts the primary email in extra_email_1,
    it shouldn't bloat the alias table or warn the admin — silent
    no-op is right because it's typically a clerical accident."""
    user = tenant_with_user["user"]
    warnings = await _apply_alias_emails(
        db_session, user, ["alice@example.com", "alice.work@example.com"]
    )
    await db_session.commit()
    assert warnings == []
    assert await _aliases_for(db_session, user.id) == ["alice.work@example.com"]


@pytest.mark.asyncio
async def test_re_import_is_idempotent(db_session, tenant_with_user):
    """Running the helper twice with the same alias list produces one
    row, not duplicates. This is the "re-import roster after adding
    a column" scenario."""
    user = tenant_with_user["user"]
    await _apply_alias_emails(db_session, user, ["alice.work@example.com"])
    await db_session.commit()
    warnings = await _apply_alias_emails(db_session, user, ["alice.work@example.com"])
    await db_session.commit()
    assert warnings == []
    assert await _aliases_for(db_session, user.id) == ["alice.work@example.com"]


@pytest.mark.asyncio
async def test_normalizes_case_and_whitespace(db_session, tenant_with_user):
    user = tenant_with_user["user"]
    warnings = await _apply_alias_emails(
        db_session, user, ["  Alice.Work@Example.COM  ", "alice.personal@example.com"]
    )
    await db_session.commit()
    assert warnings == []
    assert await _aliases_for(db_session, user.id) == [
        "alice.personal@example.com",
        "alice.work@example.com",
    ]


@pytest.mark.asyncio
async def test_empty_input_is_a_noop(db_session, tenant_with_user):
    user = tenant_with_user["user"]
    warnings = await _apply_alias_emails(db_session, user, [])
    await db_session.commit()
    assert warnings == []
    assert await _aliases_for(db_session, user.id) == []


# ─── collision warning ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_warns_when_alias_belongs_to_another_user(db_session, tenant_with_user):
    """The interesting collision case: the alias already exists as
    another user's primary email. We must NOT silently take it over
    (it would make logins ambiguous). Skip + warn."""
    other = await _user(
        db_session,
        email="taken@example.com",
        full_name="Other",
        tenant_id=tenant_with_user["tenant"].id,
    )
    await db_session.commit()

    user = tenant_with_user["user"]
    warnings = await _apply_alias_emails(
        db_session, user, ["taken@example.com", "fresh@example.com"]
    )
    await db_session.commit()

    assert len(warnings) == 1
    assert "taken@example.com" in warnings[0]
    assert "another user" in warnings[0].lower()
    # The fresh alias still got through; collision skip is per-entry,
    # not all-or-nothing.
    assert await _aliases_for(db_session, user.id) == ["fresh@example.com"]
    # The other user was not touched.
    assert await _aliases_for(db_session, other.id) == []


@pytest.mark.asyncio
async def test_warns_when_alias_belongs_to_another_user_via_their_alias(
    db_session, tenant_with_user
):
    """Same shape but the collision is through the other user's
    *alias*, not their primary email. ``get_user_by_email`` already
    handles this — the helper just needs to honor its verdict."""
    other = await _user(
        db_session,
        email="other.primary@example.com",
        full_name="Other",
        tenant_id=tenant_with_user["tenant"].id,
    )
    db_session.add(UserEmailAlias(user_id=other.id, email="other.alias@example.com"))
    await db_session.commit()

    user = tenant_with_user["user"]
    warnings = await _apply_alias_emails(db_session, user, ["other.alias@example.com"])
    await db_session.commit()

    assert len(warnings) == 1
    assert "other.alias@example.com" in warnings[0]
    assert await _aliases_for(db_session, user.id) == []
    # Other user's existing alias is untouched.
    assert await _aliases_for(db_session, other.id) == ["other.alias@example.com"]
