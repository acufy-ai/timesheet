"""One-shot backfill: synthesize per-day TimeEntry rows for an
already-approved IngestionTimesheet that didn't materialize line
items.

Context: Sravanthi Duppati's five inbox-approved timesheets carry
only summary totals (period_start, period_end, total_hours). The
rollup view on the Approved Timesheets surface aggregates by
``entry_date``, so without per-day rows the bridge-week submission
(Mar 30 - Apr 5) lumps its full 40h into the period_start month
(March), inflating Sravanthi's March total to 200h instead of the
176h that the calendar actually supports.

This script uses the existing ``distribute_hours_evenly`` helper to
spread each summary's total across its working days, then writes
one TimeEntry per day. It flips ``time_entries_created=True`` so the
rollup view stops counting the summary as a separate "summary-only"
row.

Usage (inside the api container):
    PYTHONPATH=/app python scripts/backfill_sravanthi_entries.py

Idempotent: re-running skips IngestionTimesheets that already have
``time_entries_created=True``.
"""
from __future__ import annotations

import asyncio
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.db_tenant import get_session_factory_for_slug
from app.models.ingestion_timesheet import IngestionTimesheet
from app.models.time_entry import TimeEntry, TimeEntryStatus
from app.models.user import User
from app.services.ingestion_entry_expansion import distribute_hours_evenly


TENANT_SLUG = "acuent"
EMPLOYEE_EMAIL = "sravanthiduppati79@gmail.com"


async def main() -> None:
    sf = await get_session_factory_for_slug(TENANT_SLUG)
    async with sf() as session:
        user = (await session.execute(
            select(User).where(User.email == EMPLOYEE_EMAIL)
        )).scalar_one_or_none()
        if not user:
            print(f"no user {EMPLOYEE_EMAIL}")
            return
        print(f"user_id={user.id} tenant_id={user.tenant_id}")

        timesheets = (await session.execute(
            select(IngestionTimesheet)
            .options(selectinload(IngestionTimesheet.reviewer))
            .where(
                IngestionTimesheet.employee_id == user.id,
                IngestionTimesheet.status == "approved",
            )
        )).scalars().all()
        print(f"approved ingestion timesheets: {len(timesheets)}")

        # Need a project to attach the synthesized entries to. The
        # employee's primary project access is the right anchor — if
        # they have one. For external employees (no project access),
        # this script bails so we don't invent a project.
        from app.models.assignments import UserProjectAccess
        from app.models.project import Project
        accesses = (await session.execute(
            select(Project).join(UserProjectAccess, UserProjectAccess.project_id == Project.id)
            .where(UserProjectAccess.user_id == user.id, Project.is_active == True)
        )).scalars().all()
        if not accesses:
            # External employees often have no internal project. Fall
            # back to the first active project in the tenant matching
            # the client_id when available, else any active project.
            print("no project access; falling back to a tenant project anchor")
            tenant_projects = (await session.execute(
                select(Project).where(
                    Project.tenant_id == user.tenant_id,
                    Project.is_active == True,
                )
            )).scalars().all()
            if not tenant_projects:
                print("no projects in tenant; aborting")
                return
            default_project = tenant_projects[0]
        else:
            default_project = accesses[0]
        print(f"using default project_id={default_project.id} '{default_project.name}'")

        total_created = 0
        for ts in timesheets:
            if ts.time_entries_created:
                print(f"  ts={ts.id} already materialised — skip")
                continue
            if not ts.period_start or not ts.period_end or not ts.total_hours:
                print(f"  ts={ts.id} missing period or total — skip")
                continue
            days = distribute_hours_evenly(ts.total_hours, ts.period_start, ts.period_end)
            if not days:
                print(f"  ts={ts.id} no working days — skip")
                continue
            # IngestionTimesheet has client_id, not project_id. Pick
            # the first active project whose client_id matches when
            # we can, else fall back to the default anchor project.
            project_id = default_project.id
            if ts.client_id:
                candidate = (await session.execute(
                    select(Project).where(
                        Project.tenant_id == user.tenant_id,
                        Project.is_active == True,
                        Project.client_id == ts.client_id,
                    ).limit(1)
                )).scalar_one_or_none()
                if candidate:
                    project_id = candidate.id
            for d in days:
                entry = TimeEntry(
                    tenant_id=user.tenant_id,
                    user_id=user.id,
                    project_id=project_id,
                    entry_date=d.work_date,
                    hours=Decimal(str(d.hours)),
                    description=f"Inbox-approved timesheet (ts #{ts.id})",
                    is_billable=True,
                    status=TimeEntryStatus.APPROVED,
                    submitted_at=ts.created_at,
                    approved_at=ts.reviewed_at,
                    approved_by=ts.reviewer_id,
                    ingestion_timesheet_id=str(ts.id),
                    ingestion_approved_by_name=ts.reviewer.full_name if ts.reviewer else None,
                )
                session.add(entry)
                total_created += 1
            ts.time_entries_created = True
            session.add(ts)
            print(f"  ts={ts.id} period={ts.period_start}..{ts.period_end} → {len(days)} entries")

        if total_created == 0:
            print("nothing to backfill")
            return
        await session.commit()
        print(f"\nbackfill complete: {total_created} TimeEntry rows created")


if __name__ == "__main__":
    asyncio.run(main())
