"""Unit tests for ``app.services.tenant_provisioning``.

The real provisioning path creates Postgres databases and shells out
to ``alembic upgrade head`` — neither works in the SQLite unit-test
harness. The tests below monkeypatch the two side-effect functions
(`_ensure_database_exists`, `_run_alembic_upgrade`, `_read_alembic_revision`)
and exercise the surrounding orchestration: control-row updates,
TenantProvisioningJob lifecycle, and failure handling.
"""
from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover
    return "JSON"


from app.models.control import ControlBase, ControlTenant, TenantProvisioningJob
from app.models.control.tenant import ControlTenantStatus
from app.models.control.tenant_provisioning_job import (
    ProvisioningJobKind,
    ProvisioningJobStatus,
)
from app.services import tenant_provisioning
from app.services.tenant_provisioning import (
    ProvisionError,
    provision_tenant_db,
    tenant_db_name,
    validate_slug,
)


@pytest_asyncio.fixture
async def control_session(tmp_path) -> AsyncSession:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'control.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(ControlBase.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


@pytest_asyncio.fixture
async def control_tenant(control_session: AsyncSession) -> ControlTenant:
    tenant = ControlTenant(
        name="Acme Corp",
        slug="acme-corp",
        status=ControlTenantStatus.active,
    )
    control_session.add(tenant)
    await control_session.commit()
    await control_session.refresh(tenant)
    return tenant


# ─── slug validation ───────────────────────────────────────────────────


def test_validate_slug_accepts_kebab_case():
    validate_slug("acme")
    validate_slug("acme-corp")
    validate_slug("acme-corp-2026")


def test_validate_slug_rejects_uppercase_or_special_chars():
    for bad in ["Acme", "acme_corp", "acme.corp", "acme corp", "-acme", "acme-"]:
        with pytest.raises(ProvisionError):
            validate_slug(bad)


def test_tenant_db_name_format_default_prod_naming(monkeypatch):
    """When the source DB is ``timesheet_db`` (prod-like), the
    per-tenant prefix stays ``acufy_tenant_`` — unchanged from before.
    Pinning this keeps existing prod DBs reachable."""
    from app.services import tenant_provisioning as svc
    monkeypatch.setattr(
        svc.settings, "database_url",
        "postgresql+asyncpg://u:p@db:5432/timesheet_db",
    )
    assert tenant_db_name("acme") == "acufy_tenant_acme"
    assert tenant_db_name("acme-corp-2026") == "acufy_tenant_acme-corp-2026"


def test_tenant_db_name_format_includes_env_suffix(monkeypatch):
    """ldev's source DB is ``timesheet_ldev``; the prefix becomes
    ``acufy_tenant_ldev_`` so ldev tenants don't collide with prod
    tenants sharing the same Postgres server."""
    from app.services import tenant_provisioning as svc
    monkeypatch.setattr(
        svc.settings, "database_url",
        "postgresql+asyncpg://u:p@ldb.acufy.ai:5432/timesheet_ldev",
    )
    assert tenant_db_name("webilent-test") == "acufy_tenant_ldev_webilent-test"
    assert tenant_db_name("acme") == "acufy_tenant_ldev_acme"


def test_tenant_db_name_format_falls_back_for_non_timesheet_source(monkeypatch):
    """A custom legacy DB name (no ``timesheet_`` prefix) shouldn't
    produce a garbage env-name. Fall back to the bare prefix."""
    from app.services import tenant_provisioning as svc
    monkeypatch.setattr(
        svc.settings, "database_url",
        "postgresql+asyncpg://u:p@db:5432/some_other_db",
    )
    assert tenant_db_name("acme") == "acufy_tenant_acme"


def test_tenant_db_name_format_staging_env(monkeypatch):
    """Same rule scales: ``timesheet_staging`` -> ``acufy_tenant_staging_<slug>``."""
    from app.services import tenant_provisioning as svc
    monkeypatch.setattr(
        svc.settings, "database_url",
        "postgresql+asyncpg://u:p@db:5432/timesheet_staging",
    )
    assert tenant_db_name("acme") == "acufy_tenant_staging_acme"


