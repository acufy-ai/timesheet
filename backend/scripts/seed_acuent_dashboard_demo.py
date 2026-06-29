"""DEMO seed: give the acuent manager dashboard enough authored data to show
ALL six project-health states AND exercise pagination on both the Projects
widget (>8 clients) and the Project-hours-by-person matrix (>10 people).

Everything is AUTHORED, not hardcoded dummy rows:
  * each new project is owned by manager1 (John Doe, id 5) via manager_id, so it
    surfaces on his dashboard exactly like a real engagement;
  * every hour is a real TimeEntry by a real existing report of manager1's,
    APPROVED by the manager (approved_by=5, which differs from the author per the
    DB check constraint);
  * the blocked state comes from a real Task in 'blocked' status.

Health is tuned per project via budget_amount + end_date + logged billable hours
(budget burn = approved billable revenue / budget) and a blocked task:
  at-risk (~90% burn), on-track (~65%), excellent (~30%, far end), not-set
  (no budget/no end), blocked (a blocked task), not-started (no time logged).
The existing acuent projects already cover critical + excellent + blocked, so
together the board shows all six.

Strictly additive / idempotent: keyed on client name (unique per tenant); a
re-run skips clients that already exist and never duplicates time entries
(guarded by a per-entry marker in the description). Demo data only.

Run locally:
  docker compose exec -T api sh -c "cd /app && PYTHONPATH=/app python scripts/seed_acuent_dashboard_demo.py"
"""
import asyncio
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select

from app.db_tenant import tenant_session
from app.models.client import Client, ClientStatus, ClientType
from app.models.project import Project, ProjectStatus
from app.models.task import Task, TaskStatus
from app.models.time_entry import TimeEntry, TimeEntryStatus
from app.models.user import User, UserRole

SLUG = "acuent"
MANAGER_ID = 5            # manager1@example.com / John Doe
MARKER = "[dash-demo]"    # per-entry guard so re-runs don't duplicate hours
RATE = Decimal("150")     # billable rate used for the demo projects

TODAY = date.today()


# Per demo client: (client_name, project_name, code, target_health, budget,
# end_offset_days, billable_hours_to_log, blocked). The hours are split across
# real reports below. budget/hours/end are tuned to land the target health.
PLAN = [
    # at-risk: ~90% burn (between high_burn 80 and over_budget 100), end far.
    ("Meridian Health", "Claims Portal Rebuild", "MHC", "at-risk",
     Decimal("60000"), 120, Decimal("360"), False),     # 360h*150 = 54000 = 90%
    # on-track: ~65% burn, end far.
    ("Vertex Logistics", "WMS Upgrade", "VLW", "on-track",
     Decimal("80000"), 150, Decimal("347"), False),     # 347*150 = 52050 ~ 65%
    # excellent: ~30% burn, end far out.
    ("Crestline Bank", "Fraud Detection Platform", "CBF", "excellent",
     Decimal("120000"), 200, Decimal("240"), False),    # 240*150 = 36000 = 30%
    # not-set: no budget, no end date (still has logged hours so it's "started").
    ("Northwind Retail", "POS Refresh", "NWP", "not-set",
     None, None, Decimal("80"), False),
    # blocked: healthy burn but a blocked task.
    ("Solstice Energy", "Grid Analytics", "SEG", "blocked",
     Decimal("90000"), 140, Decimal("200"), True),      # 200*150 = 30000 ~ 33% + blocked task
    # not-started: a project with NO time logged at all.
    ("Harbor Freight Co", "Fleet Tracker", "HFF", "not-started",
     Decimal("40000"), 90, Decimal("0"), False),
]


