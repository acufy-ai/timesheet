"""Admin-only operational endpoints.

Currently exposes a single system-health endpoint that aggregates the
operational state of the services the admin dashboard renders.

This is intentionally a separate router from `dashboard` because these
checks are infra-level (DB ping, Redis ping, mailbox freshness) rather
than tenant analytics. Future operational endpoints (worker stats,
queue depth, OAuth refresh activity) will land here too.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status as http_status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.deps import get_current_user, get_tenant_db, require_role
from app.models.mailbox import Mailbox
from app.models.tenant import Tenant
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])


SystemHealthStatus = Literal["healthy", "attention", "loading"]


class SystemHealthCheck(BaseModel):
    """Per-service operational status surfaced on the admin dashboard.

    Mirrored shape on the frontend (`SystemHealthCardProps`). Stable key
    is included so the UI can pin per-service icons / ordering without
    matching by display label.
    """

    key: str = Field(description="Stable identifier, e.g. 'database', 'redis'")
    label: str = Field(description="Human-readable service name")
    status: SystemHealthStatus = Field(description="healthy | attention | loading")
    subtitle: str = Field(description="Freshness or detail line, e.g. 'Last query 2s ago'")


def _format_relative_age(target: datetime, now: datetime) -> str:
    """Compact relative age. We keep it server-side so every client
    renders the same wording without time-zone drift."""
    delta = now - target
    secs = int(delta.total_seconds())
    if secs < 0:
        # Clock skew or future timestamp — present as "just now" instead
        # of a confusing "-3s ago".
        return "just now"
    if secs < 60:
        return f"{secs}s ago"
    mins = secs // 60
    if mins < 60:
        return f"{mins}m ago"
    hours = mins // 60
    if hours < 48:
        return f"{hours}h ago"
    days = hours // 24
    return f"{days}d ago"


async def _check_database(db: AsyncSession) -> SystemHealthCheck:
    """Round-trip a SELECT 1 and time it. Anything reachable counts as
    healthy; an exception flips to attention."""
    started = time.perf_counter()
    try:
        await db.execute(text("SELECT 1"))
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return SystemHealthCheck(
            key="database",
            label="Database",
            status="healthy",
            subtitle=f"Last query {elapsed_ms}ms",
        )
    except Exception as exc:  # noqa: BLE001 - we want to coalesce all failures
        logger.warning("system-health database check failed: %s", exc)
        return SystemHealthCheck(
            key="database",
            label="Database",
            status="attention",
            subtitle="Unreachable",
        )


async def _check_redis() -> SystemHealthCheck:
    """PING the configured Redis. We import the client lazily so a
    Redis-less local env can still serve the rest of the dashboard."""
    try:
        import redis.asyncio as aioredis  # type: ignore[import-not-found]
    except Exception:  # pragma: no cover - redis is in requirements.txt
        return SystemHealthCheck(
            key="redis",
            label="Background jobs",
            status="attention",
            subtitle="Client library unavailable",
        )

    client = aioredis.from_url(settings.redis_url)
    started = time.perf_counter()
    try:
        await asyncio.wait_for(client.ping(), timeout=2.0)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return SystemHealthCheck(
            key="redis",
            label="Background jobs",
            status="healthy",
            subtitle=f"Last ping {elapsed_ms}ms",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("system-health redis check failed: %s", exc)
        return SystemHealthCheck(
            key="redis",
            label="Background jobs",
            status="attention",
            subtitle="Ping failed",
        )
    finally:
        try:
            await client.aclose()
        except Exception:  # pragma: no cover - cleanup best effort
            pass


_DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


async def _load_fetch_window(db: AsyncSession) -> dict:
    """Read the tenant's fetch-window settings. Missing keys fall back to
    the env defaults so this stays compatible with tenants that have
    never opened the Mailboxes admin UI.

    Values are stored JSON-encoded by ``set_setting`` (a string "08:00"
    round-trips as the literal ``"08:00"`` with quotes included). Decode
    each row so downstream string parsers see "08:00" not ``"08:00"``.
    """
    import json
    from app.models.tenant_settings import TenantSettings

    result = await db.execute(
        select(TenantSettings).where(
            TenantSettings.key.in_([
                "fetch_emails_enabled",
                "fetch_emails_interval_minutes",
                "fetch_emails_days",
                "fetch_emails_start_time",
                "fetch_emails_end_time",
                "tenant_default_timezone",
            ])
        )
    )
    out: dict[str, str] = {}
    for row in result.scalars().all():
        raw = row.value
        if raw is None:
            continue
        try:
            decoded = json.loads(raw)
        except (ValueError, TypeError):
            out[row.key] = raw
            continue
        if isinstance(decoded, bool):
            out[row.key] = "true" if decoded else "false"
        elif decoded is None:
            continue
        else:
            out[row.key] = str(decoded)
    return out


def _inside_fetch_window(tenant_settings: dict, now_local: datetime) -> bool:
    """Mirror of workers.email_fetch._should_fetch_now's day+time check.

    Returns True if ``now_local`` falls inside the configured window. The
    cron-tick check is intentionally omitted: we only care whether the
    worker SHOULD be fetching right now, not whether this exact minute is
    a cron tick.

    Mirrors the cron's malformed-window behavior (return False), so the
    health widget agrees with reality instead of telling the admin
    "expected every Nm" while the cron silently skips.
    """
    def _clean(s: str | None) -> str:
        return (s or "").strip().strip('"').strip("'")

    days_str = _clean(tenant_settings.get("fetch_emails_days") or settings.email_fetch_days)
    start_str = _clean(tenant_settings.get("fetch_emails_start_time") or settings.email_fetch_start_time)
    end_str = _clean(tenant_settings.get("fetch_emails_end_time") or settings.email_fetch_end_time)

    allowed_days = [d.strip().lower() for d in days_str.split(",") if d.strip()]
    if not allowed_days:
        return True  # no day restriction set → always inside
    if _DAY_NAMES[now_local.weekday()] not in allowed_days:
        return False

    try:
        start_h, start_m = map(int, start_str.split(":"))
        end_h, end_m = map(int, end_str.split(":"))
    except (ValueError, AttributeError):
        return False  # malformed → match the cron, which also bails
    current_mins = now_local.hour * 60 + now_local.minute
    return start_h * 60 + start_m <= current_mins <= end_h * 60 + end_m


def _format_window_subtitle(tenant_settings: dict) -> str:
    days = (tenant_settings.get("fetch_emails_days") or settings.email_fetch_days or "").strip()
    start = tenant_settings.get("fetch_emails_start_time") or settings.email_fetch_start_time
    end = tenant_settings.get("fetch_emails_end_time") or settings.email_fetch_end_time
    return f"Outside fetch window ({days} {start}-{end})"


async def _check_email_ingestion(db: AsyncSession) -> SystemHealthCheck:
    """Latest mailbox fetch wins. If no mailbox is configured at all we
    surface that explicitly rather than as a failure — a tenant without
    ingestion enabled is a normal state, not a degraded one.

    Staleness is only flagged when the current time falls inside the
    tenant's configured fetch window. Outside the window (evenings,
    weekends, etc.) staleness is expected and reported as healthy.
    """
    from app.core.timezone_utils import now_for_tenant

    result = await db.execute(
        select(Mailbox.last_fetched_at)
        .where(Mailbox.is_active.is_(True))
        .order_by(Mailbox.last_fetched_at.desc().nullslast())
        .limit(1)
    )
    last_fetched = result.scalar_one_or_none()
    tenant_settings = await _load_fetch_window(db)
    fetch_enabled = (tenant_settings.get("fetch_emails_enabled") or "false").lower() == "true"
    tenant_tz = tenant_settings.get("tenant_default_timezone") or "UTC"
    now_local = now_for_tenant(tenant_tz)
    inside_window = _inside_fetch_window(tenant_settings, now_local)
    try:
        interval_minutes = int(
            tenant_settings.get("fetch_emails_interval_minutes")
            or settings.email_fetch_interval_minutes
        )
    except (TypeError, ValueError):
        interval_minutes = settings.email_fetch_interval_minutes

    if last_fetched is None:
        active_count_result = await db.execute(
            select(Mailbox.id).where(Mailbox.is_active.is_(True)).limit(1)
        )
        has_active = active_count_result.first() is not None
        if not has_active:
            return SystemHealthCheck(
                key="email_ingestion", label="Inbox processing",
                status="healthy", subtitle="No active mailboxes",
            )
        # Mailbox exists but never fetched. Only attention-worthy when
        # auto-fetch is enabled AND we're inside the configured window.
        if fetch_enabled and inside_window:
            return SystemHealthCheck(
                key="email_ingestion", label="Inbox processing",
                status="attention", subtitle="No mailbox has fetched yet",
            )
        return SystemHealthCheck(
            key="email_ingestion", label="Inbox processing",
            status="healthy",
            subtitle="Auto-fetch disabled" if not fetch_enabled else _format_window_subtitle(tenant_settings),
        )

    now_utc = datetime.now(timezone.utc)
    if last_fetched.tzinfo is None:
        last_fetched = last_fetched.replace(tzinfo=timezone.utc)
    age_seconds = (now_utc - last_fetched).total_seconds()
    relative = _format_relative_age(last_fetched, now_utc)

    # Outside the fetch window (or with auto-fetch off) staleness is
    # expected. Show last-fetch info but stay healthy.
    if not fetch_enabled:
        return SystemHealthCheck(
            key="email_ingestion", label="Inbox processing",
            status="healthy", subtitle=f"Auto-fetch disabled · last fetch {relative}",
        )
    if not inside_window:
        return SystemHealthCheck(
            key="email_ingestion", label="Inbox processing",
            status="healthy",
            subtitle=f"{_format_window_subtitle(tenant_settings)} · last fetch {relative}",
        )

    # Attention threshold: 2x the configured fetch interval. A single
    # missed cycle is normal (workers retry); two missed in a row means
    # something is genuinely stuck.
    threshold_seconds = max(60, interval_minutes * 60 * 2)
    if age_seconds > threshold_seconds:
        return SystemHealthCheck(
            key="email_ingestion", label="Inbox processing",
            status="attention",
            subtitle=f"Last fetch {relative} · expected every {interval_minutes}m",
        )
    return SystemHealthCheck(
        key="email_ingestion", label="Inbox processing",
        status="healthy", subtitle=f"Last fetch {relative}",
    )


@router.get("/system-health", response_model=list[SystemHealthCheck])
async def get_system_health(
    db: AsyncSession = Depends(get_tenant_db),
    _: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> list[SystemHealthCheck]:
    """Aggregate operational status for the admin dashboard.

    Each check is independent and isolated: a failure in one (e.g. Redis
    down) does not mask the result of another. Each catches its own
    exceptions and returns a sentinel ``attention`` payload, so the
    response shape stays stable.

    The two DB-bound checks share a single session, so they run
    sequentially (AsyncSession does not support concurrent operations
    on the same session). Redis, which is independent of the session,
    runs concurrently with them.
    """
    redis_task = asyncio.create_task(_check_redis())
    database = await _check_database(db)
    email_ingestion = await _check_email_ingestion(db)
    redis_check = await redis_task
    return [database, redis_check, email_ingestion]


# ─────────────────────────────────────────────────────────────────────────────
# Tenant branding logo
#
# All three endpoints are tenant-scoped via Depends(get_tenant_db) — that
# session is wired to the caller's own per-tenant DB by app.core.deps, so
# an admin in tenant A literally cannot read or write tenant B's row.
# The upload path is also slug-scoped at the storage layer: the file
# lands under tenant-logos/<slug>/ where <slug> comes from the per-tenant
# Tenant row, never from a client-supplied field.
# ─────────────────────────────────────────────────────────────────────────────


# 2 MB cap. PDFs embed the logo, so keeping the file small keeps PDF
# downloads reasonable even when many employees are exported.
_LOGO_MAX_BYTES = 2 * 1024 * 1024


class TenantLogoStatus(BaseModel):
    has_logo: bool
    mime_type: str | None = None


def _resolve_tenant_for_logo(current_user: User) -> int:
    if not current_user.tenant_id:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="No tenant context.",
        )
    return current_user.tenant_id


@router.post("/tenant/logo", response_model=TenantLogoStatus)
async def upload_tenant_logo(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN")),
) -> TenantLogoStatus:
    """Upload (or replace) the current tenant's branding logo.

    Admin-only. The file is stored under
    ``tenant-logos/<authenticated-tenant-slug>/<uuid>.<ext>`` — the slug
    is read server-side from the per-tenant ``Tenant`` row, so a
    client-supplied path or slug cannot redirect the write to another
    tenant's prefix.
    """
    from app.services.storage import save_tenant_logo, delete_file

    tenant_id = _resolve_tenant_for_logo(current_user)
    tenant = await db.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="Tenant not found.",
        )

    content = await file.read()
    if not content:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Empty file.",
        )
    if len(content) > _LOGO_MAX_BYTES:
        raise HTTPException(
            status_code=http_status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Logo must be at most {_LOGO_MAX_BYTES // 1024 // 1024} MB.",
        )

    filename = file.filename or "logo"
    try:
        new_key = await save_tenant_logo(content, filename, tenant.slug)
    except ValueError as exc:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )

    # Delete the previous logo file (best-effort). The DB row is the
    # source of truth; a leftover orphan file is preferable to a row
    # pointing at a missing key, so we update the DB after the delete.
    old_key = tenant.logo_storage_key
    tenant.logo_storage_key = new_key
    tenant.logo_mime_type = (file.content_type or "").split(";")[0].strip() or None
    db.add(tenant)
    await db.commit()
    if old_key and old_key != new_key:
        try:
            await delete_file(old_key)
        except Exception as exc:  # noqa: BLE001
            logger.debug("Could not delete prior tenant logo %s: %s", old_key, exc)

    return TenantLogoStatus(has_logo=True, mime_type=tenant.logo_mime_type)


@router.get("/tenant/logo")
async def get_tenant_logo(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """Return the current tenant's logo bytes.

    Any authenticated user in the tenant can read the logo — it's
    branding, not sensitive. Returns 404 when no logo is set so the
    frontend can fall back to text rendering.
    """
    from app.services.storage import read_file

    tenant_id = _resolve_tenant_for_logo(current_user)
    tenant = await db.get(Tenant, tenant_id)
    if tenant is None or not tenant.logo_storage_key:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="No logo set.",
        )
    try:
        content = await read_file(tenant.logo_storage_key)
    except FileNotFoundError:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="Logo file missing.",
        )
    mime = tenant.logo_mime_type or "application/octet-stream"
    return Response(content=content, media_type=mime)


# ─────────────────────────────────────────────────────────────────────────────
# Approved ingestion timesheets — read-only summary for admin reporting.
#
# The Team Timesheets tab (Admin / Manager / Viewer) shows real TimeEntry
# rows plus a merge of "approved ingestion timesheets that have no line
# items" (summary-only PDFs whose data lives only on the ingestion row).
# The reviewer-queue endpoint at /ingestion/timesheets is gated to
# reviewers (Admin is explicitly excluded), so admins can't reach it.
# This endpoint is a narrower, admin-permissive read of approved-only
# timesheets used purely for that table merge. It returns the same
# IngestionTimesheetSummary shape so the existing frontend code keeps
# working.
# ─────────────────────────────────────────────────────────────────────────────


async def _verify_approved_ingestion_attachment(
    attachment_id: int, db: AsyncSession, current_user: User
):
    """Shared gate: attachment must belong to the caller's tenant AND
    have at least one approved ingestion timesheet referencing it.
    Returns the ``EmailAttachment`` row. Used by both the file and
    full-html admin endpoints below."""
    from app.models.email_attachment import EmailAttachment
    from app.models.ingested_email import IngestedEmail
    from app.models.ingestion_timesheet import IngestionTimesheet, IngestionTimesheetStatus

    attachment_result = await db.execute(
        select(EmailAttachment)
        .join(IngestedEmail, EmailAttachment.email_id == IngestedEmail.id)
        .where(
            (EmailAttachment.id == attachment_id)
            & (IngestedEmail.tenant_id == current_user.tenant_id)
        )
    )
    attachment = attachment_result.scalar_one_or_none()
    if attachment is None:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Attachment not found",
        )
    approved_exists = await db.execute(
        select(IngestionTimesheet.id).where(
            (IngestionTimesheet.attachment_id == attachment_id)
            & (IngestionTimesheet.tenant_id == current_user.tenant_id)
            & (IngestionTimesheet.status == IngestionTimesheetStatus.approved)
        ).limit(1)
    )
    if approved_exists.scalar_one_or_none() is None:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Attachment is not from an approved timesheet.",
        )
    return attachment


@router.get("/approved-ingestion-attachments/{attachment_id}/full-html")
async def get_approved_ingestion_attachment_html(
    attachment_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "MANAGER", "VIEWER", "PLATFORM_ADMIN")),
) -> dict:
    """Return the spreadsheet attachment rendered as HTML for inline
    preview in the Team Timesheets modal. Mirror of the reviewer
    /ingestion/attachments/{id}/full-html, gated to approved-ingestion
    rows only so admin doesn't gain reviewer-queue visibility."""
    from app.services.storage import read_file
    from app.services.xlsx_render import (
        render_csv_to_html,
        render_xls_to_html,
        render_xlsx_to_html,
    )

    attachment = await _verify_approved_ingestion_attachment(
        attachment_id, db, current_user,
    )
    mime = attachment.mime_type or ""
    if not ("openxmlformats" in mime or mime == "application/vnd.ms-excel" or "csv" in mime):
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Inline preview is only available for spreadsheets.",
        )
    try:
        file_bytes = await read_file(attachment.storage_key)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Attachment file not found",
        ) from exc
    rendered = None
    if "openxmlformats" in mime or mime.endswith(".sheet"):
        rendered = render_xlsx_to_html(file_bytes, bounded=False)
    elif mime == "application/vnd.ms-excel":
        rendered = render_xls_to_html(file_bytes, bounded=False)
    elif "csv" in mime:
        rendered = render_csv_to_html(file_bytes)
    if rendered is None:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to render attachment",
        )
    return {"html": rendered, "mime_type": mime, "filename": attachment.filename}


