"""ADDITIVE fix for the nexillo seed: make the seeded time coherent.

The earlier nexillo seed (seed_psa_nexillo.py) added approved time with a real
``user_id`` (author) but left ``task_id=NULL`` and didn't put the loggers on the
project roster. So the project cards render "no tasks / no users" even though the
time has an author. This script fixes ONLY the projects that seed shaped (6, 7,
8) by:

  1. Creating named tasks on the project (if it has fewer than the target).
  2. Adding each logging employee to the project roster (UserProjectAccess) and
     as a TaskAssignee.
  3. Re-tagging that project's NULL-task APPROVED entries to the new tasks, so
     hours are attributed to tasks (the "Why" breakdown then populates).

Strictly additive / non-destructive: only touches projects in TARGET_PIDS, only
re-tags entries whose task_id IS NULL, never deletes anything, never touches the
real projects 3/4. Idempotent: re-running detects existing tasks/roster rows.

Run on the prod host:
  docker compose exec -T api sh -c "cd /app && PYTHONPATH=/app python scripts/fix_nexillo_task_authorship.py"
"""
import asyncio
from decimal import Decimal

from sqlalchemy import select

from app.db_tenant import tenant_session
from app.models.assignments import TaskAssignee, UserProjectAccess
from app.models.project import Project
from app.models.task import Task, TaskStatus
from app.models.time_entry import TimeEntry, TimeEntryStatus

SLUG = "nexillo"

# Only the seed-shaped projects, with coherent task names per project. These are
# the ones with untagged time + no/sparse tasks. Real projects (3, 4) excluded.
PROJECT_TASKS = {
    6: ["Provider onboarding flow", "Compliance review", "Video SDK evaluation"],
    7: ["Care coordination module", "Patient portal UX", "Telehealth integration"],
    8: ["ETL pipeline", "Data model design", "Patient data migration"],
}


async def main() -> None:
    async with tenant_session(SLUG) as db:
        tenant_id = (await db.execute(select(Project.tenant_id).limit(1))).scalar_one()

        existing_roster = {
            (r.user_id, r.project_id)
            for r in (await db.execute(select(UserProjectAccess))).scalars().all()
        }
        existing_assignee = {
            (a.task_id, a.user_id)
            for a in (await db.execute(select(TaskAssignee))).scalars().all()
        }

        created_tasks = added_roster = added_assignee = retagged = 0

        for pid, task_names in PROJECT_TASKS.items():
            project = (await db.execute(
                select(Project).where(Project.id == pid)
            )).scalars().first()
            if project is None:
                continue

            # 1) Ensure tasks exist (match by name so re-runs don't duplicate).
            existing = {
                t.name: t for t in (await db.execute(
                    select(Task).where(Task.project_id == pid)
                )).scalars().all()
            }
            tasks: list[Task] = []
            for i, name in enumerate(task_names):
                t = existing.get(name)
                if t is None:
                    # Vary status so the board looks real: first in_progress, rest to_do.
                    status = TaskStatus.in_progress if i == 0 else TaskStatus.to_do
                    t = Task(tenant_id=tenant_id, project_id=pid, name=name, status=status)
                    db.add(t)
                    await db.flush()  # get t.id
                    created_tasks += 1
                tasks.append(t)

            # 2) The untagged approved entries on this project, grouped by author.
            untagged = (await db.execute(
                select(TimeEntry).where(
                    TimeEntry.project_id == pid,
                    TimeEntry.status == TimeEntryStatus.APPROVED,
                    TimeEntry.task_id.is_(None),
                )
            )).scalars().all()

            # Author -> the task we attribute their hours to. Spread authors
            # across tasks deterministically so each task gets some real time and
            # the breakdown shows a believable split.
            authors = sorted({e.user_id for e in untagged})
            author_task = {uid: tasks[i % len(tasks)] for i, uid in enumerate(authors)}

            # 3) Roster + task assignment for each author; re-tag their entries.
            for uid in authors:
                if (uid, pid) not in existing_roster:
                    db.add(UserProjectAccess(user_id=uid, project_id=pid))
                    existing_roster.add((uid, pid))
                    added_roster += 1
                t = author_task[uid]
                if (t.id, uid) not in existing_assignee:
                    db.add(TaskAssignee(task_id=t.id, user_id=uid, tenant_id=tenant_id))
                    existing_assignee.add((t.id, uid))
                    added_assignee += 1

            for e in untagged:
                e.task_id = author_task[e.user_id].id
                retagged += 1

            await db.flush()

        await db.commit()
        print(f"projects {list(PROJECT_TASKS)}: +{created_tasks} tasks, "
              f"+{added_roster} roster, +{added_assignee} task-assignees, "
              f"re-tagged {retagged} approved entries to tasks.")
        print("done (additive).")


if __name__ == "__main__":
    asyncio.run(main())
