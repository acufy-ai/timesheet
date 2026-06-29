"""ADDITIVE dashboard-demo seed for the nexillo PROD tenant.

Mirrors the local acuent dashboard demo (seed_acuent_dashboard_demo.py): it gives
the manager dashboard + Insights enough AUTHORED data to show the FULL range of
project-health states AND exercise pagination on the Projects widget and the
project-hours-by-person matrix, WITHOUT touching any existing nexillo data.

Follows the nexillo seed conventions exactly:
  * new clients/projects are keyed by name (unique per tenant) so re-runs skip
    them (idempotent);
  * pm1@nexillo.com is set as the project's ProjectManager so each project
    surfaces on the manager dashboard;
  * every hour is a real TimeEntry authored by a REAL active nexillo employee,
    APPROVED by pm1 (approved_by != user_id per the DB check constraint),
    billed + cost stamped so margin/EVM are real;
  * SEED LESSON (2026-06-26): time is only "authored" enough if it has a
    task_id AND the logger is on the project roster (UserProjectAccess) AND a
    TaskAssignee. Otherwise the UI reads as authorless dummy data. So every demo
    project gets named tasks, the loggers are added to the roster + assigned to
    a task, and their entries carry that task_id.

Health is tuned per project via budget_amount + end_date + logged billable
revenue (burn = approved billable revenue / budget) and a blocked task:
  at-risk (~90% burn), on-track (~65%), excellent (~30%), not-set (no budget /
  no end), blocked (a blocked task), not-started (no time logged).

Strictly additive / idempotent: keyed on client name; a re-run skips clients
that already exist and never duplicates time entries (guarded by a per-entry
marker in the description). Demo data only. Never touches existing nexillo
clients/projects/users.

Run on the prod host:
  docker compose exec -T api sh -c "cd /app && PYTHONPATH=/app python scripts/seed_nexillo_dashboard_demo.py"
"""
import asyncio
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select

from app.db_tenant import tenant_session
from app.models.assignments import (
    EmployeeManagerAssignment,
    ProjectManager,
    TaskAssignee,
    UserProjectAccess,
)
from app.models.client import Client, ClientStatus, ClientType
from app.models.project import Project, ProjectStatus
from app.models.task import Task, TaskStatus
from app.models.time_entry import TimeEntry, TimeEntryStatus
from app.models.user import User

SLUG = "nexillo"
PM_EMAIL = "pm1@nexillo.com"
MARKER = "[dash-demo]"      # per-entry guard so re-runs don't duplicate hours
RATE = Decimal("150")       # billable rate used for the demo projects
COST = Decimal("85")        # cost rate so margin is real (~43%)

TODAY = date.today()

# Per demo client: (client_name, project_name, code, target_health, budget,
# end_offset_days, billable_hours_to_log, blocked, [task names]). Hours are split
# across real nexillo employees below. budget/hours/end land the target health.
#
# NAMING follows the existing nexillo convention exactly: clients are "Client N"
# and projects are "Project <clientNumber>-<index>". The tenant already has
# Client 1-3 / Project 1-1.. so the demo clients continue from Client 4. Each
# demo client owns a single project (-1).
PLAN = [
    # at-risk: ~90% burn (between high_burn 80 and over_budget 100), end far.
    ("Client 4", "Project 4-1", "P41", "at-risk",
     Decimal("60000"), 120, Decimal("360"), False,
     ["Portal UX", "Auth integration", "Claims view"]),     # 360h*150 = 54000 = 90%
    # on-track: ~65% burn, end far.
    ("Client 5", "Project 5-1", "P51", "on-track",
     Decimal("80000"), 150, Decimal("347"), False,
     ["Routing engine", "Telemetry sync", "Driver app"]),   # 347*150 = 52050 ~ 65%
    # excellent: ~30% burn, end far out.
    ("Client 6", "Project 6-1", "P61", "excellent",
     Decimal("120000"), 200, Decimal("240"), False,
     ["Model training", "Rules engine", "Alerting"]),       # 240*150 = 36000 = 30%
    # not-set: no budget, no end date (still has logged hours so it's "started").
    ("Client 7", "Project 7-1", "P71", "not-set",
     None, None, Decimal("80"), False,
     ["Terminal firmware", "Inventory sync"]),
    # blocked: healthy burn but a blocked task.
    ("Client 8", "Project 8-1", "P81", "blocked",
     Decimal("90000"), 140, Decimal("200"), True,
     ["Sensor ingest", "Vendor data feed", "Dashboard"]),   # 200*150 = 30000 ~ 33% + blocked
    # not-started: a project with NO time logged at all.
    ("Client 9", "Project 9-1", "P91", "not-started",
     Decimal("40000"), 90, Decimal("0"), False,
     ["Discovery", "Pilot integration"]),
]


