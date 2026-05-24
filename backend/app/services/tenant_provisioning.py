"""Per-tenant database provisioning.

Single source of truth for "create the per-tenant database, run alembic
against it, record the job, return connection details." Two callers
share this code:

- ``scripts/provision_tenant_db.py`` — the operator path. Idempotent,
  CLI-driven, safe to re-run after a half-failed prior attempt.

- ``POST /tenants`` (when ``is_isolated=true`` on the create request)
  — the platform-admin UI path. Runs inline; the HTTP request stays
  open for the duration (typically 5-30s).

The flip of ``is_isolated`` on the control-plane ``tenants`` row is a
separate, deliberate step. Provisioning prepares the per-tenant DB
but does NOT flip the flag — callers do that after they're satisfied
the DB is ready (e.g. data has been migrated for legacy tenants, or
"nothing to migrate" for a brand-new tenant).

Provisioning is idempotent: each step (DB exists, alembic head,
connection details on the control row) is a check-then-act.
"""
from __future__ import annotations

import logging
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.config import settings
from app.models.control import ControlTenant, TenantProvisioningJob
from app.models.control.tenant_provisioning_job import (
    ProvisioningJobKind,
    ProvisioningJobStatus,
)

logger = logging.getLogger(__name__)

# Slug rules: lowercase alphanumeric + hyphens, 1-63 chars, no leading
# or trailing hyphen. Mirrors Postgres database name constraints and
# matches the script's validation so the two callers behave identically.
_SLUG_PATTERN = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")


class ProvisionError(RuntimeError):
    """Raised when provisioning fails irrecoverably. The TenantProvisioningJob
    row is updated to ``failed`` before this is raised so an operator can
    see what happened via the platform-audit log."""


@dataclass(frozen=True)
class ProvisionResult:
    db_name: str
    db_host: Optional[str]
    db_port: Optional[int]
    alembic_revision: Optional[str]
    job_id: int


def _tenant_db_prefix() -> str:
    """Derive the per-tenant DB name prefix from the source DB.

    Two environments share the same Postgres server today: prod-like
    (legacy DB ``timesheet_db``) and ldev (legacy DB ``timesheet_ldev``).
    Without env-aware naming, both want to create
    ``acufy_tenant_<slug>`` databases and collide on the same names.

    Convention:

      - Source DB == ``timesheet_db``      -> ``acufy_tenant_``
      - Source DB == ``timesheet_<env>``   -> ``acufy_tenant_<env>_``
      - Any other name                     -> ``acufy_tenant_``
        (fallback so test/dev environments don't get a weird prefix)

    Prod naming stays exactly as it was, so the existing
    ``acufy_tenant_<slug>`` DBs are unaffected. ldev becomes
    self-namespaced (``acufy_tenant_ldev_<slug>``) and any future env
    (staging, qa, ...) follows the same rule automatically.
    """
    base = urlparse(settings.database_url)
    db_name = (base.path or "").lstrip("/")
    if db_name == "timesheet_db" or not db_name.startswith("timesheet_"):
        return "acufy_tenant_"
    env = db_name[len("timesheet_"):]
    return f"acufy_tenant_{env}_"


def tenant_db_name(slug: str) -> str:
    """Postgres database name for the given slug, namespaced by env.

    See ``_tenant_db_prefix`` for the derivation rule. Hyphens in slugs
    stay legal in Postgres database identifiers; no transformation.
    """
    return f"{_tenant_db_prefix()}{slug}"


def validate_slug(slug: str) -> None:
    if not _SLUG_PATTERN.match(slug):
        raise ProvisionError(
            f"Invalid slug {slug!r}: must be lowercase alphanumeric + hyphens, "
            "1-63 chars, no leading/trailing hyphen."
        )


def _tenant_db_url(db_name: str) -> str:
    """Build the asyncpg URL for a tenant DB by swapping the database
    name in the shared connection URL."""
    base = urlparse(settings.database_url)
    return f"{base.scheme}://{base.netloc}/{db_name}"


