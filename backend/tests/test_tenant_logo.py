"""Tests for ``/admin/tenant/logo`` upload / read / delete.

Coverage focuses on tenant isolation - the slug in the storage path is
derived from the authenticated tenant's Tenant row, never from a client-
supplied field, so a manipulated form field cannot redirect the write to
another tenant's prefix.

The local storage backend is wired through tmp_path so each test runs
against a clean directory; nothing touches the real ./uploads tree.
"""
from io import BytesIO
from pathlib import Path

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


from app.api import admin as admin_api
from app.core import config as config_module
from app.core.security import create_access_token, get_password_hash
from app.db import get_db
from app.core.deps import get_tenant_db
from app.models.base import Base
from app.models.tenant import Tenant, TenantStatus
from app.models.user import User, UserRole


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    db_file = tmp_path / "tenant_logo.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_file}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


@pytest.fixture(autouse=True)
def isolate_storage(tmp_path, monkeypatch):
    """Redirect the local storage backend to a temp directory so the
    real ./uploads tree is never touched. The provider is forced to
    local since the app is local-only in production too."""
    storage_path = tmp_path / "uploads"
    storage_path.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config_module.settings, "storage_path", str(storage_path))
    monkeypatch.setattr(config_module.settings, "storage_provider", "local")
    return storage_path


def _make_app(db_session: AsyncSession) -> TestClient:
    app = FastAPI()
    app.include_router(admin_api.router)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_tenant_db] = override_get_db
    return TestClient(app)


def _auth_headers(user: User) -> dict:
    token = create_access_token({"sub": str(user.id), "tenant_id": user.tenant_id})
    return {"Authorization": f"Bearer {token}"}


async def _make_tenant(session: AsyncSession, *, name: str, slug: str) -> Tenant:
    t = Tenant(name=name, slug=slug, status=TenantStatus.active)
    session.add(t)
    await session.flush()
    return t


async def _make_user(
    session: AsyncSession, *, tenant_id: int, role: UserRole, email: str
) -> User:
    user = User(
        tenant_id=tenant_id,
        email=email,
        username=email.split("@")[0],
        full_name=email,
        hashed_password=get_password_hash("password"),
        role=role,
        is_active=True,
        email_verified=True,
        has_changed_password=True,
    )
    session.add(user)
    await session.flush()
    return user


# A tiny valid PNG (1x1, red pixel). 67 bytes — well under the 2 MB cap.
_TINY_PNG = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde"
    b"\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0\x00\x00\x00\x03\x00\x01\\\xcd\xff\x69"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)


@pytest.mark.asyncio
async def test_non_admin_cannot_upload_logo(db_session, isolate_storage):
    tenant = await _make_tenant(db_session, name="Acme", slug="acme")
    employee = await _make_user(db_session, tenant_id=tenant.id, role=UserRole.EMPLOYEE, email="e@acme.io")
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.post(
            "/admin/tenant/logo",
            files={"file": ("logo.png", BytesIO(_TINY_PNG), "image/png")},
            headers=_auth_headers(employee),
        )
    assert resp.status_code == 403
    # No file landed on disk.
    assert list(isolate_storage.rglob("*.png")) == []


@pytest.mark.asyncio
async def test_admin_upload_writes_under_tenant_prefix(db_session, isolate_storage):
    """The storage key must start with tenant-logos/<authenticated-slug>/.
    Even if the request smuggled a different slug somewhere, the server
    sources the slug from the per-tenant Tenant row."""
    tenant = await _make_tenant(db_session, name="Acme", slug="acme")
    admin = await _make_user(db_session, tenant_id=tenant.id, role=UserRole.ADMIN, email="a@acme.io")
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.post(
            "/admin/tenant/logo",
            files={"file": ("logo.png", BytesIO(_TINY_PNG), "image/png")},
            headers=_auth_headers(admin),
        )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"has_logo": True, "mime_type": "image/png"}

    # Storage key + file location both scoped under acme's prefix.
    await db_session.refresh(tenant)
    assert tenant.logo_storage_key is not None
    assert tenant.logo_storage_key.startswith("tenant-logos/acme/")
    assert tenant.logo_mime_type == "image/png"
    on_disk = list(isolate_storage.rglob("*.png"))
    assert len(on_disk) == 1
    assert "tenant-logos" in on_disk[0].as_posix()
    assert "/acme/" in on_disk[0].as_posix()


@pytest.mark.asyncio
async def test_admin_cannot_cross_tenant_via_form_field(db_session, isolate_storage):
    """Tenant A's admin uploads a logo, attempting to manipulate the
    multipart filename to escape into tenant B's prefix. The file must
    still land under A's prefix and B's row must be unchanged."""
    tenant_a = await _make_tenant(db_session, name="Acme", slug="acme")
    tenant_b = await _make_tenant(db_session, name="Beta", slug="beta")
    admin_a = await _make_user(db_session, tenant_id=tenant_a.id, role=UserRole.ADMIN, email="a@acme.io")
    await db_session.commit()

    # An attacker-style filename with path traversal. The server uses
    # uuid + a sanitized extension, so the filename is never trusted
    # into the on-disk path.
    malicious = "../../tenant-logos/beta/owned.png"
    with _make_app(db_session) as client:
        resp = client.post(
            "/admin/tenant/logo",
            files={"file": (malicious, BytesIO(_TINY_PNG), "image/png")},
            headers=_auth_headers(admin_a),
        )
    assert resp.status_code == 200, resp.text

    await db_session.refresh(tenant_a)
    await db_session.refresh(tenant_b)
    # Acme's row got the new key; Beta is untouched.
    assert tenant_a.logo_storage_key is not None
    assert tenant_a.logo_storage_key.startswith("tenant-logos/acme/")
    assert tenant_b.logo_storage_key is None

    # File on disk is under acme/, not beta/.
    on_disk = list(isolate_storage.rglob("*.png"))
    assert len(on_disk) == 1
    assert "/acme/" in on_disk[0].as_posix()
    assert "/beta/" not in on_disk[0].as_posix()


