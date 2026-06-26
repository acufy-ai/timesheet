"""DEMO seed: give nexillo projects a varied Phase 2 cause-signals mix.

The Phase 2 schema (estimates / due dates / blocked status + reason /
dependencies) shipped to prod nexillo, but its tasks captured none of those
signals, so the project-report "Why it needs a closer look" only shows the hours
breakdown and falls back to "detail will appear once tasks capture due dates,
estimates and blockers." This script adds a realistic, VARIED mix per project so
each WhySection renders the cause-signals block:

  * one task OVER ESTIMATE  (estimated_hours set below its approved hours)
  * one task BLOCKED        (status=blocked + a reason)
  * one task OVERDUE        (a past due_date on an open task)
  * one DEPENDENCY edge     (a still-open predecessor -> a dependent task)

Plan is keyed by the CURRENT nexillo task ids (see the inspection query in the
deploy session). Strictly additive / idempotent: matches by task id, only sets
fields that are still empty, never flips a task already blocked, and skips a
dependency edge that already exists. Re-running is a no-op. Demo data only — does
not touch billing, hours, names, or any existing non-null field.

Run on prod nexillo:
  docker compose exec -T api sh -c "cd /app && PYTHONPATH=/app python scripts/seed_nexillo_phase2_signals.py"
"""
import asyncio
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select

from app.db_tenant import tenant_session
from app.models.task import Task, TaskStatus
from app.models.task_dependency import TaskDependency

SLUG = "nexillo"

# Per project: which task gets which signal, keyed by the current nexillo task id.
# over=under-estimate task, blocked=blocked task, overdue=past-due task,
# dep=(dependent, predecessor) edge. Tasks left out keep their current state.
PLAN = {
    3: {"over": 1, "overdue": 2},  # Project 1-1 (2 tasks)
    4: {"over": 3, "blocked": 4, "overdue": 5, "dep": (5, 3),
        "blocked_reason": "Waiting on the shared component library release"},
    6: {"over": 9, "blocked": 10, "dep": (10, 9),
        "blocked_reason": "Blocked on the new auth SDK release"},  # Project 2-1
    7: {"over": 12, "blocked": 13, "overdue": 14, "dep": (14, 12),
        "blocked_reason": "Pending security sign-off on the access changes"},  # Project 3-1
    8: {"over": 15, "blocked": 16, "overdue": 17, "dep": (17, 15),
        "blocked_reason": "Waiting on the ETL pipeline to finish first"},  # Project 1-3
}


async def _approved_hours(db, task_id: int) -> Decimal:
    from app.models.time_entry import TimeEntry, TimeEntryStatus
    rows = (await db.execute(
        select(TimeEntry.hours).where(
            TimeEntry.task_id == task_id,
            TimeEntry.status == TimeEntryStatus.APPROVED,
        )
    )).scalars().all()
    return sum((h or Decimal("0") for h in rows), Decimal("0"))


async def main() -> None:
    today = date.today()
    async with tenant_session(SLUG) as db:
        by_id = {
            t.id: t for t in (await db.execute(
                select(Task).where(Task.project_id.in_(list(PLAN.keys())))
            )).scalars().all()
        }

        changed = {"over": 0, "blocked": 0, "overdue": 0, "dep": 0}

        for plan in PLAN.values():
            # OVER ESTIMATE: estimate below the task's actual approved hours.
            if "over" in plan:
                over = by_id.get(plan["over"])
                if over is not None and over.estimated_hours is None:
                    actual = await _approved_hours(db, over.id)
                    # ~65% of actual so the overrun is clear (+~54%).
                    est = (actual * Decimal("0.65")).quantize(Decimal("1"))
                    over.estimated_hours = est if est > 0 else Decimal("10")
                    db.add(over)
                    changed["over"] += 1

            # BLOCKED: status + reason.
            if "blocked" in plan:
                blocked = by_id.get(plan["blocked"])
                if blocked is not None and blocked.status != TaskStatus.blocked:
                    blocked.status = TaskStatus.blocked
                    blocked.blocked_reason = plan["blocked_reason"]
                    db.add(blocked)
                    changed["blocked"] += 1

            # OVERDUE: a past due date on an open task.
            if "overdue" in plan:
                overdue = by_id.get(plan["overdue"])
                if overdue is not None and overdue.due_date is None:
                    overdue.due_date = today - timedelta(days=5)
                    db.add(overdue)
                    changed["overdue"] += 1

            # DEPENDENCY: dependent depends on predecessor (predecessor open).
            if "dep" in plan:
                dep_id, pred_id = plan["dep"]
                exists = (await db.execute(
                    select(TaskDependency).where(
                        TaskDependency.task_id == dep_id,
                        TaskDependency.depends_on_task_id == pred_id,
                    )
                )).scalars().first()
                if exists is None and dep_id in by_id and pred_id in by_id:
                    db.add(TaskDependency(
                        tenant_id=by_id[dep_id].tenant_id,
                        task_id=dep_id, depends_on_task_id=pred_id,
                        reason="Needs the upstream component finished first",
                    ))
                    changed["dep"] += 1

        await db.commit()
        print(f"nexillo projects {list(PLAN.keys())}: "
              f"+{changed['over']} over-estimate, +{changed['blocked']} blocked, "
              f"+{changed['overdue']} overdue, +{changed['dep']} dependencies.")
        print("done (additive demo seed).")


if __name__ == "__main__":
    asyncio.run(main())
