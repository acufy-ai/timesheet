"""Cadence-aware submission-period helpers.

The manager dashboard's late/critical signal is driven by submission
cadence (weekly or monthly), not by per-day deadlines. A user is
"late" when the most recent *closed* period for their cadence has a
working day without a SUBMITTED/APPROVED time entry or an APPROVED
time-off request covering it.

Single source of truth for:
  - which cadence applies to a given user (internal vs external)
  - the closed-period window and deadline for that cadence
  - "is this user late for that period?"

Tenant timezone is honored. New accounts (created on or after the
period start) are never marked late for that period.
"""
from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Literal, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tenant_settings import get_setting
from app.core.timezone_utils import combine_tenant, now_for_tenant
from app.models.holiday import Holiday
from app.models.time_entry import TimeEntry, TimeEntryStatus
from app.models.time_off_request import TimeOffRequest, TimeOffStatus
from app.models.user import User

Cadence = Literal["weekly", "monthly"]

_WEEKDAY_NAMES: dict[str, int] = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}


@dataclass(frozen=True)
class SubmissionPeriod:
    """A closed submission window for a cadence.

    ``start`` and ``end`` are inclusive. ``deadline_at`` is the
    tenant-tz-aware datetime by which a submission was due.
    """
    start: date
    end: date
    deadline_at: datetime
    cadence: Cadence


async def _get(db: AsyncSession, tenant_id: int, key: str, fallback):
    """Read a setting, tolerating a missing catalog row.

    The catalog is seeded by migration 058 and the standalone seed
    script. Test harnesses or partially-migrated tenants may not have
    the row yet, in which case we fall back to ``fallback`` rather
    than 500-ing the dashboard."""
    try:
        return await get_setting(db, tenant_id, key)
    except KeyError:
        return fallback


async def get_user_cadence(
    db: AsyncSession, tenant_id: int, user: User
) -> Cadence:
    """Return the cadence that applies to ``user`` in this tenant."""
    default: Cadence = "monthly" if user.is_external else "weekly"
    key = "submission_cadence_external" if user.is_external else "submission_cadence_internal"
    raw = await _get(db, tenant_id, key, default)
    if raw in ("weekly", "monthly"):
        return raw  # type: ignore[return-value]
    return default


async def _weekly_period(
    db: AsyncSession, tenant_id: int, today: date, tenant_tz: Optional[str]
) -> Optional[SubmissionPeriod]:
    """Most recent closed weekly period (Mon-Sun)."""
    deadline_day_raw = await _get(db, tenant_id, "reminder_internal_deadline_day", "friday")
    deadline_time_raw = await _get(db, tenant_id, "reminder_internal_deadline_time", "17:00")
    deadline_dow = _WEEKDAY_NAMES.get(str(deadline_day_raw).lower(), 4)  # Friday
    deadline_time = _parse_time(deadline_time_raw, default=time(17, 0))

    # Walk back to find the most recent period whose deadline has passed.
    # The "current" week starts on the most recent Monday relative to today.
    # The "closed" period is the prior week if today is before this week's
    # deadline, otherwise this week.
    current_week_monday = today - timedelta(days=today.weekday())
    deadline_date_this_week = current_week_monday + timedelta(days=deadline_dow)
    deadline_dt_this_week = combine_tenant(
        deadline_date_this_week, deadline_time, tenant_tz
    )
    now = now_for_tenant(tenant_tz)
    if now >= deadline_dt_this_week:
        period_start = current_week_monday
        deadline_at = deadline_dt_this_week
    else:
        period_start = current_week_monday - timedelta(days=7)
        deadline_at = combine_tenant(
            period_start + timedelta(days=deadline_dow),
            deadline_time, tenant_tz,
        )
    period_end = period_start + timedelta(days=6)
    return SubmissionPeriod(
        start=period_start, end=period_end,
        deadline_at=deadline_at, cadence="weekly",
    )


