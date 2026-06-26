from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy.orm import selectinload
from sqlalchemy import and_, asc, desc, func, or_
from sqlalchemy import false as sa_false
from sqlalchemy.exc import IntegrityError
from decimal import Decimal
from app.models.time_entry import TimeEntry, TimeEntryEditHistory, TimeEntryStatus
from app.models.project import Project
from app.models.task import Task
from app.models.user import User
from app.models.tenant_settings import TenantSettings
from app.core.config import settings
from app.schemas import TimeEntryCreate, TimeEntryUpdate
from typing import Optional
from datetime import date, datetime, timedelta, timezone


DEFAULT_PAST_DAYS = 14
DEFAULT_FUTURE_DAYS = 0


def _coerce_int(value: Optional[str], default: int) -> int:
    if value is None:
        return default
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    return max(0, n)


def _coerce_float(value: Optional[str], default: float) -> float:
    if value is None:
        return default
    try:
        n = float(str(value).strip())
    except (TypeError, ValueError):
        return default
    return max(0.0, n)


def _coerce_bool(value: Optional[str], default: bool) -> bool:
    if value is None:
        return default
    return str(value).strip().lower() in ("true", "1", "yes", "on")


async def _tenant_hours_policy(db: AsyncSession, tenant_id: int) -> dict:
    """Return per-tenant hour caps with env-config defaults."""
    result = await db.execute(
        select(TenantSettings.key, TenantSettings.value).where(
            TenantSettings.tenant_id == tenant_id,
            TenantSettings.key.in_((
                "max_hours_per_entry",
                "max_hours_per_day",
                "max_hours_per_week",
                "min_submit_weekly_hours",
                "allow_partial_week_submit",
            )),
        )
    )
    rows = {row[0]: row[1] for row in result.all()}
    return {
        "max_per_entry": _coerce_float(rows.get("max_hours_per_entry"), settings.max_hours_per_entry),
        "max_per_day": _coerce_float(rows.get("max_hours_per_day"), settings.max_hours_per_day),
        "max_per_week": _coerce_float(rows.get("max_hours_per_week"), settings.max_hours_per_week),
        "min_submit_weekly": _coerce_float(rows.get("min_submit_weekly_hours"), settings.min_submit_weekly_hours),
        "allow_partial_week": _coerce_bool(rows.get("allow_partial_week_submit"), False),
    }


async def _entry_window(db: AsyncSession, tenant_id: int) -> tuple[date, date, int, int]:
    """Return (min_date, max_date, past_days, future_days) for the tenant's editable window."""
    result = await db.execute(
        select(TenantSettings.key, TenantSettings.value).where(
            TenantSettings.tenant_id == tenant_id,
            TenantSettings.key.in_(("time_entry_past_days", "time_entry_future_days")),
        )
    )
    rows = {row[0]: row[1] for row in result.all()}
    past_days = _coerce_int(rows.get("time_entry_past_days"), DEFAULT_PAST_DAYS)
    future_days = _coerce_int(rows.get("time_entry_future_days"), DEFAULT_FUTURE_DAYS)
    today = date.today()
    return today - timedelta(days=past_days), today + timedelta(days=future_days), past_days, future_days


def _format_window_error(action: str, past_days: int, future_days: int) -> str:
    parts = [f"up to {past_days} day{'s' if past_days != 1 else ''} in the past"]
    if future_days > 0:
        parts.append(f"and {future_days} day{'s' if future_days != 1 else ''} in the future")
    else:
        parts.append("but not in the future")
    return f"You can only {action} time {' '.join(parts)}."


async def get_time_entry_by_id(db: AsyncSession, entry_id: int, tenant_id: Optional[int] = None) -> Optional[TimeEntry]:
    """Get time entry by ID, scoped to a tenant. Pass tenant_id=None only for PLATFORM_ADMIN."""
    query = select(TimeEntry).where(TimeEntry.id == entry_id)
    if tenant_id is not None:
        query = query.where(TimeEntry.tenant_id == tenant_id)
    query = query.options(
        selectinload(TimeEntry.user).selectinload(User.manager_assignment),
        selectinload(TimeEntry.user).selectinload(User.project_access),
        selectinload(TimeEntry.project),
        selectinload(TimeEntry.task),
        selectinload(TimeEntry.approved_by_user),
    )
    result = await db.execute(query)
    return result.scalars().first()


