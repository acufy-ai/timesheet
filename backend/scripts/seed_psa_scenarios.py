"""Seed PSA scenario data so the margin / health / financial reports show the
FULL range of cases, not empty or single-state views.

Produces, in the acuent tenant DB:
  - Varied per-user COST rates (so margins compute; some people are "good
    value" = high bill-to-cost, some "bad value" = thin/negative margin).
  - Project budgets + end_dates spanning every health state:
      good  · at-risk (>80% budget or near end) · needs-attention (over budget
      or overdue) · not-set (left bare on purpose for contrast).
  - Backfilled cost snapshots on already-APPROVED entries (re-approving
    hundreds of entries isn't practical; we stamp cost_rate from the owner's
    new cost_rate, mirroring _stamp_billed_rate, and also backfill billed_rate
    where it's NULL so revenue is real).

Idempotent: re-running re-applies the same deterministic values.

Run inside the api container:
  docker compose exec -T api sh -c "cd /app && PYTHONPATH=/app python scripts/seed_psa_scenarios.py acuent"
"""
import asyncio
import sys
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select

from app.db_tenant import tenant_session
from app.models.assignments import ProjectManager
from app.models.project import Project
from app.models.project_baseline import ProjectBaseline
from app.models.resource_allocation import ResourceAllocation
from app.models.time_entry import TimeEntry, TimeEntryStatus
from app.models.user import User


# Cost rate assigned by title bucket (loaded hourly cost to the firm). Paired
# against typical bill rates (100–175) this yields a spread of margins:
#   - senior/exec billed high but cost high too (moderate margin)
#   - consultants billed 125–150, cost ~60–80 (healthy margin = good value)
#   - a few deliberately underwater (cost near or above effective bill) = bad value
COST_BY_BUCKET = {
    "exec": Decimal("140.00"),       # VP/Director/Chief — high cost
    "senior": Decimal("95.00"),      # Sr. Consultant / Lead / Principal
    "mid": Decimal("70.00"),         # Consultant / Engineer / Analyst
    "junior": Decimal("48.00"),      # Associate / Specialist
    "expensive": Decimal("165.00"),  # deliberately bad-value (thin/negative margin)
}


def bucket_for(title: str, idx: int) -> str:
    t = (title or "").lower()
    if any(k in t for k in ("chief", "vp", "director", "executive", "head")):
        return "exec"
    if any(k in t for k in ("senior", "sr.", "lead", "principal", "manager")):
        return "senior"
    if any(k in t for k in ("associate", "specialist", "junior", "intern")):
        return "junior"
    # sprinkle a few "expensive" bad-value people deterministically (~1 in 7)
    if idx % 7 == 0:
        return "expensive"
    return "mid"


# Project scenarios: (match_substring, budget_as_x_of_revenue, end_offset_days,
# note). Budget is set RELATIVE to each project's actual computed revenue so the
# health state is deterministic regardless of how many hours were logged:
#   budget = revenue / burn_target  ->  burn% = revenue/budget = burn_target*100
# end_offset negative = already past (overdue). Health logic:
#   needs-attention: burn > 100% OR >30d overdue
#   at-risk: within 7d of end OR burn > 80%
#   good: otherwise ; not-set: no budget AND no end_date
PROJECT_SCENARIOS = [
    # (substr, target burn fraction, end offset days)
    ("AI Platform",        Decimal("1.20"),  -12, "needs-attention — 120% over budget + overdue"),
    ("Mobile App",         Decimal("0.90"),  5,   "at-risk — 90% burn + near end"),
    ("Operations Enable",  Decimal("0.55"),  120, "good — 55% burn"),
    ("Infrastructure",     Decimal("0.85"),  -40, "needs-attention — overdue 40d"),
    ("Claims Automation",  Decimal("0.30"),  200, "good — healthy"),
    ("Telehealth",         Decimal("1.10"),  60,  "needs-attention — 110% over budget"),
    ("Patient Data",       Decimal("0.82"),  14,  "at-risk — 82% burn"),
    # abcd / F-030 / Project 1 left bare -> "not-set" contrast
]