async def main() -> None:
    async with tenant_session(SLUG) as db:
        tenant_id = (await db.execute(select(Project.tenant_id).limit(1))).scalar_one()
        pm = (await db.execute(select(User).where(User.email == PM_EMAIL))).scalars().first()
        assert pm is not None, f"{PM_EMAIL} not found"

        # Real active nexillo employees to attribute hours to (NOT pm1 himself,
        # so approved_by != user_id). Spread across as many as possible so the
        # per-person matrix paginates. Deterministic order by id.
        report_ids = [
            uid for (uid,) in (await db.execute(
                select(User.id)
                .where(User.is_active.is_(True), User.id != pm.id)
                .order_by(User.id.asc())
            )).all()
        ]
        assert report_ids, "no active employees to author hours"
        if len(report_ids) < 11:
            print(f"NOTE: only {len(report_ids)} employees available; matrix may not paginate.")

        # Idempotency sets.
        existing_pm = {(m.project_id, m.user_id)
                       for m in (await db.execute(select(ProjectManager))).scalars().all()}
        existing_roster = {(r.user_id, r.project_id)
                           for r in (await db.execute(select(UserProjectAccess))).scalars().all()}
        existing_assignee = {(a.task_id, a.user_id)
                             for a in (await db.execute(select(TaskAssignee))).scalars().all()}
        # Reporting lines to pm1: the portfolio/financials surfaces scope to the
        # manager's TEAM (direct reports), so an author who logs time but doesn't
        # report to pm1 has their hours excluded -> health burn reads low. Mirror
        # seed_psa_nexillo: add each author as a report of pm1 (additive).
        existing_rep = {(a.employee_id, a.manager_id)
                        for a in (await db.execute(select(EmployeeManagerAssignment))).scalars().all()}

        created = {"clients": 0, "projects": 0, "tasks": 0, "pm": 0, "report": 0,
                   "roster": 0, "assignee": 0, "entries": 0, "skipped": 0}

        for (cname, pname, code, _health, budget, end_off, bill_hours, blocked, task_names) in PLAN:
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

            # Project (idempotent on tenant+client+name).
            project = (await db.execute(
                select(Project).where(
                    Project.tenant_id == tenant_id, Project.client_id == client.id,
                    Project.name == pname,
                )
            )).scalar_one_or_none()
            if project is None:
                project = Project(
                    tenant_id=tenant_id, client_id=client.id, name=pname, code=code,
                    billable_rate=RATE, budget_amount=budget, currency="USD",
                    end_date=(TODAY + timedelta(days=end_off)) if end_off is not None else None,
                    is_active=True, status=ProjectStatus.in_progress,
                )
                db.add(project)
                await db.flush()
                created["projects"] += 1

            # pm1 as ProjectManager (additive) so it shows on the manager dash.
            if (project.id, pm.id) not in existing_pm:
                db.add(ProjectManager(project_id=project.id, user_id=pm.id, tenant_id=tenant_id))
                existing_pm.add((project.id, pm.id))
                created["pm"] += 1

            # Tasks (idempotent on name). First in_progress; one 'blocked' if the
            # project targets the blocked state; rest to_do.
            existing_tasks = {
                t.name: t for t in (await db.execute(
                    select(Task).where(Task.project_id == project.id)
                )).scalars().all()
            }
            tasks: list[Task] = []
            for i, tname in enumerate(task_names):
                t = existing_tasks.get(tname)
                if t is None:
                    if blocked and i == 1:
                        status = TaskStatus.blocked
                        kw = {"blocked_reason": "Waiting on the vendor's data export"}
                    elif i == 0:
                        status, kw = TaskStatus.in_progress, {}
                    else:
                        status, kw = TaskStatus.to_do, {}
                    t = Task(tenant_id=tenant_id, project_id=project.id, name=tname,
                             status=status, is_active=True, **kw)
                    db.add(t)
                    await db.flush()
                    created["tasks"] += 1
                tasks.append(t)

            # Authored, approved, billable hours in 8h/day chunks (<=24h per entry
            # per the DB check constraint). Rotate authors so MANY employees get
            # hours -> per-person matrix paginates. Each author is added to the
            # roster + assigned to a task, and their entries carry that task_id.
            if bill_hours and bill_hours > 0:
                per_day = Decimal("8")
                n_days = int((bill_hours / per_day).to_integral_value(rounding="ROUND_CEILING"))
                remaining = bill_hours
                desc = f"{MARKER} {pname}"
                base_day = TODAY - timedelta(days=20)
                # Tasks eligible for logging: skip the blocked one (no time on it).
                log_tasks = [t for t in tasks if t.status != TaskStatus.blocked] or tasks
                for i in range(n_days):
                    uid = report_ids[i % len(report_ids)]
                    task = log_tasks[i % len(log_tasks)]
                    h = min(per_day, remaining)
                    remaining -= h
                    if h <= 0:
                        break

                    # reporting line to pm1 (additive) so the author's hours fall
                    # inside pm1's scoped team and count toward project burn.
                    if (uid, pm.id) not in existing_rep:
                        db.add(EmployeeManagerAssignment(employee_id=uid, manager_id=pm.id, is_primary=False))
                        existing_rep.add((uid, pm.id))
                        created["report"] += 1

                    # roster + task assignment (additive).
                    if (uid, project.id) not in existing_roster:
                        db.add(UserProjectAccess(user_id=uid, project_id=project.id))
                        existing_roster.add((uid, project.id))
                        created["roster"] += 1
                    if (task.id, uid) not in existing_assignee:
                        db.add(TaskAssignee(task_id=task.id, user_id=uid, tenant_id=tenant_id))
                        existing_assignee.add((task.id, uid))
                        created["assignee"] += 1

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
                        tenant_id=tenant_id, user_id=uid, project_id=project.id, task_id=task.id,
                        entry_date=day, hours=h, description=desc, is_billable=True,
                        status=TimeEntryStatus.APPROVED, approved_by=pm.id,
                        billed_rate=RATE, billed_currency="USD",
                        cost_rate=COST, cost_currency="USD",
                    ))
                    created["entries"] += 1

        await db.commit()
        print(
            f"nexillo dashboard demo: +{created['clients']} clients, "
            f"+{created['projects']} projects, +{created['tasks']} tasks, "
            f"+{created['pm']} PM links, +{created['report']} reports, +{created['roster']} roster, "
            f"+{created['assignee']} task-assignees, +{created['entries']} approved entries "
            f"({created['skipped']} already present)."
        )
        print("done (additive demo seed).")


if __name__ == "__main__":
    asyncio.run(main())