async def get_time_entries_by_ids(db: AsyncSession, entry_ids: list[int], tenant_id: Optional[int] = None) -> list[TimeEntry]:
    if not entry_ids:
        return []

    query = select(TimeEntry).where(TimeEntry.id.in_(entry_ids))
    if tenant_id is not None:
        query = query.where(TimeEntry.tenant_id == tenant_id)
    query = query.options(
        selectinload(TimeEntry.user).selectinload(User.manager_assignment),
        selectinload(TimeEntry.user).selectinload(User.project_access),
        selectinload(TimeEntry.project),
        selectinload(TimeEntry.task),
        selectinload(TimeEntry.approved_by_user),
    )
    result = await db.execute(query)
    return list(result.scalars().all())


async def count_protected_entries_for_project(
    db: AsyncSession, project_id: int, tenant_id: Optional[int] = None
) -> int:
    """Count time entries on a project that must not be silently destroyed.

    Anything beyond a personal DRAFT is billing-relevant history (submitted,
    approved, or rejected). Used to block destructive project/client deletes.
    """
    query = select(func.count(TimeEntry.id)).where(
        TimeEntry.project_id == project_id,
        TimeEntry.status != TimeEntryStatus.DRAFT,
    )
    if tenant_id is not None:
        query = query.where(TimeEntry.tenant_id == tenant_id)
    return int((await db.execute(query)).scalar_one())


async def count_protected_entries_for_client(
    db: AsyncSession, client_id: int, tenant_id: Optional[int] = None
) -> int:
    """Count non-DRAFT time entries across every project under a client."""
    query = (
        select(func.count(TimeEntry.id))
        .select_from(TimeEntry)
        .join(Project, Project.id == TimeEntry.project_id)
        .where(
            Project.client_id == client_id,
            TimeEntry.status != TimeEntryStatus.DRAFT,
        )
    )
    if tenant_id is not None:
        query = query.where(TimeEntry.tenant_id == tenant_id)
    return int((await db.execute(query)).scalar_one())


async def create_time_entry(db: AsyncSession, user_id: int, tenant_id: int, entry_create: TimeEntryCreate) -> TimeEntry:
    """Create a new time entry."""
    min_date, max_date, past_days, future_days = await _entry_window(db, tenant_id)
    if entry_create.entry_date < min_date or entry_create.entry_date > max_date:
        raise ValueError(_format_window_error("log", past_days, future_days))

    await _validate_hours_constraints(
        db,
        user_id=user_id,
        tenant_id=tenant_id,
        entry_date=entry_create.entry_date,
        hours=entry_create.hours,
    )
    await _validate_task_selection(
        db,
        project_id=entry_create.project_id,
        task_id=entry_create.task_id,
    )

    db_entry = TimeEntry(
        user_id=user_id,
        tenant_id=tenant_id,
        created_by=user_id,
        updated_by=user_id,
        **entry_create.model_dump()
    )
    db.add(db_entry)
    try:
        await db.commit()
        await db.refresh(db_entry)
    except IntegrityError:
        await db.rollback()
        raise
    return db_entry


def _week_start(value: date, week_start_day: int = 0) -> date:
    """Return the date of the start of the week containing `value`.

    week_start_day: 0=Sunday, 1=Monday (matches date-fns convention).
    Defaults to Sunday for the synchronous callers that don't have tenant context;
    async callers should pass the tenant's configured value.
    """
    # Python's weekday() returns 0=Monday..6=Sunday. Convert to days-since-Sunday-or-Monday.
    py_weekday = value.weekday()  # 0=Mon..6=Sun
    if week_start_day == 0:
        # Sunday-based: shift so Sunday=0..Saturday=6
        offset = (py_weekday + 1) % 7
    else:
        # Monday-based: already 0=Mon..6=Sun
        offset = py_weekday
    return value - timedelta(days=offset)


def _last_working_day_for_week(value: date, week_start_day: int = 0) -> date:
    return _week_start(value, week_start_day) + timedelta(days=4)


async def _tenant_week_start_day(db: AsyncSession, tenant_id: int) -> int:
    """0=Sunday (default), 1=Monday."""
    result = await db.execute(
        select(TenantSettings.value).where(
            TenantSettings.tenant_id == tenant_id,
            TenantSettings.key == "week_start_day",
        )
    )
    raw = result.scalar_one_or_none()
    n = _coerce_int(raw, 0)
    return 1 if n == 1 else 0