async def _ensure_database_exists(db_name: str) -> bool:
    """Create the database if missing. Returns True if newly created."""
    base = urlparse(settings.database_url)
    maint_url = f"{base.scheme}://{base.netloc}/postgres"
    engine = create_async_engine(maint_url, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as conn:
            exists = (await conn.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :n"),
                {"n": db_name},
            )).first() is not None
            if exists:
                logger.info("database %s already exists, skipping create", db_name)
                return False
            # Database name comes from a validated slug; safe to inline.
            await conn.execute(text(f'CREATE DATABASE "{db_name}"'))
            logger.info("created database %s", db_name)
            return True
    finally:
        await engine.dispose()


def _run_alembic_upgrade(db_url: str) -> None:
    """Run ``alembic upgrade head`` against the target URL by shelling
    out so the existing ``alembic/env.py`` drives the migration loop."""
    env = os.environ.copy()
    env["DATABASE_URL"] = db_url
    result = subprocess.run(
        ["alembic", "upgrade", "head"],
        cwd="/app",
        env=env,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        logger.error("alembic upgrade failed:\n%s\n%s", result.stdout, result.stderr)
        raise ProvisionError(
            f"alembic upgrade failed (exit {result.returncode}): {result.stderr.strip()[:500]}"
        )
    logger.info("alembic upgrade head succeeded against %s", db_url)


async def _read_alembic_revision(db_url: str) -> Optional[str]:
    engine = create_async_engine(db_url)
    try:
        async with engine.connect() as conn:
            return (await conn.execute(
                text("SELECT version_num FROM alembic_version")
            )).scalar_one_or_none()
    finally:
        await engine.dispose()


async def provision_tenant_db(
    control_session: AsyncSession,
    tenant: ControlTenant,
) -> ProvisionResult:
    """Provision a per-tenant database for ``tenant``.

    Caller owns the control-plane session — we add and flush against
    it, but do NOT commit. Callers commit when their broader workflow
    is satisfied (e.g. the API endpoint commits once the legacy +
    control writes both succeed).

    Idempotent: a half-provisioned tenant (DB exists, alembic done,
    connection details written) re-runs cleanly.

    Raises:
        ProvisionError: any irrecoverable failure. The
        TenantProvisioningJob row is set to ``failed`` and committed
        before the exception propagates so an operator can see why.
    """
    validate_slug(tenant.slug)
    db_name = tenant_db_name(tenant.slug)
    db_url = _tenant_db_url(db_name)

    base = urlparse(settings.database_url)
    db_host = base.hostname
    db_port = base.port or 5432

    job = TenantProvisioningJob(
        tenant_id=tenant.id,
        kind=ProvisioningJobKind.create,
        status=ProvisioningJobStatus.running,
        started_at=datetime.now(timezone.utc),
    )
    control_session.add(job)
    await control_session.flush()
    # Commit the running-state job row before the slow alembic step so
    # an operator inspecting the table mid-provision sees what's
    # happening, not an empty queue. The post-success commit happens
    # in the caller; the failure commit is below.
    await control_session.commit()

    try:
        await _ensure_database_exists(db_name)
        _run_alembic_upgrade(db_url)

        tenant.db_name = db_name
        tenant.db_host = db_host
        tenant.db_port = db_port
        control_session.add(tenant)

        revision = await _read_alembic_revision(db_url)

        job.status = ProvisioningJobStatus.succeeded
        job.completed_at = datetime.now(timezone.utc)
        if revision is not None:
            job.alembic_revision = revision
        control_session.add(job)
        await control_session.flush()

        return ProvisionResult(
            db_name=db_name,
            db_host=db_host,
            db_port=db_port,
            alembic_revision=revision,
            job_id=job.id,
        )
    except Exception as exc:
        # Best-effort: mark the job failed so the audit trail records
        # the partial state. Do this in a fresh transaction so the
        # outer session's state stays clean for whatever the caller
        # decides next.
        try:
            job.status = ProvisioningJobStatus.failed
            job.error_message = str(exc)
            job.completed_at = datetime.now(timezone.utc)
            control_session.add(job)
            await control_session.commit()
        except Exception:
            logger.exception("could not record provisioning failure for slug=%s", tenant.slug)
        logger.exception("provisioning failed for slug=%s", tenant.slug)
        raise ProvisionError(str(exc)) from exc
