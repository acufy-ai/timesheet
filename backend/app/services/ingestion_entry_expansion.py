"""Approve-time helpers that turn an ingestion timesheet into per-day
``TimeEntry`` rows.

Two timesheet shapes need to land as real time entries:

1. **Itemized**: the LLM extracted per-day rows. Each line item
   becomes one ``TimeEntry`` dated by ``work_date``. This is the
   pre-existing path; the helper here just lives alongside (2).

2. **Total-only**: the LLM extracted a period total but no per-day
   breakdown. Common for contractors who submit a monthly invoice.
   We synthesize per-day rows by distributing ``total_hours`` evenly
   across the working days (Mon-Fri) of ``[period_start, period_end]``.
   Rounding remainder lands on the last working day so the sum is
   exact.

The point of materializing per-day rows is calendar-aware month
scoping. With one row per day, any month-filter query "WHERE
entry_date BETWEEN X AND Y" hits exactly the days inside that
month, regardless of whether the original timesheet's period
crossed a month boundary.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.client import Client
from app.models.project import Project


@dataclass(frozen=True)
class SynthesizedDay:
    """One day's worth of synthesized hours, ready to become a
    ``TimeEntry`` row in the approval handler."""
    work_date: date
    hours: Decimal


def working_days_between(start: date, end_inclusive: date) -> list[date]:
    """Mon-Fri inside [start, end_inclusive]. Weekends excluded.

    Empty list if ``start > end_inclusive`` or if the range contains
    no weekday (e.g. a single Saturday).
    """
    if end_inclusive < start:
        return []
    out: list[date] = []
    cursor = start
    while cursor <= end_inclusive:
        if cursor.weekday() < 5:
            out.append(cursor)
        cursor += timedelta(days=1)
    return out


def distribute_hours_evenly(
    total_hours: Decimal | float | int,
    period_start: date,
    period_end: date,
) -> list[SynthesizedDay]:
    """Spread ``total_hours`` across the working days in
    ``[period_start, period_end]``.

    Each day gets ``total_hours / working_days`` rounded to 2dp; the
    rounding remainder is absorbed onto the last working day so the
    sum is exact. Returns an empty list when there are no working
    days in the period.
    """
    days = working_days_between(period_start, period_end)
    if not days:
        return []
    total = Decimal(str(total_hours))
    per_day = (total / Decimal(len(days))).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )
    out: list[SynthesizedDay] = [
        SynthesizedDay(work_date=d, hours=per_day) for d in days
    ]
    # Absorb rounding drift on the last day so the synthesized total
    # equals the input exactly. Otherwise 40 / 3 days = 13.33 each =
    # 39.99 total, and downstream summaries don't reconcile.
    accumulated = per_day * len(days)
    drift = total - accumulated
    if drift != Decimal("0"):
        last = out[-1]
        out[-1] = SynthesizedDay(work_date=last.work_date, hours=last.hours + drift)
    return out


async def resolve_default_project_for_client(
    session: AsyncSession,
    tenant_id: int,
    client_id: int,
    actor_user_id: Optional[int] = None,
) -> Project:
    """Return a project for ``client_id``, creating a default one if
    none exists.

    Order:

    1. Active project for the client, if exactly one exists, use it.
    2. Active project for the client, if multiple exist, return the
       oldest one (deterministic). Callers who care about a specific
       project should set ``line_item.project_id`` upstream.
    3. No active project: auto-create ``"<Client Name> Default"``
       and return it. ``is_active=True`` so it shows up immediately
       in the projects list.

    Raises ``ValueError`` if ``client_id`` doesn't belong to the
    tenant (defense in depth; the caller should have validated this
    already).
    """
    client = await session.get(Client, client_id)
    if client is None or client.tenant_id != tenant_id:
        raise ValueError(f"Client {client_id} not found in tenant {tenant_id}")

    existing = (await session.execute(
        select(Project)
        .where(
            Project.tenant_id == tenant_id,
            Project.client_id == client_id,
            Project.is_active.is_(True),
        )
        .order_by(Project.id.asc())
    )).scalars().all()
    if existing:
        return existing[0]

    # No active project. Create the default. Keep the name stable so
    # repeated approvals on a freshly-created client all use the same
    # project rather than creating one per approval.
    default = Project(
        tenant_id=tenant_id,
        client_id=client_id,
        name=f"{client.name} Default",
        billable_rate=Decimal("0"),
        is_active=True,
    )
    session.add(default)
    await session.flush()
    return default