async def _validate_hours_constraints(
    db: AsyncSession,
    user_id: int,
    tenant_id: int,
    entry_date: date,
    hours: Decimal,
    exclude_entry_id: Optional[int] = None,
) -> None:
    entry_hours = Decimal(str(hours))
    policy = await _tenant_hours_policy(db, tenant_id)
    max_hours_per_entry = Decimal(str(policy["max_per_entry"]))
    max_hours_per_day = Decimal(str(policy["max_per_day"]))
    max_hours_per_week = Decimal(str(policy["max_per_week"]))

    if entry_hours > max_hours_per_entry:
        raise ValueError(
            f"Hours per entry cannot exceed {policy['max_per_entry']:g}"
        )

    daily_query = select(func.coalesce(func.sum(TimeEntry.hours), 0)).where(
        (TimeEntry.user_id == user_id)
        & (TimeEntry.entry_date == entry_date)
        & (TimeEntry.status != TimeEntryStatus.REJECTED)
    )
    if exclude_entry_id is not None:
        daily_query = daily_query.where(TimeEntry.id != exclude_entry_id)

    daily_existing_total = Decimal(str((await db.scalar(daily_query)) or 0))
    if daily_existing_total + entry_hours > max_hours_per_day:
        raise ValueError(
            f"Daily total hours cannot exceed {policy['max_per_day']:g}"
        )

    wsd = await _tenant_week_start_day(db, tenant_id)
    week_start = _week_start(entry_date, wsd)
    week_end = week_start + timedelta(days=6)
    weekly_query = select(func.coalesce(func.sum(TimeEntry.hours), 0)).where(
        (TimeEntry.user_id == user_id)
        & (TimeEntry.entry_date >= week_start)
        & (TimeEntry.entry_date <= week_end)
        & (TimeEntry.status != TimeEntryStatus.REJECTED)
    )
    if exclude_entry_id is not None:
        weekly_query = weekly_query.where(TimeEntry.id != exclude_entry_id)

    weekly_existing_total = Decimal(str((await db.scalar(weekly_query)) or 0))
    if weekly_existing_total + entry_hours > max_hours_per_week:
        raise ValueError(
            f"Weekly total hours cannot exceed {policy['max_per_week']:g}"
        )


async def _validate_task_selection(
    db: AsyncSession,
    project_id: int,
    task_id: Optional[int],
) -> None:
    if task_id is None:
        return

    result = await db.execute(
        select(Task).where(Task.id == task_id)
    )
    task = result.scalars().first()
    if not task:
        raise ValueError("Selected task not found")
    if not task.is_active:
        raise ValueError("Selected task is inactive")
    if task.project_id != project_id:
        raise ValueError("Selected task does not belong to selected project")


async def update_time_entry(
    db: AsyncSession,
    entry: TimeEntry,
    entry_update: TimeEntryUpdate,
    edited_by: int,
) -> TimeEntry:
    """Update time entry (DRAFT or REJECTED entries). REJECTED entries transition back to DRAFT."""
    if entry.status not in (TimeEntryStatus.DRAFT, TimeEntryStatus.REJECTED):
        raise ValueError("Can only update DRAFT or REJECTED time entries")

    update_data = entry_update.model_dump(exclude_unset=True)
    edit_reason = (update_data.pop("edit_reason", None) or "").strip()
    history_summary = (update_data.pop("history_summary", None) or "").strip()
    # Employee self-edits of their own DRAFT/REJECTED entries don't require an
    # edit reason — they own the timesheet until it's submitted, and this is the
    # only path that reaches here (update is restricted to DRAFT/REJECTED above).
    # We still record a non-null audit summary so the history isn't blank.
    if not edit_reason:
        edit_reason = "Edited by employee"
    if not history_summary:
        history_summary = edit_reason

    target_entry_date = update_data.get("entry_date", entry.entry_date)
    target_hours = update_data.get("hours", entry.hours)
    target_project_id = update_data.get("project_id", entry.project_id)
    target_task_id = update_data.get("task_id", entry.task_id)

    min_date, max_date, past_days, future_days = await _entry_window(db, entry.tenant_id)
    if target_entry_date < min_date or target_entry_date > max_date:
        raise ValueError(_format_window_error("set entry date", past_days, future_days))

    await _validate_hours_constraints(
        db,
        user_id=entry.user_id,
        tenant_id=entry.tenant_id,
        entry_date=target_entry_date,
        hours=target_hours,
        exclude_entry_id=entry.id,
    )
    await _validate_task_selection(
        db,
        project_id=target_project_id,
        task_id=target_task_id,
    )

    db.add(
        TimeEntryEditHistory(
            tenant_id=entry.tenant_id,
            time_entry_id=entry.id,
            edited_by=edited_by,
            edited_at=datetime.now(timezone.utc),
            edit_reason=edit_reason,
            history_summary=history_summary,
            previous_project_id=entry.project_id,
            previous_entry_date=entry.entry_date,
            previous_hours=entry.hours,
            previous_description=entry.description,
        )
    )

    for field, value in update_data.items():
        setattr(entry, field, value)

    # If editing a REJECTED entry, transition it back to DRAFT so it can be resubmitted.
    if entry.status == TimeEntryStatus.REJECTED:
        entry.status = TimeEntryStatus.DRAFT
        entry.rejection_reason = None
        entry.approved_by = None
        entry.approved_at = None

    entry.last_edit_reason = edit_reason
    entry.last_history_summary = history_summary
    entry.updated_by = edited_by

    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    return entry


