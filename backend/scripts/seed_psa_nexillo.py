"""ADDITIVE PSA scenario seed for the nexillo PROD tenant.

Goal: make the manager (pm1@nexillo.com) Insights surfaces show the FULL range
of scenarios (good / at-risk / needs-attention health, real margins, EVM,
resourcing) WITHOUT destroying any existing real data.

Strictly additive / non-destructive rules:
  - cost_rate: filled ONLY where NULL. Never overwritten.
  - existing APPROVED entries: only stamp cost_rate where NULL (makes margin
    real on the real time). billed_rate left as-is.
  - We DO NOT touch the real, already-meaningful projects 3 (over budget ->
    needs-attention) and 4 (good). They stay exactly as they are.
  - We shape only the currently-empty/draft-only projects (6, 7, 8) by ADDING
    approved billable time authored by REAL nexillo employees, plus a budget /
    end_date that yields a clean scenario.
  - baselines / allocations / health configs: INSERT only, guarded by an
    existence check. NO global deletes (unlike the local acuent seed).
  - reporting lines to pm1: added only if missing. Never removed.

Idempotent: re-running detects what it already added (by project + marker
description) and does not duplicate.

Run on the prod host:
  docker compose exec -T api sh -c "cd /app && PYTHONPATH=/app python scripts/seed_psa_nexillo.py"
"""
import asyncio
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select

from app.db_tenant import tenant_session
from app.models.assignments import EmployeeManagerAssignment, ProjectManager
from app.models.project import Project
from app.models.project_baseline import ProjectBaseline
from app.models.resource_allocation import ResourceAllocation
from app.models.time_entry import TimeEntry, TimeEntryStatus
from app.models.user import User

SLUG = "nexillo"
PM_EMAIL = "pm1@nexillo.com"
MARKER = "[psa-demo]"  # description marker on entries WE add, for idempotency

# Per-user cost buckets (loaded hourly cost). Paired vs. bill rates (150-180)
# this gives a margin spread. Filled only where cost_rate is NULL.
COST_BY_BUCKET = {
    "exec": Decimal("140.00"),
    "senior": Decimal("95.00"),
    "mid": Decimal("70.00"),
    "junior": Decimal("48.00"),
    "expensive": Decimal("165.00"),  # deliberately thin/negative margin
}


def bucket_for(title: str, idx: int) -> str:
    t = (title or "").lower()
    if any(k in t for k in ("chief", "vp", "director", "head", "executive")):
        return "exec"
    if any(k in t for k in ("senior", "sr.", "lead", "principal", "manager")):
        return "senior"
    if any(k in t for k in ("associate", "specialist", "junior", "intern")):
        return "junior"
    if idx % 7 == 0:
        return "expensive"
    return "mid"


# Projects we SHAPE (only empty/draft-only ones). For each: which employees
# author approved billable time, hours each, the bill rate, the target burn
# (budget = revenue / burn), end-date offset days, rev-rec, and a schedule
# elapsed target for EVM. Real projects 3 & 4 are intentionally absent here.
#   burn>1 => needs-attention ; 0.8<burn<=1 or near end => at-risk ; else good
SHAPE = [
    # project 7: Client 3, ends 2026-07-31 already -> at-risk via near-end + 0.85 burn
    {"pid": 7, "rate": Decimal("160"), "authors": [(23, 80), (24, 70), (28, 60)],
     "burn": Decimal("0.85"), "end_off": None, "revrec": "as_billed", "sched": Decimal("0.80")},
    # project 6: Client 2, no budget -> at-risk via 0.85 burn (>80%), % complete revrec
    {"pid": 6, "rate": Decimal("150"), "authors": [(25, 90), (29, 80)],
     "burn": Decimal("0.85"), "end_off": 150, "revrec": "percent_complete", "sched": Decimal("0.55")},
    # project 8: Client 1, budget 10k -> we ADD time + set budget relative -> needs-attention (1.15 burn)
    {"pid": 8, "rate": Decimal("175"), "authors": [(26, 70), (30, 65), (31, 55)],
     "burn": Decimal("1.15"), "end_off": -20, "revrec": "as_billed", "sched": Decimal("0.95")},
]


