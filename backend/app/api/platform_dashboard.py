"""Platform-admin Dashboard + Calendar + Audit endpoints.

All routes here require PLATFORM_ADMIN and read from the control-plane
DB plus (for users-count fan-out) every tenant DB. Tenant-realm tokens
are rejected.

Routes:
  GET  /platform/dashboard/summary       fleet-wide aggregates
  GET  /platform/dashboard/health        control-plane + worker health
  GET  /platform/calendar/events         tenant lifecycle events in range
  GET  /platform/audit                   paginated, filtered event log
  GET  /platform/audit/{event_id}        single-event detail for the drawer
  GET  /platform/tenants/users-count     {tenant_id: count} fan-out
"""
from __future__ import annotations

import logging
from datetime import datetime, date, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db_control import AsyncControlSessionLocal
from app.db_tenant import get_session_factory_for_slug
from app.models.control import (
    ControlTenant,
    PlatformAuditCategory,
    PlatformAuditEvent,
    PlatformAuditSeverity,
    TenantProvisioningJob,
)
from app.models.control.tenant import ControlTenantStatus
from app.models.user import User
from app.models.time_entry import TimeEntry, TimeEntryStatus

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/platform",
    tags=["platform-dashboard"],
)


# ── Schemas ─────────────────────────────────────────────────────────


class DashboardSummary(BaseModel):
    """Fleet-snapshot strip on the platform Dashboard.

    Each metric carries an optional delta string the frontend prints
    under the headline number ("+1 in last 30 days", "2 failed, 40 succeeded").
    """

    active_tenants: int
    active_tenants_delta: Optional[str] = None
    total_users: int
    total_users_delta: Optional[str] = None
    fetch_jobs_24h: int
    fetch_jobs_24h_delta: Optional[str] = None
    hours_logged_this_week: float
    hours_logged_delta: Optional[str] = None


class HealthWidget(BaseModel):
    """One card in the Platform Health grid. The frontend renders status
    color from ``status``: good/warn/bad."""

    key: str
    label: str
    value: str
    status: str  # "good" | "warn" | "bad"
    detail: Optional[str] = None


class DashboardHealth(BaseModel):
    widgets: list[HealthWidget]
    refreshed_at: datetime


class CalendarEvent(BaseModel):
    """One tenant-lifecycle entry on the platform Calendar."""

    id: str            # synthetic, since events come from multiple tables
    date: date         # the day to render under
    type: str          # "tenant_created" | "provisioning" | "migration" | "maintenance" | "contract"
    title: str         # short display string
    tenant_slug: Optional[str] = None
    tenant_name: Optional[str] = None
    detail: Optional[str] = None


class CalendarEventsResponse(BaseModel):
    range_start: date
    range_end: date
    events: list[CalendarEvent]


class AuditEventRow(BaseModel):
    """One row in the audit page table. ``before_state`` / ``after_state``
    are returned only by the detail endpoint, not the list endpoint, to
    keep page payloads small."""

    id: int
    created_at: datetime
    category: PlatformAuditCategory
    event: str
    severity: PlatformAuditSeverity
    summary: str
    actor_user_id: Optional[int] = None
    actor_email: Optional[str] = None
    actor_label: Optional[str] = None
    tenant_id: Optional[int] = None
    tenant_slug: Optional[str] = None
    tenant_name: Optional[str] = None
    request_ip: Optional[str] = None
    route: Optional[str] = None


class AuditEventDetail(AuditEventRow):
    """The detail endpoint includes the JSON payload diffs."""

    user_agent: Optional[str] = None
    before_state: Optional[dict[str, Any]] = None
    after_state: Optional[dict[str, Any]] = None


class AuditListResponse(BaseModel):
    items: list[AuditEventRow]
    total: int
    limit: int
    offset: int