async def delete_time_entry(db: AsyncSession, entry_id: int, tenant_id: Optional[int] = None) -> bool:
    """Delete time entry (only DRAFT entries), scoped to a tenant."""
    entry = await get_time_entry_by_id(db, entry_id, tenant_id=tenant_id)
    if entry and entry.status == TimeEntryStatus.DRAFT:
        await db.delete(entry)
        await db.commit()
        return True
    return False


async def list_user_entries(
    db: AsyncSession,
    user_id: int,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    status: Optional[TimeEntryStatus] = None,
    search: Optional[str] = None,
    sort_by: str = "entry_date",
    sort_order: str = "desc",
    skip: int = 0,
    limit: int = 100,
) -> list[TimeEntry]:
    """List time entries for a user with optional filters."""
    query = select(TimeEntry).where(TimeEntry.user_id == user_id)

    # Eagerly load relationships
    query = query.options(
        selectinload(TimeEntry.user).selectinload(User.manager_assignment),
        selectinload(TimeEntry.user).selectinload(User.project_access),
        selectinload(TimeEntry.project),
        selectinload(TimeEntry.task),
        selectinload(TimeEntry.approved_by_user),
    )

    if start_date:
        query = query.where(TimeEntry.entry_date >= start_date)
    if end_date:
        query = query.where(TimeEntry.entry_date <= end_date)
    if status:
        query = query.where(TimeEntry.status == status)

    if search:
        like = f"%{search.strip()}%"
        query = query.join(Project, Project.id == TimeEntry.project_id).where(
            or_(
                TimeEntry.description.ilike(like),
                Project.name.ilike(like),
            )
        )

    sort_map = {
        "entry_date": TimeEntry.entry_date,
        "created_at": TimeEntry.created_at,
        "hours": TimeEntry.hours,
        "status": TimeEntry.status,
    }
    sort_column = sort_map.get(sort_by, TimeEntry.entry_date)
    query = query.order_by(asc(sort_column) if sort_order ==
                           "asc" else desc(sort_column))

    query = query.offset(skip).limit(limit)
    result = await db.execute(query)
    return result.scalars().all()


async def list_tenant_entries(
    db: AsyncSession,
    tenant_id: int,
    user_id: Optional[int] = None,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    status: Optional[TimeEntryStatus] = None,
    sort_by: str = "entry_date",
    sort_order: str = "desc",
    skip: int = 0,
    limit: int = 200,
) -> list[TimeEntry]:
    """List time entries across the entire tenant. Admin/manager use only."""
    query = select(TimeEntry).where(TimeEntry.tenant_id == tenant_id)
    query = query.options(
        selectinload(TimeEntry.user),
        selectinload(TimeEntry.project),
        selectinload(TimeEntry.task),
    )
    if user_id is not None:
        query = query.where(TimeEntry.user_id == user_id)
    if start_date:
        query = query.where(TimeEntry.entry_date >= start_date)
    if end_date:
        query = query.where(TimeEntry.entry_date <= end_date)
    if status:
        query = query.where(TimeEntry.status == status)

    sort_map = {
        "entry_date": TimeEntry.entry_date,
        "created_at": TimeEntry.created_at,
        "hours": TimeEntry.hours,
        "status": TimeEntry.status,
    }
    sort_column = sort_map.get(sort_by, TimeEntry.entry_date)
    query = query.order_by(asc(sort_column) if sort_order == "asc" else desc(sort_column))
    query = query.offset(skip).limit(limit)
    result = await db.execute(query)
    return result.scalars().all()