async def main() -> None:
    async with tenant_session(SLUG) as db:
        today = date.today()
        tenant_id = (await db.execute(select(Project.tenant_id).limit(1))).scalar_one()
        pm = (await db.execute(select(User).where(User.email == PM_EMAIL))).scalars().first()
        assert pm is not None, f"{PM_EMAIL} not found"

        # 1) cost rates: fill ONLY where NULL.
        users = (await db.execute(select(User).where(User.is_active == True))).scalars().all()  # noqa: E712
        filled = 0
        for i, u in enumerate(users):
            if u.cost_rate is None:
                u.cost_rate = COST_BY_BUCKET[bucket_for(u.title or "", i)]
                u.cost_currency = "USD"
                filled += 1
            if u.weekly_capacity_hours is None:
                u.weekly_capacity_hours = Decimal("40")
        await db.flush()
        ucost = {u.id: (u.cost_rate, u.cost_currency or "USD") for u in users}
        print(f"cost_rate filled on {filled} users (NULL only)")

        # 2) backfill cost snapshot on existing APPROVED entries where NULL.
        appr = (await db.execute(
            select(TimeEntry).where(TimeEntry.status == TimeEntryStatus.APPROVED)
        )).scalars().all()
        stamped = 0
        for e in appr:
            if e.cost_rate is None and e.user_id in ucost and ucost[e.user_id][0] is not None:
                e.cost_rate, e.cost_currency = ucost[e.user_id]
                stamped += 1
        await db.flush()
        print(f"cost snapshot stamped on {stamped} existing approved entries (NULL only)")

        projects = {p.id: p for p in (await db.execute(select(Project))).scalars().all()}

        # 3) shape the empty/draft-only projects, additively.
        existing_pm = {(pm_.project_id, pm_.user_id)
                       for pm_ in (await db.execute(select(ProjectManager))).scalars().all()}
        existing_rep = {(a.employee_id, a.manager_id)
                        for a in (await db.execute(select(EmployeeManagerAssignment))).scalars().all()}
        # entries we already added (idempotency): (project_id, user_id, entry_date)
        already = {(e.project_id, e.user_id, e.entry_date)
                   for e in (await db.execute(
                       select(TimeEntry).where(TimeEntry.description == MARKER)
                   )).scalars().all()}
        have_baseline = {b.project_id for b in (await db.execute(select(ProjectBaseline))).scalars().all()}
        have_alloc = {(a.user_id, a.project_id) for a in (await db.execute(select(ResourceAllocation))).scalars().all()}

        added_entries = added_pm = added_rep = added_bl = added_alloc = 0
        for spec in SHAPE:
            p = projects.get(spec["pid"])
            if p is None:
                continue
            # ensure pm1 is PM (additive)
            if (p.id, pm.id) not in existing_pm:
                db.add(ProjectManager(project_id=p.id, user_id=pm.id, tenant_id=tenant_id))
                existing_pm.add((p.id, pm.id))
                added_pm += 1

            # add approved billable time authored by real employees
            base_day = today - timedelta(days=21)
            revenue = Decimal("0")
            actual_hours = Decimal("0")
            actual_cost = Decimal("0")
            for ai, (uid, total_hours) in enumerate(spec["authors"]):
                # reporting line to pm1 (additive)
                if (uid, pm.id) not in existing_rep:
                    db.add(EmployeeManagerAssignment(employee_id=uid, manager_id=pm.id, is_primary=False))
                    existing_rep.add((uid, pm.id))
                    added_rep += 1
                # spread total_hours over ~5 working days, 1 entry/day
                per = Decimal(total_hours) / Decimal(5)
                for d in range(5):
                    day = base_day + timedelta(days=(ai * 6 + d))
                    if (p.id, uid, day) in already:
                        continue
                    cr = ucost.get(uid, (None, "USD"))
                    db.add(TimeEntry(
                        tenant_id=tenant_id, user_id=uid, project_id=p.id, task_id=None,
                        entry_date=day, hours=per, description=MARKER, is_billable=True,
                        status=TimeEntryStatus.APPROVED, approved_by=pm.id,
                        billed_rate=spec["rate"], billed_currency="USD",
                        cost_rate=cr[0], cost_currency=cr[1],
                    ))
                    added_entries += 1
                    revenue += per * spec["rate"]
                    actual_hours += per
                    actual_cost += per * (cr[0] or Decimal("0"))

            # also fold in any pre-existing approved billable revenue on this proj
            for e in appr:
                if e.project_id == p.id and e.is_billable:
                    revenue += (e.hours or Decimal("0")) * (e.billed_rate or spec["rate"])
                    actual_hours += e.hours or Decimal("0")
                    actual_cost += (e.hours or Decimal("0")) * (e.cost_rate or Decimal("0"))

            # budget relative to revenue -> deterministic burn. ONLY set it when
            # the project has no real budget yet; never overwrite a real one.
            if p.budget_amount is None and revenue > 0 and spec["burn"] > 0:
                p.budget_amount = (revenue / spec["burn"]).quantize(Decimal("1"))
            # end date: only set when missing (don't overwrite a real end date).
            if spec["end_off"] is not None and p.end_date is None:
                p.end_date = today + timedelta(days=spec["end_off"])
            if p.estimated_hours is None:
                p.estimated_hours = (actual_hours * Decimal("1.15")).quantize(Decimal("1")) or Decimal("300")
            p.revenue_recognition = spec["revrec"]

            # baseline for EVM (insert only)
            if p.id not in have_baseline and actual_hours > 0:
                dur = 120
                elapsed = int(dur * float(spec["sched"]))
                start = today - timedelta(days=elapsed)
                db.add(ProjectBaseline(
                    tenant_id=tenant_id, project_id=p.id, name="Baseline", is_active=True,
                    planned_hours=(actual_hours * Decimal("1.15")).quantize(Decimal("1")),
                    planned_cost=(actual_cost * Decimal("1.15")).quantize(Decimal("1")) or Decimal("20000"),
                    currency="USD", baseline_start=start, baseline_end=start + timedelta(days=dur),
                ))
                added_bl += 1

        await db.flush()

        # 4) a few resource allocations (over / good / bench) on shaped projects,
        #    insert-only. Use the shaped authors so it's coherent.
        shaped_pids = [s["pid"] for s in SHAPE]
        win_s, win_e = today, today + timedelta(weeks=8)
        alloc_plan = [
            (23, 7, Decimal("70")), (23, 6, Decimal("55")),   # over-allocated (125%)
            (24, 7, Decimal("80")),                            # well-allocated
            (25, 6, Decimal("90")),                            # well-allocated
            (26, 8, Decimal("45")),                            # under-utilized
            # emp 27/32 left with no allocation -> bench
        ]
        for uid, pid, pct in alloc_plan:
            if pid in shaped_pids and (uid, pid) not in have_alloc:
                db.add(ResourceAllocation(
                    tenant_id=tenant_id, user_id=uid, project_id=pid,
                    start_date=win_s, end_date=win_e, percent=pct,
                ))
                have_alloc.add((uid, pid))
                added_alloc += 1

        await db.commit()
        print(f"shaped projects {shaped_pids}: +{added_entries} entries, +{added_pm} PM, "
              f"+{added_rep} reporting, +{added_bl} baselines, +{added_alloc} allocations")
        print("done (additive).")


if __name__ == "__main__":
    asyncio.run(main())