@pytest.mark.asyncio
async def test_upload_rejects_non_image_extension(db_session, isolate_storage):
    tenant = await _make_tenant(db_session, name="Acme", slug="acme")
    admin = await _make_user(db_session, tenant_id=tenant.id, role=UserRole.ADMIN, email="a@acme.io")
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.post(
            "/admin/tenant/logo",
            files={"file": ("payload.svg", BytesIO(b"<svg/>"), "image/svg+xml")},
            headers=_auth_headers(admin),
        )
    assert resp.status_code == 400
    assert "Unsupported" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_upload_rejects_oversize(db_session, isolate_storage):
    tenant = await _make_tenant(db_session, name="Acme", slug="acme")
    admin = await _make_user(db_session, tenant_id=tenant.id, role=UserRole.ADMIN, email="a@acme.io")
    await db_session.commit()
    big = b"\x00" * (3 * 1024 * 1024)  # 3 MB > 2 MB cap
    with _make_app(db_session) as client:
        resp = client.post(
            "/admin/tenant/logo",
            files={"file": ("big.png", BytesIO(big), "image/png")},
            headers=_auth_headers(admin),
        )
    assert resp.status_code == 413


@pytest.mark.asyncio
async def test_get_logo_returns_bytes_for_own_tenant(db_session, isolate_storage):
    tenant = await _make_tenant(db_session, name="Acme", slug="acme")
    admin = await _make_user(db_session, tenant_id=tenant.id, role=UserRole.ADMIN, email="a@acme.io")
    employee = await _make_user(db_session, tenant_id=tenant.id, role=UserRole.EMPLOYEE, email="e@acme.io")
    await db_session.commit()
    with _make_app(db_session) as client:
        client.post(
            "/admin/tenant/logo",
            files={"file": ("logo.png", BytesIO(_TINY_PNG), "image/png")},
            headers=_auth_headers(admin),
        )
        # Employee in same tenant can read the bytes — it's branding, not sensitive.
        resp = client.get("/admin/tenant/logo", headers=_auth_headers(employee))
    assert resp.status_code == 200
    assert resp.content == _TINY_PNG
    assert resp.headers["content-type"].startswith("image/png")


@pytest.mark.asyncio
async def test_get_logo_404_when_unset(db_session, isolate_storage):
    tenant = await _make_tenant(db_session, name="Acme", slug="acme")
    admin = await _make_user(db_session, tenant_id=tenant.id, role=UserRole.ADMIN, email="a@acme.io")
    await db_session.commit()
    with _make_app(db_session) as client:
        resp = client.get("/admin/tenant/logo", headers=_auth_headers(admin))
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_logo_clears_row_and_file(db_session, isolate_storage):
    tenant = await _make_tenant(db_session, name="Acme", slug="acme")
    admin = await _make_user(db_session, tenant_id=tenant.id, role=UserRole.ADMIN, email="a@acme.io")
    await db_session.commit()
    with _make_app(db_session) as client:
        client.post(
            "/admin/tenant/logo",
            files={"file": ("logo.png", BytesIO(_TINY_PNG), "image/png")},
            headers=_auth_headers(admin),
        )
        resp = client.delete("/admin/tenant/logo", headers=_auth_headers(admin))
    assert resp.status_code == 200
    assert resp.json() == {"has_logo": False, "mime_type": None}
    await db_session.refresh(tenant)
    assert tenant.logo_storage_key is None
    assert tenant.logo_mime_type is None
    # File on disk is gone.
    assert list(isolate_storage.rglob("*.png")) == []


@pytest.mark.asyncio
async def test_replace_logo_deletes_old_file(db_session, isolate_storage):
    """Uploading a second logo replaces the first; the old file on disk
    is cleaned up so STORAGE_PATH doesn't grow unboundedly."""
    tenant = await _make_tenant(db_session, name="Acme", slug="acme")
    admin = await _make_user(db_session, tenant_id=tenant.id, role=UserRole.ADMIN, email="a@acme.io")
    await db_session.commit()
    with _make_app(db_session) as client:
        client.post(
            "/admin/tenant/logo",
            files={"file": ("first.png", BytesIO(_TINY_PNG), "image/png")},
            headers=_auth_headers(admin),
        )
        client.post(
            "/admin/tenant/logo",
            files={"file": ("second.png", BytesIO(_TINY_PNG), "image/png")},
            headers=_auth_headers(admin),
        )
    on_disk = list(isolate_storage.rglob("*.png"))
    assert len(on_disk) == 1, f"Expected exactly one file (newest), got {on_disk}"
