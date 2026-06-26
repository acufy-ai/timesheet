"""Tenant-configurable access-token (sign-in session) length.

Covers the additive pieces of the feature without standing up the full
multi-DB login flow:

  * the ``access_token_expire_minutes`` catalog key exists with the expected
    shape (security category, enum of vetted minute values, default 30);
  * ``set_setting`` validates against the enum (rejects unsafe/odd values,
    accepts a vetted one) and the value round-trips via ``get_setting``;
  * ``create_access_token`` honors an ``expires_delta`` so a tenant override
    actually changes the issued token's ``exp`` (the effect the auth wiring
    relies on);
  * ``_access_expiry_for_tenant`` returns ``None`` when there is no tenant, so
    platform-admin tokens fall back to the global default.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover - test shim
    return "JSON"


from app.core.security import create_access_token, decode_token
from app.core.tenant_settings import get_setting, set_setting
from app.models.base import Base
from app.models.setting_definition import SettingDefinition
from app.seed_setting_definitions import CATALOG, seed_async

KEY = "access_token_expire_minutes"
TENANT_ID = 1
ACTOR_ID = 99


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'tokexp.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        await seed_async(session)
        await session.commit()
        yield session
    await engine.dispose()


def test_catalog_entry_shape():
    defn = CATALOG[KEY]
    assert defn["category"] == "security"
    assert defn["data_type"] == "int"
    assert defn["default_value"] == 30
    assert defn["validation"]["enum"] == [15, 30, 60, 120, 240, 480]
    # Not public: an unauthenticated/non-admin caller must not read it.
    assert defn["is_public"] is False


@pytest.mark.asyncio
async def test_default_is_30_when_unset(db_session: AsyncSession):
    assert await get_setting(db_session, TENANT_ID, KEY) == 30


@pytest.mark.asyncio
async def test_set_valid_value_round_trips(db_session: AsyncSession):
    await set_setting(db_session, TENANT_ID, KEY, 60, actor_id=ACTOR_ID)
    await db_session.commit()
    assert await get_setting(db_session, TENANT_ID, KEY) == 60


@pytest.mark.asyncio
async def test_rejects_value_outside_enum(db_session: AsyncSession):
    # 10080 minutes (= 7 days) is exactly the kind of unsafe value the preset
    # dropdown + enum guard exists to prevent.
    with pytest.raises(ValueError):
        await set_setting(db_session, TENANT_ID, KEY, 10080, actor_id=ACTOR_ID)
    # An in-range-but-not-vetted value is also rejected (enum, not min/max).
    with pytest.raises(ValueError):
        await set_setting(db_session, TENANT_ID, KEY, 45, actor_id=ACTOR_ID)


def test_create_access_token_honors_expires_delta():
    """The override only matters if expires_delta actually moves exp. A 60-min
    delta should land ~60 min out, clearly distinct from the 30-min default."""
    before = datetime.now(timezone.utc)
    token = create_access_token({"sub": "1"}, expires_delta=timedelta(minutes=60))
    payload = decode_token(token)
    assert payload is not None
    exp = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
    delta_min = (exp - before).total_seconds() / 60
    assert 59 <= delta_min <= 61


@pytest.mark.asyncio
async def test_access_expiry_helper_none_without_tenant():
    """Platform-admin tokens (no tenant slug / id) get None -> global default."""
    from app.api.auth import _access_expiry_for_tenant

    assert await _access_expiry_for_tenant(None, None) is None
    assert await _access_expiry_for_tenant(None, 5) is None
    assert await _access_expiry_for_tenant("some-slug", None) is None