async def main(slug: str) -> None:
    async with tenant_session(slug) as db:
        today = date.today()

        # 1) cost rates on every active user
        users = (await db.execute(select(User).where(User.is_active == True))).scalars().all()  # noqa: E712
        for i, u in enumerate(users):
            u.cost_rate = COST_BY_BUCKET[bucket_for(u.title or "", i)]
            u.cost_currency = "USD"
        print(f"cost rates set on {len(users)} users")

        # 2) end dates per scenario + remember each project's burn target (budget
        #    is set later, relative to computed revenue). Match substring -> project.
        projects = (await db.execute(select(Project))).scalars().all()
        by_id = {p.id: p for p in projects}
        burn_target: dict[int, Decimal] = {}
        scenario_pids: list[int] = []
        for sub, target, end_off, _note in PROJECT_SCENARIOS:
            for p in projects:
                if sub.lower() in (p.name or "").lower():
                    p.end_date = today + timedelta(days=end_off)
                    if p.estimated_hours is None:
                        p.estimated_hours = Decimal("400.00")
                    burn_target[p.id] = target
                    scenario_pids.append(p.id)
                    break
        print(f"end_date set on {len(scenario_pids)} scenario projects")

        # Put the WHOLE scenario inside ONE manager's scope so it can be tested
        # as a real manager (not just a whole-tenant viewer). manager1 becomes:
        #   (a) PM on every scenario project, and
        #   (b) the manager of every employee who logged time on those projects,
        # so the manager's team-scoped endpoints surface the full range.
        from app.models.assignments import EmployeeManagerAssignment
        from sqlalchemy import delete as _del

        mgr = (await db.execute(
            select(User).where(User.email == "manager1@example.com")
        )).scalars().first() or (await db.execute(
            select(User).where(User.role.in_(["MANAGER", "ADMIN"]), User.is_active == True)  # noqa: E712
        )).scalars().first()
        tenant_id = projects[0].tenant_id if projects else None
        pm_added = 0
        reparented = 0
        if mgr is not None:
            existing_pm = {
                (pm.project_id, pm.user_id)
                for pm in (await db.execute(select(ProjectManager))).scalars().all()
            }
            for pid in scenario_pids:
                if (pid, mgr.id) not in existing_pm:
                    db.add(ProjectManager(project_id=pid, user_id=mgr.id, tenant_id=tenant_id))
                    pm_added += 1
            # Reparent the loggers of scenario projects to manager1 (primary).
            logger_ids = {
                uid for (uid,) in (await db.execute(
                    select(TimeEntry.user_id).where(
                        TimeEntry.project_id.in_(scenario_pids),
                        TimeEntry.status == TimeEntryStatus.APPROVED,
                    ).distinct()
                )).all()
            }
            logger_ids.discard(mgr.id)
            for uid in logger_ids:
                await db.execute(_del(EmployeeManagerAssignment).where(
                    EmployeeManagerAssignment.employee_id == uid,
                    EmployeeManagerAssignment.manager_id == mgr.id,
                ))
                db.add(EmployeeManagerAssignment(employee_id=uid, manager_id=mgr.id, is_primary=False))
                reparented += 1
            await db.flush()
        print(f"PM assigned to {pm_added} scenario projects; reparented {reparented} loggers to mgr={mgr.id if mgr else None}")

        # Rev-rec: set a couple scenario projects to percent_complete (fixed-fee)
        # so the revenue-recognition view shows both methods.
        for idx, pid in enumerate(scenario_pids):
            by_id[pid].revenue_recognition = "percent_complete" if idx % 3 == 0 else "as_billed"

        await db.flush()

        # 3) backfill snapshots on APPROVED entries: cost_rate from owner, and
        #    billed_rate from project rate where NULL, so revenue + cost are real.
        entries = (await db.execute(
            select(TimeEntry).where(TimeEntry.status == TimeEntryStatus.APPROVED)
        )).scalars().all()
        ucost = {u.id: (u.cost_rate, u.cost_currency) for u in users}
        stamped_cost = stamped_bill = 0
        for e in entries:
            cr = ucost.get(e.user_id)
            if cr and cr[0] is not None and e.cost_rate is None:
                e.cost_rate, e.cost_currency = cr[0], cr[1] or "USD"
                stamped_cost += 1
            if e.billed_rate is None:
                proj = by_id.get(e.project_id)
                if proj is not None:
                    e.billed_rate = proj.billable_rate
                    e.billed_currency = proj.currency or "USD"
                    stamped_bill += 1
        print(f"backfilled cost on {stamped_cost} entries, billed_rate on {stamped_bill} entries")

        # 4) Set budgets RELATIVE to each scenario project's actual revenue, so
        #    health states are deterministic. budget = revenue / burn_target.
        revenue_by_proj: dict[int, Decimal] = {}
        for e in entries:
            if not e.is_billable:
                continue
            proj = by_id.get(e.project_id)
            rate = e.billed_rate or (proj.billable_rate if proj else Decimal("0"))
            revenue_by_proj[e.project_id] = revenue_by_proj.get(e.project_id, Decimal("0")) + (e.hours or Decimal("0")) * rate
        budgeted = 0
        for pid in scenario_pids:
            rev = revenue_by_proj.get(pid, Decimal("0"))
            target = burn_target.get(pid, Decimal("0.7"))
            if rev > 0 and target > 0:
                by_id[pid].budget_amount = (rev / target).quantize(Decimal("1"))
                budgeted += 1
        print(f"revenue-relative budgets set on {budgeted} projects")

        # 5) Resource allocations — varied so the Resourcing view shows the full
        #    range: over-allocated (>100%), well-allocated, under-utilized (bench).
        #    Wipe prior seeded allocations first (idempotent).
        from sqlalchemy import delete as sa_delete
        await db.execute(sa_delete(ResourceAllocation))
        tenant_id = projects[0].tenant_id if projects else None
        scenario_proj = [p for p in projects if p.id in set(scenario_pids)] or projects[:4]
        win_start = today
        win_end = today + timedelta(weeks=8)
        alloc_added = 0
        # Set capacity: most FT (40), a couple part-time (20/30) for contrast.
        for i, u in enumerate(users):
            u.weekly_capacity_hours = Decimal("20") if i % 23 == 0 else (Decimal("30") if i % 17 == 0 else Decimal("40"))
        # Allocation pattern by index: every 5th over-allocated (120%), most ~80%,
        # every 4th left with no allocation (bench / under-utilized).
        emp_users = [u for u in users if u.role.value in ("EMPLOYEE", "MANAGER")] if hasattr(users[0].role, "value") else users
        for i, u in enumerate(emp_users):
            if not scenario_proj:
                break
            if i % 4 == 0:
                continue  # bench — no allocation -> under-utilized
            proj = scenario_proj[i % len(scenario_proj)]
            if i % 5 == 0:
                # over-allocated: two overlapping bookings summing to 120%
                db.add(ResourceAllocation(tenant_id=tenant_id, user_id=u.id, project_id=proj.id,
                    start_date=win_start, end_date=win_end, percent=Decimal("70"), role=u.title))
                proj2 = scenario_proj[(i + 1) % len(scenario_proj)]
                db.add(ResourceAllocation(tenant_id=tenant_id, user_id=u.id, project_id=proj2.id,
                    start_date=win_start, end_date=win_end, percent=Decimal("50"), role=u.title))
                alloc_added += 2
            else:
                db.add(ResourceAllocation(tenant_id=tenant_id, user_id=u.id, project_id=proj.id,
                    start_date=win_start, end_date=win_end, percent=Decimal("80"), role=u.title))
                alloc_added += 1
        print(f"resource allocations created: {alloc_added}")

        # 6) Baselines for EVM. For each scenario project, snapshot a plan:
        #    planned_hours (from actuals so EV is meaningful), planned_cost, and a
        #    schedule window. Vary the window so SPI/CPI span ahead/behind &
        #    over/under cost. Wipe prior baselines first (idempotent).
        await db.execute(sa_delete(ProjectBaseline))
        # actual cost + hours per project (from the just-stamped entries)
        actual = {}
        for e in entries:
            a = actual.setdefault(e.project_id, {"hours": Decimal("0"), "cost": Decimal("0")})
            a["hours"] += e.hours or Decimal("0")
            a["cost"] += (e.hours or Decimal("0")) * (e.cost_rate or Decimal("0"))
        # Schedule-elapsed% target per scenario index, so SPI = work%/sched% lands
        # in a believable range (some ahead, some behind). We back into the
        # baseline window from the target: started in the past, ends in future.
        # (sched_target, hours_multiplier) — hours mult >1 makes %complete<100.
        sched_targets = [
            Decimal("0.95"),  # behind unless nearly done -> SPI low
            Decimal("0.70"),
            Decimal("0.60"),
            Decimal("0.85"),
            Decimal("0.50"),
            Decimal("0.75"),
            Decimal("0.40"),
        ]
        bl_added = 0
        for idx, pid in enumerate(scenario_pids):
            a = actual.get(pid, {"hours": Decimal("0"), "cost": Decimal("0")})
            sched_target = sched_targets[idx % len(sched_targets)]
            # Pick a 120-day window with `sched_target` already elapsed.
            dur = 120
            elapsed_days = int(dur * float(sched_target))
            start = today - timedelta(days=elapsed_days)
            end = start + timedelta(days=dur)
            # planned hours 1.15x actuals -> ~87% complete; planned cost = bac.
            planned_hours = (a["hours"] * Decimal("1.15")).quantize(Decimal("1")) or Decimal("400")
            planned_cost = (a["cost"] * Decimal("1.15")).quantize(Decimal("1")) or Decimal("40000")
            db.add(ProjectBaseline(
                tenant_id=tenant_id, project_id=pid, name="Baseline", is_active=True,
                planned_hours=planned_hours, planned_cost=planned_cost, currency="USD",
                baseline_start=start, baseline_end=end,
            ))
            bl_added += 1
        print(f"baselines created: {bl_added}")

        await db.commit()
        print("done.")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "acuent"))