async def submit_time_entries(
    db: AsyncSession,
    user_id: int,
    entry_ids: list[int],
    approver_manager_id: Optional[int] = None,
) -> list[TimeEntry]:
    """Submit multiple time entries for approval.

    approver_manager_id routes the entries to a specific manager (multi-manager
    mode). It's honored only when the approval_by_assigned_manager setting is on
    and the chosen manager is actually one of the employee's managers; otherwise
    it's ignored (entries stay unrouted = any manager can approve)."""
    # Get all entries with relationships loaded
    query = select(TimeEntry).where(
        (TimeEntry.user_id == user_id) &
        (TimeEntry.id.in_(entry_ids)) &
        (TimeEntry.status == TimeEntryStatus.DRAFT)
    )
    query = query.options(
        selectinload(TimeEntry.user).selectinload(User.manager_assignment),
        selectinload(TimeEntry.user).selectinload(User.project_access),
        selectinload(TimeEntry.project),
        selectinload(TimeEntry.task),
        selectinload(TimeEntry.approved_by_user),
    )
    result = await db.execute(query)
    entries = result.scalars().all()

    if not entries:
        raise ValueError("No DRAFT entries found to submit")

    tenant_id = entries[0].tenant_id
    min_date, max_date, past_days, future_days = await _entry_window(db, tenant_id)
    out_of_window = [e for e in entries if e.entry_date < min_date or e.entry_date > max_date]
    if out_of_window:
        raise ValueError(_format_window_error("submit", past_days, future_days))

    policy = await _tenant_hours_policy(db, tenant_id)
    wsd = await _tenant_week_start_day(db, tenant_id)

    requested_ids = {entry.id for entry in entries}
    week_starts = {_week_start(entry.entry_date, wsd) for entry in entries}

    for week_start in week_starts:
        week_end_calendar = week_start + timedelta(days=6)

        week_entries = [entry for entry in entries if _week_start(
            entry.entry_date, wsd) == week_start]
        week_requested_ids = {entry.id for entry in week_entries}

        full_week_query = select(TimeEntry.id).where(
            (TimeEntry.user_id == user_id)
            & (TimeEntry.status == TimeEntryStatus.DRAFT)
            & (TimeEntry.entry_date >= week_start)
            & (TimeEntry.entry_date <= week_end_calendar)
        )
        full_week_result = await db.execute(full_week_query)
        full_week_ids = set(full_week_result.scalars().all())
        # Default: must submit all DRAFT entries for the week together. Tenants
        # that allow partial-week submission (e.g. mid-week corrections) skip this.
        if not policy["allow_partial_week"] and week_requested_ids != full_week_ids:
            missing_ids = sorted(list(full_week_ids - requested_ids))
            raise ValueError(
                f"Submit all draft entries for the week of {week_start.isoformat()} together. Missing entry ids: {missing_ids}"
            )

        weekly_total = Decimal(str((await db.scalar(
            select(func.coalesce(func.sum(TimeEntry.hours), 0)).where(
                (TimeEntry.user_id == user_id)
                & (TimeEntry.entry_date >= week_start)
                & (TimeEntry.entry_date <= week_start + timedelta(days=6))
                & (TimeEntry.status != TimeEntryStatus.REJECTED)
            )
        )) or 0))

        minimum_weekly_hours = Decimal(str(policy["min_submit_weekly"]))
        if weekly_total < minimum_weekly_hours:
            raise ValueError(
                f"Cannot submit week of {week_start.isoformat()} because weekly hours are below minimum required ({policy['min_submit_weekly']:g})"
            )

    # Resolve the routing target. Only honor it when multi-manager routing is on
    # AND the chosen manager is one of this employee's managers.
    routed_manager_id: Optional[int] = None
    if approver_manager_id is not None:
        from app.core.tenant_settings import get_setting
        from app.models.assignments import EmployeeManagerAssignment

        if await get_setting(db, tenant_id, "approval_by_assigned_manager"):
            is_mine = await db.scalar(
                select(func.count())
                .select_from(EmployeeManagerAssignment)
                .where(
                    EmployeeManagerAssignment.employee_id == user_id,
                    EmployeeManagerAssignment.manager_id == approver_manager_id,
                )
            )
            if is_mine:
                routed_manager_id = approver_manager_id

    # Update status
    for entry in entries:
        entry.status = TimeEntryStatus.SUBMITTED
        entry.submitted_at = datetime.now(timezone.utc)
        entry.updated_by = user_id
        if routed_manager_id is not None:
            entry.approver_manager_id = routed_manager_id
        db.add(entry)

    await db.commit()

    # Refresh all entries
    for entry in entries:
        await db.refresh(entry)

    return entries