# ─── happy path ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_provision_happy_path_writes_connection_details_and_succeeds(
    control_session, control_tenant, monkeypatch
):
    """Provision succeeds → db_name/host/port are set on the control
    row, a TenantProvisioningJob is in ``succeeded`` state, and the
    alembic revision is recorded on the job."""
    async def fake_ensure(db_name):
        return True

    def fake_alembic(db_url):
        return None

    async def fake_revision(db_url):
        return "059_holidays"

    monkeypatch.setattr(tenant_provisioning, "_ensure_database_exists", fake_ensure)
    monkeypatch.setattr(tenant_provisioning, "_run_alembic_upgrade", fake_alembic)
    monkeypatch.setattr(tenant_provisioning, "_read_alembic_revision", fake_revision)

    result = await provision_tenant_db(control_session, control_tenant)
    await control_session.commit()

    assert result.db_name == "acufy_tenant_acme-corp"
    assert result.alembic_revision == "059_holidays"

    refreshed = await control_session.get(ControlTenant, control_tenant.id)
    assert refreshed.db_name == "acufy_tenant_acme-corp"
    # is_isolated is NOT set by the service — the caller flips it.
    assert refreshed.is_isolated is False

    from sqlalchemy import select
    jobs = (await control_session.execute(
        select(TenantProvisioningJob).where(TenantProvisioningJob.tenant_id == control_tenant.id)
    )).scalars().all()
    assert len(jobs) == 1
    assert jobs[0].status == ProvisioningJobStatus.succeeded
    assert jobs[0].kind == ProvisioningJobKind.create
    assert jobs[0].alembic_revision == "059_holidays"


# ─── failure path ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_provision_alembic_failure_records_failed_job_and_raises(
    control_session, control_tenant, monkeypatch
):
    """When alembic fails, the service must (a) leave a ``failed``
    TenantProvisioningJob row for the operator audit trail, and (b)
    raise ProvisionError so the caller can surface the failure."""
    async def fake_ensure(db_name):
        return True

    def boom(db_url):
        raise ProvisionError("alembic upgrade failed (exit 1): pretend stderr")

    monkeypatch.setattr(tenant_provisioning, "_ensure_database_exists", fake_ensure)
    monkeypatch.setattr(tenant_provisioning, "_run_alembic_upgrade", boom)

    with pytest.raises(ProvisionError):
        await provision_tenant_db(control_session, control_tenant)

    from sqlalchemy import select
    jobs = (await control_session.execute(
        select(TenantProvisioningJob).where(TenantProvisioningJob.tenant_id == control_tenant.id)
    )).scalars().all()
    assert len(jobs) == 1
    assert jobs[0].status == ProvisioningJobStatus.failed
    assert "alembic upgrade failed" in (jobs[0].error_message or "")

    # db_name is NOT persisted on the control row when provision fails
    # before that point.
    refreshed = await control_session.get(ControlTenant, control_tenant.id)
    assert refreshed.db_name is None
    assert refreshed.is_isolated is False


@pytest.mark.asyncio
async def test_provision_invalid_slug_raises_before_any_writes(
    control_session, control_tenant
):
    control_tenant.slug = "Invalid Slug!"
    await control_session.commit()
    with pytest.raises(ProvisionError):
        await provision_tenant_db(control_session, control_tenant)

    from sqlalchemy import select
    jobs = (await control_session.execute(select(TenantProvisioningJob))).scalars().all()
    assert jobs == []


# ─── idempotency ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_provision_is_idempotent_when_database_already_exists(
    control_session, control_tenant, monkeypatch
):
    """A second provision after a prior success runs alembic again
    (cheap if there's nothing to do) and writes a second job row."""
    ensure_calls = []

    async def fake_ensure(db_name):
        ensure_calls.append(db_name)
        return False  # already exists

    def fake_alembic(db_url):
        return None

    async def fake_revision(db_url):
        return "059_holidays"

    monkeypatch.setattr(tenant_provisioning, "_ensure_database_exists", fake_ensure)
    monkeypatch.setattr(tenant_provisioning, "_run_alembic_upgrade", fake_alembic)
    monkeypatch.setattr(tenant_provisioning, "_read_alembic_revision", fake_revision)

    await provision_tenant_db(control_session, control_tenant)
    await control_session.commit()
    await provision_tenant_db(control_session, control_tenant)
    await control_session.commit()

    assert len(ensure_calls) == 2

    from sqlalchemy import select
    jobs = (await control_session.execute(
        select(TenantProvisioningJob).where(TenantProvisioningJob.tenant_id == control_tenant.id)
    )).scalars().all()
    assert len(jobs) == 2
    assert all(j.status == ProvisioningJobStatus.succeeded for j in jobs)
