"""DEMO seed: give acuent projects 1-4 a varied Phase 2 cause-signals mix.

After fix_acuent_task_authorship.py attributed hours to real tasks, those four
projects show the hours breakdown but NOT the cause-signals block (no estimates /
due dates / blockers / dependencies captured). This script adds a realistic,
VARIED mix per project so each WhySection renders the icon block differently:

  * one task OVER ESTIMATE  (estimated_hours set below its approved hours)
  * one task BLOCKED        (status=blocked + a reason)
  * one task OVERDUE        (a past due_date on an open task)
  * one DEPENDENCY edge     (a still-open predecessor -> a dependent task)

It also promotes the stray placeholder "Task 1" on project 1 into a real named
task (estimate + due date), so it stops reading as empty junk.

Strictly additive / idempotent: matches by task id, only sets fields that are
still empty, and ON CONFLICT-guards the dependency. Re-running is a no-op.
Demo data only — does not touch billing.

Run locally:
  docker compose exec -T api sh -c "cd /app && PYTHONPATH=/app python scripts/seed_acuent_phase2_signals.py"
"""
import asyncio
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select

from app.db_tenant import tenant_session
from app.models.project import Project
from app.models.task import Task, TaskStatus
from app.models.task_dependency import TaskDependency

SLUG = "acuent"

# Per project: which task gets which signal. Keyed by task id (from the current
# acuent DB). over=under-estimate task, blocked=blocked task, overdue=past-due
# task, dep=(dependent, predecessor) edge.
PLAN = {
    1: {"over": 27, "blocked": 28, "overdue": 29, "dep": (30, 27),
        "blocked_reason": "Waiting on labeled training set from the data vendor"},
    2: {"over": 31, "blocked": 32, "overdue": 33, "dep": (34, 31),
        "blocked_reason": "Blocked on the new auth SDK release"},
    3: {"over": 35, "blocked": 36, "overdue": 37, "dep": (38, 35),
        "blocked_reason": "Pending security sign-off on the access changes"},
    4: {"over": 39, "blocked": 40, "overdue": 41, "dep": (42, 39),
        "blocked_reason": "Waiting on the new hardware to arrive"},
}

# The stray placeholder to promote into a real task (project 1).
STRAY_TASK_ID = 1
STRAY_NEW_NAME = "Model registry and serving"


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

        changed = {"over": 0, "blocked": 0, "overdue": 0, "dep": 0, "stray": 0}

        # Promote the stray "Task 1" -> a real named task with estimate + due date.
        stray = by_id.get(STRAY_TASK_ID)
        if stray is not None and stray.name.strip().lower().startswith("task "):
            stray.name = STRAY_NEW_NAME
            if stray.estimated_hours is None:
                stray.estimated_hours = Decimal("40")
            if stray.due_date is None:
                stray.due_date = today + timedelta(days=10)
            stray.status = TaskStatus.in_progress
            db.add(stray)
            changed["stray"] += 1

        for pid, plan in PLAN.items():
            # OVER ESTIMATE: estimate below the task's actual approved hours.
            over = by_id.get(plan["over"])
            if over is not None and over.estimated_hours is None:
                actual = await _approved_hours(db, over.id)
                # ~65% of actual so the overrun is clear (+~54%).
                est = (actual * Decimal("0.65")).quantize(Decimal("1"))
                over.estimated_hours = est if est > 0 else Decimal("10")
                db.add(over)
                changed["over"] += 1

            # BLOCKED: status + reason.
            blocked = by_id.get(plan["blocked"])
            if blocked is not None and blocked.status != TaskStatus.blocked:
                blocked.status = TaskStatus.blocked
                blocked.blocked_reason = plan["blocked_reason"]
                db.add(blocked)
                changed["blocked"] += 1

            # OVERDUE: a past due date on an open task.
            overdue = by_id.get(plan["overdue"])
            if overdue is not None and overdue.due_date is None:
                overdue.due_date = today - timedelta(days=5)
                db.add(overdue)
                changed["overdue"] += 1

            # DEPENDENCY: dependent depends on predecessor (predecessor open).
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
        print(f"acuent projects {list(PLAN.keys())}: "
              f"+{changed['over']} over-estimate, +{changed['blocked']} blocked, "
              f"+{changed['overdue']} overdue, +{changed['dep']} dependencies, "
              f"stray promoted: {changed['stray']}.")
        print("done (additive demo seed).")


if __name__ == "__main__":
    asyncio.run(main())