async def _monthly_period(
    db: AsyncSession, tenant_id: int, today: date, tenant_tz: Optional[str]
) -> Optional[SubmissionPeriod]:
    """Most recent closed monthly period (calendar month)."""
    deadline_dom_raw = await _get(db, tenant_id, "reminder_external_deadline_day_of_month", 28)
    deadline_time_raw = await _get(db, tenant_id, "reminder_external_deadline_time", "17:00")
    try:
        deadline_dom = int(deadline_dom_raw) if deadline_dom_raw is not None else 28
    except (TypeError, ValueError):
        deadline_dom = 28
    deadline_dom = max(1, min(31, deadline_dom))
    deadline_time = _parse_time(deadline_time_raw, default=time(17, 0))

    # Deadline for "this month": clamp day to month length (Feb 28/29).
    last_day_this_month = calendar.monthrange(today.year, today.month)[1]
    deadline_day_this_month = min(deadline_dom, last_day_this_month)
    deadline_date_this_month = date(today.year, today.month, deadline_day_this_month)
    deadline_dt_this_month = combine_tenant(
        deadline_date_this_month, deadline_time, tenant_tz
    )
    now = now_for_tenant(tenant_tz)
    if now >= deadline_dt_this_month:
        period_year, period_month = today.year, today.month
    else:
        if today.month == 1:
            period_year, period_month = today.year - 1, 12
        else:
            period_year, period_month = today.year, today.month - 1
    last_day = calendar.monthrange(period_year, period_month)[1]
    period_start = date(period_year, period_month, 1)
    period_end = date(period_year, period_month, last_day)
    deadline_day_for_period = min(deadline_dom, last_day)
    deadline_at = combine_tenant(
        date(period_year, period_month, deadline_day_for_period),
        deadline_time, tenant_tz,
    )
    return SubmissionPeriod(
        start=period_start, end=period_end,
        deadline_at=deadline_at, cadence="monthly",
    )


async def latest_closed_period(
    db: AsyncSession,
    tenant_id: int,
    user: User,
    today: date,
    tenant_tz: Optional[str] = None,
) -> Optional[SubmissionPeriod]:
    """Return the most recent submission period whose deadline has
    passed for this user, or None if no closed period exists yet
    (e.g. the very first period for a fresh tenant)."""
    cadence = await get_user_cadence(db, tenant_id, user)
    if cadence == "weekly":
        period = await _weekly_period(db, tenant_id, today, tenant_tz)
    else:
        period = await _monthly_period(db, tenant_id, today, tenant_tz)
    if period is None:
        return None
    # Apply the configured grace period before flagging anyone late.
    grace_raw = await _get(db, tenant_id, "late_grace_business_days", 1)
    try:
        grace = int(grace_raw) if grace_raw is not None else 1
    except (TypeError, ValueError):
        grace = 1
    grace_cutoff = _add_business_days(period.deadline_at.date(), max(0, grace))
    if today < grace_cutoff:
        return None
    return period


async def is_user_late_for_period(
    db: AsyncSession,
    user: User,
    period: SubmissionPeriod,
) -> bool:
    """True if ``user`` has at least one uncovered working day inside
    ``period``. Working days are Mon-Fri. A day is "covered" by any
    of: a SUBMITTED/APPROVED ``TimeEntry``, an APPROVED
    ``TimeOffRequest``, or an org-wide ``Holiday`` (PUBLIC or
    COMPANY) for that date."""
    # Brand-new account exemption: the user must have existed before
    # the period started. ``created_at`` is timezone-aware UTC. Compare
    # by date in UTC; the granularity of the period (full days) makes
    # tenant-tz drift here a non-issue.
    if user.created_at is not None:
        created_date = user.created_at.astimezone(timezone.utc).date()
        if created_date >= period.start:
            return False

    working_days = {
        period.start + timedelta(days=i)
        for i in range((period.end - period.start).days + 1)
        if (period.start + timedelta(days=i)).weekday() < 5
    }
    if not working_days:
        return False

    entry_rows = await db.execute(
        select(TimeEntry.entry_date).where(
            TimeEntry.user_id == user.id,
            TimeEntry.entry_date >= period.start,
            TimeEntry.entry_date <= period.end,
            TimeEntry.status.in_(
                [TimeEntryStatus.SUBMITTED, TimeEntryStatus.APPROVED]
            ),
        )
    )
    covered_dates: set[date] = {row[0] for row in entry_rows.all()}

    pto_rows = await db.execute(
        select(TimeOffRequest.request_date).where(
            TimeOffRequest.user_id == user.id,
            TimeOffRequest.request_date >= period.start,
            TimeOffRequest.request_date <= period.end,
            TimeOffRequest.status == TimeOffStatus.APPROVED,
        )
    )
    covered_dates.update(row[0] for row in pto_rows.all())

    if user.tenant_id is not None:
        holiday_rows = await db.execute(
            select(Holiday.date).where(
                Holiday.tenant_id == user.tenant_id,
                Holiday.date >= period.start,
                Holiday.date <= period.end,
            )
        )
        covered_dates.update(row[0] for row in holiday_rows.all())

    missing = working_days - covered_dates
    return bool(missing)


def _parse_time(raw, default: time) -> time:
    if isinstance(raw, time):
        return raw
    if isinstance(raw, str) and ":" in raw:
        try:
            hh, mm = raw.split(":", 1)
            return time(hour=int(hh), minute=int(mm))
        except (TypeError, ValueError):
            return default
    return default


def _add_business_days(start: date, n: int) -> date:
    cursor = start
    remaining = n
    while remaining > 0:
        cursor += timedelta(days=1)
        if cursor.weekday() < 5:
            remaining -= 1
    return cursor
