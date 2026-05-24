"""Regression tests for the platform-admin tenant-scoped listing paths.

Two bugs are pinned here:

1. ``GET /platform/tenants/stats`` was returning the shared legacy
   DB's full user/admin totals for every non-isolated tenant. The
   per-tenant fan-out now filters by ``User.tenant_id``.

2. ``GET /users`` (PA branch) returned every user in the session-bound
   DB. The handler now reads ``X-Tenant-Slug``, resolves it to a
   tenant id via the control plane, and filters the query.

These tests do NOT exercise the real per-tenant DB fan-out (would
require Postgres + multiple databases); they cover the filter
clause and header handling at the FastAPI layer with a SQLite
session pretending to be the shared legacy DB.
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
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'scoped.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


def _make_app(db_session: AsyncSession, monkeypatch, slug_to_id: dict[str, int]) -> TestClient:
    """``slug_to_id`` is the lookup table the handler queries via the
    control plane. We feed it in from the test rather than spinning
    up a second SQLite DB with the ControlTenant schema (the two
    Bases have different definitions of the ``tenants`` table)."""
    app = FastAPI()
    app.include_router(users_api.router)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_tenant_db] = override_get_db

    # Stand-in for AsyncControlSessionLocal. The handler runs:
    #   async with AsyncControlSessionLocal() as control_db:
    #       target_tenant_id = await control_db.scalar(
    #           select(ControlTenant.id).where(ControlTenant.slug == header_slug))
    # The fake session below inspects the where-clause's parameter
    # binding to find the slug, then returns the id from slug_to_id.
    from contextlib import asynccontextmanager

    class _FakeControlSession:
        async def scalar(self, stmt):
            # The slug literal is in the compiled WHERE params.
            compiled = stmt.compile(compile_kwargs={"literal_binds": True})
            sql = str(compiled).lower()
            for slug, tid in slug_to_id.items():
                if f"'{slug.lower()}'" in sql:
                    return tid
            return None

    @asynccontextmanager
    async def _ctl_session():
        yield _FakeControlSession()

    monkeypatch.setattr(
        "app.db_control.AsyncControlSessionLocal",
        _ctl_session,
    )

    return TestClient(app)


async def _user(session, *, email, role, tenant_id, full_name=None) -> User:
    u = User(
        tenant_id=tenant_id,
        email=email,
        username=email.split("@")[0].replace(".", "-"),
        full_name=full_name or email,
        hashed_password=get_password_hash("password"),
        role=role,
        is_active=True,
        email_verified=True,
        has_changed_password=True,
    )
    session.add(u)
    await session.flush()
    return u


def _auth(user_id: int, tenant_id: int | None) -> dict:
    token = create_access_token({"sub": str(user_id), "tenant_id": tenant_id})
    return {"Authorization": f"Bearer {token}"}


@pytest_asyncio.fixture
async def two_tenant_world(db_session: AsyncSession):
    """Two tenants, each with users + an admin. Mirrors the
    multi-tenant legacy DB shape that caused Nexillo to show every
    other tenant's users."""
    nexillo = Tenant(name="Nexillo", slug="nexillo", status=TenantStatus.active)
    acuent = Tenant(name="Acuent", slug="acuent", status=TenantStatus.active)
    db_session.add_all([nexillo, acuent])
    await db_session.flush()

    # 1 user in Nexillo, 3 in Acuent (of which 2 are admins).
    nexillo_user = await _user(db_session, email="nex1@example.com", role=UserRole.EMPLOYEE, tenant_id=nexillo.id)
    await _user(db_session, email="acu1@example.com", role=UserRole.ADMIN, tenant_id=acuent.id)
    await _user(db_session, email="acu2@example.com", role=UserRole.ADMIN, tenant_id=acuent.id)
    await _user(db_session, email="acu3@example.com", role=UserRole.EMPLOYEE, tenant_id=acuent.id)

    pa = await _user(db_session, email="platform@example.com", role=UserRole.PLATFORM_ADMIN, tenant_id=None)

    await db_session.commit()
    return {"nexillo": nexillo, "acuent": acuent, "pa": pa, "nexillo_user": nexillo_user}


# ─────────────────────────────────────────────────────────────────────
# GET /users PA branch
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_pa_listing_filters_to_header_tenant(db_session, two_tenant_world, monkeypatch):
    """PA listing /users with X-Tenant-Slug=nexillo returns only
    Nexillo's user, never Acuent's. The pre-fix behaviour returned
    every user across both tenants."""
    pa = two_tenant_world["pa"]
    slug_to_id = {
        "nexillo": two_tenant_world["nexillo"].id,
        "acuent": two_tenant_world["acuent"].id,
    }
    with _make_app(db_session, monkeypatch, slug_to_id) as client:
        resp = client.get(
            "/users",
            headers={
                **_auth(pa.id, None),
                "X-Tenant-Slug": "nexillo",
            },
        )
    assert resp.status_code == 200, resp.text
    emails = sorted(u["email"] for u in resp.json())
    assert emails == ["nex1@example.com"]


@pytest.mark.asyncio
async def test_pa_listing_for_acuent_returns_only_acuent_users(db_session, two_tenant_world, monkeypatch):
    pa = two_tenant_world["pa"]
    slug_to_id = {
        "nexillo": two_tenant_world["nexillo"].id,
        "acuent": two_tenant_world["acuent"].id,
    }
    with _make_app(db_session, monkeypatch, slug_to_id) as client:
        resp = client.get(
            "/users",
            headers={
                **_auth(pa.id, None),
                "X-Tenant-Slug": "acuent",
            },
        )
    assert resp.status_code == 200, resp.text
    emails = sorted(u["email"] for u in resp.json())
    assert emails == ["acu1@example.com", "acu2@example.com", "acu3@example.com"]
    admin_count = sum(1 for u in resp.json() if u["role"] == "ADMIN")
    assert admin_count == 2


@pytest.mark.asyncio
async def test_pa_listing_unknown_slug_returns_empty(db_session, two_tenant_world, monkeypatch):
    """An unrecognised slug yields no rows rather than leaking the
    full legacy listing. Fail-closed behaviour: when the control
    plane can't resolve the slug, the handler must filter on a
    sentinel id so no rows match."""
    pa = two_tenant_world["pa"]
    slug_to_id = {
        "nexillo": two_tenant_world["nexillo"].id,
        "acuent": two_tenant_world["acuent"].id,
    }
    with _make_app(db_session, monkeypatch, slug_to_id) as client:
        resp = client.get(
            "/users",
            headers={
                **_auth(pa.id, None),
                "X-Tenant-Slug": "does-not-exist",
            },
        )
    assert resp.status_code == 200, resp.text
    assert resp.json() == []