@router.get("/approved-ingestion-attachments/{attachment_id}/file")
async def get_approved_ingestion_attachment_file(
    attachment_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "MANAGER", "VIEWER", "PLATFORM_ADMIN")),
) -> Response:
    """Stream the original source file (PDF / Excel / image) for an
    attachment that belongs to an APPROVED ingestion timesheet.

    Reviewer-queue access stays gated separately at
    /ingestion/attachments/{id}/file. This admin-scoped path serves
    attachments only when an approved ingestion timesheet references
    them; pending/under-review queue artifacts remain reviewer-only.
    """
    from app.services.storage import read_file

    attachment = await _verify_approved_ingestion_attachment(
        attachment_id, db, current_user,
    )
    try:
        file_bytes = await read_file(attachment.storage_key)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="Attachment file not found",
        ) from exc
    return Response(
        content=file_bytes,
        media_type=attachment.mime_type or "application/octet-stream",
        headers={"Content-Disposition": f'inline; filename="{attachment.filename}"'},
    )


@router.get("/approved-ingestion-timesheets")
async def list_approved_ingestion_timesheets(
    employee_id: int | None = None,
    scope: str = "workspace",
    limit: int = 200,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "MANAGER", "VIEWER", "PLATFORM_ADMIN")),
) -> list[dict]:
    """Approved ingestion-pipeline timesheets for the Approved
    Timesheets surface (admin's User Management tab + manager's
    Approvals page tab).

    ``scope`` controls how the rows are filtered:

    * ``workspace`` (default) — every approved PDF in the tenant.
      Admins/viewers use this. Managers may use it too if they
      explicitly ask (e.g. via a "show all" toggle), but the frontend
      defaults to ``mine`` for non-admins.
    * ``mine`` — manager-scoped union: PDFs belonging to one of the
      manager's direct reports OR PDFs the manager personally
      reviewed. Pure-managers see this scope on their Approvals page.

    Admin/Platform-admin/Viewer always get workspace data even when
    ``scope=mine`` is sent, because they don't have the supervisor
    tree restriction. The redundancy is benign — the frontend just
    sends one consistent param and the backend decides.
    """
    from app.crud.ingestion_timesheet import list_ingestion_timesheets
    from app.api.ingestion import _timesheet_to_summary
    from app.models.assignments import EmployeeManagerAssignment
    from app.models.user import UserRole
    from sqlalchemy import select as _sa_select

    employee_ids: list[int] | None = None
    reviewer_id: int | None = None
    elevated_roles = {UserRole.ADMIN, UserRole.PLATFORM_ADMIN, UserRole.VIEWER}
    if scope == "mine" and current_user.role not in elevated_roles:
        # Resolve the manager's direct-report tree.
        descendants: set[int] = set()
        frontier: set[int] = {current_user.id}
        while frontier:
            result = await db.execute(
                _sa_select(EmployeeManagerAssignment.employee_id)
                .where(EmployeeManagerAssignment.manager_id.in_(frontier))
            )
            children = set(result.scalars().all())
            new_children = children - descendants
            descendants.update(new_children)
            frontier = new_children
        employee_ids = list(descendants)
        reviewer_id = current_user.id

    rows = await list_ingestion_timesheets(
        session=db,
        tenant_id=current_user.tenant_id,
        status="approved",
        employee_id=employee_id,
        employee_ids=employee_ids,
        reviewer_id=reviewer_id,
        limit=max(1, min(limit, 500)),
        offset=0,
    )
    return [_timesheet_to_summary(t) for t in rows]


@router.delete("/tenant/logo", response_model=TenantLogoStatus)
async def delete_tenant_logo(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN")),
) -> TenantLogoStatus:
    """Remove the current tenant's logo. Falls back to text rendering."""
    from app.services.storage import delete_file

    tenant_id = _resolve_tenant_for_logo(current_user)
    tenant = await db.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="Tenant not found.",
        )
    old_key = tenant.logo_storage_key
    tenant.logo_storage_key = None
    tenant.logo_mime_type = None
    db.add(tenant)
    await db.commit()
    if old_key:
        try:
            await delete_file(old_key)
        except Exception as exc:  # noqa: BLE001
            logger.debug("Could not delete tenant logo file %s: %s", old_key, exc)
    return TenantLogoStatus(has_logo=False)