async def recall_time_entries(
    db: AsyncSession,
    user_id: int,
    entry_ids: list[int],
) -> list[TimeEntry]:
    """Recall (un-submit) time entries that haven't been actioned yet.

    Flips SUBMITTED entries back to DRAFT so the user can edit and
    resubmit. Refuses if any entry has already been APPROVED or
    REJECTED (managers act on the queue in real time, so a recall
    that races an approval must lose cleanly).

    Writes a TimeEntryEditHistory row per entry with
    ``edit_reason="Recalled by user"`` so the lifecycle is auditable.

    Raises:
        ValueError if no SUBMITTED entries match (already-approved
        race, cross-user attempt, or empty list).
    """
    if not entry_ids:
        raise ValueError("No entries provided to recall")

    query = select(TimeEntry).where(
        (TimeEntry.user_id == user_id) &
        (TimeEntry.id.in_(entry_ids))
    )
    query = query.options(
        selectinload(TimeEntry.user).selectinload(User.manager_assignment),
        selectinload(TimeEntry.user).selectinload(User.project_access),
        selectinload(TimeEntry.project),
        selectinload(TimeEntry.task),
        selectinload(TimeEntry.approved_by_user),
    )
    result = await db.execute(query)
    owned = result.scalars().all()

    if not owned:
        raise ValueError("No entries found to recall")

    # Any already-actioned entry blocks the whole batch. Recall is a
    # week-level affordance — surface the conflict instead of silently
    # recalling part of the week.
    actioned = [e for e in owned if e.status in (
        TimeEntryStatus.APPROVED, TimeEntryStatus.REJECTED)]
    if actioned:
        raise ValueError(
            "Cannot recall: one or more entries have already been "
            "approved or rejected. Refresh and try again."
        )

    pending = [e for e in owned if e.status == TimeEntryStatus.SUBMITTED]
    if not pending:
        raise ValueError("No submitted entries to recall")

    now = datetime.now(timezone.utc)
    for entry in pending:
        db.add(
            TimeEntryEditHistory(
                tenant_id=entry.tenant_id,
                time_entry_id=entry.id,
                edited_by=user_id,
                edited_at=now,
                edit_reason="Recalled by user",
                history_summary=f"Recalled submission from {entry.submitted_at.isoformat()}"
                if entry.submitted_at else "Recalled submission",
                previous_project_id=entry.project_id,
                previous_entry_date=entry.entry_date,
                previous_hours=entry.hours,
                previous_description=entry.description,
            )
        )
        entry.status = TimeEntryStatus.DRAFT
        entry.submitted_at = None
        entry.updated_by = user_id
        entry.last_edit_reason = "Recalled by user"
        entry.last_history_summary = "Submission recalled"
        db.add(entry)

    await db.commit()

    for entry in pending:
        await db.refresh(entry)

    return pending


async def get_weekly_submission_status(db: AsyncSession, user_id: int) -> tuple[bool, str | None, date]:
    """can_submit is true when the user has any DRAFT entries inside the tenant's editable window."""
    today = date.today()

    user_row = await db.execute(select(User.tenant_id).where(User.id == user_id))
    tenant_id = user_row.scalar_one_or_none()
    if tenant_id is None:
        return False, "No tenant context for this user.", today

    wsd = await _tenant_week_start_day(db, tenant_id)
    due_date = _last_working_day_for_week(today, wsd)

    min_date, max_date, _, _ = await _entry_window(db, tenant_id)
    draft_count = await db.scalar(
        select(func.count(TimeEntry.id)).where(
            (TimeEntry.user_id == user_id)
            & (TimeEntry.status == TimeEntryStatus.DRAFT)
            & (TimeEntry.entry_date >= min_date)
            & (TimeEntry.entry_date <= max_date)
        )
    )
    if int(draft_count or 0) == 0:
        return False, "No draft entries to submit.", due_date

    return True, None, due_date