async def main() -> None:
    async with tenant_session(SLUG) as db:
        tenant_id = (await db.execute(
            select(User.tenant_id).where(User.id == MANAGER_ID)
        )).scalar_one()

        # Reports of manager1 we can attribute hours to (real, active, not the
        # manager himself). Spread across >=11 so the matrix paginates.
        from app.models.assignments import EmployeeManagerAssignment
        report_ids = [
            uid for (uid,) in (await db.execute(
                select(User.id)
                .join(EmployeeManagerAssignment, EmployeeManagerAssignment.employee_id == User.id)
                .where(
                    EmployeeManagerAssignment.manager_id == MANAGER_ID,
                    User.is_active.is_(True),
                    User.id != MANAGER_ID,
                )
            )).all()
        ]
        if len(report_ids) < 11:
            print(f"WARNING: only {len(report_ids)} reports available; matrix may not paginate.")

        created = {"clients": 0, "projects": 0, "tasks": 0, "entries": 0, "skipped": 0}

        for (cname, pname, code, _health, budget, end_off, bill_hours, blocked) in PLAN:
            # Client (idempotent on unique tenant+name).
            client = (await db.execute(
                select(Client).where(Client.tenant_id == tenant_id, Client.name == cname)
            )).scalar_one_or_none()
            if client is None:
                client = Client(
                    tenant_id=tenant_id, name=cname,
                    client_type=ClientType.external, status=ClientStatus.active,
                )
                db.add(client)
                await db.flush()
                created["clients"] += 1

            # Project owned by manager1 (idempotent on tenant+client+name).
            project = (await db.execute(
                select(Project).where(
                    Project.tenant_id == tenant_id, Project.client_id == client.id,
                    Project.name == pname,
                )
            )).scalar_one_or_none()
            if project is None:
                project = Project(
                    tenant_id=tenant_id, client_id=client.id, name=pname, code=code,
                    billable_rate=RATE, manager_id=MANAGER_ID,
                    budget_amount=budget, currency="USD",
                    end_date=(TODAY + timedelta(days=end_off)) if end_off is not None else None,
                    is_active=True, status=ProjectStatus.in_progress,
                )
                db.add(project)
                await db.flush()
                created["projects"] += 1

            # Blocked task (idempotent on name).
            if blocked:
                exists = (await db.execute(
                    select(Task).where(Task.project_id == project.id, Task.name == "Vendor data feed")
                )).scalar_one_or_none()
                if exists is None:
                    db.add(Task(
                        tenant_id=tenant_id, project_id=project.id, name="Vendor data feed",
                        status=TaskStatus.blocked, is_active=True,
                        blocked_reason="Waiting on the vendor's data export",
                    ))
                    created["tasks"] += 1

            # Authored, approved, billable hours in realistic daily chunks (<=24h
            # per entry; we use 8h/day). Rotate authors so MANY of manager1's
            # reports get hours -> the per-person matrix paginates. Idempotent:
            # skip if a marker entry for this (author, project) already exists.
            if bill_hours and bill_hours > 0 and report_ids:
                per_day = Decimal("8")
                n_days = int((bill_hours / per_day).to_integral_value(rounding="ROUND_CEILING"))
                remaining = bill_hours
                desc = f"{MARKER} {pname}"
                base_day = TODAY - timedelta(days=20)
                for i in range(n_days):
                    uid = report_ids[i % len(report_ids)]
                    h = min(per_day, remaining)
                    remaining -= h
                    if h <= 0:
                        break
                    # Guard duplicates on (project, author, day, marker).
                    day = base_day + timedelta(days=i % 18)
                    already = (await db.execute(
                        select(TimeEntry.id).where(
                            TimeEntry.project_id == project.id,
                            TimeEntry.user_id == uid,
                            TimeEntry.entry_date == day,
                            TimeEntry.description == desc,
                        ).limit(1)
                    )).scalar_one_or_none()
                    if already is not None:
                        created["skipped"] += 1
                        continue
                    db.add(TimeEntry(
                        tenant_id=tenant_id, user_id=uid, project_id=project.id, task_id=None,
                        entry_date=day, hours=h, description=desc, is_billable=True,
                        status=TimeEntryStatus.APPROVED, approved_by=MANAGER_ID,
                    ))
                    created["entries"] += 1

        await db.commit()
        print(
            f"acuent dashboard demo: +{created['clients']} clients, "
            f"+{created['projects']} projects, +{created['tasks']} blocked tasks, "
            f"+{created['entries']} approved time entries "
            f"({created['skipped']} already present)."
        )
        print("done (additive demo seed).")


if __name__ == "__main__":
    asyncio.run(main())
