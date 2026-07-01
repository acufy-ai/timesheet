from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Optional
import time as time_module

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
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
    TeamResourcingResponse,
    ResourcingRow,
    ResourcingAllocRow,
    PortfolioResponse,
    PortfolioRow,
    EvmResponse,
    EvmRow,
    RevRecResponse,
    RevRecRow,
    HealthConfigBody,
    HealthConfigResponse,
    ProjectHealthOverrideBody,
    ProjectHealthOverrideResponse,
    ManagerClientsResponse,
    ManagerClientRow,
    ManagerClientProject,
    ProjectTaskBreakdownResponse,
    TaskBreakdownTask,
    TaskBreakdownPerson,
    TaskBlockingEdge,
    TeamDailyOverviewResponse,
    TeamRejectionReason,
    TeamRejectionRow,
    TeamRejectionStatsResponse,
    UserResponse,
    DashboardScopeOptions,
    ScopeClientOption,
    ScopeProjectOption,
    ScopeTaskOption,
    ScopePersonOption,
    ResourceDetailResponse,
    ResourceProjectRow,
    ResourceTaskRow,
)
from app.api._dashboard_scope import (
    DashboardScope, ResolvedScope, get_dashboard_scope, resolve_scope,
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


async def _get_scoped_project_ids(db: AsyncSession, current_user: "User") -> list[int]:
    """Projects in scope for the caller.

    - MANAGER: projects they own (``manager_id``) or PM (``project_managers``).
    - VIEWER / ADMIN: all active projects in the tenant.

    Used to find the client-side people (portal grants) attached to the caller's
    engagements, mirroring how ``_get_scoped_employee_ids`` scopes internal staff.
    """
    from app.models.assignments import ProjectManager

    base = select(Project.id).where(
        Project.tenant_id == current_user.tenant_id,
        Project.is_active.is_(True),
    )
    if current_user.role == UserRole.MANAGER:
        pm_ids = (await db.execute(
            select(ProjectManager.project_id).where(
                ProjectManager.tenant_id == current_user.tenant_id,
                ProjectManager.user_id == current_user.id,
            )
        )).scalars().all()
        base = base.where(
            or_(Project.manager_id == current_user.id, Project.id.in_(list(pm_ids) or [-1]))
        )
    return list((await db.execute(base)).scalars().all())


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


@dataclass
class HealthConfig:
    """Resolved thresholds behind the project-health classification. Defaults
    mirror the historical hardcoded values, so an unconfigured tenant behaves
    exactly as before. Each rule group can be disabled."""
    budget_enabled: bool = True
    over_budget_pct: float = 100.0   # critical at/above
    high_burn_pct: float = 80.0      # at-risk above
    excellent_under_pct: float = 50.0  # excellent below (+ schedule comfort)
    schedule_enabled: bool = True
    ending_soon_days: int = 7        # at-risk within
    overdue_days: int = 30           # critical past end (days)
    margin_enabled: bool = False
    low_margin_pct: float = 15.0     # at-risk below


async def _load_health_config(
    db: AsyncSession, tenant_id: int, user_id: Optional[int]
) -> HealthConfig:
    """Resolve health thresholds: the manager's own override if present, else
    the tenant's workspace default, else the built-in fallback. One query."""
    from app.models.project_health_config import ProjectHealthConfig

    rows = (await db.execute(
        select(ProjectHealthConfig).where(
            ProjectHealthConfig.tenant_id == tenant_id,
            or_(
                ProjectHealthConfig.user_id == user_id,
                ProjectHealthConfig.user_id.is_(None),
            ),
        )
    )).scalars().all()
    by_scope = {r.user_id: r for r in rows}
    row = by_scope.get(user_id) or by_scope.get(None)
    if row is None:
        return HealthConfig()
    return HealthConfig(
        budget_enabled=row.budget_enabled,
        over_budget_pct=float(row.over_budget_pct),
        high_burn_pct=float(row.high_burn_pct),
        excellent_under_pct=float(getattr(row, "excellent_under_pct", None) or 50.0),
        schedule_enabled=row.schedule_enabled,
        ending_soon_days=int(row.ending_soon_days),
        overdue_days=int(row.overdue_days),
        margin_enabled=row.margin_enabled,
        low_margin_pct=float(row.low_margin_pct),
    )


# Five-tier project health. Severity worst→best (lower rank = more urgent).
# 'not-started' (no time logged yet) and 'not-set' (no budget/dates to assess)
# are non-urgent display states, ranked last.
HEALTH_RANK = {
    "critical": 0,
    "blocked": 1,
    "at-risk": 2,
    "on-track": 3,
    "excellent": 4,
    "not-set": 5,
    "not-started": 6,
}
# Human labels (for the "Manually set to X" tooltip).
HEALTH_LABEL = {
    "critical": "Critical",
    "blocked": "Blocked",
    "at-risk": "At risk",
    "on-track": "On track",
    "excellent": "Excellent",
    "not-set": "Not set",
    "not-started": "Not started",
}
# Values a manager may set as a manual override (blocked is auto-derived from
# tasks; not-set means "no data" and isn't a deliberate choice).
MANUAL_HEALTH_VALUES = {"excellent", "on-track", "at-risk", "critical"}


def _classify_by_pace(
    pct_complete, pct_elapsed, pct_budget_used, days_until_end,
    cfg: "HealthConfig", has_blocked_task: bool,
) -> tuple[str, str]:
    """Derive health from PACE ratios (the demo-prep model): compare progress
    against how much of the schedule and budget it has consumed, so the status
    always follows logically from the inputs and can never contradict them
    (no "0% done but at risk with 170 hours logged").

    Schedule pace = % complete / % of time elapsed   (>1 ahead, ~1 on track, <1 behind)
    Budget pace   = % complete / % of budget used ($) (>1 under budget, <1 over)

    `% of budget used` is DOLLAR-based (revenue / budget), the same number the
    financials tile shows as Billed %, so health never contradicts financials.

    Mapping: both healthy → on-track/excellent; one slipping with room left →
    at-risk; both well behind (or over budget) with the deadline close → critical.
    """
    # Guard against divide-by-zero: 0% elapsed/used means we can't judge pace
    # on that axis yet, so treat it as "no signal" (None) rather than infinite.
    sched_pace = (pct_complete / pct_elapsed) if pct_elapsed and pct_elapsed > 0 else None
    budget_pace = (pct_complete / pct_budget_used) if pct_budget_used and pct_budget_used > 0 else None

    behind_schedule = sched_pace is not None and sched_pace < 0.8   # <1 with margin
    well_behind = sched_pace is not None and sched_pace < 0.5
    over_budget = budget_pace is not None and budget_pace < 1.0
    well_over_budget = budget_pace is not None and budget_pace < 0.75
    overdue = days_until_end is not None and days_until_end < 0
    deadline_close = days_until_end is not None and 0 <= days_until_end <= cfg.ending_soon_days

    def pct(x):  # these inputs are ALREADY 0-100 percentages; just round.
        return int(round(x)) if x is not None else 0

    # Reusable phrases that name exactly what each percentage measures: tasks
    # (done vs total), schedule (elapsed vs the planned window) and budget
    # (dollars spent vs the dollar budget — the same figure as Billed %).
    tasks = f"{pct_complete}% of tasks are done"
    schedule = f"{pct(pct_elapsed)}% of the schedule has passed" if pct_elapsed is not None else None
    budget = f"{pct(pct_budget_used)}% of the budget is used" if pct_budget_used is not None else None

    # 1. Critical — badly behind on both axes, or over budget with the deadline
    #    upon us, or already overdue and not done.
    if (well_behind and over_budget) or (over_budget and (deadline_close or overdue)) or (overdue and pct_complete < 100):
        reasons = []
        if over_budget and budget:
            # "only" reads wrong when tasks are actually fairly complete.
            lead = "only " if pct_complete is not None and pct_complete < 50 else ""
            reasons.append(f"{budget} but {lead}{tasks}")
        if overdue:
            reasons.append(f"the deadline passed {abs(days_until_end)} days ago")
        elif well_behind and schedule:
            reasons.append(f"{tasks} but {schedule}")
        base = "; ".join(reasons) if reasons else "the project is behind on both budget and schedule"
        return "critical", base[0].upper() + base[1:] + "."
    # 2. Blocked — after critical, so over-budget + blocked reads as critical.
    if has_blocked_task:
        return "blocked", "One or more tasks are blocked and can't move forward."
    # 3. At risk — slipping on one axis (behind schedule OR over budget), or the
    #    deadline is close. Still recoverable, so a watch rather than a crisis.
    if behind_schedule or over_budget or deadline_close:
        reasons = []
        if over_budget and budget:
            reasons.append(f"{budget} but only {tasks}")
        if behind_schedule and schedule:
            reasons.append(f"{tasks} but {schedule}, so it's behind schedule")
        if deadline_close:
            reasons.append(f"the deadline is {days_until_end} day{'s' if days_until_end != 1 else ''} away")
        base = "; ".join(reasons)
        return "at-risk", base[0].upper() + base[1:] + "."
    # 4. Healthy — completion keeping up with spend and schedule. Excellent when
    #    comfortably ahead on both; otherwise on-track.
    ahead = (sched_pace is None or sched_pace >= 1.0) and (budget_pace is None or budget_pace >= 1.1)
    tail = []
    if schedule:
        tail.append(f"{pct(pct_elapsed)}% of the schedule used")
    if budget:
        tail.append(f"{pct(pct_budget_used)}% of the budget used")
    ctx = f" ({', '.join(tail)})" if tail else ""
    if ahead and not deadline_close:
        return "excellent", f"{tasks}, ahead of both schedule and budget{ctx}."
    return "on-track", f"{tasks}, keeping pace with schedule and budget{ctx}."


def _classify_health(
    budget_pct, days_until_end, budget_amount, end_date,
    cfg: Optional["HealthConfig"] = None, margin_pct=None,
    has_blocked_task: bool = False,
    pct_complete=None, pct_elapsed=None, pct_budget_used=None,
) -> tuple[str, str]:
    """Return (health, reason) for a project. The reason is a plain-language
    explanation of WHY this health state, for the pill tooltip.

    PRIMARY (derived) path: when the caller supplies pace inputs (``pct_complete``
    with ``pct_elapsed`` and/or ``pct_budget_used``), health is derived from the
    schedule/budget PACE ratios so the status always follows from the inputs and
    can't contradict them. ``pct_budget_used`` is dollar-based (matches Billed %).
    See ``_classify_by_pace``.

    FALLBACK path (no pace inputs — e.g. the portfolio tile): the historical
    dollar-burn + deadline heuristic, unchanged, so callers that don't compute
    completion behave exactly as before.

    ``has_blocked_task`` is supplied by the caller (any task in 'blocked'
    status). This stays pure-computed; a manual override is overlaid afterward."""
    if cfg is None:
        cfg = HealthConfig()

    # Derived pace path — only when we actually have completion + at least one
    # consumption axis to compare it against.
    if pct_complete is not None and (
        (pct_elapsed is not None and pct_elapsed > 0)
        or (pct_budget_used is not None and pct_budget_used > 0)
    ):
        return _classify_by_pace(
            pct_complete, pct_elapsed, pct_budget_used, days_until_end,
            cfg, has_blocked_task,
        )

    is_over_budget = cfg.budget_enabled and budget_pct is not None and budget_pct > cfg.over_budget_pct
    is_long_overdue = cfg.schedule_enabled and days_until_end is not None and days_until_end < -cfg.overdue_days
    is_close_to_end = cfg.schedule_enabled and days_until_end is not None and 0 <= days_until_end <= cfg.ending_soon_days
    is_high_burn = cfg.budget_enabled and budget_pct is not None and budget_pct > cfg.high_burn_pct
    is_low_margin = cfg.margin_enabled and margin_pct is not None and margin_pct < cfg.low_margin_pct
    no_budget_no_end = budget_amount is None and end_date is None

    # 1. Critical — the worst computed state (over budget / long overdue).
    if is_over_budget or is_long_overdue:
        reasons = []
        if is_over_budget:
            reasons.append(f"over budget ({budget_pct}% used)")
        if is_long_overdue:
            reasons.append(f"{abs(days_until_end)} days overdue")
        return "critical", " and ".join(reasons).capitalize() + "."
    # 2. Blocked — checked after critical, so over-budget + blocked = critical.
    if has_blocked_task:
        return "blocked", "One or more tasks are blocked."
    # 3. At risk — near the end date, high burn, or thin margin.
    if is_close_to_end or is_high_burn or is_low_margin:
        reasons = []
        if is_high_burn:
            reasons.append(f"{budget_pct}% of budget used")
        if is_low_margin:
            reasons.append(f"margin {margin_pct}% below {int(cfg.low_margin_pct)}% target")
        if is_close_to_end:
            reasons.append(f"ends in {days_until_end} day{'s' if days_until_end != 1 else ''}")
        return "at-risk", " and ".join(reasons).capitalize() + "."
    # 4. Not set — nothing to assess.
    if no_budget_no_end:
        return "not-set", "No budget or end date set, so health can't be assessed."
    # 5. Excellent vs On track — healthy; excellent if comfortably under budget
    #    AND comfortably ahead of (or with no) end date, and not overdue.
    budget_comfortable = (
        not cfg.budget_enabled or budget_pct is None or budget_pct < cfg.excellent_under_pct
    )
    schedule_comfortable = (
        not cfg.schedule_enabled or days_until_end is None or days_until_end > cfg.ending_soon_days
    )
    not_overdue = days_until_end is None or days_until_end >= 0
    if budget_comfortable and schedule_comfortable and not_overdue:
        return "excellent", "Comfortably on budget and ahead of schedule."
    return "on-track", "On budget and on schedule."


def _apply_health_override(
    computed: tuple[str, str], override: Optional[str]
) -> tuple[str, str]:
    """Overlay a manager's manual override on the computed (health, reason). A
    valid override wins; the reason notes the auto value so it's never hidden."""
    if override and override in MANUAL_HEALTH_VALUES:
        computed_health, computed_reason = computed
        return override, f"Manually set to {HEALTH_LABEL[override]}. (Auto: {computed_reason})"
    return computed


async def _projects_with_blocked_task(
    db: AsyncSession, project_ids: list[int], tenant_id: int
) -> set[int]:
    """Project ids that have at least one active task in 'blocked' status. One
    grouped query so the project-health 'blocked' tier costs no N+1."""
    if not project_ids:
        return set()
    from app.models.task import Task, TaskStatus

    result = await db.execute(
        select(Task.project_id)
        .where(
            Task.project_id.in_(project_ids),
            Task.tenant_id == tenant_id,
            Task.status == TaskStatus.blocked,
            Task.is_active.is_(True),
        )
        .group_by(Task.project_id)
    )
    return {pid for (pid,) in result.all()}


async def _task_completion_by_project(
    db: AsyncSession, project_ids: list[int], tenant_id: int
) -> dict[int, tuple[int, int]]:
    """project_id -> (done_count, total_count) over active tasks. Used to derive
    a project's % complete when the manager hasn't entered one by hand."""
    if not project_ids:
        return {}
    from app.models.task import Task, TaskStatus

    rows = (await db.execute(
        select(
            Task.project_id,
            func.count(Task.id),
            func.count().filter(Task.status == TaskStatus.done),
        )
        .where(
            Task.project_id.in_(project_ids),
            Task.tenant_id == tenant_id,
            Task.is_active.is_(True),
        )
        .group_by(Task.project_id)
    )).all()
    return {pid: (int(done or 0), int(total or 0)) for pid, total, done in rows}


def _derive_pace_inputs(project, revenue, task_done_total, today):
    """Return (pct_complete, pct_elapsed, pct_budget_used) for the pace-based
    health classifier, or Nones where an input can't be established.

    - pct_complete:    the manager's entered value, else the task-done ratio.
    - pct_elapsed:     today's position in [start_date, end_date] as a %.
    - pct_budget_used: revenue / dollar budget as a %. Deliberately DOLLAR-based
      (not hours) so the health "budget used" figure is the SAME number the
      Financials tile shows as Billed % — one definition of "over budget"
      everywhere, no 120%-vs-108% contradiction.
    """
    # % complete — hand-entered wins; else derive from task completion.
    pct_complete = None
    if getattr(project, "percent_complete", None) is not None:
        pct_complete = max(0, min(100, int(project.percent_complete)))
    elif task_done_total is not None:
        done, total = task_done_total
        if total > 0:
            pct_complete = int(round(done / total * 100))

    # % of schedule elapsed.
    pct_elapsed = None
    if project.start_date and project.end_date and project.end_date > project.start_date:
        span = (project.end_date - project.start_date).days
        used = (today - project.start_date).days
        pct_elapsed = max(0.0, min(150.0, used / span * 100)) if span > 0 else None

    # % of the DOLLAR budget consumed = revenue / budget_amount (same as Billed %).
    pct_budget_used = None
    budget = getattr(project, "budget_amount", None)
    if budget is not None and Decimal(str(budget)) > 0:
        pct_budget_used = float(Decimal(str(revenue or 0)) / Decimal(str(budget)) * 100)

    return pct_complete, pct_elapsed, pct_budget_used


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


def _overlap_weeks(a_start: date, a_end: date, w_start: date, w_end: date) -> Decimal:
    """Fractional number of weeks an allocation [a_start,a_end] covers within the
    planning window [w_start,w_end]. Used to weight an allocation's intensity by
    how much of the window it actually spans (a 1-week booking shouldn't count
    the same as one spanning the whole window)."""
    lo = max(a_start, w_start)
    hi = min(a_end, w_end)
    if hi < lo:
        return Decimal("0")
    days = (hi - lo).days + 1
    return Decimal(days) / Decimal("7")


def compute_capacity(
    allocations,
    weekly_capacity: Decimal,
    window_start: date,
    window_end: date,
    pto_hours_in_window: Decimal = Decimal("0"),
    holiday_workdays_in_window: int = 0,
) -> dict:
    """Capacity utilization for ONE person over a planning window.

    Refinements over a flat percent-sum:
      - Each allocation is WEIGHTED by how many of the window's weeks it spans
        (a booking covering 2 of 8 weeks contributes 2/8 of its weekly load).
      - Available capacity is REDUCED by approved PTO + holidays in the window,
        so someone booked 100% who is also off that period reads as a conflict.

    Returns: allocated_pct (int), state ('over'|'ok'|'under'), per-project planned
    percents (window-weighted, of nominal weekly capacity), and a pto/holiday
    flag for conflict surfacing.
    """
    window_weeks = _overlap_weeks(window_start, window_end, window_start, window_end)
    if window_weeks <= 0:
        window_weeks = Decimal("1")
    cap = weekly_capacity if weekly_capacity and weekly_capacity > 0 else Decimal("40")

    # Nominal capacity-hours across the window, then subtract time off.
    nominal_hours = cap * window_weeks
    holiday_hours = (cap / 5) * Decimal(holiday_workdays_in_window)  # workday = cap/5
    available_hours = max(nominal_hours - pto_hours_in_window - holiday_hours, Decimal("0"))

    # Each allocation's hours = weekly intensity (hrs) × weeks it overlaps.
    planned_by_proj: dict[int, Decimal] = {}
    total_alloc_hours = Decimal("0")
    for a in allocations:
        if a.percent is not None:
            weekly_hours = a.percent / 100 * cap
        elif a.hours_per_week is not None:
            weekly_hours = a.hours_per_week
        else:
            weekly_hours = Decimal("0")
        weeks = _overlap_weeks(a.start_date, a.end_date, window_start, window_end)
        alloc_hours = weekly_hours * weeks
        total_alloc_hours += alloc_hours
        # Express each project's planned share as a % of NOMINAL window capacity
        # (so "70% planned" reads naturally), window-weighted.
        planned_by_proj[a.project_id] = planned_by_proj.get(a.project_id, Decimal("0")) + (
            (alloc_hours / nominal_hours * 100) if nominal_hours > 0 else Decimal("0")
        )

    # Utilization is against AVAILABLE (time-off-adjusted) capacity, so PTO pushes
    # the percentage up — that's how "booked but off" surfaces as over-capacity.
    allocated_pct = int(round((total_alloc_hours / available_hours * 100))) if available_hours > 0 else (
        100 if total_alloc_hours > 0 else 0
    )
    state = "over" if allocated_pct > 100 else ("under" if allocated_pct < 60 else "ok")
    return {
        "allocated_pct": allocated_pct,
        "state": state,
        "planned_by_proj": {pid: int(round(pc)) for pid, pc in planned_by_proj.items()},
        "pto_hours": int(round(pto_hours_in_window)),
        "holiday_days": holiday_workdays_in_window,
        "available_hours": int(round(available_hours)),
        "nominal_hours": int(round(nominal_hours)),
    }


async def _pto_and_holidays_in_window(
    db: AsyncSession, tenant_id: int, user_ids: list[int], window_start: date, window_end: date,
) -> tuple[dict[int, Decimal], int]:
    """Approved PTO hours per user, and the count of holiday WORKDAYS, within the
    window. Holidays are tenant-wide; PTO is per user (APPROVED only)."""
    from app.models.holiday import Holiday

    pto: dict[int, Decimal] = {}
    if user_ids:
        rows = (await db.execute(
            select(TimeOffRequest.user_id, func.coalesce(func.sum(TimeOffRequest.hours), 0))
            .where(
                TimeOffRequest.user_id.in_(user_ids),
                TimeOffRequest.tenant_id == tenant_id,
                TimeOffRequest.status == TimeOffStatus.APPROVED,
                TimeOffRequest.request_date >= window_start,
                TimeOffRequest.request_date <= window_end,
            )
            .group_by(TimeOffRequest.user_id)
        )).all()
        pto = {uid: Decimal(str(h or 0)) for uid, h in rows}

    holiday_dates = (await db.execute(
        select(Holiday.date).where(
            Holiday.tenant_id == tenant_id,
            Holiday.date >= window_start,
            Holiday.date <= window_end,
        )
    )).scalars().all()
    holiday_workdays = sum(1 for d in holiday_dates if d.weekday() < 5)
    return pto, holiday_workdays


@router.get("/manager-team-overview", response_model=ManagerTeamOverviewResponse)
async def get_manager_team_overview(
    week_offset: int = Query(
        0, le=0, ge=-12,
        description="Weeks back from the current week. 0 = current week "
        "(counted week-to-date); negative = a past, fully-elapsed week.",
    ),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Aggregate roster + capacity context for the manager dashboard.

    Authorization mirrors `/dashboard/team-daily-overview`: MANAGER /
    MANAGER / VIEWER / ADMIN. EMPLOYEE and PLATFORM_ADMIN get 403.

    `week_offset` lets the dashboard look back at previous weeks. For the
    current week (offset 0) counts are week-to-date (bounded by today); for a
    past week the whole Mon-Sun week is counted (it's already elapsed).
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
    current_week_start = today - timedelta(days=today.weekday())
    week_start = current_week_start + timedelta(weeks=week_offset)
    week_end = week_start + timedelta(days=6)
    next_week_start = week_start + timedelta(days=7)
    next_week_end = next_week_start + timedelta(days=6)
    # Upper bound for week-to-date counts: today for the current week (it's still
    # in progress), the full week_end for a past, already-elapsed week.
    is_past_week = week_offset < 0
    count_upper = week_end if is_past_week else today

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
            TimeEntry.entry_date <= count_upper,
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
            TimeEntry.entry_date <= count_upper,
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
        working_days = _working_days_between(week_start, count_upper)
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
        select(TimeEntry.user_id, TimeEntry.submitted_at, TimeEntry.created_at)
        .where(
            TimeEntry.user_id.in_(team_member_ids),
            TimeEntry.status == TimeEntryStatus.SUBMITTED,
        )
    )).all()
    # Count EMPLOYEES awaiting approval, not raw entries — the approval UI groups
    # by employee (and week), so 5 pending days from one employee is "1 pending",
    # matching the Approvals tab. The timestamps below still use all rows for the
    # oldest/avg age of waiting work.
    pending_approvals_count = len({r.user_id for r in pending_rows})
    pending_approvals_oldest_hours: Optional[int] = None
    pending_approvals_avg_hours: Optional[int] = None
    if pending_rows:
        now_utc = datetime.now(timezone.utc)
        ages_hours: list[float] = []
        for _uid, submitted_at, created_at in pending_rows:
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

    # Team members drive the hours/revenue aggregation below. A manager may own
    # projects without having direct reports (or with reports who haven't logged
    # time yet), so this is NOT a gate on which projects show — only on whose
    # hours count toward them.
    team_member_ids = await _get_scoped_employee_ids(db, current_user)

    # 1) Load ALL active projects this manager runs — not just ones with recent
    # logged time — so not-started projects also appear on the board. A MANAGER
    # owns a project via a direct manager_id OR a project_managers row; VIEWER/
    # ADMIN see every active project in the tenant. (Same ownership rule as
    # get_manager_clients.) Archived/inactive projects are excluded.
    from app.models.assignments import ProjectManager

    proj_q = (
        select(Project)
        .options(selectinload(Project.client))
        .where(
            Project.tenant_id == current_user.tenant_id,
            Project.is_active.is_(True),
        )
    )
    if current_user.role == UserRole.MANAGER:
        pm_ids = (await db.execute(
            select(ProjectManager.project_id).where(
                ProjectManager.tenant_id == current_user.tenant_id,
                ProjectManager.user_id == current_user.id,
            )
        )).scalars().all()
        proj_q = proj_q.where(
            or_(Project.manager_id == current_user.id, Project.id.in_(list(pm_ids) or [-1]))
        )
    projects = list((await db.execute(proj_q)).scalars().all())
    project_ids = [p.id for p in projects]
    if not project_ids:
        return ManagerProjectHealthResponse(rows=[])

    # 1b) Lifetime-worked set: projects with ANY submitted/approved time ever.
    # A project absent here has never been started → health "not-started"
    # (overlaid below, unless a manual override is set).
    worked_pids = {
        pid for (pid,) in (await db.execute(
            select(TimeEntry.project_id)
            .where(
                TimeEntry.project_id.in_(project_ids),
                TimeEntry.status.in_([TimeEntryStatus.SUBMITTED, TimeEntryStatus.APPROVED]),
            )
            .group_by(TimeEntry.project_id)
        )).all()
    }

    # 2b) Which projects have at least one BLOCKED task (Phase-2 task status).
    # One grouped query → set of project ids, so the classifier's "blocked"
    # signal costs no per-project query.
    blocked_pids = await _projects_with_blocked_task(
        db, project_ids, current_user.tenant_id
    )

    # 2c) Task completion per project (done, total) — feeds the derived
    # % complete when the manager hasn't entered one, so health can't claim
    # "0% done" while hundreds of hours are logged.
    task_completion = await _task_completion_by_project(
        db, project_ids, current_user.tenant_id
    )

    # 3) LOGGED HOURS per project (all-time, not week-scoped). This column used to
    # be "hours this week", but at the start of a week it reads 0 even when the
    # project has real budget/financials (which aggregate all-time), so it looked
    # broken. It now sums all non-rejected logged time (DRAFT + SUBMITTED +
    # APPROVED) over the project's life, so hours reconcile with the budget/health
    # figures on the same row. (The schema/pref key stays `hours_this_week` to
    # avoid breaking persisted column prefs; the UI label is "Logged hours".)
    hours_logged_result = await db.execute(
        select(TimeEntry.project_id, func.coalesce(func.sum(TimeEntry.hours), 0))
        .where(
            TimeEntry.project_id.in_(project_ids),
            TimeEntry.user_id.in_(team_member_ids),
            TimeEntry.status.in_(
                [TimeEntryStatus.DRAFT, TimeEntryStatus.SUBMITTED, TimeEntryStatus.APPROVED]
            ),
        )
        .group_by(TimeEntry.project_id)
    )
    hours_week_by_project = {pid: Decimal(str(h or 0)) for pid, h in hours_logged_result.all()}

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

    # Resolve this manager's health thresholds (own override → workspace
    # default → built-in fallback) once for the whole list.
    health_cfg = await _load_health_config(db, current_user.tenant_id, current_user.id)

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

        # Derived pace inputs (% complete / % elapsed / % budget used). Budget
        # used is dollar-based (revenue / budget), the same figure as Billed %,
        # so health never contradicts the financials tile.
        pct_complete, pct_elapsed, pct_budget_used = _derive_pace_inputs(
            project, revenue, task_completion.get(project.id), today,
        )

        health, health_reason = _apply_health_override(
            _classify_health(
                budget_pct, days_until_end, budget_amount, project.end_date,
                cfg=health_cfg, has_blocked_task=(project.id in blocked_pids),
                pct_complete=pct_complete, pct_elapsed=pct_elapsed,
                pct_budget_used=pct_budget_used,
            ),
            project.health_override,
        )
        # Not-started overlay: a project with no time logged ever reads as
        # "not-started" — unless a manager has manually set its health.
        if project.id not in worked_pids and not project.health_override:
            health = "not-started"
            health_reason = "No time logged yet."

        rows.append(
            ManagerProjectHealthRow(
                project_id=project.id,
                project_name=project.name,
                code=project.code,
                status=(project.status.value if hasattr(project.status, "value")
                        else (project.status or None)),
                client_id=project.client_id,
                client_name=project.client.name if project.client else "",
                days_until_end=days_until_end,
                hours_this_week=hours_this_week,
                budget_pct=budget_pct,
                budget_hours_remaining=budget_remaining,
                health=health,
                health_reason=health_reason,
            )
        )

    # Sort by severity (critical → blocked → at-risk → on-track → excellent →
    # not-set), then by name.
    rows.sort(key=lambda r: (HEALTH_RANK.get(r.health, 9), r.project_name.lower()))
    return ManagerProjectHealthResponse(rows=rows)


@router.get("/manager-financials", response_model=ManagerFinancialsResponse)
async def get_manager_financials(
    scope: DashboardScope = Depends(get_dashboard_scope),
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
    from app.services.billing_rates import entry_billed_amount, entry_cost_amount

    resolved = await resolve_scope(db, current_user, scope)
    if resolved.empty:
        return ManagerFinancialsResponse(summary=FinancialSummary(), projects=[])

    team_ids = await _get_scoped_employee_ids(db, current_user)
    if resolved.user_ids is not None:
        team_ids = [u for u in team_ids if u in set(resolved.user_ids)]
    if not team_ids:
        return ManagerFinancialsResponse(summary=FinancialSummary(), projects=[])

    # All APPROVED entries for the team (revenue is realized on approval).
    fin_where = [
        TimeEntry.user_id.in_(team_ids),
        TimeEntry.tenant_id == current_user.tenant_id,
        TimeEntry.status == TimeEntryStatus.APPROVED,
    ]
    if resolved.project_ids is not None:
        fin_where.append(TimeEntry.project_id.in_(resolved.project_ids or [-1]))
    if resolved.task_id is not None:
        fin_where.append(TimeEntry.task_id == resolved.task_id)
    entries = (await db.execute(select(TimeEntry).where(*fin_where))).scalars().all()
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

    # Logged hours per project = submitted (awaiting approval) + approved. The
    # `entries` above are APPROVED-only (revenue realizes on approval), so this
    # extra grouped query supplies the "logged" total. pending_approval =
    # logged - approved is derived on the frontend.
    logged_where = [
        TimeEntry.user_id.in_(team_ids),
        TimeEntry.tenant_id == current_user.tenant_id,
        TimeEntry.status.in_([TimeEntryStatus.SUBMITTED, TimeEntryStatus.APPROVED]),
        TimeEntry.project_id.in_(list(managed_ids) or [-1]),
    ]
    if resolved.task_id is not None:
        logged_where.append(TimeEntry.task_id == resolved.task_id)
    logged_rows = (await db.execute(
        select(TimeEntry.project_id, func.coalesce(func.sum(TimeEntry.hours), 0))
        .where(*logged_where)
        .group_by(TimeEntry.project_id)
    )).all()
    logged_by_pid: dict[int, Decimal] = {
        pid: Decimal(str(hrs or 0)) for pid, hrs in logged_rows
    }

    # Aggregate per project.
    agg: dict[int, dict] = {}
    total_billable = Decimal("0")
    total_nonbillable = Decimal("0")
    total_cost = Decimal("0")
    for e in entries:
        if e.project_id not in managed_ids:
            continue
        p = projects.get(e.project_id)
        d = agg.setdefault(e.project_id, {"hours": Decimal("0"), "billable": Decimal("0"), "revenue": Decimal("0"), "cost": Decimal("0")})
        hrs = e.hours or Decimal("0")
        d["hours"] += hrs
        # Labor cost applies to ALL hours (billable or not) — what the person
        # costs the firm. Zero when no cost was stamped (margin reads "unknown").
        ecost = entry_cost_amount(e)
        d["cost"] += ecost
        total_cost += ecost
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
        cost = d["cost"]
        total_revenue += revenue
        budget = p.budget_amount
        if budget:
            total_budget += budget
        budget_pct = int(round(revenue / budget * 100)) if budget and budget > 0 else None
        budget_remaining = (budget - revenue) if budget is not None else None
        # Margin (PSA): profit = revenue - cost; margin % of revenue. Only
        # meaningful when revenue > 0 and some cost was captured.
        margin = revenue - cost
        margin_pct = int(round(margin / revenue * 100)) if revenue and revenue > 0 else None
        ct = contracts.get(p.contract_id) if p.contract_id else None
        contract_pct = (
            int(round(revenue / ct.value * 100)) if ct and ct.value and ct.value > 0 else None
        )
        rows.append(ProjectFinancialRow(
            project_id=pid, project_name=p.name,
            client_id=p.client_id, client_name=client_name.get(p.client_id, ""),
            currency=p.currency or "USD",
            approved_hours=d["hours"],
            logged_hours=logged_by_pid.get(pid, d["hours"]),
            billable_hours=d["billable"], revenue=revenue,
            cost=cost, margin=margin, margin_pct=margin_pct,
            budget_amount=budget, budget_used_pct=budget_pct, budget_remaining=budget_remaining,
            contract_id=ct.id if ct else None, contract_title=ct.title if ct else None,
            contract_value=ct.value if ct else None, contract_used_pct=contract_pct,
        ))
    rows.sort(key=lambda r: r.revenue, reverse=True)

    total_hours = total_billable + total_nonbillable
    util = int(round(total_billable / total_hours * 100)) if total_hours > 0 else None
    total_margin = total_revenue - total_cost
    total_margin_pct = int(round(total_margin / total_revenue * 100)) if total_revenue and total_revenue > 0 else None
    summary = FinancialSummary(
        total_revenue=total_revenue, total_budget=total_budget,
        total_approved_hours=total_hours, billable_hours=total_billable,
        nonbillable_hours=total_nonbillable, utilization_pct=util,
        total_cost=total_cost, total_margin=total_margin, total_margin_pct=total_margin_pct,
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

    # Blocker linkage (task_dependencies), same semantics as the portal. Edge
    # (task_id=A, depends_on=B) means B blocks A. Over the user's assigned tasks:
    #   blocking_others[B] = B blocks some task A (holds up other work).
    #   blocked_by[A] = A waits on a task B (that isn't done); shown when B is
    #                   also one of the user's tasks so we can name it.
    from app.models.task_dependency import TaskDependency
    from app.schemas import MyWorkBlockerRef
    blocking_others: set[int] = set()
    blocked_by: dict[int, MyWorkBlockerRef] = {}
    if assigned_task_ids:
        vids = list(assigned_task_ids)
        dep_rows = (await db.execute(
            select(TaskDependency.task_id, TaskDependency.depends_on_task_id)
            .where(TaskDependency.tenant_id == current_user.tenant_id)
            .where(TaskDependency.task_id.in_(vids) | TaskDependency.depends_on_task_id.in_(vids))
        )).all()
        ref_ids = {tid for edge in dep_rows for tid in edge}
        name_status: dict[int, tuple] = {}
        if ref_ids:
            for tid, nm, st in (await db.execute(
                select(TaskModel.id, TaskModel.name, TaskModel.status)
                .where(TaskModel.id.in_(list(ref_ids)), TaskModel.tenant_id == current_user.tenant_id)
            )).all():
                name_status[tid] = (nm, st.value if hasattr(st, "value") else str(st))
        assigned_set = set(assigned_task_ids)
        for a_id, b_id in dep_rows:  # b blocks a
            if b_id in assigned_set:
                blocking_others.add(b_id)
            if a_id in assigned_set and b_id in name_status and name_status[b_id][1] != "done":
                blocked_by[a_id] = MyWorkBlockerRef(task_id=b_id, name=name_status[b_id][0])

    tasks_by_project: dict[int, list[MyWorkTask]] = {}
    for t in all_assigned_tasks:
        tasks_by_project.setdefault(t.project_id, []).append(MyWorkTask(
            task_id=t.id, name=t.name,
            status=t.status.value if hasattr(t.status, "value") else (str(t.status) if t.status else None),
            priority=t.priority.value if hasattr(t.priority, "value") else (str(t.priority) if t.priority else None),
            description=t.description,
            can_edit=True,
            due_date=t.due_date, blocked_reason=t.blocked_reason,
            blocking_others=(t.id in blocking_others),
            blocked_by=blocked_by.get(t.id),
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
    scope: DashboardScope = Depends(get_dashboard_scope),
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

    resolved = await resolve_scope(db, current_user, scope)
    if resolved.empty:
        return TeamOnTimeStatsResponse(days_back=days_back, rows=[], team_on_time_pct=None)

    team_member_ids = await _get_scoped_employee_ids(db, current_user)
    if resolved.user_ids is not None:
        team_member_ids = [u for u in team_member_ids if u in set(resolved.user_ids)]
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
    ontime_where = [
        TimeEntry.user_id.in_(team_member_ids),
        TimeEntry.entry_date >= window_start,
        TimeEntry.entry_date <= today,
        TimeEntry.submitted_at.is_not(None),
    ]
    if resolved.project_ids is not None:
        ontime_where.append(TimeEntry.project_id.in_(resolved.project_ids or [-1]))
    if resolved.task_id is not None:
        ontime_where.append(TimeEntry.task_id == resolved.task_id)
    entries_result = await db.execute(
        select(TimeEntry.user_id, TimeEntry.entry_date, TimeEntry.submitted_at)
        .where(*ontime_where)
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


@router.get("/team-resourcing", response_model=TeamResourcingResponse)
async def get_team_resourcing(
    weeks_ahead: int = Query(4, ge=1, le=26),
    scope: DashboardScope = Depends(get_dashboard_scope),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Resourcing view (PSA): for each team member, their PLANNED allocation %
    over the next ``weeks_ahead`` weeks vs. their weekly capacity, with an
    over/under-allocation flag. Powers the Insights > Resourcing tab.

    Allocation % per person = sum over their allocations overlapping the window
    of the allocation's intensity (percent, or hours_per_week / capacity * 100).
    > 100% = over-allocated (double-booked); < 60% = under-utilized (bench).
    """
    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(status_code=403, detail="This endpoint is not available for your role")

    from app.models.resource_allocation import ResourceAllocation

    resolved = await resolve_scope(db, current_user, scope)
    if resolved.empty:
        return TeamResourcingResponse(
            weeks_ahead=weeks_ahead, team_size=0, over_allocated=0, under_utilized=0, rows=[],
        )

    team_ids = await _get_scoped_employee_ids(db, current_user)
    if resolved.user_ids is not None:
        team_ids = [u for u in team_ids if u in set(resolved.user_ids)]
    today = date.today()
    window_end = today + timedelta(weeks=weeks_ahead)

    members = {u.id: u for u in (await db.execute(
        select(User).where(User.id.in_(team_ids or [-1]))
    )).scalars().all()}

    alloc_where = [
        ResourceAllocation.user_id.in_(team_ids or [-1]),
        ResourceAllocation.tenant_id == current_user.tenant_id,
        ResourceAllocation.start_date <= window_end,
        ResourceAllocation.end_date >= today,
    ]
    if resolved.project_ids is not None:
        alloc_where.append(ResourceAllocation.project_id.in_(resolved.project_ids or [-1]))
    allocs = (await db.execute(select(ResourceAllocation).where(*alloc_where))).scalars().all()

    proj_name = {pid: name for pid, name in (await db.execute(
        select(Project.id, Project.name).where(Project.tenant_id == current_user.tenant_id)
    )).all()}

    by_user: dict[int, list[ResourceAllocation]] = {}
    for a in allocs:
        by_user.setdefault(a.user_id, []).append(a)

    # NOTE: PTO/holiday capacity reduction is intentionally disabled for now
    # (allocation and time off are kept independent; we'll revisit). The window
    # weighting below stays active.

    rows: list[ResourcingRow] = []
    over = under = 0
    DEFAULT_CAP = Decimal("40")
    for uid in team_ids:
        u = members.get(uid)
        if u is None:
            continue
        cap = u.weekly_capacity_hours or DEFAULT_CAP
        user_allocs = by_user.get(uid, [])
        c = compute_capacity(user_allocs, cap, today, window_end)
        planned = c["planned_by_proj"]
        projects: list[ResourcingAllocRow] = []
        for a in user_allocs:
            projects.append(ResourcingAllocRow(
                project_id=a.project_id, project_name=proj_name.get(a.project_id, ""),
                percent=planned.get(a.project_id, 0),
                start_date=a.start_date.isoformat(), end_date=a.end_date.isoformat(),
            ))
        # Dedupe duplicate project rows (a project may have >1 allocation row);
        # keep the per-project planned % which is already summed.
        seen: dict[int, ResourcingAllocRow] = {}
        for pr in projects:
            seen[pr.project_id] = ResourcingAllocRow(
                project_id=pr.project_id, project_name=pr.project_name,
                percent=planned.get(pr.project_id, 0),
                start_date=pr.start_date, end_date=pr.end_date,
            )
        projects = list(seen.values())
        state = c["state"]
        if state == "over":
            over += 1
        elif state == "under":
            under += 1
        rows.append(ResourcingRow(
            user_id=uid, full_name=u.full_name, title=u.title,
            capacity_hours=cap, allocated_pct=c["allocated_pct"], state=state, allocations=projects,
        ))

    # Sort: over-allocated first (most urgent), then by allocation desc.
    rows.sort(key=lambda r: (0 if r.state == "over" else 1 if r.state == "ok" else 2, -r.allocated_pct))

    # ── Client-side resources on the caller's projects ───────────────────────
    # Portal users don't carry allocations or billing, so a capacity % is
    # meaningless for them. They appear as task-progress rows instead (assigned
    # tasks + how many are done), scoped to the caller's projects. Anything
    # billing-related is intentionally omitted.
    client_rows = await _client_resource_rows(db, current_user, resolved)

    return TeamResourcingResponse(
        weeks_ahead=weeks_ahead, team_size=len(rows),
        over_allocated=over, under_utilized=under,
        rows=rows + client_rows, client_count=len(client_rows),
    )


async def _client_resource_rows(
    db: AsyncSession, current_user: User, resolved,
) -> list[ResourcingRow]:
    """Client-side people (ClientAccessGrant) working on the caller's projects,
    as task-progress rows. No allocation, no billing — just assigned tasks and
    how many are done, so a manager can see client-side progress alongside the
    internal team."""
    from app.models.task import Task as TaskModel
    from app.models.client_access_grant import ClientAccessGrant

    scoped_project_ids = await _get_scoped_project_ids(db, current_user)
    if resolved.project_ids is not None:
        scoped_project_ids = [p for p in scoped_project_ids if p in set(resolved.project_ids)]
    if not scoped_project_ids:
        return []
    project_id_set = set(scoped_project_ids)
    proj_name = {pid: name for pid, name in (await db.execute(
        select(Project.id, Project.name).where(Project.id.in_(scoped_project_ids))
    )).all()}

    grants = (await db.execute(
        select(ClientAccessGrant.user_id, ClientAccessGrant.project_id, ClientAccessGrant.task_id)
        .where(ClientAccessGrant.tenant_id == current_user.tenant_id)
    )).all()
    if not grants:
        return []

    # Resolve task-level grants to their project (only within the caller's projects).
    grant_task_ids = [tid for _, _, tid in grants if tid is not None]
    task_project: dict[int, int] = {}
    if grant_task_ids:
        task_project = {tid: pid for tid, pid in (await db.execute(
            select(TaskModel.id, TaskModel.project_id)
            .where(TaskModel.id.in_(grant_task_ids), TaskModel.project_id.in_(scoped_project_ids))
        )).all()}

    # user -> set of granted task ids (task-level grants) + set of project ids touched.
    user_tasks: dict[int, set[int]] = {}
    user_projects: dict[int, set[int]] = {}
    for uid, gpid, gtid in grants:
        if gpid is not None and gpid in project_id_set:
            user_projects.setdefault(uid, set()).add(gpid)
        elif gtid is not None and gtid in task_project:
            user_tasks.setdefault(uid, set()).add(gtid)
            user_projects.setdefault(uid, set()).add(task_project[gtid])
    if not user_projects:
        return []

    # Progress across each user's granted tasks. Also count assigned tasks on
    # project-level grants (a project grant implies the client's tasks under it).
    from app.models.assignments import TaskAssignee
    # Tasks the client user is a formal assignee of, within the scoped projects.
    assignee_rows = (await db.execute(
        select(TaskAssignee.user_id, TaskModel.id, TaskModel.status)
        .join(TaskModel, TaskModel.id == TaskAssignee.task_id)
        .where(TaskAssignee.user_id.in_(list(user_projects.keys())),
               TaskModel.project_id.in_(scoped_project_ids))
    )).all()
    # Task statuses for the explicitly task-granted ids.
    granted_ids = {tid for tids in user_tasks.values() for tid in tids}
    granted_status = {}
    if granted_ids:
        granted_status = {tid: st for tid, st in (await db.execute(
            select(TaskModel.id, TaskModel.status).where(TaskModel.id.in_(list(granted_ids)))
        )).all()}

    # Per-user task set (assignee tasks ∪ granted tasks) with status.
    per_user_tasks: dict[int, dict[int, str]] = {}
    for uid, tid, st in assignee_rows:
        per_user_tasks.setdefault(uid, {})[tid] = st.value if hasattr(st, "value") else str(st)
    for uid, tids in user_tasks.items():
        for tid in tids:
            st = granted_status.get(tid)
            per_user_tasks.setdefault(uid, {})[tid] = (st.value if hasattr(st, "value") else str(st)) if st is not None else "to_do"

    users = {u.id: u for u in (await db.execute(
        select(User).where(User.id.in_(list(user_projects.keys())))
    )).scalars().all()}

    out: list[ResourcingRow] = []
    for uid, pids in user_projects.items():
        u = users.get(uid)
        if u is None:
            continue
        tmap = per_user_tasks.get(uid, {})
        total = len(tmap)
        done = sum(1 for st in tmap.values() if st == "done")
        pct = int(round(done / total * 100)) if total else 0
        names = sorted({proj_name.get(p, f"Project {p}") for p in pids}, key=str.lower)
        out.append(ResourcingRow(
            user_id=uid, full_name=u.full_name, title=u.title,
            is_client=True, role=u.role.value if hasattr(u.role, "value") else str(u.role),
            task_total=total, task_done=done, progress_pct=pct, project_names=names,
        ))
    # Most tasks first, then least complete (needs attention), then name.
    out.sort(key=lambda r: (-r.task_total, r.progress_pct, r.full_name.lower()))
    return out


async def _client_resource_detail(
    db: AsyncSession, current_user: User, person: User,
) -> ResourceDetailResponse:
    """Detail view for a client-side portal user: the tasks they're granted /
    assigned on the caller's projects and each task's status. No billing, cost,
    or allocation — clients aren't billed and carry no forward capacity."""
    from app.models.task import Task as TaskModel
    from app.models.assignments import TaskAssignee
    from app.models.client_access_grant import ClientAccessGrant

    scoped_project_ids = await _get_scoped_project_ids(db, current_user)
    if not scoped_project_ids:
        raise HTTPException(status_code=404, detail="Client resource not found in your projects.")
    project_id_set = set(scoped_project_ids)

    grants = (await db.execute(
        select(ClientAccessGrant.project_id, ClientAccessGrant.task_id)
        .where(ClientAccessGrant.user_id == person.id,
               ClientAccessGrant.tenant_id == current_user.tenant_id)
    )).all()
    grant_task_ids = [tid for _, tid in grants if tid is not None]
    grant_project_ids = {pid for pid, _ in grants if pid is not None} & project_id_set

    # Task-level grants within the caller's projects.
    granted_tasks = {}
    if grant_task_ids:
        granted_tasks = {t.id: t for t in (await db.execute(
            select(TaskModel).where(TaskModel.id.in_(grant_task_ids),
                                    TaskModel.project_id.in_(scoped_project_ids))
        )).scalars().all()}
    # Tasks the client user is a formal assignee of, within the caller's projects.
    assignee_tasks = {t.id: t for t in (await db.execute(
        select(TaskModel).join(TaskAssignee, TaskAssignee.task_id == TaskModel.id)
        .where(TaskAssignee.user_id == person.id, TaskModel.project_id.in_(scoped_project_ids))
    )).scalars().all()}
    all_tasks = {**granted_tasks, **assignee_tasks}

    if not all_tasks and not grant_project_ids:
        raise HTTPException(status_code=404, detail="Client resource not found in your projects.")

    proj_ids = {t.project_id for t in all_tasks.values()} | grant_project_ids
    projects = {p.id: p for p in (await db.execute(
        select(Project).where(Project.id.in_(list(proj_ids) or [-1]))
    )).scalars().all()}
    client_name = {cid: name for cid, name in (await db.execute(
        select(Client.id, Client.name).where(Client.tenant_id == current_user.tenant_id)
    )).all()}

    def _st(t) -> str:
        return t.status.value if hasattr(t.status, "value") else str(t.status)

    task_rows = []
    for tid, t in all_tasks.items():
        p = projects.get(t.project_id)
        task_rows.append(ResourceTaskRow(
            task_id=tid, task_name=t.name, project_id=t.project_id,
            project_name=p.name if p else f"Project {t.project_id}",
            client_name=client_name.get(p.client_id) if p else None,
            assigned=tid in assignee_tasks, status=_st(t),
            blocked_reason=t.blocked_reason if _st(t) == "blocked" else None,
        ))
    # Unfinished first (needs attention), done last; then by name.
    task_rows.sort(key=lambda r: (1 if r.status == "done" else 0, r.task_name.lower()))

    total = len(task_rows)
    done = sum(1 for r in task_rows if r.status == "done")
    pct = int(round(done / total * 100)) if total else 0

    return ResourceDetailResponse(
        user_id=person.id, full_name=person.full_name, title=person.title,
        days_back=0, is_client=True, tasks=task_rows,
        task_total=total, task_done=done, progress_pct=pct,
    )


@router.get("/resource/{user_id}", response_model=ResourceDetailResponse)
async def get_resource_detail(
    user_id: int,
    days_back: int = Query(90, ge=7, le=365),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Per-employee detail for the resourcing slide-over: billing rate, submitted
    vs approved hours, billed/cost, and a per-project + per-task hours breakdown
    (including which tasks they're assigned to). The target must be in the
    caller's team scope."""
    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(status_code=403, detail="This endpoint is not available for your role")

    from app.models.project import Project as ProjectModel
    from app.models.task import Task as TaskModel
    from app.models.assignments import TaskAssignee
    from app.services.billing_rates import entry_billed_amount, entry_cost_amount

    person = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if person is None:
        raise HTTPException(status_code=404, detail="Employee not found.")

    # Access gate: internal team members go through the normal path. Client-side
    # portal users are gated instead to those with a grant on the caller's
    # projects, and get a task-only (no billing) view.
    scoped = set(await _get_scoped_employee_ids(db, current_user))
    if getattr(person, "is_external", False):
        return await _client_resource_detail(db, current_user, person)
    if user_id not in scoped:
        raise HTTPException(status_code=404, detail="Employee not found in your team.")

    today = date.today()
    window_start = today - timedelta(days=days_back)

    entries = (await db.execute(
        select(TimeEntry).where(
            TimeEntry.user_id == user_id,
            TimeEntry.tenant_id == current_user.tenant_id,
            TimeEntry.entry_date >= window_start,
            TimeEntry.entry_date <= today,
        )
    )).scalars().all()

    proj_ids = {e.project_id for e in entries}
    projects = {p.id: p for p in (await db.execute(
        select(ProjectModel).where(ProjectModel.id.in_(list(proj_ids) or [-1]))
    )).scalars().all()}
    client_name = {cid: name for cid, name in (await db.execute(
        select(Client.id, Client.name).where(Client.tenant_id == current_user.tenant_id)
    )).all()}
    task_ids = {e.task_id for e in entries if e.task_id is not None}
    # Tasks the person is assigned to (even with no logged time).
    assigned_task_ids = set((await db.execute(
        select(TaskAssignee.task_id).where(TaskAssignee.user_id == user_id, TaskAssignee.tenant_id == current_user.tenant_id)
    )).scalars().all())
    all_task_ids = task_ids | assigned_task_ids
    tasks = {t.id: t for t in (await db.execute(
        select(TaskModel).where(TaskModel.id.in_(list(all_task_ids) or [-1]))
    )).scalars().all()}

    # Totals.
    submitted = approved = billable = Decimal("0")
    billed = cost = Decimal("0")
    proj_agg: dict[int, dict] = {}
    task_agg: dict[int, Decimal] = {}
    for e in entries:
        hrs = e.hours or Decimal("0")
        if e.status in (TimeEntryStatus.SUBMITTED, TimeEntryStatus.APPROVED):
            submitted += hrs
        if e.status == TimeEntryStatus.APPROVED:
            approved += hrs
            cost += entry_cost_amount(e)
            d = proj_agg.setdefault(e.project_id, {"hours": Decimal("0"), "billable": Decimal("0"), "billed": Decimal("0"), "untasked": Decimal("0")})
            d["hours"] += hrs
            if e.is_billable:
                billable += hrs
                amt = entry_billed_amount(e, projects.get(e.project_id))
                billed += amt
                d["billable"] += hrs
                d["billed"] += amt
            if e.task_id is not None:
                task_agg[e.task_id] = task_agg.get(e.task_id, Decimal("0")) + hrs
            else:
                d["untasked"] += hrs

    # ── Forward planned allocation (matches the resourcing row exactly) ───────
    from app.models.resource_allocation import ResourceAllocation
    today2 = date.today()
    window_end = today2 + timedelta(weeks=8)
    allocs = (await db.execute(
        select(ResourceAllocation).where(
            ResourceAllocation.user_id == user_id,
            ResourceAllocation.tenant_id == current_user.tenant_id,
            ResourceAllocation.start_date <= window_end,
            ResourceAllocation.end_date >= today2,
        )
    )).scalars().all()
    cap = person.weekly_capacity_hours or Decimal("40")
    # Same window-weighted math as the resourcing list (PTO/holiday adjustment
    # disabled for now), so the panel's total matches the row exactly.
    cstats = compute_capacity(allocs, cap, today2, window_end)
    planned_by_proj = {pid: Decimal(pc) for pid, pc in cstats["planned_by_proj"].items()}
    allocated_pct = cstats["allocated_pct"]
    capacity_state = cstats["state"]

    # Make sure every allocated project surfaces, even with no logged time.
    alloc_proj_ids = set(planned_by_proj)
    missing_alloc_projects = {p.id: p for p in (await db.execute(
        select(ProjectModel).where(ProjectModel.id.in_(list(alloc_proj_ids - set(proj_agg)) or [-1]))
    )).scalars().all()}
    projects.update(missing_alloc_projects)
    for cid, name in (await db.execute(
        select(Client.id, Client.name).where(Client.tenant_id == current_user.tenant_id)
    )).all():
        client_name.setdefault(cid, name)

    proj_rows = []
    all_proj_ids = set(proj_agg) | alloc_proj_ids
    for pid in all_proj_ids:
        d = proj_agg.get(pid, {"hours": Decimal("0"), "billable": Decimal("0"), "billed": Decimal("0"), "untasked": Decimal("0")})
        p = projects.get(pid)
        planned = planned_by_proj.get(pid)
        proj_rows.append(ResourceProjectRow(
            project_id=pid, project_name=p.name if p else f"Project {pid}",
            client_name=client_name.get(p.client_id) if p else None,
            hours=d["hours"], billable_hours=d["billable"], billed=d["billed"],
            untasked_hours=d["untasked"],
            planned_pct=int(round(planned)) if planned is not None else None,
        ))
    # Sort: by planned allocation desc (forward focus), then logged hours desc.
    proj_rows.sort(key=lambda r: (-(r.planned_pct or 0), -float(r.hours)))

    # ── Plain-English "why" for the capacity bucket ──────────────────────────
    n_proj = len(planned_by_proj)
    top = sorted(planned_by_proj.items(), key=lambda kv: -kv[1])
    top_names = [f"{projects[pid].name if projects.get(pid) else f'Project {pid}'} ({int(round(pc))}%)" for pid, pc in top[:2]]
    if capacity_state == "over":
        capacity_summary = (
            f"Allocated {allocated_pct}% across {n_proj} project{'s' if n_proj != 1 else ''} "
            f"({', '.join(top_names)}){' and more' if n_proj > 2 else ''} — "
            f"{allocated_pct - 100}% beyond a full schedule. Consider reducing an allocation or extending a deadline."
        )
    elif capacity_state == "under":
        if allocated_pct == 0:
            capacity_summary = "No active allocations — fully available to take on work."
        else:
            capacity_summary = (
                f"Allocated {allocated_pct}% ({', '.join(top_names)}) — about {100 - allocated_pct}% of capacity is free for more work."
            )
    else:
        capacity_summary = (
            f"Allocated {allocated_pct}% across {n_proj} project{'s' if n_proj != 1 else ''} "
            f"({', '.join(top_names)}){' and more' if n_proj > 2 else ''} — a healthy, near-full schedule."
        )

    task_rows = []
    for tid in all_task_ids:
        t = tasks.get(tid)
        if t is None:
            continue
        p = projects.get(t.project_id)
        task_rows.append(ResourceTaskRow(
            task_id=tid, task_name=t.name, project_id=t.project_id,
            project_name=p.name if p else f"Project {t.project_id}",
            client_name=client_name.get(p.client_id) if p else None,
            hours=task_agg.get(tid, Decimal("0")),
            assigned=tid in assigned_task_ids,
        ))
    task_rows.sort(key=lambda r: (-float(r.hours), r.task_name.lower()))

    return ResourceDetailResponse(
        user_id=user_id, full_name=person.full_name, title=person.title,
        cost_rate=person.cost_rate,
        submitted_hours=submitted, approved_hours=approved, billable_hours=billable,
        billed=billed, cost=cost, days_back=days_back,
        allocated_pct=allocated_pct, capacity_state=capacity_state, capacity_summary=capacity_summary,
        projects=proj_rows, tasks=task_rows,
    )


@router.get("/scope-options", response_model=DashboardScopeOptions)
async def get_scope_options(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """The clients / projects / tasks / people a caller may scope a widget to.

    Built from the caller's MANAGED projects (so the pickers can't reference a
    project they don't own) + their scoped team. Tasks come from those projects;
    clients from those projects' client ids.
    """
    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(status_code=403, detail="This endpoint is not available for your role")

    from app.models.task import Task as TaskModel

    tenant_id = current_user.tenant_id
    team_ids = await _get_scoped_employee_ids(db, current_user)

    # Projects the caller has approved time across, narrowed to the ones they manage.
    proj_ids_all = set((await db.execute(
        select(TimeEntry.project_id).where(
            TimeEntry.user_id.in_(team_ids or [-1]),
            TimeEntry.tenant_id == tenant_id,
        ).distinct()
    )).scalars().all())
    managed_ids = await _filter_managed_project_ids(db, list(proj_ids_all), tenant_id)
    projects = (await db.execute(
        select(Project).where(Project.id.in_(managed_ids or [-1]))
    )).scalars().all()
    projects.sort(key=lambda p: (p.name or "").lower())

    client_ids = {p.client_id for p in projects if p.client_id is not None}
    clients = (await db.execute(
        select(Client.id, Client.name).where(
            Client.id.in_(client_ids or [-1]), Client.tenant_id == tenant_id,
        )
    )).all()

    tasks = (await db.execute(
        select(TaskModel.id, TaskModel.name, TaskModel.project_id).where(
            TaskModel.project_id.in_(managed_ids or [-1]),
            TaskModel.tenant_id == tenant_id,
            TaskModel.is_active.is_(True),
        )
    )).all()

    people = (await db.execute(
        select(User.id, User.full_name).where(User.id.in_(team_ids or [-1]))
    )).all()

    return DashboardScopeOptions(
        clients=sorted(
            [ScopeClientOption(id=c.id, name=c.name) for c in clients],
            key=lambda c: c.name.lower(),
        ),
        projects=[ScopeProjectOption(id=p.id, name=p.name, client_id=p.client_id) for p in projects],
        tasks=sorted(
            [ScopeTaskOption(id=t.id, title=t.name, project_id=t.project_id) for t in tasks],
            key=lambda t: t.title.lower(),
        ),
        people=sorted(
            [ScopePersonOption(id=u.id, name=u.full_name or f"User {u.id}") for u in people],
            key=lambda u: u.name.lower(),
        ),
    )


@router.get("/portfolio", response_model=PortfolioResponse)
async def get_portfolio(
    scope: DashboardScope = Depends(get_dashboard_scope),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Portfolio roll-up (PSA): one row per managed project combining health,
    margin, budget burn and timeline — the whole book of work at a glance, sorted
    by attention needed. Powers Insights > Portfolio. Reuses the same health
    classification as project-health and the same revenue/cost math as
    financials, so the numbers reconcile."""
    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(status_code=403, detail="This endpoint is not available for your role")
    resolved = await resolve_scope(db, current_user, scope)
    if resolved.empty:
        return PortfolioResponse(
            project_count=0, excellent=0, on_track=0, at_risk=0, critical=0, blocked=0,
            not_set=0, total_revenue=Decimal("0"), total_cost=Decimal("0"),
            total_margin_pct=None, rows=[],
        )

    from app.models.project import Project as ProjectModel
    from app.models.client import Client
    from app.services.billing_rates import entry_billed_amount, entry_cost_amount

    team_ids = await _get_scoped_employee_ids(db, current_user)
    if resolved.user_ids is not None:
        team_ids = [u for u in team_ids if u in set(resolved.user_ids)]
    today = date.today()
    health_cfg = await _load_health_config(db, current_user.tenant_id, current_user.id)

    entry_where = [
        TimeEntry.user_id.in_(team_ids or [-1]),
        TimeEntry.tenant_id == current_user.tenant_id,
        TimeEntry.status == TimeEntryStatus.APPROVED,
    ]
    if resolved.project_ids is not None:
        entry_where.append(TimeEntry.project_id.in_(resolved.project_ids or [-1]))
    if resolved.task_id is not None:
        entry_where.append(TimeEntry.task_id == resolved.task_id)
    entries = (await db.execute(select(TimeEntry).where(*entry_where))).scalars().all()
    proj_ids = {e.project_id for e in entries}
    managed_ids = set(await _filter_managed_project_ids(db, list(proj_ids), current_user.tenant_id))
    projects = {p.id: p for p in (await db.execute(
        select(ProjectModel).where(ProjectModel.id.in_(list(proj_ids) or [-1]))
    )).scalars().all()}
    client_name = {cid: name for cid, name in (await db.execute(
        select(Client.id, Client.name).where(Client.tenant_id == current_user.tenant_id)
    )).all()}
    blocked_pids = await _projects_with_blocked_task(
        db, list(managed_ids), current_user.tenant_id
    )
    # Task completion per project — feeds the derived % complete so portfolio
    # health matches the dashboard's manager-project-health (both pace-based).
    task_completion = await _task_completion_by_project(
        db, list(managed_ids), current_user.tenant_id
    )

    agg: dict[int, dict] = {}
    for e in entries:
        if e.project_id not in managed_ids:
            continue
        d = agg.setdefault(e.project_id, {"hours": Decimal("0"), "revenue": Decimal("0"), "cost": Decimal("0")})
        d["hours"] += e.hours or Decimal("0")
        d["cost"] += entry_cost_amount(e)
        if e.is_billable:
            d["revenue"] += entry_billed_amount(e, projects.get(e.project_id))

    rows: list[PortfolioRow] = []
    counts = {"excellent": 0, "on-track": 0, "at-risk": 0, "critical": 0, "blocked": 0, "not-set": 0}
    tot_rev = tot_cost = Decimal("0")
    for pid, d in agg.items():
        p = projects.get(pid)
        if p is None:
            continue
        revenue, cost = d["revenue"], d["cost"]
        tot_rev += revenue
        tot_cost += cost
        margin = revenue - cost
        margin_pct = int(round(margin / revenue * 100)) if revenue > 0 else None
        budget = p.budget_amount
        budget_pct = int(round(revenue / budget * 100)) if budget and budget > 0 else None
        days_until_end = (p.end_date - today).days if p.end_date else None

        # Derived pace inputs so this page's health matches the dashboard.
        # Budget used = revenue / budget ($), the same figure as Billed %.
        pct_complete, pct_elapsed, pct_budget_used = _derive_pace_inputs(
            p, revenue, task_completion.get(pid), today,
        )

        health, health_reason = _apply_health_override(
            _classify_health(
                budget_pct, days_until_end, budget, p.end_date, cfg=health_cfg,
                margin_pct=margin_pct, has_blocked_task=(pid in blocked_pids),
                pct_complete=pct_complete, pct_elapsed=pct_elapsed,
                pct_budget_used=pct_budget_used,
            ),
            p.health_override,
        )
        counts[health] = counts.get(health, 0) + 1

        rows.append(PortfolioRow(
            project_id=pid, project_name=p.name, client_id=p.client_id, client_name=client_name.get(p.client_id, ""),
            health=health, health_reason=health_reason, approved_hours=d["hours"], revenue=revenue, cost=cost,
            margin=margin, margin_pct=margin_pct, budget_amount=budget, budget_used_pct=budget_pct,
            days_until_end=days_until_end, currency=p.currency or "USD",
        ))

    rows.sort(key=lambda r: (HEALTH_RANK.get(r.health, 9), -(r.margin_pct if r.margin_pct is not None else -999)))
    tot_margin_pct = int(round((tot_rev - tot_cost) / tot_rev * 100)) if tot_rev > 0 else None
    return PortfolioResponse(
        project_count=len(rows),
        excellent=counts["excellent"], on_track=counts["on-track"], at_risk=counts["at-risk"],
        critical=counts["critical"], blocked=counts["blocked"], not_set=counts["not-set"],
        total_revenue=tot_rev, total_cost=tot_cost, total_margin_pct=tot_margin_pct, rows=rows,
    )


# ── Configurable project-health thresholds ──────────────────────────────────
def _cfg_to_body(row) -> HealthConfigBody:
    return HealthConfigBody(
        budget_enabled=row.budget_enabled,
        over_budget_pct=float(row.over_budget_pct),
        high_burn_pct=float(row.high_burn_pct),
        excellent_under_pct=float(getattr(row, "excellent_under_pct", None) or 50.0),
        schedule_enabled=row.schedule_enabled,
        ending_soon_days=int(row.ending_soon_days),
        overdue_days=int(row.overdue_days),
        margin_enabled=row.margin_enabled,
        low_margin_pct=float(row.low_margin_pct),
    )


@router.get("/health-config", response_model=HealthConfigResponse)
async def get_health_config(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Read the project-health thresholds for this manager: the workspace
    default plus this manager's personal override (if any), and which is in
    effect. Managers/viewers configure how health is judged for their teams."""
    from app.models.project_health_config import ProjectHealthConfig

    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(status_code=403, detail="This endpoint is not available for your role")

    rows = (await db.execute(
        select(ProjectHealthConfig).where(
            ProjectHealthConfig.tenant_id == current_user.tenant_id,
            or_(
                ProjectHealthConfig.user_id == current_user.id,
                ProjectHealthConfig.user_id.is_(None),
            ),
        )
    )).scalars().all()
    by_scope = {r.user_id: r for r in rows}
    ws_row = by_scope.get(None)
    ov_row = by_scope.get(current_user.id)
    return HealthConfigResponse(
        workspace=_cfg_to_body(ws_row) if ws_row else HealthConfigBody(),
        override=_cfg_to_body(ov_row) if ov_row else None,
        effective_scope="override" if ov_row else "workspace",
        can_edit_workspace=True,
    )


@router.put("/health-config", response_model=HealthConfigResponse)
async def set_health_config(
    body: HealthConfigBody,
    scope: str = Query("override", pattern="^(workspace|override)$"),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Upsert the project-health thresholds. ``scope=workspace`` sets the tenant
    default (one shared row); ``scope=override`` sets this manager's personal
    override. Managers and viewers may edit both; ADMIN is read-only here."""
    from app.models.project_health_config import ProjectHealthConfig

    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER]:
        raise HTTPException(status_code=403, detail="Only managers can configure project health.")

    target_user_id = None if scope == "workspace" else current_user.id
    existing = (await db.execute(
        select(ProjectHealthConfig).where(
            ProjectHealthConfig.tenant_id == current_user.tenant_id,
            ProjectHealthConfig.user_id.is_(None) if target_user_id is None
            else ProjectHealthConfig.user_id == target_user_id,
        )
    )).scalar_one_or_none()

    fields = dict(
        budget_enabled=body.budget_enabled,
        over_budget_pct=body.over_budget_pct,
        high_burn_pct=body.high_burn_pct,
        excellent_under_pct=body.excellent_under_pct,
        schedule_enabled=body.schedule_enabled,
        ending_soon_days=body.ending_soon_days,
        overdue_days=body.overdue_days,
        margin_enabled=body.margin_enabled,
        low_margin_pct=body.low_margin_pct,
    )
    if existing is None:
        db.add(ProjectHealthConfig(
            tenant_id=current_user.tenant_id, user_id=target_user_id, **fields,
        ))
    else:
        for k, v in fields.items():
            setattr(existing, k, v)
    await db.commit()
    return await get_health_config(db=db, current_user=current_user)


@router.delete("/health-config/override", status_code=204)
async def clear_health_override(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Drop this manager's personal override so they fall back to the workspace
    default."""
    from app.models.project_health_config import ProjectHealthConfig

    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER]:
        raise HTTPException(status_code=403, detail="Only managers can configure project health.")
    await db.execute(
        ProjectHealthConfig.__table__.delete().where(
            ProjectHealthConfig.tenant_id == current_user.tenant_id,
            ProjectHealthConfig.user_id == current_user.id,
        )
    )
    await db.commit()


@router.put("/project/{project_id}/health-override", response_model=ProjectHealthOverrideResponse)
async def set_project_health_override(
    project_id: int,
    body: ProjectHealthOverrideBody,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Manually override one project's health tier (or clear it to fall back to
    the auto-computed value). ``health=null`` clears. Settable values are
    excellent | on-track | at-risk | critical (blocked is auto-derived from
    tasks; not-set means 'no data'). The PM/manager must manage the project."""
    from app.models.project import Project as ProjectModel

    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(status_code=403, detail="This endpoint is not available for your role")

    new_value = body.health
    if new_value is not None and new_value not in MANUAL_HEALTH_VALUES:
        raise HTTPException(
            status_code=422,
            detail=f"health must be one of {sorted(MANUAL_HEALTH_VALUES)} or null.",
        )

    project = (await db.execute(
        select(ProjectModel).where(
            ProjectModel.id == project_id,
            ProjectModel.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    # ADMIN/VIEWER act tenant-wide; a MANAGER may only override projects they
    # run (direct manager_id OR a project_managers row).
    if current_user.role == UserRole.MANAGER:
        from app.models.assignments import ProjectManager

        owns = project.manager_id == current_user.id or (await db.execute(
            select(ProjectManager.project_id).where(
                ProjectManager.tenant_id == current_user.tenant_id,
                ProjectManager.user_id == current_user.id,
                ProjectManager.project_id == project_id,
            ).limit(1)
        )).scalar_one_or_none() is not None
        if not owns:
            raise HTTPException(status_code=403, detail="You don't manage this project.")

    project.health_override = new_value
    await db.commit()
    return ProjectHealthOverrideResponse(
        project_id=project_id,
        health_override=new_value,
    )


@router.get("/manager-clients", response_model=ManagerClientsResponse)
async def get_manager_clients(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """The current manager's clients, each with the projects they run, for the
    dashboard "Clients & projects" widget. A MANAGER sees only projects they
    own (direct manager_id or a project_managers row); VIEWER/ADMIN see the
    whole tenant. Grouped by client, clients sorted by name."""
    from app.models.assignments import ProjectManager
    from app.models.client import Client

    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(status_code=403, detail="This endpoint is not available for your role")

    proj_q = select(Project).where(Project.tenant_id == current_user.tenant_id)
    if current_user.role == UserRole.MANAGER:
        # Projects this manager owns: direct manager_id OR a project_managers row.
        pm_ids = (await db.execute(
            select(ProjectManager.project_id).where(
                ProjectManager.tenant_id == current_user.tenant_id,
                ProjectManager.user_id == current_user.id,
            )
        )).scalars().all()
        proj_q = proj_q.where(
            or_(Project.manager_id == current_user.id, Project.id.in_(list(pm_ids) or [-1]))
        )
    projects = (await db.execute(proj_q)).scalars().all()

    client_ids = {p.client_id for p in projects if p.client_id is not None}
    client_name = {cid: name for cid, name in (await db.execute(
        select(Client.id, Client.name).where(Client.id.in_(list(client_ids) or [-1]))
    )).all()}

    by_client: dict[int, list[Project]] = {}
    for p in projects:
        if p.client_id is None:
            continue
        by_client.setdefault(p.client_id, []).append(p)

    rows: list[ManagerClientRow] = []
    for cid, projs in by_client.items():
        projs_sorted = sorted(projs, key=lambda p: p.name.lower())
        rows.append(ManagerClientRow(
            client_id=cid,
            client_name=client_name.get(cid, ""),
            project_count=len(projs_sorted),
            projects=[
                ManagerClientProject(
                    project_id=p.id, project_name=p.name,
                    status=p.status.value if hasattr(p.status, "value") else (p.status or None),
                )
                for p in projs_sorted
            ],
        ))
    rows.sort(key=lambda r: r.client_name.lower())
    return ManagerClientsResponse(client_count=len(rows), rows=rows)


@router.get("/project/{project_id}/task-breakdown", response_model=ProjectTaskBreakdownResponse)
async def get_project_task_breakdown(
    project_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Task-level "why" for a single project, computed from EXISTING data only
    (approved time per task, task status, project dates) — no fabricated causes.
    Surfaces where the hours/cost went, what's unfinished at the deadline, what's
    stalled (to_do with zero hours), and who's carrying the work. Powers the
    project report's health detail. Manager/viewer only; the project must be in
    the caller's scope."""
    from app.models.task import Task, TaskStatus
    from app.models.assignments import TaskAssignee
    from app.services.billing_rates import entry_billed_amount, entry_cost_amount

    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(status_code=403, detail="This endpoint is not available for your role")

    project = (await db.execute(
        select(Project).where(Project.id == project_id, Project.tenant_id == current_user.tenant_id)
    )).scalars().first()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    # Scope check for managers: must own the project (manager_id or a PM row).
    if current_user.role == UserRole.MANAGER:
        from app.models.assignments import ProjectManager
        owns = project.manager_id == current_user.id or (await db.execute(
            select(ProjectManager.project_id).where(
                ProjectManager.project_id == project_id,
                ProjectManager.user_id == current_user.id,
            )
        )).first() is not None
        if not owns:
            raise HTTPException(status_code=403, detail="Project is not in your scope")

    today = date.today()

    tasks = (await db.execute(
        select(Task).where(Task.project_id == project_id, Task.is_active.is_(True))
    )).scalars().all()
    tasks_by_id = {t.id: t for t in tasks}

    # Assignee names per task.
    assignee_names: dict[int, list[str]] = {}
    if tasks:
        rows = (await db.execute(
            select(TaskAssignee.task_id, User.full_name)
            .join(User, User.id == TaskAssignee.user_id)
            .where(TaskAssignee.task_id.in_([t.id for t in tasks]))
        )).all()
        for tid, name in rows:
            assignee_names.setdefault(tid, []).append(name)

    # Approved time aggregated per task and per person.
    entries = (await db.execute(
        select(TimeEntry).where(
            TimeEntry.project_id == project_id,
            TimeEntry.status == TimeEntryStatus.APPROVED,
        )
    )).scalars().all()

    per_task: dict[int, dict] = {}
    per_person: dict[int, Decimal] = {}
    total_hours = Decimal("0")
    for e in entries:
        hrs = e.hours or Decimal("0")
        total_hours += hrs
        per_person[e.user_id] = per_person.get(e.user_id, Decimal("0")) + hrs
        if e.task_id is not None:
            d = per_task.setdefault(e.task_id, {"hours": Decimal("0"), "cost": Decimal("0"), "revenue": Decimal("0")})
            d["hours"] += hrs
            d["cost"] += entry_cost_amount(e)
            if e.is_billable:
                d["revenue"] += entry_billed_amount(e, project)

    def pct(part: Decimal) -> int:
        return int(round(part / total_hours * 100)) if total_hours > 0 else 0

    def task_row(t: "Task") -> TaskBreakdownTask:
        agg = per_task.get(t.id, {"hours": Decimal("0"), "cost": Decimal("0"), "revenue": Decimal("0")})
        hrs = agg["hours"]
        # Estimate overrun — only when an estimate exists AND logged hours exceed
        # it. A missing estimate is "unknown", never an overrun.
        est = t.estimated_hours
        over_hours = None
        over_pct = None
        if est is not None and est > 0 and hrs > est:
            over_hours = hrs - est
            over_pct = int(round(float(over_hours) / float(est) * 100))
        # Overdue — only when a due_date exists and is in the past. Done tasks are
        # not "overdue"; the caller filters by open-ness where that matters.
        days_od = None
        if t.due_date is not None and t.due_date < today:
            days_od = (today - t.due_date).days
        return TaskBreakdownTask(
            task_id=t.id, name=t.name,
            status=t.status.value if hasattr(t.status, "value") else str(t.status),
            hours=hrs, cost=agg["cost"], revenue=agg["revenue"],
            pct_of_hours=pct(hrs),
            assignees=assignee_names.get(t.id, []),
            estimated_hours=est,
            due_date=t.due_date,
            blocked_reason=t.blocked_reason,
            over_estimate_hours=over_hours,
            over_estimate_pct=over_pct,
            days_overdue=days_od,
        )

    def status_str(t: "Task") -> str:
        return t.status.value if hasattr(t.status, "value") else str(t.status)

    done = [t for t in tasks if (t.status.value if hasattr(t.status, "value") else t.status) == "done"]
    open_tasks = [t for t in tasks if t not in done]

    # Top tasks by hours (where the effort/budget went).
    ranked = sorted(tasks, key=lambda t: per_task.get(t.id, {}).get("hours", Decimal("0")), reverse=True)
    top_tasks = [task_row(t) for t in ranked if per_task.get(t.id, {}).get("hours", Decimal("0")) > 0][:6]

    days_overdue = (today - project.end_date).days if project.end_date and project.end_date < today else 0
    is_overdue = days_overdue > 0
    # Open work while the project is at/past its end date (holding completion).
    near_or_past = project.end_date is not None and (project.end_date - today).days <= 7
    unfinished = [task_row(t) for t in open_tasks] if near_or_past else []
    unfinished.sort(key=lambda r: r.hours, reverse=True)

    # Stalled: to_do with zero approved hours (not started / candidate blockers).
    stalled = [
        task_row(t) for t in tasks
        if (t.status.value if hasattr(t.status, "value") else t.status) == "to_do"
        and per_task.get(t.id, {}).get("hours", Decimal("0")) == 0
    ]

    name_by_user = {uid: n for uid, n in (await db.execute(
        select(User.id, User.full_name).where(User.id.in_(list(per_person.keys()) or [-1]))
    )).all()}
    by_person = sorted(
        [TaskBreakdownPerson(user_id=uid, full_name=name_by_user.get(uid, "—"), hours=h, pct_of_hours=pct(h))
         for uid, h in per_person.items()],
        key=lambda p: p.hours, reverse=True,
    )[:8]

    # ── Phase 2 cause signals (each empty until the data is captured) ────────
    # Blocked: status == blocked. Carries blocked_reason for the "why" line.
    blocked_tasks = [task_row(t) for t in tasks if status_str(t) == "blocked"]

    # Over estimate: logged hours exceeded the task's estimate. Sort by the
    # biggest absolute overrun first.
    over_estimate_tasks = [
        r for r in (task_row(t) for t in tasks) if r.over_estimate_hours is not None
    ]
    over_estimate_tasks.sort(key=lambda r: r.over_estimate_hours or Decimal("0"), reverse=True)

    # Overdue: OPEN tasks past their own due date. A done task is never overdue,
    # and a task with no due date is "unknown" (excluded).
    overdue_tasks = [
        task_row(t) for t in tasks
        if status_str(t) != "done" and t.due_date is not None and t.due_date < today
    ]
    overdue_tasks.sort(key=lambda r: r.days_overdue or 0, reverse=True)

    # Blocking chains: an OPEN predecessor still holding a dependent task. We only
    # surface edges where the blocker isn't done (a finished predecessor no longer
    # blocks). Names resolved from tasks_by_id; cross-project edges can't exist.
    from app.models.task_dependency import TaskDependency
    dep_rows = (await db.execute(
        select(TaskDependency).where(
            TaskDependency.task_id.in_([t.id for t in tasks] or [-1])
        )
    )).scalars().all()
    blocking_chains: list[TaskBlockingEdge] = []
    for d in dep_rows:
        dep_task = tasks_by_id.get(d.task_id)
        blocker = tasks_by_id.get(d.depends_on_task_id)
        if dep_task is None or blocker is None:
            continue
        blocker_open = status_str(blocker) != "done"
        if not blocker_open:
            continue
        # Has the dependent task already had work logged against it? If so, the
        # "waiting on a predecessor" framing would contradict the logged time, so
        # we flag it and the copy describes it as "in progress before its
        # prerequisite is done" (a real process signal) instead.
        dep_started = (
            per_task.get(d.task_id, {}).get("hours", Decimal("0")) > 0
            or status_str(dep_task) == "in_progress"
        )
        blocking_chains.append(TaskBlockingEdge(
            task_id=d.task_id, task_name=dep_task.name,
            depends_on_task_id=d.depends_on_task_id, depends_on_task_name=blocker.name,
            reason=d.reason, blocker_open=blocker_open,
            dependent_started=dep_started,
        ))

    has_causal_data = any(
        t.estimated_hours is not None or t.due_date is not None or t.blocked_reason
        for t in tasks
    ) or bool(dep_rows)

    # Data-derived headline notes. The specific task-level causes (blocked /
    # over-estimate / overdue / blocking chain) render from their structured
    # lists in the cause-signals block, so we do NOT repeat them here — these
    # notes carry only the project-level summary (where the hours concentrated,
    # deadline pressure, not-started count) that the block doesn't cover.
    notes: list[str] = []
    if top_tasks:
        t0 = top_tasks[0]
        t1 = top_tasks[1] if len(top_tasks) > 1 else None
        # Only call out ONE task as the driver when it clearly dominates the
        # next one (>=1.5x its hours). When the top tasks are tied/close, that
        # framing is misleading — describe the concentration across them instead.
        dominates = t1 is None or float(t0.hours) >= 1.5 * float(t1.hours)
        if t0.pct_of_hours >= 40 and dominates:
            notes.append(f"“{t0.name}” took the most time — {t0.pct_of_hours}% of logged hours ({int(round(float(t0.hours)))}h).")
        elif t1 is not None and (t0.pct_of_hours + t1.pct_of_hours) >= 70:
            notes.append(f"Most of the hours went to “{t0.name}” and “{t1.name}” ({t0.pct_of_hours + t1.pct_of_hours}% combined).")
    if is_overdue and len(open_tasks) > 0:
        notes.append(f"{len(open_tasks)} of {len(tasks)} tasks are still open {days_overdue} days past the end date.")
    elif near_or_past and len(open_tasks) > 0:
        notes.append(f"{len(open_tasks)} of {len(tasks)} tasks are still open as the deadline approaches.")
    if stalled:
        notes.append(f"{len(stalled)} task{'s' if len(stalled) != 1 else ''} not started (no time logged yet).")

    return ProjectTaskBreakdownResponse(
        project_id=project.id, project_name=project.name,
        total_tasks=len(tasks), done_tasks=len(done), open_tasks=len(open_tasks),
        total_hours=total_hours, is_overdue=is_overdue, days_overdue=days_overdue,
        top_tasks=top_tasks, unfinished_at_deadline=unfinished[:6],
        stalled_tasks=stalled[:6], by_person=by_person,
        blocked_tasks=blocked_tasks[:6],
        over_estimate_tasks=over_estimate_tasks[:6],
        overdue_tasks=overdue_tasks[:6],
        blocking_chains=blocking_chains[:6],
        has_causal_data=has_causal_data,
        notes=notes,
    )


@router.get("/evm", response_model=EvmResponse)
async def get_evm(
    scope: DashboardScope = Depends(get_dashboard_scope),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Earned Value Management (PSA): for each project with an ACTIVE baseline,
    compute PV (planned value), EV (earned value), AC (actual cost), and the
    derived CPI/SPI + cost/schedule variance. Powers Insights > Forecasts.

      PV = planned_cost * schedule_elapsed%  (linear over the baseline window)
      EV = planned_cost * work_complete%      (approved hours / planned hours)
      AC = actual labor cost incurred         (sum of cost snapshots)
      CPI = EV/AC  (>1 = under cost) ; SPI = EV/PV (>1 = ahead of schedule)
      CV = EV-AC   ; SV = EV-PV
    """
    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(status_code=403, detail="This endpoint is not available for your role")

    from app.models.project import Project as ProjectModel
    from app.models.client import Client
    from app.models.project_baseline import ProjectBaseline
    from app.services.billing_rates import entry_cost_amount

    # EVM is per-project; only the client/project scope axes apply (a CPI for a
    # single task or one person isn't meaningful), so we filter the project set.
    resolved = await resolve_scope(db, current_user, scope)
    if resolved.empty:
        return EvmResponse(rows=[])

    team_ids = await _get_scoped_employee_ids(db, current_user)
    today = date.today()

    bl_where = [
        ProjectBaseline.tenant_id == current_user.tenant_id,
        ProjectBaseline.is_active == True,  # noqa: E712
    ]
    if resolved.project_ids is not None:
        bl_where.append(ProjectBaseline.project_id.in_(resolved.project_ids or [-1]))
    baselines = (await db.execute(select(ProjectBaseline).where(*bl_where))).scalars().all()
    if not baselines:
        return EvmResponse(rows=[])
    bl_by_proj = {b.project_id: b for b in baselines}

    entries = (await db.execute(
        select(TimeEntry).where(
            TimeEntry.user_id.in_(team_ids or [-1]),
            TimeEntry.tenant_id == current_user.tenant_id,
            TimeEntry.project_id.in_(list(bl_by_proj.keys())),
            TimeEntry.status == TimeEntryStatus.APPROVED,
        )
    )).scalars().all()
    actual: dict[int, dict] = {}
    for e in entries:
        a = actual.setdefault(e.project_id, {"hours": Decimal("0"), "cost": Decimal("0")})
        a["hours"] += e.hours or Decimal("0")
        a["cost"] += entry_cost_amount(e)

    projects = {p.id: p for p in (await db.execute(
        select(ProjectModel).where(ProjectModel.id.in_(list(bl_by_proj.keys())))
    )).scalars().all()}
    client_name = {cid: name for cid, name in (await db.execute(
        select(Client.id, Client.name).where(Client.tenant_id == current_user.tenant_id)
    )).all()}
    # Task completion drives "work complete %" so EVM's % done matches the task
    # card (and health) — one completion number everywhere. Hours are only a
    # fallback for projects that have no tasks to measure against.
    task_completion = await _task_completion_by_project(
        db, list(bl_by_proj.keys()), current_user.tenant_id
    )

    def _pct(n: Decimal, d: Decimal) -> Decimal:
        return (n / d) if d and d > 0 else Decimal("0")

    rows: list[EvmRow] = []
    for pid, bl in bl_by_proj.items():
        p = projects.get(pid)
        if p is None:
            continue
        bac = bl.planned_cost or Decimal("0")            # budget at completion
        a = actual.get(pid, {"hours": Decimal("0"), "cost": Decimal("0")})
        ac = a["cost"]

        # schedule elapsed %
        if bl.baseline_start and bl.baseline_end and bl.baseline_end > bl.baseline_start:
            total = Decimal((bl.baseline_end - bl.baseline_start).days)
            elapsed = Decimal((min(today, bl.baseline_end) - bl.baseline_start).days)
            sched_pct = max(Decimal("0"), min(Decimal("1"), _pct(elapsed, total)))
        else:
            sched_pct = Decimal("0")
        # work complete % — task done/total (so it agrees with the task card and
        # health), falling back to hours/planned-hours when the project has no
        # tasks to measure.
        done_total = task_completion.get(pid)
        if done_total and done_total[1] > 0:
            work_pct = min(Decimal("1"), Decimal(done_total[0]) / Decimal(done_total[1]))
        else:
            work_pct = min(Decimal("1"), _pct(a["hours"], bl.planned_hours or Decimal("0")))

        pv = bac * sched_pct
        ev = bac * work_pct
        cpi = _pct(ev, ac) if ac > 0 else None
        spi = _pct(ev, pv) if pv > 0 else None

        # FORECAST (predictive): project the final outcome from current trend.
        #   EAC (estimate at completion) = BAC / CPI — at current efficiency.
        #   VAC (variance at completion) = BAC - EAC ; negative = projected overrun.
        # Risk: cost overrun (EAC>BAC by >5%) and/or behind schedule (SPI<0.9).
        eac = (bac / Decimal(str(cpi))) if (cpi and cpi > 0) else (bac if bac else Decimal("0"))
        vac = bac - eac
        over_pct = int(round(float(_pct(eac - bac, bac)) * 100)) if bac and bac > 0 else 0
        cost_risk = eac > bac * Decimal("1.05")
        sched_risk = spi is not None and spi < Decimal("0.9")
        if cost_risk and sched_risk:
            risk = "high"
        elif cost_risk or sched_risk:
            risk = "medium"
        else:
            risk = "low"

        rows.append(EvmRow(
            project_id=pid, project_name=p.name, client_name=client_name.get(p.client_id, ""),
            bac=bac, pv=pv.quantize(Decimal("1")), ev=ev.quantize(Decimal("1")), ac=ac.quantize(Decimal("1")),
            cpi=round(float(cpi), 2) if cpi is not None else None,
            spi=round(float(spi), 2) if spi is not None else None,
            cost_variance=(ev - ac).quantize(Decimal("1")),
            schedule_variance=(ev - pv).quantize(Decimal("1")),
            percent_complete=int(round(work_pct * 100)),
            eac=eac.quantize(Decimal("1")), vac=vac.quantize(Decimal("1")),
            projected_overrun_pct=over_pct, risk=risk,
            currency=bl.currency or "USD",
        ))
    # Sort by risk (high first), then worst CPI.
    risk_order = {"high": 0, "medium": 1, "low": 2}
    rows.sort(key=lambda r: (risk_order.get(r.risk, 9), r.cpi if r.cpi is not None else 99))
    return EvmResponse(rows=rows)


@router.get("/revenue-recognition", response_model=RevRecResponse)
async def get_revenue_recognition(
    scope: DashboardScope = Depends(get_dashboard_scope),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Recognized revenue per project by its rev-rec method (PSA):
      as_billed        -> approved billable hours x rate (the billed amount).
      percent_complete -> (contract value or budget) x (hours done / planned),
                          from the active baseline. Fixed-fee work.
    Surfaces recognized vs. billed so a manager sees the gap. Manager/viewer."""
    if current_user.role not in [UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN]:
        raise HTTPException(status_code=403, detail="This endpoint is not available for your role")

    from app.models.project import Project as ProjectModel
    from app.models.client import Client
    from app.models.contract import Contract
    from app.models.project_baseline import ProjectBaseline
    from app.services.billing_rates import entry_billed_amount

    resolved = await resolve_scope(db, current_user, scope)
    if resolved.empty:
        return RevRecResponse(rows=[])

    team_ids = await _get_scoped_employee_ids(db, current_user)
    if resolved.user_ids is not None:
        team_ids = [u for u in team_ids if u in set(resolved.user_ids)]
    rr_where = [
        TimeEntry.user_id.in_(team_ids or [-1]),
        TimeEntry.tenant_id == current_user.tenant_id,
        TimeEntry.status == TimeEntryStatus.APPROVED,
    ]
    if resolved.project_ids is not None:
        rr_where.append(TimeEntry.project_id.in_(resolved.project_ids or [-1]))
    if resolved.task_id is not None:
        rr_where.append(TimeEntry.task_id == resolved.task_id)
    entries = (await db.execute(select(TimeEntry).where(*rr_where))).scalars().all()
    proj_ids = {e.project_id for e in entries}
    managed_ids = set(await _filter_managed_project_ids(db, list(proj_ids), current_user.tenant_id))
    projects = {p.id: p for p in (await db.execute(
        select(ProjectModel).where(ProjectModel.id.in_(list(proj_ids) or [-1]))
    )).scalars().all()}
    client_name = {cid: name for cid, name in (await db.execute(
        select(Client.id, Client.name).where(Client.tenant_id == current_user.tenant_id)
    )).all()}
    contracts = {c.id: c for c in (await db.execute(select(Contract))).scalars().all()}
    baselines = {b.project_id: b for b in (await db.execute(
        select(ProjectBaseline).where(
            ProjectBaseline.tenant_id == current_user.tenant_id,
            ProjectBaseline.is_active == True,  # noqa: E712
        )
    )).scalars().all()}

    agg: dict[int, dict] = {}
    for e in entries:
        if e.project_id not in managed_ids:
            continue
        d = agg.setdefault(e.project_id, {"hours": Decimal("0"), "billed": Decimal("0")})
        d["hours"] += e.hours or Decimal("0")
        if e.is_billable:
            d["billed"] += entry_billed_amount(e, projects.get(e.project_id))

    rows: list[RevRecRow] = []
    tot_billed = tot_recognized = Decimal("0")
    for pid, d in agg.items():
        p = projects.get(pid)
        if p is None:
            continue
        method = p.revenue_recognition or "as_billed"
        billed = d["billed"]
        if method == "percent_complete":
            bl = baselines.get(pid)
            ct = contracts.get(p.contract_id) if p.contract_id else None
            # Prefer the project budget (the fixed fee for this engagement) over a
            # blanket contract value, which may span many projects and overstate
            # this one's recognizable revenue.
            total_value = p.budget_amount or (ct.value if ct and ct.value else None) or Decimal("0")
            planned_hours = (bl.planned_hours if bl else None) or p.estimated_hours
            pct = (d["hours"] / planned_hours) if planned_hours and planned_hours > 0 else Decimal("0")
            pct = min(Decimal("1"), pct)
            recognized = (total_value * pct).quantize(Decimal("1"))
            pct_complete = int(round(pct * 100))
        else:
            recognized = billed
            pct_complete = None
        tot_billed += billed
        tot_recognized += recognized
        rows.append(RevRecRow(
            project_id=pid, project_name=p.name, client_name=client_name.get(p.client_id, ""),
            method=method, billed=billed.quantize(Decimal("1")), recognized=recognized,
            percent_complete=pct_complete, currency=p.currency or "USD",
        ))
    rows.sort(key=lambda r: -float(r.recognized))
    return RevRecResponse(
        total_billed=tot_billed, total_recognized=tot_recognized, rows=rows,
    )