async def list_pending_approvals(
    db: AsyncSession,
    employee_ids: Optional[list[int]] = None,
    manager_ids: Optional[list[int]] = None,
    tenant_id: Optional[int] = None,
    search: Optional[str] = None,
    sort_by: str = "entry_date",
    sort_order: str = "desc",
    skip: int = 0,
    limit: int = 100,
    routed_to_manager_id: Optional[int] = None,
) -> list[TimeEntry]:
    """
    List submitted time entries for managers to approve.

    Default (single-manager): pass ``employee_ids`` = the manager's reports;
    every submitted entry for those employees is returned.

    Multi-manager routing: pass ``routed_to_manager_id`` = the manager AND
    ``employee_ids`` = their reports. The queue then shows entries explicitly
    routed to this manager (approver_manager_id == them) PLUS unrouted entries
    (approver_manager_id IS NULL) of their reports — so a week split across two
    managers shows each manager only their own slice.
    """
    # Backward compatibility: historical callers passed manager_ids, but that
    # parameter never actually filtered results.
    _ = manager_ids

    query = select(TimeEntry).where(
        TimeEntry.status == TimeEntryStatus.SUBMITTED)
    if tenant_id is not None:
        query = query.where(TimeEntry.tenant_id == tenant_id)
    if routed_to_manager_id is not None:
        # Routed to me, OR unrouted and one of my reports.
        report_clause = (
            TimeEntry.user_id.in_(employee_ids)
            if employee_ids else sa_false()
        )
        query = query.where(
            or_(
                TimeEntry.approver_manager_id == routed_to_manager_id,
                and_(TimeEntry.approver_manager_id.is_(None), report_clause),
            )
        )
    elif employee_ids is not None:
        if not employee_ids:
            return []
        query = query.where(TimeEntry.user_id.in_(employee_ids))
    query = query.options(
        selectinload(TimeEntry.user),
        selectinload(TimeEntry.project),
        selectinload(TimeEntry.task),
    )
    joined_user = False

    if search:
        like = f"%{search.strip()}%"
        query = query.join(User, User.id == TimeEntry.user_id).join(Project, Project.id == TimeEntry.project_id).where(
            or_(
                TimeEntry.description.ilike(like),
                User.full_name.ilike(like),
                Project.name.ilike(like),
            )
        )
        joined_user = True

    sort_map = {
        "entry_date": TimeEntry.entry_date,
        "submitted_at": TimeEntry.submitted_at,
        "hours": TimeEntry.hours,
        "employee": User.full_name,
    }

    if sort_by == "employee" and not joined_user:
        query = query.join(User, User.id == TimeEntry.user_id)

    sort_column = sort_map.get(sort_by, TimeEntry.entry_date)
    query = query.order_by(asc(sort_column) if sort_order ==
                           "asc" else desc(sort_column))

    query = query.offset(skip).limit(limit)
    result = await db.execute(query)
    return result.scalars().all()


async def _stamp_billed_rate(db: AsyncSession, entry: TimeEntry) -> None:
    """Freeze the resolved billable rate onto the entry at approval. Best-effort:
    a resolution failure must never block an approval, so it's swallowed (the
    entry keeps NULL snapshot and reporting falls back to the live project rate).
    """
    try:
        from app.services.billing_rates import resolve_entry_rate

        resolved = await resolve_entry_rate(db, entry)
        if resolved is not None:
            entry.billed_rate = resolved.rate
            entry.billed_currency = resolved.currency
    except Exception:  # noqa: BLE001 - never let rate resolution break approval
        pass
    # PSA: freeze the cost snapshot too, in PARALLEL — from the entry owner's
    # cost_rate. Same best-effort contract: never block an approval, leave NULL
    # when no cost rate is set (margin reporting simply omits that entry's cost).
    try:
        from app.models.user import User

        owner = await db.get(User, entry.user_id)
        if owner is not None and owner.cost_rate is not None:
            entry.cost_rate = owner.cost_rate
            entry.cost_currency = owner.cost_currency or "USD"
    except Exception:  # noqa: BLE001 - cost stamping must never break approval
        pass