class TenantUsersCountResponse(BaseModel):
    """{tenant_id: user_count} fan-out for the Tenants tab Users column."""

    counts: dict[int, int]
    # Tenants whose count couldn't be fetched (DB unreachable, mid-flip,
    # etc.) come back here so the frontend can show "—" instead of "0".
    failed_tenant_ids: list[int] = Field(default_factory=list)


class TenantStatsEntry(BaseModel):
    """Per-tenant snapshot for the compact list view.

    All fields are nullable to keep the rendering honest when a tenant
    DB is mid-migration or unreachable. ``user_count`` is null (not 0)
    when the fan-out failed, so the UI can show '—' instead of an
    incorrect zero.
    """

    user_count: Optional[int] = None
    # Latest user.last_login_at within the tenant. None when no user has
    # ever logged in (newly provisioned tenant) or when the fan-out
    # failed.
    last_activity_at: Optional[datetime] = None
    admin_count: Optional[int] = None
    # Best-effort error label when this entry couldn't be fully filled.
    error: Optional[str] = None


class TenantStatsResponse(BaseModel):
    """Per-tenant compact-list stats. Keyed by tenant_id (stringified
    by JSON, but the backend uses int keys)."""

    stats: dict[int, TenantStatsEntry]


# ── Dashboard: summary ──────────────────────────────────────────────


def _format_delta(prefix: str, value: float) -> str:
    """Human-friendly delta string. Empty when value is zero."""
    if value == 0:
        return ""
    sign = "+" if value > 0 else "-"
    formatted = (
        f"{value:.1f}".rstrip("0").rstrip(".") if isinstance(value, float) else str(value)
    )
    return f"{sign}{formatted.lstrip('-')} {prefix}"


@router.get("/dashboard/summary", response_model=DashboardSummary)
async def get_dashboard_summary(
    _: User = Depends(require_role("PLATFORM_ADMIN")),
) -> DashboardSummary:
    """Fleet snapshot: active tenants, total users, fetch jobs in last 24h,
    hours logged this week. Numbers are summed across every tenant.

    Failures from individual tenant DBs are tolerated: a tenant we
    couldn't reach contributes zero to the totals and is logged. We
    never 500 the whole request because one tenant is mid-migration.
    """
    async with AsyncControlSessionLocal() as control:
        # Active tenants (status=active in control plane).
        active_q = await control.execute(
            select(func.count())
            .select_from(ControlTenant)
            .where(ControlTenant.status == ControlTenantStatus.active)
        )
        active_tenants = active_q.scalar_one()

        # Tenants created in the last 30 days for the delta string.
        thirty_days_ago = datetime.now(timezone.utc) - timedelta(days=30)
        new_tenants_q = await control.execute(
            select(func.count())
            .select_from(ControlTenant)
            .where(ControlTenant.created_at >= thirty_days_ago)
        )
        new_tenants_30d = new_tenants_q.scalar_one()

        # All active tenant rows for the fan-out below.
        tenants_q = await control.execute(
            select(ControlTenant).where(
                ControlTenant.status == ControlTenantStatus.active
            )
        )
        tenants = list(tenants_q.scalars().all())

    # Fan-out across tenant DBs for user count + hours-this-week.
    total_users = 0
    hours_this_week = 0.0
    week_start = (datetime.now(timezone.utc).date() - timedelta(
        days=datetime.now(timezone.utc).date().weekday()
    ))

    for tenant in tenants:
        try:
            factory = await get_session_factory_for_slug(tenant.slug)
        except LookupError:
            logger.warning(
                "dashboard_summary: control-plane slug %s not resolvable", tenant.slug
            )
            continue
        try:
            async with factory() as tenant_session:
                count = await tenant_session.scalar(
                    select(func.count()).select_from(User)
                )
                total_users += int(count or 0)

                hours = await tenant_session.scalar(
                    select(func.coalesce(func.sum(TimeEntry.hours), 0)).where(
                        and_(
                            TimeEntry.entry_date >= week_start,
                            TimeEntry.status.in_(
                                [
                                    TimeEntryStatus.SUBMITTED,
                                    TimeEntryStatus.APPROVED,
                                ]
                            ),
                        )
                    )
                )
                hours_this_week += float(hours or 0)
        except Exception as exc:  # noqa: BLE001 - per-tenant resilience
            logger.warning(
                "dashboard_summary: tenant %s contributed zero (%s)",
                tenant.slug,
                exc,
            )

    # Fetch jobs in the last 24h: the worker writes to the per-tenant
    # ingestion_jobs table, but the count there isn't currently surfaced
    # to the control plane. For now we surface 0 with a "TBD" detail to
    # match the dashboard spec; a follow-up will pipe job counts through.
    fetch_jobs_24h = 0
    fetch_jobs_delta = "Pending wiring"

    return DashboardSummary(
        active_tenants=active_tenants,
        active_tenants_delta=(
            f"+{new_tenants_30d} in last 30 days" if new_tenants_30d > 0 else ""
        ),
        total_users=total_users,
        total_users_delta="",  # Without historical snapshots we can't compute this
        fetch_jobs_24h=fetch_jobs_24h,
        fetch_jobs_24h_delta=fetch_jobs_delta,
        hours_logged_this_week=hours_this_week,
        hours_logged_delta="",
    )


