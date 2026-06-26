"""Billable-rate resolution.

Resolves the rate that should be billed for a time entry, wiring up the
previously-orphaned per-client role rate cards (ClientRoleRate).

Resolution order (first match wins):
  1. A ClientRoleRate for the entry's project's CLIENT whose `role` matches the
     user's title (case-insensitive), effective on or before the entry date
     (the latest such effective_date wins; rows with no effective_date are
     treated as always-effective and rank below dated ones).
  2. The project's flat `billable_rate`.

The resolved rate is stamped onto the entry at approval (see crud.time_entry),
so later edits to a rate card or project rate never re-price approved history.
"""
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.client_extras import ClientRoleRate
from app.models.project import Project
from app.models.task import Task  # noqa: F401 - kept for type context
from app.models.time_entry import TimeEntry
from app.models.user import User


@dataclass
class ResolvedRate:
    rate: Decimal
    currency: str
    source: str  # "role_rate" | "project" — for transparency/debugging


async def resolve_entry_rate(
    db: AsyncSession, entry: TimeEntry
) -> Optional[ResolvedRate]:
    """Resolve the billable rate for a single time entry. Returns None only if
    the project can't be loaded (shouldn't happen for a valid entry)."""
    project = await db.get(Project, entry.project_id)
    if project is None:
        return None

    user = await db.get(User, entry.user_id)
    title = (user.title or "").strip().lower() if user else ""

    if title:
        rows = (await db.execute(
            select(ClientRoleRate).where(
                ClientRoleRate.tenant_id == entry.tenant_id,
                ClientRoleRate.client_id == project.client_id,
            )
        )).scalars().all()

        on = entry.entry_date or date.today()

        def _eligible(r: ClientRoleRate) -> bool:
            if (r.role or "").strip().lower() != title:
                return False
            return r.effective_date is None or r.effective_date <= on

        # Latest effective date wins; undated rows sort earliest so a dated card
        # supersedes them.
        candidates = sorted(
            (r for r in rows if _eligible(r)),
            key=lambda r: (r.effective_date or date.min),
        )
        if candidates:
            best = candidates[-1]
            return ResolvedRate(
                rate=best.rate,
                currency=best.currency or (project.currency or "USD"),
                source="role_rate",
            )

    return ResolvedRate(
        rate=project.billable_rate,
        currency=project.currency or "USD",
        source="project",
    )


def entry_billed_amount(entry: TimeEntry, project: Optional[Project]) -> Decimal:
    """The billable amount for an entry, preferring the frozen snapshot.

    Uses the stamped `billed_rate` when present (approved entries); otherwise
    falls back to the live project rate (pre-snapshot history / un-approved
    entries). Non-billable entries contribute 0.
    """
    if not entry.is_billable:
        return Decimal("0")
    rate = entry.billed_rate
    if rate is None:
        rate = project.billable_rate if project is not None else Decimal("0")
    return (entry.hours or Decimal("0")) * rate


def entry_cost_amount(entry: TimeEntry) -> Decimal:
    """The labor COST of an entry, from the frozen cost snapshot (PSA).

    Unlike revenue, cost applies to ALL hours — billable or not — because the
    person costs the firm the same regardless of whether the time is billed.
    Returns 0 when no cost was stamped (the owner had no cost_rate at approval);
    margin reporting treats that as "cost unknown" rather than zero-cost.
    """
    rate = entry.cost_rate
    if rate is None:
        return Decimal("0")
    return (entry.hours or Decimal("0")) * rate