async def approve_time_entry(
    db: AsyncSession,
    entry_id: int,
    approved_by_id: int,
    tenant_id: Optional[int] = None,
) -> TimeEntry:
    """Approve a time entry."""
    entry = await get_time_entry_by_id(db, entry_id, tenant_id=tenant_id)
    if not entry:
        raise ValueError("Time entry not found")

    if entry.user_id == approved_by_id:
        # Defense-in-depth: the API layer already blocks self-approval via
        # the time_entry.approve permission check, but enforcing it here
        # too means a future caller that forgets the API guard can't
        # silently let a user approve their own entry.
        raise ValueError("Cannot approve your own time entry")

    if entry.status != TimeEntryStatus.SUBMITTED:
        raise ValueError("Can only approve SUBMITTED entries")

    entry.status = TimeEntryStatus.APPROVED
    entry.approved_by = approved_by_id
    entry.approved_at = datetime.now(timezone.utc)
    entry.rejection_reason = None
    entry.updated_by = approved_by_id

    # Freeze the billable rate onto the entry (role-rate card -> project rate).
    # Once stamped, later rate-card/project edits never re-price this entry.
    await _stamp_billed_rate(db, entry)

    db.add(entry)
    await db.commit()

    # Re-fetch with relationships loaded
    return await get_time_entry_by_id(db, entry_id, tenant_id=tenant_id)


async def approve_time_entries_batch(
    db: AsyncSession,
    entry_ids: list[int],
    approved_by_id: int,
    tenant_id: Optional[int] = None,
) -> list[TimeEntry]:
    entries = await get_time_entries_by_ids(db, entry_ids, tenant_id=tenant_id)
    if len(entries) != len(set(entry_ids)):
        raise ValueError("One or more time entries were not found")

    if any(entry.user_id == approved_by_id for entry in entries):
        raise ValueError("Cannot approve your own time entry")

    if any(entry.status != TimeEntryStatus.SUBMITTED for entry in entries):
        raise ValueError("Can only approve SUBMITTED entries")

    approved_at = datetime.now(timezone.utc)
    for entry in entries:
        entry.status = TimeEntryStatus.APPROVED
        entry.approved_by = approved_by_id
        entry.approved_at = approved_at
        entry.rejection_reason = None
        entry.updated_by = approved_by_id
        # Freeze the billable rate (see approve_time_entry).
        await _stamp_billed_rate(db, entry)
        db.add(entry)

    await db.commit()
    return await get_time_entries_by_ids(db, entry_ids, tenant_id=tenant_id)


async def reject_time_entry(
    db: AsyncSession,
    entry_id: int,
    approved_by_id: int,
    rejection_reason: str,
    tenant_id: Optional[int] = None,
) -> TimeEntry:
    """Reject a time entry."""
    entry = await get_time_entry_by_id(db, entry_id, tenant_id=tenant_id)
    if not entry:
        raise ValueError("Time entry not found")

    if entry.user_id == approved_by_id:
        raise ValueError("Cannot reject your own time entry")

    if entry.status != TimeEntryStatus.SUBMITTED:
        raise ValueError("Can only reject SUBMITTED entries")

    entry.status = TimeEntryStatus.REJECTED
    entry.approved_by = approved_by_id
    entry.approved_at = datetime.now(timezone.utc)
    entry.rejection_reason = rejection_reason
    entry.updated_by = approved_by_id

    db.add(entry)
    await db.commit()

    # Re-fetch with relationships loaded
    return await get_time_entry_by_id(db, entry_id, tenant_id=tenant_id)


async def reject_time_entries_batch(
    db: AsyncSession,
    entry_ids: list[int],
    rejected_by_id: int,
    rejection_reason: str,
    tenant_id: Optional[int] = None,
) -> list[TimeEntry]:
    entries = await get_time_entries_by_ids(db, entry_ids, tenant_id=tenant_id)
    if len(entries) != len(set(entry_ids)):
        raise ValueError("One or more time entries were not found")

    if any(entry.status != TimeEntryStatus.SUBMITTED for entry in entries):
        raise ValueError("Can only reject SUBMITTED entries")

    rejected_at = datetime.now(timezone.utc)
    for entry in entries:
        entry.status = TimeEntryStatus.REJECTED
        entry.approved_by = rejected_by_id
        entry.approved_at = rejected_at
        entry.rejection_reason = rejection_reason
        entry.updated_by = rejected_by_id
        db.add(entry)

    await db.commit()
    return await get_time_entries_by_ids(db, entry_ids, tenant_id=tenant_id)