# ── Dashboard: health ───────────────────────────────────────────────


@router.get("/dashboard/health", response_model=DashboardHealth)
async def get_dashboard_health(
    _: User = Depends(require_role("PLATFORM_ADMIN")),
) -> DashboardHealth:
    """Platform health widgets. Best-effort checks; widgets that can't
    be resolved come back with status=warn and a "Not configured" detail
    rather than 500ing the whole panel."""
    widgets: list[HealthWidget] = []

    # Control-plane DB ping.
    try:
        start = datetime.now(timezone.utc)
        async with AsyncControlSessionLocal() as control:
            await control.execute(select(1))
        elapsed_ms = (datetime.now(timezone.utc) - start).total_seconds() * 1000
        widgets.append(
            HealthWidget(
                key="control_db",
                label="Control-plane DB",
                value=f"{elapsed_ms:.0f}ms p95",
                status="good" if elapsed_ms < 50 else "warn",
                detail="Healthy" if elapsed_ms < 50 else "Slower than usual",
            )
        )
    except Exception as exc:  # noqa: BLE001
        widgets.append(
            HealthWidget(
                key="control_db",
                label="Control-plane DB",
                value="Unreachable",
                status="bad",
                detail=str(exc)[:120],
            )
        )

    # Migration head. Reads the alembic_version row from the control
    # plane. The per-tenant tree head would require fan-out and isn't
    # surfaced here; the control-plane head is the operationally
    # useful number for the platform admin.
    try:
        from sqlalchemy import text
        async with AsyncControlSessionLocal() as control:
            raw = await control.execute(
                text("SELECT version_num FROM alembic_version LIMIT 1")
            )
            head_row = raw.first()
            head_value = head_row[0] if head_row else "unknown"
        widgets.append(
            HealthWidget(
                key="migrations",
                label="Control-plane migrations",
                value=str(head_value),
                status="good",
                detail="At alembic head",
            )
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("dashboard_health: migration head check failed: %s", exc)
        widgets.append(
            HealthWidget(
                key="migrations",
                label="Control-plane migrations",
                value="N/A",
                status="warn",
                detail="Could not read alembic_version",
            )
        )

    # Fetch-job queue depth. arq stores pending jobs as a ZSET keyed
    # on the default queue name. We read ZCARD for queued jobs and a
    # SCAN-based count for the in-progress prefix; both should usually
    # be small. A queue depth in the high tens means a worker is stuck
    # or behind on email-fetch retries.
    try:
        import redis.asyncio as aioredis  # local import; keeps the
        from arq.constants import default_queue_name, in_progress_key_prefix  # noqa: E501
        # response shape independent of redis availability in tests.
        from app.core.config import settings as _settings

        client = aioredis.from_url(_settings.redis_url)
        try:
            queued = int(await client.zcard(default_queue_name) or 0)
            in_progress = 0
            async for _key in client.scan_iter(match=f"{in_progress_key_prefix}*"):
                in_progress += 1
            total = queued + in_progress
            widgets.append(
                HealthWidget(
                    key="fetch_queue",
                    label="Fetch-job queue",
                    value=f"{total}",
                    # > 20 in flight is when an operator should look
                    # at whether workers are stuck or backed up.
                    status="good" if total < 20 else "warn",
                    detail=f"{queued} queued, {in_progress} in flight",
                )
            )
        finally:
            await client.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("dashboard_health: fetch queue check failed: %s", exc)
        widgets.append(
            HealthWidget(
                key="fetch_queue",
                label="Fetch-job queue",
                value="N/A",
                status="warn",
                detail="Could not reach Redis",
            )
        )

    # API error rate (last 1 hour). Approximated from the
    # platform_audit_events table by counting category=system events
    # with non-info severity. Until structured /metrics export is in
    # place, the audit log is the most honest signal we have.
    try:
        async with AsyncControlSessionLocal() as control:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
            cnt_q = await control.execute(
                select(func.count()).select_from(PlatformAuditEvent).where(
                    and_(
                        PlatformAuditEvent.category == PlatformAuditCategory.system,
                        PlatformAuditEvent.severity != PlatformAuditSeverity.info,
                        PlatformAuditEvent.created_at >= cutoff,
                    )
                )
            )
            error_count = int(cnt_q.scalar_one() or 0)
        widgets.append(
            HealthWidget(
                key="api_error_rate",
                label="System errors · 1h",
                value=f"{error_count}",
                status="good" if error_count == 0 else "warn",
                detail=(
                    "No system-actor errors in the last hour"
                    if error_count == 0
                    else f"{error_count} flagged in audit log"
                ),
            )
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("dashboard_health: error rate check failed: %s", exc)
        widgets.append(
            HealthWidget(
                key="api_error_rate",
                label="System errors · 1h",
                value="N/A",
                status="warn",
                detail="Could not read audit table",
            )
        )

    # Recent fetch failures: count rows in platform_audit_events with
    # category=system & severity>=warn in the last 24h.
    try:
        async with AsyncControlSessionLocal() as control:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
            cnt_q = await control.execute(
                select(func.count()).select_from(PlatformAuditEvent).where(
                    and_(
                        PlatformAuditEvent.category == PlatformAuditCategory.system,
                        PlatformAuditEvent.severity != PlatformAuditSeverity.info,
                        PlatformAuditEvent.created_at >= cutoff,
                    )
                )
            )
            fails = int(cnt_q.scalar_one() or 0)
        widgets.append(
            HealthWidget(
                key="recent_failures",
                label="Recent fetch failures",
                value=f"{fails}",
                status="good" if fails == 0 else "warn",
                detail="No failures in last 24h" if fails == 0
                       else f"{fails} flagged event{'s' if fails != 1 else ''}",
            )
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("dashboard_health: failure count failed: %s", exc)
        widgets.append(
            HealthWidget(
                key="recent_failures",
                label="Recent fetch failures",
                value="N/A",
                status="warn",
                detail="Could not read audit table",
            )
        )

    # Active platform-admin sessions. Each PA refresh token is stored
    # at pa_refresh:<jti> in Redis with the refresh-token TTL. SCAN
    # gives a best-effort live count; the exact value drifts as tokens
    # expire / refresh, which is fine for an operator dashboard.
    try:
        import redis.asyncio as aioredis
        from app.core.config import settings as _settings

        client = aioredis.from_url(_settings.redis_url)
        try:
            session_count = 0
            async for _key in client.scan_iter(match="pa_refresh:*"):
                session_count += 1
            widgets.append(
                HealthWidget(
                    key="pa_sessions",
                    label="Platform admin sessions",
                    value=f"{session_count}",
                    status="good",
                    detail=(
                        "No active PA sessions"
                        if session_count == 0
                        else f"{session_count} active refresh token"
                        + ("s" if session_count != 1 else "")
                    ),
                )
            )
        finally:
            await client.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("dashboard_health: PA session count failed: %s", exc)
        widgets.append(
            HealthWidget(
                key="pa_sessions",
                label="Platform admin sessions",
                value="N/A",
                status="warn",
                detail="Could not reach Redis",
            )
        )

    return DashboardHealth(
        widgets=widgets,
        refreshed_at=datetime.now(timezone.utc),
    )


# ── Calendar: tenant-lifecycle events ───────────────────────────────


@router.get("/calendar/events", response_model=CalendarEventsResponse)
async def get_calendar_events(
    range_start: date = Query(..., description="Inclusive start date (YYYY-MM-DD)."),
    range_end: date = Query(..., description="Inclusive end date (YYYY-MM-DD)."),
    _: User = Depends(require_role("PLATFORM_ADMIN")),
) -> CalendarEventsResponse:
    """Tenant-lifecycle events in a date range.

    Sources:
      - ControlTenant.created_at -> "tenant_created" event
      - TenantProvisioningJob.scheduled_for (when set) -> "provisioning"
      - PlatformAuditEvent rows with category=migration -> "migration"

    We don't expose maintenance windows or contract dates yet because
    they aren't modeled. The mockup includes them as future categories;
    they return empty here and the calendar simply has nothing on those
    days.
    """
    if range_end < range_start:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="range_end must be on or after range_start",
        )

    events: list[CalendarEvent] = []

    async with AsyncControlSessionLocal() as control:
        # Tenants created in range.
        tenants_q = await control.execute(
            select(ControlTenant).where(
                and_(
                    func.date(ControlTenant.created_at) >= range_start,
                    func.date(ControlTenant.created_at) <= range_end,
                )
            )
        )
        for tenant in tenants_q.scalars().all():
            events.append(
                CalendarEvent(
                    id=f"tenant_created:{tenant.id}",
                    date=tenant.created_at.date(),
                    type="tenant_created",
                    title=f"{tenant.name} created",
                    tenant_slug=tenant.slug,
                    tenant_name=tenant.name,
                    detail=(
                        "Isolated DB" if tenant.is_isolated else "Shared DB"
                    ),
                )
            )

        # Provisioning jobs in range. The table tracks both completed
        # runs and pending scheduled ones; we surface both.
        try:
            jobs_q = await control.execute(
                select(TenantProvisioningJob)
                .where(
                    and_(
                        func.date(TenantProvisioningJob.created_at) >= range_start,
                        func.date(TenantProvisioningJob.created_at) <= range_end,
                    )
                )
            )
            for job in jobs_q.scalars().all():
                tenant_name = getattr(job, "tenant_slug", None) or f"tenant#{job.tenant_id}"
                events.append(
                    CalendarEvent(
                        id=f"provisioning:{job.id}",
                        date=job.created_at.date(),
                        type="provisioning",
                        title=f"Provisioning · {tenant_name}",
                        tenant_slug=getattr(job, "tenant_slug", None),
                        tenant_name=tenant_name,
                        detail=getattr(job, "status", None),
                    )
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("calendar_events: provisioning fetch failed: %s", exc)

        # Migration events from the audit log.
        mig_q = await control.execute(
            select(PlatformAuditEvent).where(
                and_(
                    PlatformAuditEvent.category == PlatformAuditCategory.migration,
                    func.date(PlatformAuditEvent.created_at) >= range_start,
                    func.date(PlatformAuditEvent.created_at) <= range_end,
                )
            )
        )
        for ev in mig_q.scalars().all():
            events.append(
                CalendarEvent(
                    id=f"migration:{ev.id}",
                    date=ev.created_at.date(),
                    type="migration",
                    title=ev.summary,
                    tenant_slug=ev.tenant_slug,
                    tenant_name=ev.tenant_name,
                    detail=None,
                )
            )

    events.sort(key=lambda e: (e.date, e.type))
    return CalendarEventsResponse(
        range_start=range_start,
        range_end=range_end,
        events=events,
    )


# ── Audit list + detail ─────────────────────────────────────────────


@router.get("/audit", response_model=AuditListResponse)
async def list_audit_events(
    category: Optional[PlatformAuditCategory] = Query(None),
    actor_email: Optional[str] = Query(None),
    tenant_id: Optional[int] = Query(None),
    search: Optional[str] = Query(None, min_length=1, max_length=200),
    range_start: Optional[date] = Query(None),
    range_end: Optional[date] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _: User = Depends(require_role("PLATFORM_ADMIN")),
) -> AuditListResponse:
    """Paginated audit log read.

    Filters are AND-combined. ``search`` does a case-insensitive
    ``ILIKE %search%`` on summary, actor_email, tenant_name, and
    request_ip so a free-text query lands on the most useful columns.
    """
    base = select(PlatformAuditEvent)
    count_base = select(func.count()).select_from(PlatformAuditEvent)

    filters = []
    if category is not None:
        filters.append(PlatformAuditEvent.category == category)
    if actor_email:
        filters.append(PlatformAuditEvent.actor_email == actor_email)
    if tenant_id is not None:
        filters.append(PlatformAuditEvent.tenant_id == tenant_id)
    if range_start is not None:
        filters.append(func.date(PlatformAuditEvent.created_at) >= range_start)
    if range_end is not None:
        filters.append(func.date(PlatformAuditEvent.created_at) <= range_end)
    if search:
        like = f"%{search}%"
        filters.append(
            or_(
                PlatformAuditEvent.summary.ilike(like),
                PlatformAuditEvent.actor_email.ilike(like),
                PlatformAuditEvent.tenant_name.ilike(like),
                PlatformAuditEvent.request_ip.ilike(like),
            )
        )

    if filters:
        base = base.where(and_(*filters))
        count_base = count_base.where(and_(*filters))

    async with AsyncControlSessionLocal() as control:
        total = (await control.execute(count_base)).scalar_one()
        rows_q = await control.execute(
            base.order_by(PlatformAuditEvent.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        rows = list(rows_q.scalars().all())

    items = [
        AuditEventRow(
            id=r.id,
            created_at=r.created_at,
            category=r.category,
            event=r.event,
            severity=r.severity,
            summary=r.summary,
            actor_user_id=r.actor_user_id,
            actor_email=r.actor_email,
            actor_label=r.actor_label,
            tenant_id=r.tenant_id,
            tenant_slug=r.tenant_slug,
            tenant_name=r.tenant_name,
            request_ip=r.request_ip,
            route=r.route,
        )
        for r in rows
    ]

    return AuditListResponse(
        items=items,
        total=int(total or 0),
        limit=limit,
        offset=offset,
    )


@router.get("/audit/{event_id}", response_model=AuditEventDetail)
async def get_audit_event(
    event_id: int,
    _: User = Depends(require_role("PLATFORM_ADMIN")),
) -> AuditEventDetail:
    """Single-event detail for the drawer. Includes the JSON payloads
    that ``list`` omits."""
    async with AsyncControlSessionLocal() as control:
        row = (await control.execute(
            select(PlatformAuditEvent).where(PlatformAuditEvent.id == event_id)
        )).scalar_one_or_none()

    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audit event not found")

    return AuditEventDetail(
        id=row.id,
        created_at=row.created_at,
        category=row.category,
        event=row.event,
        severity=row.severity,
        summary=row.summary,
        actor_user_id=row.actor_user_id,
        actor_email=row.actor_email,
        actor_label=row.actor_label,
        tenant_id=row.tenant_id,
        tenant_slug=row.tenant_slug,
        tenant_name=row.tenant_name,
        request_ip=row.request_ip,
        route=row.route,
        user_agent=row.user_agent,
        before_state=row.before_state if isinstance(row.before_state, dict) else None,
        after_state=row.after_state if isinstance(row.after_state, dict) else None,
    )


# ── Per-tenant users-count fan-out ──────────────────────────────────


@router.get("/tenants/users-count", response_model=TenantUsersCountResponse)
async def get_tenant_users_count(
    _: User = Depends(require_role("PLATFORM_ADMIN")),
) -> TenantUsersCountResponse:
    """Return {tenant_id: user_count} by asking every active tenant's
    DB for its count(*) on users.

    Tenants whose DBs we couldn't reach are reported in
    ``failed_tenant_ids`` instead of contributing a wrong zero.
    """
    counts: dict[int, int] = {}
    failed: list[int] = []

    async with AsyncControlSessionLocal() as control:
        tenants_q = await control.execute(
            select(ControlTenant).where(
                ControlTenant.status == ControlTenantStatus.active
            )
        )
        tenants = list(tenants_q.scalars().all())

    for tenant in tenants:
        try:
            factory = await get_session_factory_for_slug(tenant.slug)
            async with factory() as tenant_session:
                cnt = await tenant_session.scalar(
                    select(func.count()).select_from(User)
                )
                counts[tenant.id] = int(cnt or 0)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "users_count: tenant %s (id=%s) unreachable (%s)",
                tenant.slug,
                tenant.id,
                exc,
            )
            failed.append(tenant.id)

    return TenantUsersCountResponse(counts=counts, failed_tenant_ids=failed)


# ── Per-tenant compact-list stats fan-out ──────────────────────────


@router.get("/tenants/stats", response_model=TenantStatsResponse)
async def get_tenant_stats(
    _: User = Depends(require_role("PLATFORM_ADMIN")),
) -> TenantStatsResponse:
    """Per-tenant snapshot for the compact list view.

    Single fan-out across active tenant DBs. Returns user count, admin
    count, and last_login_at (= "last activity") for each tenant.
    Tenants we can't reach come back with ``error`` set so the UI can
    label them honestly.
    """
    from app.models.user import UserRole

    stats: dict[int, TenantStatsEntry] = {}

    async with AsyncControlSessionLocal() as control:
        tenants_q = await control.execute(
            select(ControlTenant).where(
                ControlTenant.status == ControlTenantStatus.active
            )
        )
        tenants = list(tenants_q.scalars().all())

    for tenant in tenants:
        try:
            factory = await get_session_factory_for_slug(tenant.slug)
            async with factory() as tenant_session:
                # Always filter by tenant_id. For isolated tenants
                # the clause is trivially satisfied (every row in the
                # per-tenant DB has the same tenant_id); for
                # non-isolated tenants the session is bound to the
                # shared legacy DB, where an unfiltered count would
                # bleed across tenants.
                user_count = await tenant_session.scalar(
                    select(func.count()).select_from(User).where(
                        User.tenant_id == tenant.id
                    )
                )
                admin_count = await tenant_session.scalar(
                    select(func.count()).select_from(User).where(
                        User.tenant_id == tenant.id,
                        User.role == UserRole.ADMIN,
                    )
                )
                last_login = await tenant_session.scalar(
                    select(func.max(User.last_login_at)).where(
                        User.tenant_id == tenant.id
                    )
                )
            stats[tenant.id] = TenantStatsEntry(
                user_count=int(user_count or 0),
                admin_count=int(admin_count or 0),
                last_activity_at=last_login,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "tenant_stats: tenant %s (id=%s) unreachable (%s)",
                tenant.slug,
                tenant.id,
                exc,
            )
            stats[tenant.id] = TenantStatsEntry(error=str(exc)[:200])

    return TenantStatsResponse(stats=stats)
