from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Optional
import time as time_module

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.deps import get_current_user, get_tenant_db, require_role
from app.core.permissions import shadow_check
from app.core.timezone_utils import combine_tenant, now_for_tenant
from app.models.assignments import EmployeeManagerAssignment
from app.models.activity_log import ActivityLog
from app.models.client import Client
from app.models.project import Project
from app.models.tenant import Tenant
from app.models.time_entry import TimeEntry, TimeEntryStatus
from app.models.time_off_request import TimeOffRequest, TimeOffStatus
from app.models.user import User, UserRole
from app.schemas import (
    DashboardActivity,
    DashboardAnalyticsResponse,
    DashboardBarEntryDetail,
    DashboardDayBreakdownDetailed,
    DashboardDayProjectSegment,
    DashboardProjectBreakdown,
    DashboardRecentActivityItem,
    DashboardSummaryResponse,
    ManagerProjectHealthResponse,
    ManagerFinancialsResponse, FinancialSummary, ProjectFinancialRow,
    MyWorkResponse, MyWorkClient, MyWorkProject, MyWorkTask,
    ManagerProjectHealthRow,
    ManagerTeamCapacityEntry,
    ManagerTeamMemberStatus,
    ManagerTeamOverviewResponse,
    TeamBillableRow,
    TeamBillableStatsResponse,
    TeamOnTimeRow,
    TeamOnTimeStatsResponse,
    TeamOnTimeWeek,
    TeamProjectMatrixCell,
    TeamProjectMatrixProject,
    TeamProjectMatrixResponse,
    TeamProjectMatrixRow,
    TeamDailyOverviewResponse,
    TeamRejectionReason,
    TeamRejectionRow,
    TeamRejectionStatsResponse,
    UserResponse,
)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


async def _get_managed_employee_ids(db: AsyncSession, manager_id: int, as_of: Optional[date] = None) -> list[int]:
    query = select(EmployeeManagerAssignment.employee_id).where(
        EmployeeManagerAssignment.manager_id == manager_id
    )
    if as_of is not None:
        # Historical "as_of end-of-day" filter, not current wall-clock deadline
        # math. This intentionally stays date-scoped rather than tenant-now based.
        query = query.where(EmployeeManagerAssignment.created_at <=
                            datetime.combine(as_of, time.max))
    result = await db.execute(query)
    return list(result.scalars().all())


async def _get_managed_active_employee_ids(db: AsyncSession, manager_id: int, as_of: Optional[date] = None) -> list[int]:
    query = (
        select(User.id)
        .join(EmployeeManagerAssignment, EmployeeManagerAssignment.employee_id == User.id)
        .where(
            EmployeeManagerAssignment.manager_id == manager_id,
            User.role == UserRole.EMPLOYEE,
            User.is_active.is_(True),
        )
    )
    if as_of is not None:
        # Historical "as_of end-of-day" filter, not current wall-clock deadline
        # math. This intentionally stays date-scoped rather than tenant-now based.
        query = query.where(EmployeeManagerAssignment.created_at <=
                            datetime.combine(as_of, time.max))
    result = await db.execute(query)
    return list(result.scalars().all())


async def _get_direct_active_report_ids(db: AsyncSession, manager_id: int, as_of: Optional[date] = None) -> list[int]:
    """Active users in the manager's report tree.

    Matches the /user-management tree walk (BFS over EmployeeManagerAssignment),
    so the dashboard's team view sees the same people the manager sees on
    their My Team page: direct reports plus everyone below them (any internal
    role). External users are excluded — they aren't part of the internal org.
    """
    descendant_ids: set[int] = set()
    frontier: set[int] = {manager_id}
    while frontier:
        sub_query = (
            select(EmployeeManagerAssignment.employee_id)
            .where(EmployeeManagerAssignment.manager_id.in_(frontier))
        )
        if as_of is not None:
            sub_query = sub_query.where(
                EmployeeManagerAssignment.created_at <= datetime.combine(as_of, time.max)
            )
        result = await db.execute(sub_query)
        children = set(result.scalars().all())
        next_frontier = children - descendant_ids
        descendant_ids.update(next_frontier)
        frontier = next_frontier

    if not descendant_ids:
        return []

    active_result = await db.execute(
        select(User.id).where(
            User.id.in_(descendant_ids),
            User.is_active.is_(True),
            # External users (clients/contractors) aren't part of a manager's
            # internal team; exclude them so the dashboard team view matches the
            # 'My Team' page (which also filters externals).
            User.is_external.is_(False),
        )
    )
    return list(active_result.scalars().all())


async def _get_scoped_employee_ids(db: AsyncSession, current_user: "User") -> list[int]:
    """Return the list of active employee IDs that are in scope for the given user.

    - MANAGER: direct active employee reports only.
    - VIEWER / ADMIN: all active employees in the tenant.
    """
    if current_user.role == UserRole.MANAGER:
        return await _get_direct_active_report_ids(db, current_user.id)

    # VIEWER / ADMIN – whole tenant
    return await _get_all_active_employee_ids(db, tenant_id=current_user.tenant_id)


async def _filter_managed_project_ids(
    db: AsyncSession, project_ids: list[int], tenant_id: Optional[int]
) -> list[int]:
    """Keep only projects that have a manager/PM assigned.

    A real live engagement has either a direct ``manager_id`` or at least one
    ``project_managers`` row. Unassigned seed/abandoned projects carry stray
    historical time but aren't owned by anyone, so dashboard widgets that claim
    to show "the team's projects" should exclude them (authorship). Preserves
    the input ordering.
    """
    if not project_ids:
        return []
    from app.models.assignments import ProjectManager

    has_direct = set((await db.execute(
        select(Project.id).where(
            Project.id.in_(project_ids),
            Project.manager_id.is_not(None),
        )
    )).scalars().all())
    has_pm = set((await db.execute(
        select(ProjectManager.project_id).where(
            ProjectManager.project_id.in_(project_ids)
        ).distinct()
    )).scalars().all())
    managed = has_direct | has_pm
    return [pid for pid in project_ids if pid in managed]


async def _get_all_active_employee_ids(db: AsyncSession, tenant_id: Optional[int] = None) -> list[int]:
    query = select(User.id).where(
        User.role == UserRole.EMPLOYEE,
        User.is_active.is_(True),
    )
    if tenant_id is not None:
        query = query.where(User.tenant_id == tenant_id)
    result = await db.execute(query)
    return list(result.scalars().all())


async def _get_all_active_user_ids(db: AsyncSession, tenant_id: int) -> list[int]:
    query = select(User.id).where(User.is_active.is_(True))
    query = query.where(User.tenant_id == tenant_id)
    result = await db.execute(query)
    return list(result.scalars().all())


def _week_start(value: date, week_start_day: int = 0) -> date:
    """0=Sunday, 1=Monday."""
    py_weekday = value.weekday()
    offset = (py_weekday + 1) % 7 if week_start_day == 0 else py_weekday
    return value - timedelta(days=offset)


async def _count_pending_timesheet_weeks(
    db: AsyncSession,
    tenant_id: int,
    user_ids: list[int] | None = None,
) -> int:
    from app.crud.time_entry import _tenant_week_start_day
    wsd = await _tenant_week_start_day(db, tenant_id)
    query = select(TimeEntry.user_id, TimeEntry.entry_date).where(
        TimeEntry.status == TimeEntryStatus.SUBMITTED
    )
    if user_ids is not None:
        if not user_ids:
            return 0
        query = query.where(TimeEntry.user_id.in_(user_ids))

    result = await db.execute(query)
    pending_weeks = {
        (user_id, _week_start(entry_date, wsd))
        for user_id, entry_date in result.all()
    }
    return len(pending_weeks)


def _previous_working_day(reference: date) -> date:
    candidate = reference - timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate -= timedelta(days=1)
    return candidate


def _next_working_day(reference: date) -> date:
    candidate = reference + timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate += timedelta(days=1)
    return candidate


@router.get("/summary", response_model=DashboardSummaryResponse)
async def get_dashboard_summary(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    hours_logged_timesheet = await db.scalar(
        select(func.coalesce(func.sum(TimeEntry.hours), 0)).where(
            (TimeEntry.user_id == current_user.id)
            & (TimeEntry.status.in_([TimeEntryStatus.DRAFT, TimeEntryStatus.SUBMITTED, TimeEntryStatus.APPROVED]))
        )
    )
    hours_logged_time_off = await db.scalar(
        select(func.coalesce(func.sum(TimeOffRequest.hours), 0)).where(
            (TimeOffRequest.user_id == current_user.id)
            & (TimeOffRequest.status.in_([TimeOffStatus.DRAFT, TimeOffStatus.SUBMITTED, TimeOffStatus.APPROVED]))
        )
    )

    approved_timesheet = await db.scalar(
        select(func.coalesce(func.sum(TimeEntry.hours), 0)).where(
            (TimeEntry.user_id == current_user.id) & (
                TimeEntry.status == TimeEntryStatus.APPROVED)
        )
    )
    approved_time_off = await db.scalar(
        select(func.coalesce(func.sum(TimeOffRequest.hours), 0)).where(
            (TimeOffRequest.user_id == current_user.id) & (
                TimeOffRequest.status == TimeOffStatus.APPROVED)
        )
    )

    pending_timesheet = await db.scalar(
        select(func.coalesce(func.sum(TimeEntry.hours), 0)).where(
            (TimeEntry.user_id == current_user.id) & (
                TimeEntry.status == TimeEntryStatus.SUBMITTED)
        )
    )
    pending_time_off = await db.scalar(
        select(func.coalesce(func.sum(TimeOffRequest.hours), 0)).where(
            (TimeOffRequest.user_id == current_user.id) & (
                TimeOffRequest.status == TimeOffStatus.SUBMITTED)
        )
    )

    pending_approvals = 0
    team_members = 0
    if current_user.role in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        scoped_employee_ids = await _get_scoped_employee_ids(db, current_user)

        pending_time_entries_count = await _count_pending_timesheet_weeks(
            db,
            current_user.tenant_id,
            scoped_employee_ids,
        )
        if scoped_employee_ids:
            pending_time_off_count = await db.scalar(
                select(func.count(TimeOffRequest.id)).where(
                    TimeOffRequest.status == TimeOffStatus.SUBMITTED,
                    TimeOffRequest.user_id.in_(scoped_employee_ids),
                )
            )
        else:
            pending_time_off_count = 0

        pending_approvals = int(
            pending_time_entries_count or 0) + int(pending_time_off_count or 0)
        team_members = len(scoped_employee_ids)

    return DashboardSummaryResponse(
        hours_logged=Decimal(str(hours_logged_timesheet or 0)) +
        Decimal(str(hours_logged_time_off or 0)),
        approved_hours=Decimal(str(approved_timesheet or 0)) +
        Decimal(str(approved_time_off or 0)),
        pending_hours=Decimal(str(pending_timesheet or 0)) +
        Decimal(str(pending_time_off or 0)),
        pending_approvals=pending_approvals,
        team_members=team_members,
    )


@router.get("/team", response_model=list[UserResponse])
async def get_dashboard_team(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        return []

    if current_user.role in [UserRole.MANAGER]:
        managed_user_ids = await _get_scoped_employee_ids(db, current_user)
        if not managed_user_ids:
            return []
        query = select(User).where(User.id.in_(managed_user_ids)).where(User.is_active.is_(True))
    else:
        query = select(User).where(
            (User.role == UserRole.EMPLOYEE)
            & (User.is_active.is_(True))
            & (User.tenant_id == current_user.tenant_id)
        )

    result = await db.execute(
        query
        .options(
            selectinload(User.manager_assignment),
            selectinload(User.project_access),
            selectinload(User.task_access),
        )
        .order_by(User.full_name.asc())
    )
    return result.scalars().all()


@router.get("/team-daily-overview", response_model=TeamDailyOverviewResponse)
async def get_team_daily_overview(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    # Load tenant.timezone for deadline math. ``get_current_user`` does not
    # eagerload the tenant, so a targeted ``db.get`` keeps this endpoint the
    # only thing that pays for the extra fetch.
    tenant_timezone: Optional[str] = None
    if current_user.tenant_id is not None:
        tenant = await db.get(Tenant, current_user.tenant_id)
        if tenant is not None:
            tenant_timezone = tenant.timezone

    # Daily submission cutoff time — settings-driven (catalog key added in
    # Tier 1 WS1). Falls back to 10:00 if the row is missing or malformed.
    deadline_time = time(hour=10, minute=0)
    if current_user.tenant_id is not None:
        from app.core.tenant_settings import get_setting

        try:
            raw = await get_setting(
                db, current_user.tenant_id, "daily_submission_deadline_time"
            )
            if isinstance(raw, str) and ":" in raw:
                hh, mm = raw.split(":", 1)
                deadline_time = time(hour=int(hh), minute=int(mm))
        except (KeyError, ValueError):
            pass

    now = now_for_tenant(tenant_timezone)
    target_date = _previous_working_day(now.date())
    deadline_day = _next_working_day(target_date)
    submission_deadline_at = combine_tenant(
        deadline_day, deadline_time, tenant_timezone
    )
    has_time_remaining_until_deadline = now < submission_deadline_at

    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        # Note: a local loop variable named ``status`` later in this function
        # shadows the ``fastapi.status`` import, so use the numeric constant.
        raise HTTPException(
            status_code=403,
            detail="This endpoint is not available for your role",
        )

    team_member_ids = await _get_scoped_employee_ids(db, current_user)

    if not team_member_ids:
        return TeamDailyOverviewResponse(
            date=target_date,
            submission_deadline_at=submission_deadline_at,
            has_time_remaining_until_deadline=has_time_remaining_until_deadline,
            team_size=0,
            submitted_yesterday_count=0,
            submitted_yesterday=[],
            draft_yesterday_count=0,
            draft_yesterday=[],
            missing_yesterday_count=0,
            missing_yesterday=[],
            pending_approvals_count=0,
            pending_time_entries_count=0,
            pending_time_off_count=0,
            total_hours_logged_yesterday=Decimal("0"),
        )

    team_result = await db.execute(
        select(User)
        .where(User.id.in_(team_member_ids))
        .order_by(User.full_name.asc())
    )
    team_members = list(team_result.scalars().all())

    day_status_result = await db.execute(
        select(TimeEntry.user_id, TimeEntry.status)
        .where(
            TimeEntry.user_id.in_(team_member_ids),
            TimeEntry.entry_date == target_date,
        )
    )

    status_by_user: dict[int, set[TimeEntryStatus]] = {
        member.id: set() for member in team_members}
    for user_id, status in day_status_result.all():
        status_by_user.setdefault(user_id, set()).add(status)

    submitted_users: list[User] = []
    draft_users: list[User] = []
    missing_users: list[User] = []
    for member in team_members:
        statuses = status_by_user.get(member.id, set())
        if TimeEntryStatus.SUBMITTED in statuses or TimeEntryStatus.APPROVED in statuses:
            submitted_users.append(member)
        elif has_time_remaining_until_deadline:
            draft_users.append(member)
        else:
            missing_users.append(member)

    pending_time_entries_count = await _count_pending_timesheet_weeks(db, current_user.tenant_id, team_member_ids)
    pending_time_off_count = int(
        (await db.scalar(
            select(func.count(TimeOffRequest.id)).where(
                TimeOffRequest.user_id.in_(team_member_ids),
                TimeOffRequest.status == TimeOffStatus.SUBMITTED,
            )
        ))
        or 0
    )
    total_hours_logged_yesterday = Decimal(
        str(
            (await db.scalar(
                select(func.coalesce(func.sum(TimeEntry.hours), 0)).where(
                    TimeEntry.user_id.in_(team_member_ids),
                    TimeEntry.entry_date == target_date,
                    TimeEntry.status.in_(
                        [TimeEntryStatus.SUBMITTED, TimeEntryStatus.APPROVED]),
                )
            ))
            or 0
        )
    )

    return TeamDailyOverviewResponse(
        date=target_date,
        submission_deadline_at=submission_deadline_at,
        has_time_remaining_until_deadline=has_time_remaining_until_deadline,
        team_size=len(team_members),
        submitted_yesterday_count=len(submitted_users),
        submitted_yesterday=submitted_users,
        draft_yesterday_count=len(draft_users),
        draft_yesterday=draft_users,
        missing_yesterday_count=len(missing_users),
        missing_yesterday=missing_users,
        pending_approvals_count=pending_time_entries_count + pending_time_off_count,
        pending_time_entries_count=pending_time_entries_count,
        pending_time_off_count=pending_time_off_count,
        total_hours_logged_yesterday=total_hours_logged_yesterday,
    )


@router.get("/analytics", response_model=DashboardAnalyticsResponse)
async def get_dashboard_analytics(
    start_date: date = Query(...),
    end_date: date = Query(...),
    project_id: Optional[int] = Query(None),
    user_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    # Bound the date span. Without this an attacker could request
    # 1900-01-01..2100-12-31 and force a full-table scan/aggregate. 366 days
    # matches the `days_back <= 365` cap the other dashboard endpoints use.
    # Numeric code on purpose: a local var named ``status`` shadows the
    # fastapi.status import elsewhere in this module (see note above).
    if end_date < start_date:
        raise HTTPException(
            status_code=400,
            detail="end_date must be on or after start_date.",
        )
    if (end_date - start_date).days > 366:
        raise HTTPException(
            status_code=400,
            detail="Date range too large; limit analytics to at most 366 days.",
        )

    target_user_ids = [current_user.id]
    if current_user.role in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        scoped_user_ids = await _get_scoped_employee_ids(db, current_user)

        if user_id is not None:
            if user_id in scoped_user_ids:
                target_user_ids = [user_id]
            elif user_id == current_user.id:
                target_user_ids = [current_user.id]
            else:
                target_user_ids = []
        else:
            target_user_ids = scoped_user_ids

    filters = [
        TimeEntry.user_id.in_(target_user_ids),
        TimeEntry.entry_date >= start_date,
        TimeEntry.entry_date <= end_date,
        # Exclude REJECTED entries: rejected time is not real work and must not
        # inflate logged/billable totals. DRAFT and SUBMITTED stay in — for a
        # personal "my hours" view, in-progress work the user has logged is
        # expected to count.
        TimeEntry.status != TimeEntryStatus.REJECTED,
    ]
    if project_id is not None:
        filters.append(TimeEntry.project_id == project_id)

    total_hours = await db.scalar(
        select(func.coalesce(func.sum(TimeEntry.hours), 0)).where(*filters)
    )

    billable_hours = await db.scalar(
        select(func.coalesce(func.sum(TimeEntry.hours), 0)).where(
            *filters, TimeEntry.is_billable == True  # noqa: E712
        )
    )
    non_billable_hours = Decimal(
        str(total_hours or 0)) - Decimal(str(billable_hours or 0))

    daily_result = await db.execute(
        select(TimeEntry.entry_date, func.sum(TimeEntry.hours).label("hours"))
        .where(*filters)
        .group_by(TimeEntry.entry_date)
        .order_by(TimeEntry.entry_date.asc())
    )
    daily_map = {row.entry_date: Decimal(
        str(row.hours)) for row in daily_result.all()}

    daily_segment_result = await db.execute(
        select(
            TimeEntry.id,
            TimeEntry.entry_date,
            TimeEntry.hours,
            TimeEntry.status,
            TimeEntry.description,
            Project.id.label("project_id"),
            Project.name.label("project_name"),
            Client.name.label("client_name"),
        )
        .join(Project, TimeEntry.project_id == Project.id)
        .join(Client, Project.client_id == Client.id)
        .where(*filters)
        .order_by(TimeEntry.entry_date.asc(), Project.name.asc(), TimeEntry.id.asc())
    )

    segment_map: dict[date, dict[int, DashboardDayProjectSegment]] = {}
    for row in daily_segment_result.all():
        day_segments = segment_map.setdefault(row.entry_date, {})
        existing_segment = day_segments.get(row.project_id)
        if existing_segment is None:
            existing_segment = DashboardDayProjectSegment(
                project_id=row.project_id,
                project_name=row.project_name,
                client_name=row.client_name,
                hours=Decimal("0"),
                entries=[],
            )
            day_segments[row.project_id] = existing_segment

        entry_hours = Decimal(str(row.hours or 0))
        existing_segment.hours = Decimal(
            str(existing_segment.hours)) + entry_hours
        existing_segment.entries.append(
            DashboardBarEntryDetail(
                entry_id=row.id,
                project_id=row.project_id,
                project_name=row.project_name,
                client_name=row.client_name,
                status=row.status.value,
                description=row.description or "(no description)",
                hours=entry_hours,
                entry_date=row.entry_date,
            )
        )

    daily_breakdown: list[DashboardDayBreakdownDetailed] = []
    current_day = start_date
    while current_day <= end_date:
        day_segments = list(segment_map.get(current_day, {}).values())
        day_segments.sort(key=lambda segment: segment.project_name.lower())
        daily_breakdown.append(
            DashboardDayBreakdownDetailed(
                entry_date=current_day,
                hours=daily_map.get(current_day, Decimal("0")),
                formatted_date=current_day.strftime("%a, %b %d"),
                segments=day_segments,
            )
        )
        current_day += timedelta(days=1)

    project_result = await db.execute(
        select(
            Project.id,
            Project.name,
            Client.name.label("client_name"),
            func.sum(TimeEntry.hours).label("hours"),
        )
        .join(Project, TimeEntry.project_id == Project.id)
        .join(Client, Project.client_id == Client.id)
        .where(*filters)
        .group_by(Project.id, Project.name, Client.name)
        .order_by(func.sum(TimeEntry.hours).desc(), Project.name.asc())
    )
    project_rows = project_result.all()
    total_project_hours = sum((Decimal(str(row.hours))
                              for row in project_rows), Decimal("0"))

    project_breakdown: list[DashboardProjectBreakdown] = []
    for row in project_rows:
        hours = Decimal(str(row.hours))
        percentage = float((hours / total_project_hours) *
                           Decimal("100")) if total_project_hours > 0 else 0.0
        project_breakdown.append(
            DashboardProjectBreakdown(
                project_id=row.id,
                project_name=row.name,
                client_name=row.client_name,
                hours=hours,
                percentage=percentage,
            )
        )

    activity_result = await db.execute(
        select(
            TimeEntry.description,
            Project.name.label("project_name"),
            func.sum(TimeEntry.hours).label("hours"),
        )
        .join(Project, TimeEntry.project_id == Project.id)
        .where(*filters)
        .group_by(TimeEntry.description, Project.name)
        .order_by(func.sum(TimeEntry.hours).desc(), TimeEntry.description.asc())
        .limit(10)
    )
    top_activities = [
        DashboardActivity(
            description=row.description or "(no description)",
            project_name=row.project_name,
            hours=Decimal(str(row.hours)),
        )
        for row in activity_result.all()
    ]

    return DashboardAnalyticsResponse(
        total_hours=Decimal(str(total_hours or 0)),
        billable_hours=Decimal(str(billable_hours or 0)),
        non_billable_hours=non_billable_hours,
        top_project_name=project_breakdown[0].project_name if project_breakdown else None,
        top_client_name=project_breakdown[0].client_name if project_breakdown else None,
        daily_breakdown=daily_breakdown,
        project_breakdown=project_breakdown,
        top_activities=top_activities,
    )


@router.get("/recent-activity", response_model=list[DashboardRecentActivityItem])
async def get_recent_activity(
    limit: int = Query(8, ge=1, le=20),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> list[DashboardRecentActivityItem]:
    if current_user.role == UserRole.PLATFORM_ADMIN:
        query = (
            select(ActivityLog)
            .where(ActivityLog.visibility_scope == "PLATFORM_ADMIN")
            .order_by(ActivityLog.created_at.desc(), ActivityLog.id.desc())
            .limit(limit)
        )
    elif current_user.role == UserRole.ADMIN and current_user.tenant_id is not None:
        query = (
            select(ActivityLog)
            .where(ActivityLog.visibility_scope == "TENANT_ADMIN")
            .where(ActivityLog.tenant_id == current_user.tenant_id)
            .order_by(ActivityLog.created_at.desc(), ActivityLog.id.desc())
            .limit(limit)
        )
    else:
        return []

    result = await db.execute(query)
    items = list(result.scalars().all())
    return [
        DashboardRecentActivityItem(
            id=item.id,
            activity_type=item.activity_type,
            entity_type=item.entity_type,
            entity_id=item.entity_id,
            actor_id=item.actor_user_id,
            actor_name=item.actor_name,
            summary=item.summary,
            route=item.route,
            route_params=item.route_params,
            metadata=item.metadata_json,
            severity=item.severity,
            created_at=item.created_at,
        )
        for item in items
    ]


@router.get("/audit-trail", response_model=list[DashboardRecentActivityItem])
async def get_audit_trail(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    activity_type: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> list[DashboardRecentActivityItem]:
    """Full audit trail for admins. Supports pagination, filtering by type, and text search."""
    await shadow_check(
        db,
        current_user,
        "audit.read",
        old_decision=True,
        context="GET /dashboard/audit-trail",
    )

    if current_user.role == UserRole.PLATFORM_ADMIN:
        query = select(ActivityLog).where(ActivityLog.visibility_scope == "PLATFORM_ADMIN")
    else:
        query = (
            select(ActivityLog)
            .where(ActivityLog.visibility_scope == "TENANT_ADMIN")
            .where(ActivityLog.tenant_id == current_user.tenant_id)
        )

    if activity_type:
        query = query.where(ActivityLog.activity_type == activity_type)
    if search:
        query = query.where(ActivityLog.summary.ilike(f"%{search}%"))

    query = query.order_by(ActivityLog.created_at.desc(), ActivityLog.id.desc()).offset(offset).limit(limit)
    result = await db.execute(query)
    items = list(result.scalars().all())
    return [
        DashboardRecentActivityItem(
            id=item.id,
            activity_type=item.activity_type,
            entity_type=item.entity_type,
            entity_id=item.entity_id,
            actor_id=item.actor_user_id,
            actor_name=item.actor_name,
            summary=item.summary,
            route=item.route,
            route_params=item.route_params,
            metadata=item.metadata_json,
            severity=item.severity,
            created_at=item.created_at,
        )
        for item in items
    ]


# Manager Team Overview: WTD submission status per employee + PTO context.

def _working_days_between(start: date, end_inclusive: date) -> int:
    """Count weekdays (Mon-Fri) in [start, end_inclusive]. Sizes the
    'submitted X / Y days' chip on the roster."""
    if end_inclusive < start:
        return 0
    days = 0
    cursor = start
    while cursor <= end_inclusive:
        if cursor.weekday() < 5:
            days += 1
        cursor += timedelta(days=1)
    return days


@router.get("/manager-team-overview", response_model=ManagerTeamOverviewResponse)
async def get_manager_team_overview(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Aggregate roster + capacity context for the manager dashboard.

    Authorization mirrors `/dashboard/team-daily-overview`: MANAGER /
    MANAGER / VIEWER / ADMIN. EMPLOYEE and PLATFORM_ADMIN get 403.
    """
    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(
            status_code=403,
            detail="This endpoint is not available for your role",
        )

    # Tenant timezone for "today" so the roster aligns with tenant
    # local week, not server clock.
    tenant_timezone: Optional[str] = None
    if current_user.tenant_id is not None:
        tenant = await db.get(Tenant, current_user.tenant_id)
        if tenant is not None:
            tenant_timezone = tenant.timezone

    today = now_for_tenant(tenant_timezone).date()
    # Week starts Monday for the manager view. We don't read the
    # tenant week_start_day setting here — Mon-Fri working weeks are
    # the universal frame for "is the team on track this week".
    week_start = today - timedelta(days=today.weekday())
    week_end = week_start + timedelta(days=6)
    next_week_start = week_start + timedelta(days=7)
    next_week_end = next_week_start + timedelta(days=6)

    team_member_ids = await _get_scoped_employee_ids(db, current_user)
    if not team_member_ids:
        return ManagerTeamOverviewResponse(
            week_start=week_start,
            week_end=week_end,
            today=today,
            team_size=0,
            members=[],
            pending_approvals_count=0,
            pending_time_off_count=0,
            rejected_recent_count=0,
            capacity_this_week=[],
            capacity_next_week=[],
        )

    team_result = await db.execute(
        select(User)
        .where(User.id.in_(team_member_ids))
        .order_by(User.full_name.asc())
    )
    team_members = list(team_result.scalars().all())

    # 1) Submitted-day counts per user, week-to-date. SUBMITTED + APPROVED
    #    drive the on-track / behind STATUS (what the manager chases).
    submitted_result = await db.execute(
        select(TimeEntry.user_id, TimeEntry.entry_date)
        .where(
            TimeEntry.user_id.in_(team_member_ids),
            TimeEntry.entry_date >= week_start,
            TimeEntry.entry_date <= today,
            TimeEntry.status.in_(
                [TimeEntryStatus.SUBMITTED, TimeEntryStatus.APPROVED]
            ),
        )
    )
    submitted_dates_by_user: dict[int, set[date]] = {}
    for user_id, entry_date in submitted_result.all():
        submitted_dates_by_user.setdefault(user_id, set()).add(entry_date)

    # 1b) Logged-day counts per user, week-to-date. Includes DRAFT so the
    #     roster's "X/5 days logged" reflects in-progress work the employee has
    #     started but not yet submitted. This is display-only; it does NOT
    #     change the on-track / behind status (that stays submission-based).
    logged_result = await db.execute(
        select(TimeEntry.user_id, TimeEntry.entry_date)
        .where(
            TimeEntry.user_id.in_(team_member_ids),
            TimeEntry.entry_date >= week_start,
            TimeEntry.entry_date <= today,
            TimeEntry.status.in_(
                [TimeEntryStatus.DRAFT, TimeEntryStatus.SUBMITTED, TimeEntryStatus.APPROVED]
            ),
        )
    )
    logged_dates_by_user: dict[int, set[date]] = {}
    for user_id, entry_date in logged_result.all():
        logged_dates_by_user.setdefault(user_id, set()).add(entry_date)

    # 2) PTO data: SUBMITTED + APPROVED count as consuming capacity.
    active_pto_statuses = [TimeOffStatus.SUBMITTED, TimeOffStatus.APPROVED]
    pto_window_end = next_week_end
    pto_result = await db.execute(
        select(TimeOffRequest.user_id, TimeOffRequest.request_date, TimeOffRequest.leave_type)
        .where(
            TimeOffRequest.user_id.in_(team_member_ids),
            TimeOffRequest.request_date >= week_start,
            TimeOffRequest.request_date <= pto_window_end,
            TimeOffRequest.status.in_(active_pto_statuses),
        )
    )
    pto_rows: list[tuple[int, date, str]] = list(pto_result.all())

    pto_today_users: set[int] = set()
    pto_this_week_by_user: dict[int, dict[str, int]] = {}
    pto_next_week_by_user: dict[int, dict[str, int]] = {}
    upcoming_pto_start_by_user: dict[int, date] = {}
    for user_id, req_date, leave_type in pto_rows:
        if req_date == today:
            pto_today_users.add(user_id)
        if week_start <= req_date <= week_end:
            bucket = pto_this_week_by_user.setdefault(user_id, {})
            bucket[leave_type] = bucket.get(leave_type, 0) + 1
        if next_week_start <= req_date <= next_week_end:
            bucket = pto_next_week_by_user.setdefault(user_id, {})
            bucket[leave_type] = bucket.get(leave_type, 0) + 1
        if req_date >= today:
            existing = upcoming_pto_start_by_user.get(user_id)
            if existing is None or req_date < existing:
                upcoming_pto_start_by_user[user_id] = req_date

    # Late: did the user miss the most recent closed submission
    # period for their cadence (weekly or monthly)? The cadence and
    # deadlines are tenant settings; new accounts created on or after
    # the period start are exempt. See app.services.submission_period.
    from app.services.submission_period import (
        is_user_late_for_period,
        latest_closed_period,
    )

    late_user_ids: set[int] = set()
    if current_user.tenant_id is not None:
        # latest_closed_period depends only on the user's cadence (internal vs
        # external), not the individual user, and each call re-reads several
        # tenant settings. Memoize by cadence key so this resolves at most
        # twice for the whole team instead of once per member (N+1 -> ~2).
        period_cache: dict[bool, object] = {}
        for member in team_members:
            cache_key = bool(member.is_external)
            if cache_key not in period_cache:
                period_cache[cache_key] = await latest_closed_period(
                    db, current_user.tenant_id, member, today, tenant_timezone
                )
            period = period_cache[cache_key]
            if period is None:
                continue
            if await is_user_late_for_period(db, member, period):
                late_user_ids.add(member.id)

    members: list[ManagerTeamMemberStatus] = []
    for member in team_members:
        submitted_dates = submitted_dates_by_user.get(member.id, set())
        logged_dates = logged_dates_by_user.get(member.id, set())
        working_days = _working_days_between(week_start, today)
        is_repeatedly_late = member.id in late_user_ids

        members.append(
            ManagerTeamMemberStatus(
                user_id=member.id,
                full_name=member.full_name,
                working_days_in_week=working_days,
                submitted_days=len(submitted_dates),
                logged_days=len(logged_dates),
                is_on_pto_today=member.id in pto_today_users,
                is_on_pto_this_week=member.id in pto_this_week_by_user,
                upcoming_pto_starts_at=upcoming_pto_start_by_user.get(member.id),
                is_repeatedly_late=is_repeatedly_late,
            )
        )

    # 4) Manager priority counts. We pull the timestamps too so we can
    # compute oldest/avg age for the dashboard tile. submitted_at is the
    # truthful "started waiting on a manager" time; fall back to
    # created_at when missing (legacy rows).
    pending_rows = (await db.execute(
        select(TimeEntry.submitted_at, TimeEntry.created_at)
        .where(
            TimeEntry.user_id.in_(team_member_ids),
            TimeEntry.status == TimeEntryStatus.SUBMITTED,
        )
    )).all()
    pending_approvals_count = len(pending_rows)
    pending_approvals_oldest_hours: Optional[int] = None
    pending_approvals_avg_hours: Optional[int] = None
    if pending_rows:
        now_utc = datetime.now(timezone.utc)
        ages_hours: list[float] = []
        for submitted_at, created_at in pending_rows:
            ts = submitted_at or created_at
            if ts is None:
                continue
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            ages_hours.append((now_utc - ts).total_seconds() / 3600.0)
        if ages_hours:
            pending_approvals_oldest_hours = int(round(max(ages_hours)))
            pending_approvals_avg_hours = int(round(sum(ages_hours) / len(ages_hours)))
    pending_time_off_count = int(
        (await db.scalar(
            select(func.count(TimeOffRequest.id))
            .where(
                TimeOffRequest.user_id.in_(team_member_ids),
                TimeOffRequest.status == TimeOffStatus.SUBMITTED,
            )
        ))
        or 0
    )
    rejected_recent_count = int(
        (await db.scalar(
            select(func.count(TimeEntry.id))
            .where(
                TimeEntry.user_id.in_(team_member_ids),
                TimeEntry.status == TimeEntryStatus.REJECTED,
                TimeEntry.entry_date >= week_start,
                TimeEntry.entry_date <= week_end,
            )
        ))
        or 0
    )

    user_lookup = {m.id: m.full_name for m in team_members}

    def _capacity_rows(by_user: dict[int, dict[str, int]]) -> list[ManagerTeamCapacityEntry]:
        rows: list[ManagerTeamCapacityEntry] = []
        for user_id, leave_counts in by_user.items():
            for leave_type, days in sorted(leave_counts.items()):
                rows.append(
                    ManagerTeamCapacityEntry(
                        user_id=user_id,
                        full_name=user_lookup.get(user_id, ""),
                        leave_type=leave_type,
                        days_in_window=days,
                    )
                )
        rows.sort(key=lambda r: (r.full_name, r.leave_type))
        return rows

    return ManagerTeamOverviewResponse(
        week_start=week_start,
        week_end=week_end,
        today=today,
        team_size=len(team_members),
        members=members,
        pending_approvals_count=pending_approvals_count,
        pending_time_off_count=pending_time_off_count,
        rejected_recent_count=rejected_recent_count,
        pending_approvals_oldest_hours=pending_approvals_oldest_hours,
        pending_approvals_avg_hours=pending_approvals_avg_hours,
        capacity_this_week=_capacity_rows(pto_this_week_by_user),
        capacity_next_week=_capacity_rows(pto_next_week_by_user),
    )


# Manager Project Health: scoped to projects the manager's team has logged against.

@router.get("/manager-project-health", response_model=ManagerProjectHealthResponse)
async def get_manager_project_health(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(
            status_code=403,
            detail="This endpoint is not available for your role",
        )

    tenant_timezone: Optional[str] = None
    if current_user.tenant_id is not None:
        tenant = await db.get(Tenant, current_user.tenant_id)
        if tenant is not None:
            tenant_timezone = tenant.timezone

    today = now_for_tenant(tenant_timezone).date()
    week_start = today - timedelta(days=today.weekday())
    prior_week_start = week_start - timedelta(days=7)

    team_member_ids = await _get_scoped_employee_ids(db, current_user)
    if not team_member_ids:
        return ManagerProjectHealthResponse(rows=[])

    # 1) Find the projects the team has MEANINGFULLY worked on recently. We sum
    # submitted/approved hours over the lookback and keep only projects above a
    # small floor — so stray one-off drafts on unrelated projects don't surface
    # as "the team's projects" with 0 real work. (Window widened to 30d so a
    # project worked the prior weeks still shows even with a quiet current week.)
    _MIN_PROJECT_HOURS = Decimal("1")
    lookback_start = today - timedelta(days=30)
    project_hours_result = await db.execute(
        select(TimeEntry.project_id, func.coalesce(func.sum(TimeEntry.hours), 0))
        .where(
            TimeEntry.user_id.in_(team_member_ids),
            TimeEntry.entry_date >= lookback_start,
            TimeEntry.status.in_([TimeEntryStatus.SUBMITTED, TimeEntryStatus.APPROVED]),
        )
        .group_by(TimeEntry.project_id)
    )
    worked_ids = [
        pid for pid, h in project_hours_result.all()
        if Decimal(str(h or 0)) >= _MIN_PROJECT_HOURS
    ]
    # Authorship gate: a project only counts as "the team's" if it actually has a
    # manager/PM assigned. Unassigned seed/abandoned projects (no manager_id and
    # no project_managers row) carry stray approved history but aren't a real
    # live engagement, so they don't belong on the health board.
    project_ids = await _filter_managed_project_ids(db, worked_ids, current_user.tenant_id)
    if not project_ids:
        return ManagerProjectHealthResponse(rows=[])

    # 2) Load projects + clients in one shot.
    projects_result = await db.execute(
        select(Project)
        .options(selectinload(Project.client))
        .where(
            Project.id.in_(project_ids),
            Project.tenant_id == current_user.tenant_id,
        )
    )
    projects = list(projects_result.scalars().all())

    # 3) Hours-this-week per project, only for entries that count
    # against the budget (SUBMITTED + APPROVED).
    # Include DRAFT so "Hours this week" reflects in-progress work the team has
    # entered, not only what's been submitted (matches the roster's logged_days).
    hours_week_result = await db.execute(
        select(TimeEntry.project_id, func.coalesce(func.sum(TimeEntry.hours), 0))
        .where(
            TimeEntry.project_id.in_(project_ids),
            TimeEntry.user_id.in_(team_member_ids),
            TimeEntry.entry_date >= week_start,
            TimeEntry.entry_date <= today,
            TimeEntry.status.in_(
                [TimeEntryStatus.DRAFT, TimeEntryStatus.SUBMITTED, TimeEntryStatus.APPROVED]
            ),
        )
        .group_by(TimeEntry.project_id)
    )
    hours_week_by_project = {pid: Decimal(str(h or 0)) for pid, h in hours_week_result.all()}

    # 4) Dollar budget burn per project: approved/billable revenue (hours x the
    # frozen/resolved rate) against the project's dollar budget_amount. This is
    # the money view the dashboard should show — projects carry a budget_amount,
    # not always an estimated_hours, so the old hours-based % read N/A.
    from app.services.billing_rates import entry_billed_amount

    revenue_rows = await db.execute(
        select(TimeEntry)
        .where(
            TimeEntry.project_id.in_(project_ids),
            # Scope revenue to the same team the financials tile uses (employee
            # reports only) so the two tiles report the SAME budget %. Without
            # this, the manager's own PM hours leak into health-tile revenue and
            # the percentages disagree for the same project.
            TimeEntry.user_id.in_(team_member_ids),
            TimeEntry.status == TimeEntryStatus.APPROVED,
            TimeEntry.is_billable.is_(True),
        )
    )
    project_by_id = {p.id: p for p in projects}
    revenue_by_project: dict[int, Decimal] = {}
    for entry in revenue_rows.scalars().all():
        proj = project_by_id.get(entry.project_id)
        revenue_by_project[entry.project_id] = (
            revenue_by_project.get(entry.project_id, Decimal("0"))
            + entry_billed_amount(entry, proj)
        )

    rows: list[ManagerProjectHealthRow] = []
    for project in projects:
        days_until_end: Optional[int] = None
        if project.end_date is not None:
            days_until_end = (project.end_date - today).days

        hours_this_week = hours_week_by_project.get(project.id, Decimal("0"))
        revenue = revenue_by_project.get(project.id, Decimal("0"))

        # Budget % = revenue burned against the project's dollar budget.
        # budget_hours_remaining carries DOLLARS remaining here (the column is
        # labeled "Budget" and renders the %; the remaining is informational).
        budget_pct: Optional[int] = None
        budget_remaining: Optional[Decimal] = None
        budget_amount = project.budget_amount
        if budget_amount is not None and budget_amount > 0:
            budget_pct = int(round((revenue / Decimal(str(budget_amount))) * 100))
            budget_remaining = Decimal(str(budget_amount)) - revenue

        # Health classification:
        #  needs-attention: over budget OR more than a month overdue
        #  at-risk:         within a week of end_date OR >80% budget consumed
        #  not-set:         no budget AND no end_date
        #  good:            otherwise
        is_over_budget = budget_pct is not None and budget_pct > 100
        is_long_overdue = days_until_end is not None and days_until_end < -30
        is_close_to_end = days_until_end is not None and 0 <= days_until_end <= 7
        is_high_burn = budget_pct is not None and budget_pct > 80
        no_budget_no_end = budget_amount is None and project.end_date is None

        if is_over_budget or is_long_overdue:
            health = "needs-attention"
        elif is_close_to_end or is_high_burn:
            health = "at-risk"
        elif no_budget_no_end:
            health = "not-set"
        else:
            health = "good"

        rows.append(
            ManagerProjectHealthRow(
                project_id=project.id,
                project_name=project.name,
                client_name=project.client.name if project.client else "",
                days_until_end=days_until_end,
                hours_this_week=hours_this_week,
                budget_pct=budget_pct,
                budget_hours_remaining=budget_remaining,
                health=health,
            )
        )

    # Sort: needs-attention → at-risk → good → not-set, then by name.
    health_order = {"needs-attention": 0, "at-risk": 1, "good": 2, "not-set": 3}
    rows.sort(key=lambda r: (health_order.get(r.health, 9), r.project_name.lower()))
    return ManagerProjectHealthResponse(rows=rows)


@router.get("/manager-financials", response_model=ManagerFinancialsResponse)
async def get_manager_financials(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Real financial stats for the manager's scoped team: per-project revenue
    (approved hours x the frozen/resolved rate), budget burn ($), contract burn,
    and team utilization. Computed entirely from APPROVED time + rates — no
    seeded/fabricated figures."""
    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(status_code=403, detail="This endpoint is not available for your role")

    from decimal import Decimal
    from app.models.project import Project as ProjectModel
    from app.models.client import Client
    from app.models.contract import Contract
    from app.services.billing_rates import entry_billed_amount

    team_ids = await _get_scoped_employee_ids(db, current_user)
    if not team_ids:
        return ManagerFinancialsResponse(summary=FinancialSummary(), projects=[])

    # All APPROVED entries for the team (revenue is realized on approval).
    entries = (await db.execute(
        select(TimeEntry).where(
            TimeEntry.user_id.in_(team_ids),
            TimeEntry.tenant_id == current_user.tenant_id,
            TimeEntry.status == TimeEntryStatus.APPROVED,
        )
    )).scalars().all()
    if not entries:
        return ManagerFinancialsResponse(summary=FinancialSummary(), projects=[])

    proj_ids = {e.project_id for e in entries}
    projects = {p.id: p for p in (await db.execute(
        select(ProjectModel).where(ProjectModel.id.in_(list(proj_ids)),
                                    ProjectModel.tenant_id == current_user.tenant_id)
    )).scalars().all()}
    client_name = {cid: name for cid, name in (await db.execute(
        select(Client.id, Client.name).where(Client.tenant_id == current_user.tenant_id)
    )).all()}
    contract_ids = {p.contract_id for p in projects.values() if p.contract_id}
    contracts = {c.id: c for c in (await db.execute(
        select(Contract).where(Contract.id.in_(list(contract_ids) or [-1]))
    )).scalars().all()}

    # Only surface projects that are actually managed (have a manager/PM). A
    # project with stray approved history but no owner — e.g. an abandoned seed
    # project — reads as a live engagement when it isn't. Same authorship gate
    # as project-health. Computed up front so summary totals (utilization,
    # billable/nonbillable) reflect only the managed engagements too.
    managed_ids = set(await _filter_managed_project_ids(
        db, list(proj_ids), current_user.tenant_id
    ))

    # Aggregate per project.
    agg: dict[int, dict] = {}
    total_billable = Decimal("0")
    total_nonbillable = Decimal("0")
    for e in entries:
        if e.project_id not in managed_ids:
            continue
        p = projects.get(e.project_id)
        d = agg.setdefault(e.project_id, {"hours": Decimal("0"), "billable": Decimal("0"), "revenue": Decimal("0")})
        hrs = e.hours or Decimal("0")
        d["hours"] += hrs
        if e.is_billable:
            d["billable"] += hrs
            total_billable += hrs
            d["revenue"] += entry_billed_amount(e, p)
        else:
            total_nonbillable += hrs

    rows: list[ProjectFinancialRow] = []
    total_revenue = Decimal("0")
    total_budget = Decimal("0")
    for pid, d in agg.items():
        p = projects.get(pid)
        if p is None:
            continue
        revenue = d["revenue"]
        total_revenue += revenue
        budget = p.budget_amount
        if budget:
            total_budget += budget
        budget_pct = int(round(revenue / budget * 100)) if budget and budget > 0 else None
        budget_remaining = (budget - revenue) if budget is not None else None
        ct = contracts.get(p.contract_id) if p.contract_id else None
        contract_pct = (
            int(round(revenue / ct.value * 100)) if ct and ct.value and ct.value > 0 else None
        )
        rows.append(ProjectFinancialRow(
            project_id=pid, project_name=p.name,
            client_name=client_name.get(p.client_id, ""),
            currency=p.currency or "USD",
            approved_hours=d["hours"], billable_hours=d["billable"], revenue=revenue,
            budget_amount=budget, budget_used_pct=budget_pct, budget_remaining=budget_remaining,
            contract_id=ct.id if ct else None, contract_title=ct.title if ct else None,
            contract_value=ct.value if ct else None, contract_used_pct=contract_pct,
        ))
    rows.sort(key=lambda r: r.revenue, reverse=True)

    total_hours = total_billable + total_nonbillable
    util = int(round(total_billable / total_hours * 100)) if total_hours > 0 else None
    summary = FinancialSummary(
        total_revenue=total_revenue, total_budget=total_budget,
        total_approved_hours=total_hours, billable_hours=total_billable,
        nonbillable_hours=total_nonbillable, utilization_pct=util,
    )
    return ManagerFinancialsResponse(summary=summary, projects=rows)


@router.get("/my-work", response_model=MyWorkResponse)
async def get_my_work(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """The calling user's assigned work: projects they have access to + tasks
    they're assigned, grouped by client, with their logged hours per project."""
    from decimal import Decimal
    from app.models.project import Project as ProjectModel
    from app.models.client import Client
    from app.models.task import Task as TaskModel
    from app.models.assignments import UserProjectAccess, TaskAssignee

    # Projects the user has access to.
    proj_ids = set((await db.execute(
        select(UserProjectAccess.project_id).where(UserProjectAccess.user_id == current_user.id)
    )).scalars().all())
    # Tasks assigned to the user (+ their owning projects).
    assigned_task_rows = (await db.execute(
        select(TaskAssignee.task_id).where(TaskAssignee.user_id == current_user.id)
    )).scalars().all()
    assigned_task_ids = set(assigned_task_rows)

    if assigned_task_ids:
        owner_rows = (await db.execute(
            select(TaskModel.project_id).where(TaskModel.id.in_(list(assigned_task_ids)),
                                               TaskModel.tenant_id == current_user.tenant_id)
        )).scalars().all()
        proj_ids |= set(owner_rows)

    if not proj_ids:
        return MyWorkResponse()

    projects = (await db.execute(
        select(ProjectModel).where(ProjectModel.id.in_(list(proj_ids)),
                                   ProjectModel.tenant_id == current_user.tenant_id)
    )).scalars().all()
    client_name = {cid: name for cid, name in (await db.execute(
        select(Client.id, Client.name).where(Client.tenant_id == current_user.tenant_id)
    )).all()}

    # The user's tasks per project (only their assigned ones).
    all_assigned_tasks = (await db.execute(
        select(TaskModel).where(TaskModel.id.in_(list(assigned_task_ids) or [-1]),
                                TaskModel.tenant_id == current_user.tenant_id)
    )).scalars().all()
    tasks_by_project: dict[int, list[MyWorkTask]] = {}
    for t in all_assigned_tasks:
        tasks_by_project.setdefault(t.project_id, []).append(MyWorkTask(
            task_id=t.id, name=t.name,
            status=t.status.value if hasattr(t.status, "value") else (str(t.status) if t.status else None),
            priority=t.priority.value if hasattr(t.priority, "value") else (str(t.priority) if t.priority else None),
            description=t.description,
            can_edit=True,
        ))

    # The user's logged hours per project (all + approved).
    hour_rows = (await db.execute(
        select(TimeEntry.project_id, TimeEntry.status, func.coalesce(func.sum(TimeEntry.hours), 0))
        .where(TimeEntry.user_id == current_user.id,
               TimeEntry.project_id.in_(list(proj_ids)),
               TimeEntry.tenant_id == current_user.tenant_id)
        .group_by(TimeEntry.project_id, TimeEntry.status)
    )).all()
    total_h: dict[int, Decimal] = {}
    approved_h: dict[int, Decimal] = {}
    for pid, st, hrs in hour_rows:
        total_h[pid] = total_h.get(pid, Decimal("0")) + Decimal(str(hrs or 0))
        if st == TimeEntryStatus.APPROVED:
            approved_h[pid] = approved_h.get(pid, Decimal("0")) + Decimal(str(hrs or 0))

    # Group projects by client.
    by_client: dict[int, MyWorkClient] = {}
    total_tasks = 0
    grand_hours = Decimal("0")
    for p in projects:
        mw = MyWorkProject(
            project_id=p.id, project_name=p.name, code=p.code,
            status=p.status.value if hasattr(p.status, "value") else (str(p.status) if p.status else None),
            my_hours=total_h.get(p.id, Decimal("0")),
            approved_hours=approved_h.get(p.id, Decimal("0")),
            tasks=tasks_by_project.get(p.id, []),
        )
        total_tasks += len(mw.tasks)
        grand_hours += mw.my_hours
        cid = p.client_id
        if cid not in by_client:
            by_client[cid] = MyWorkClient(client_id=cid, client_name=client_name.get(cid, "Client"), projects=[])
        by_client[cid].projects.append(mw)

    clients = sorted(by_client.values(), key=lambda c: c.client_name)
    for c in clients:
        c.projects.sort(key=lambda x: x.project_name)
    return MyWorkResponse(
        clients=clients,
        total_projects=len(projects),
        total_tasks=total_tasks,
        total_hours=grand_hours,
    )


@router.get("/team-rejection-stats", response_model=TeamRejectionStatsResponse)
async def get_team_rejection_stats(
    days_back: int = Query(90, ge=1, le=365),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Per-employee rejection rate and the team's top rejection reasons over a
    lookback window. Computed entirely from existing time entries; no new data.

    Authorization mirrors the other manager dashboard endpoints: MANAGER /
    VIEWER / ADMIN. EMPLOYEE and PLATFORM_ADMIN get 403.

    Definition of "rejection rate": of an employee's time entries that reached
    a terminal decision (APPROVED or REJECTED) with an ``entry_date`` inside the
    window, the share that are currently REJECTED. An entry that was rejected
    then resubmitted and approved counts as approved (current status), which is
    the honest "how often does work get sent back and stay back" reading. The
    rate is None (undefined) when an employee had no decided entries, never a
    misleading 0.
    """
    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(
            status_code=403,
            detail="This endpoint is not available for your role",
        )

    tenant_timezone: Optional[str] = None
    if current_user.tenant_id is not None:
        tenant = await db.get(Tenant, current_user.tenant_id)
        if tenant is not None:
            tenant_timezone = tenant.timezone

    today = now_for_tenant(tenant_timezone).date()
    window_start = today - timedelta(days=days_back)

    team_member_ids = await _get_scoped_employee_ids(db, current_user)
    if not team_member_ids:
        return TeamRejectionStatsResponse(
            days_back=days_back, rows=[], top_reasons=[], team_rejection_rate_pct=None
        )

    members_result = await db.execute(
        select(User.id, User.full_name)
        .where(User.id.in_(team_member_ids))
        .order_by(User.full_name.asc())
    )
    members = list(members_result.all())

    # Per-user decided/rejected counts. Only terminal statuses count toward the
    # denominator; DRAFT/SUBMITTED are in-flight and excluded.
    decided_statuses = [TimeEntryStatus.APPROVED, TimeEntryStatus.REJECTED]
    counts_result = await db.execute(
        select(TimeEntry.user_id, TimeEntry.status, func.count(TimeEntry.id))
        .where(
            TimeEntry.user_id.in_(team_member_ids),
            TimeEntry.entry_date >= window_start,
            TimeEntry.entry_date <= today,
            TimeEntry.status.in_(decided_statuses),
        )
        .group_by(TimeEntry.user_id, TimeEntry.status)
    )
    decided_by_user: dict[int, int] = {}
    rejected_by_user: dict[int, int] = {}
    for user_id, status, cnt in counts_result.all():
        decided_by_user[user_id] = decided_by_user.get(user_id, 0) + int(cnt)
        if status == TimeEntryStatus.REJECTED:
            rejected_by_user[user_id] = rejected_by_user.get(user_id, 0) + int(cnt)

    rows: list[TeamRejectionRow] = []
    for user_id, full_name in members:
        decided = decided_by_user.get(user_id, 0)
        rejected = rejected_by_user.get(user_id, 0)
        rate = round(rejected / decided * 100) if decided > 0 else None
        rows.append(
            TeamRejectionRow(
                user_id=user_id,
                full_name=full_name,
                decided_count=decided,
                rejected_count=rejected,
                rejection_rate_pct=rate,
            )
        )
    # Highest-rejection employees first; undefined rates sort last.
    rows.sort(key=lambda r: (r.rejection_rate_pct is None, -(r.rejection_rate_pct or 0), -r.rejected_count))

    # Top rejection reasons across the team. Normalize whitespace/case so
    # "Missing detail" and "missing detail " collapse together; blank reasons
    # bucket as "(no reason given)".
    reasons_result = await db.execute(
        select(TimeEntry.rejection_reason, func.count(TimeEntry.id))
        .where(
            TimeEntry.user_id.in_(team_member_ids),
            TimeEntry.entry_date >= window_start,
            TimeEntry.entry_date <= today,
            TimeEntry.status == TimeEntryStatus.REJECTED,
        )
        .group_by(TimeEntry.rejection_reason)
    )
    reason_tally: dict[str, int] = {}
    for reason, cnt in reasons_result.all():
        key = (reason or "").strip() or "(no reason given)"
        reason_tally[key] = reason_tally.get(key, 0) + int(cnt)
    top_reasons = [
        TeamRejectionReason(reason=r, count=c)
        for r, c in sorted(reason_tally.items(), key=lambda kv: -kv[1])
    ][:8]

    total_decided = sum(decided_by_user.values())
    total_rejected = sum(rejected_by_user.values())
    team_rate = round(total_rejected / total_decided * 100) if total_decided > 0 else None

    return TeamRejectionStatsResponse(
        days_back=days_back,
        rows=rows,
        top_reasons=top_reasons,
        team_rejection_rate_pct=team_rate,
    )


@router.get("/team-billable-stats", response_model=TeamBillableStatsResponse)
async def get_team_billable_stats(
    days_back: int = Query(90, ge=1, le=365),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Per-employee billable split over a lookback window. Of an employee's
    APPROVED hours in the window, the share marked billable. Computed from
    existing time entries; no new data and no rates involved (this is an hours
    ratio, not a revenue figure).

    Authorization mirrors the other manager dashboard endpoints: MANAGER /
    VIEWER / ADMIN. The percentage is None when an employee logged no approved
    hours in the window (undefined, not 0).
    """
    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(
            status_code=403,
            detail="This endpoint is not available for your role",
        )

    tenant_timezone: Optional[str] = None
    if current_user.tenant_id is not None:
        tenant = await db.get(Tenant, current_user.tenant_id)
        if tenant is not None:
            tenant_timezone = tenant.timezone

    today = now_for_tenant(tenant_timezone).date()
    window_start = today - timedelta(days=days_back)

    team_member_ids = await _get_scoped_employee_ids(db, current_user)
    if not team_member_ids:
        return TeamBillableStatsResponse(
            days_back=days_back, rows=[], team_billable_pct=None,
            team_approved_hours=Decimal("0"), team_billable_hours=Decimal("0"),
        )

    members_result = await db.execute(
        select(User.id, User.full_name)
        .where(User.id.in_(team_member_ids))
        .order_by(User.full_name.asc())
    )
    members = list(members_result.all())

    # Approved hours per user, split by billable flag. Only APPROVED time
    # counts (consistent with the financial source-of-truth rule).
    hours_result = await db.execute(
        select(
            TimeEntry.user_id,
            TimeEntry.is_billable,
            func.coalesce(func.sum(TimeEntry.hours), 0),
        )
        .where(
            TimeEntry.user_id.in_(team_member_ids),
            TimeEntry.entry_date >= window_start,
            TimeEntry.entry_date <= today,
            TimeEntry.status == TimeEntryStatus.APPROVED,
        )
        .group_by(TimeEntry.user_id, TimeEntry.is_billable)
    )
    approved_by_user: dict[int, Decimal] = {}
    billable_by_user: dict[int, Decimal] = {}
    for user_id, is_billable, hrs in hours_result.all():
        h = Decimal(str(hrs or 0))
        approved_by_user[user_id] = approved_by_user.get(user_id, Decimal("0")) + h
        if is_billable:
            billable_by_user[user_id] = billable_by_user.get(user_id, Decimal("0")) + h

    rows: list[TeamBillableRow] = []
    for user_id, full_name in members:
        approved = approved_by_user.get(user_id, Decimal("0"))
        billable = billable_by_user.get(user_id, Decimal("0"))
        pct = round(billable / approved * 100) if approved > 0 else None
        rows.append(
            TeamBillableRow(
                user_id=user_id,
                full_name=full_name,
                approved_hours=approved,
                billable_hours=billable,
                billable_pct=pct,
            )
        )
    # Lowest billable share first (most attention-worthy); undefined last.
    rows.sort(key=lambda r: (r.billable_pct is None, r.billable_pct if r.billable_pct is not None else 0))

    team_approved = sum(approved_by_user.values(), Decimal("0"))
    team_billable = sum(billable_by_user.values(), Decimal("0"))
    team_pct = round(team_billable / team_approved * 100) if team_approved > 0 else None

    return TeamBillableStatsResponse(
        days_back=days_back,
        rows=rows,
        team_billable_pct=team_pct,
        team_approved_hours=team_approved,
        team_billable_hours=team_billable,
    )


_DEADLINE_WEEKDAYS = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}


@router.get("/team-on-time-stats", response_model=TeamOnTimeStatsResponse)
async def get_team_on_time_stats(
    days_back: int = Query(90, ge=7, le=365),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Per-employee on-time submission trend at weekly grain over the window.

    For each employee and each Mon-Sun week that has any of their time entries,
    the week is "on time" if their latest submission for that week's entries
    happened on or before the week's submission deadline (from the tenant's
    `reminder_internal_deadline_day` / `reminder_internal_deadline_time`
    settings, defaulting to Friday 17:00). On-time rate = on-time weeks / weeks
    with activity. None when the employee had no active weeks (undefined, not 0).

    Reuses the same deadline settings as the reminder/late logic so this trend
    agrees with the existing single-period "is late" signal. Authorization
    mirrors the other manager dashboard endpoints.
    """
    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(
            status_code=403,
            detail="This endpoint is not available for your role",
        )

    tenant_timezone: Optional[str] = None
    if current_user.tenant_id is not None:
        tenant = await db.get(Tenant, current_user.tenant_id)
        if tenant is not None:
            tenant_timezone = tenant.timezone

    # Resolve the tenant deadline day/time once (same keys as submission_period).
    deadline_dow = 4  # Friday
    deadline_time = time(17, 0)
    if current_user.tenant_id is not None:
        from app.core.tenant_settings import get_setting
        try:
            day_raw = await get_setting(db, current_user.tenant_id, "reminder_internal_deadline_day")
            if isinstance(day_raw, str) and day_raw.lower() in _DEADLINE_WEEKDAYS:
                deadline_dow = _DEADLINE_WEEKDAYS[day_raw.lower()]
        except (KeyError, ValueError):
            pass
        try:
            time_raw = await get_setting(db, current_user.tenant_id, "reminder_internal_deadline_time")
            if isinstance(time_raw, str) and ":" in time_raw:
                hh, mm = time_raw.split(":", 1)
                deadline_time = time(hour=int(hh), minute=int(mm))
        except (KeyError, ValueError):
            pass

    today = now_for_tenant(tenant_timezone).date()
    window_start = today - timedelta(days=days_back)

    team_member_ids = await _get_scoped_employee_ids(db, current_user)
    if not team_member_ids:
        return TeamOnTimeStatsResponse(days_back=days_back, rows=[], team_on_time_pct=None)

    members_result = await db.execute(
        select(User.id, User.full_name)
        .where(User.id.in_(team_member_ids))
        .order_by(User.full_name.asc())
    )
    members = list(members_result.all())

    # Pull the entries we need: any entry in the window that was ever submitted
    # (submitted_at not null). A draft-only week is not counted as "activity"
    # for the on-time measure since there is nothing to be on time about.
    entries_result = await db.execute(
        select(TimeEntry.user_id, TimeEntry.entry_date, TimeEntry.submitted_at)
        .where(
            TimeEntry.user_id.in_(team_member_ids),
            TimeEntry.entry_date >= window_start,
            TimeEntry.entry_date <= today,
            TimeEntry.submitted_at.is_not(None),
        )
    )

    # Bucket by (user, week-Monday) -> latest submitted_at for that week.
    week_latest_submit: dict[tuple[int, date], datetime] = {}
    for user_id, entry_date, submitted_at in entries_result.all():
        if submitted_at is None:
            continue
        week_monday = entry_date - timedelta(days=entry_date.weekday())
        key = (user_id, week_monday)
        prev = week_latest_submit.get(key)
        if prev is None or submitted_at > prev:
            week_latest_submit[key] = submitted_at

    # For each bucket, the week is on-time if latest submit <= that week's
    # deadline. Track the per-(user, week) status so we can also render a recent
    # trend, not just the aggregate.
    active_weeks_by_user: dict[int, int] = {}
    on_time_weeks_by_user: dict[int, int] = {}
    week_status: dict[tuple[int, date], str] = {}  # 'on_time' | 'late'
    for (user_id, week_monday), latest_submit in week_latest_submit.items():
        deadline_at = combine_tenant(
            week_monday + timedelta(days=deadline_dow), deadline_time, tenant_timezone
        )
        active_weeks_by_user[user_id] = active_weeks_by_user.get(user_id, 0) + 1
        if latest_submit <= deadline_at:
            on_time_weeks_by_user[user_id] = on_time_weeks_by_user.get(user_id, 0) + 1
            week_status[(user_id, week_monday)] = "on_time"
        else:
            week_status[(user_id, week_monday)] = "late"

    # Build the most-recent run of weeks (oldest->newest) for the sparkline. We
    # show up to RECENT_WEEKS calendar weeks ending at the current week; a week
    # the employee had no submitted activity in shows as 'none'.
    RECENT_WEEKS = 8
    this_monday = today - timedelta(days=today.weekday())
    recent_mondays = [this_monday - timedelta(weeks=(RECENT_WEEKS - 1 - i)) for i in range(RECENT_WEEKS)]

    rows: list[TeamOnTimeRow] = []
    for user_id, full_name in members:
        active = active_weeks_by_user.get(user_id, 0)
        on_time = on_time_weeks_by_user.get(user_id, 0)
        pct = round(on_time / active * 100) if active > 0 else None
        recent = [
            TeamOnTimeWeek(
                week_start=wm,
                status=week_status.get((user_id, wm), "none"),
            )
            for wm in recent_mondays
        ]
        rows.append(
            TeamOnTimeRow(
                user_id=user_id,
                full_name=full_name,
                weeks_with_activity=active,
                on_time_weeks=on_time,
                on_time_pct=pct,
                recent_weeks=recent,
            )
        )
    # Lowest on-time share first (most attention-worthy); undefined last.
    rows.sort(key=lambda r: (r.on_time_pct is None, r.on_time_pct if r.on_time_pct is not None else 0))

    total_active = sum(active_weeks_by_user.values())
    total_on_time = sum(on_time_weeks_by_user.values())
    team_pct = round(total_on_time / total_active * 100) if total_active > 0 else None

    return TeamOnTimeStatsResponse(days_back=days_back, rows=rows, team_on_time_pct=team_pct)


@router.get("/team-project-matrix", response_model=TeamProjectMatrixResponse)
async def get_team_project_matrix(
    days_back: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Approved hours per employee per project over the window: the data behind a
    "who is working on what" matrix. Computed from existing time entries; no new
    data. Authorization mirrors the other manager dashboard endpoints.

    Only projects the scoped team actually logged approved time to appear as
    columns (no tenant-wide project noise). Default window is 30 days (a
    workload snapshot), shorter than the 90-day quality metrics.
    """
    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(
            status_code=403,
            detail="This endpoint is not available for your role",
        )

    tenant_timezone: Optional[str] = None
    if current_user.tenant_id is not None:
        tenant = await db.get(Tenant, current_user.tenant_id)
        if tenant is not None:
            tenant_timezone = tenant.timezone

    today = now_for_tenant(tenant_timezone).date()
    window_start = today - timedelta(days=days_back)

    team_member_ids = await _get_scoped_employee_ids(db, current_user)
    if not team_member_ids:
        return TeamProjectMatrixResponse(
            days_back=days_back, projects=[], rows=[], grand_total_hours=Decimal("0")
        )

    members_result = await db.execute(
        select(User.id, User.full_name, User.title)
        .where(User.id.in_(team_member_ids))
        .order_by(User.full_name.asc())
    )
    members = list(members_result.all())

    # Approved hours grouped by (user, project), with project + client names.
    grid_result = await db.execute(
        select(
            TimeEntry.user_id,
            TimeEntry.project_id,
            Project.name,
            Client.name,
            func.coalesce(func.sum(TimeEntry.hours), 0),
        )
        .join(Project, TimeEntry.project_id == Project.id)
        .join(Client, Project.client_id == Client.id)
        .where(
            TimeEntry.user_id.in_(team_member_ids),
            TimeEntry.entry_date >= window_start,
            TimeEntry.entry_date <= today,
            TimeEntry.status == TimeEntryStatus.APPROVED,
        )
        .group_by(TimeEntry.user_id, TimeEntry.project_id, Project.name, Client.name)
    )

    project_totals: dict[int, Decimal] = {}
    project_meta: dict[int, tuple[str, str]] = {}
    cell_hours: dict[tuple[int, int], Decimal] = {}
    for user_id, project_id, project_name, client_name, hrs in grid_result.all():
        h = Decimal(str(hrs or 0))
        cell_hours[(user_id, project_id)] = h
        project_totals[project_id] = project_totals.get(project_id, Decimal("0")) + h
        project_meta[project_id] = (project_name, client_name)

    # Project columns sorted by total hours desc (busiest project first).
    ordered_project_ids = sorted(project_totals, key=lambda pid: -project_totals[pid])
    projects = [
        TeamProjectMatrixProject(
            project_id=pid,
            project_name=project_meta[pid][0],
            client_name=project_meta[pid][1],
            total_hours=project_totals[pid],
        )
        for pid in ordered_project_ids
    ]

    # All-time revenue each person generated on these projects (approved billable
    # hours x the frozen/resolved rate). This is "how much budget they consumed"
    # in dollars. ALL-TIME on purpose — it matches the Financials tile, NOT the
    # 30-day hours column (the UI labels the revenue accordingly).
    from app.services.billing_rates import entry_billed_amount
    revenue_by_user: dict[int, Decimal] = {}
    if ordered_project_ids:
        rev_rows = (await db.execute(
            select(TimeEntry, Project)
            .join(Project, TimeEntry.project_id == Project.id)
            .where(
                TimeEntry.user_id.in_(team_member_ids),
                TimeEntry.project_id.in_(ordered_project_ids),
                TimeEntry.status == TimeEntryStatus.APPROVED,
                TimeEntry.is_billable.is_(True),
            )
        )).all()
        for entry, proj in rev_rows:
            revenue_by_user[entry.user_id] = (
                revenue_by_user.get(entry.user_id, Decimal("0"))
                + entry_billed_amount(entry, proj)
            )

    rows: list[TeamProjectMatrixRow] = []
    for user_id, full_name, title in members:
        cells: list[TeamProjectMatrixCell] = []
        row_total = Decimal("0")
        for pid in ordered_project_ids:
            h = cell_hours.get((user_id, pid), Decimal("0"))
            cells.append(TeamProjectMatrixCell(project_id=pid, hours=h))
            row_total += h
        # Only list people who actually logged hours on the displayed projects.
        # A report with zero hours everywhere isn't "working on" these projects
        # and would read as an inconsistency next to the project list.
        if row_total <= 0:
            continue
        rows.append(
            TeamProjectMatrixRow(
                user_id=user_id, full_name=full_name, title=title,
                total_hours=row_total,
                revenue=revenue_by_user.get(user_id, Decimal("0")),
                cells=cells,
            )
        )
    # Busiest employee first.
    rows.sort(key=lambda r: -r.total_hours)

    grand_total = sum(project_totals.values(), Decimal("0"))

    return TeamProjectMatrixResponse(
        days_back=days_back, projects=projects, rows=rows, grand_total_hours=grand_total
    )
