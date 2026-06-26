"""ADDITIVE fix for the acuent demo data: attribute NULL-task approved time.

The acuent seed added APPROVED time entries with a real ``user_id`` (author) but
``task_id=NULL`` and didn't roster the loggers onto tasks. So the project report's
"Why it needs a closer look" breakdown — which aggregates hours PER TASK — shows
no top-tasks and a thin/identical "who's carrying it" across projects 1-4. This
script makes that seeded time coherent for those four projects only:

  1. Creating named tasks on the project (matched by name so re-runs don't dupe).
  2. Adding each logging employee to the project roster (UserProjectAccess) and
     as a TaskAssignee on the tasks they get time on.
  3. Re-tagging that project's NULL-task APPROVED entries to the new tasks,
     spreading each author's entries across tasks so the breakdown shows a
     believable per-task split (not all of one author on a single task).

Strictly additive / non-destructive: only touches projects in PROJECT_TASKS,
only re-tags entries whose task_id IS NULL, never deletes anything, never touches
the newer properly-tagged projects (25/26/27). Idempotent: re-running detects
existing tasks/roster/assignee rows and only re-tags still-NULL entries.

Run locally:
  docker compose exec -T api sh -c "cd /app && PYTHONPATH=/app python scripts/fix_acuent_task_authorship.py"
"""
import asyncio

from sqlalchemy import select

from app.db_tenant import tenant_session
from app.models.assignments import TaskAssignee, UserProjectAccess
from app.models.project import Project
from app.models.task import Task, TaskStatus
from app.models.time_entry import TimeEntry, TimeEntryStatus

SLUG = "acuent"

# Coherent task names per acuent project (1-4). These are the projects whose
# approved time is entirely NULL-task. Names chosen to fit each project's theme.
PROJECT_TASKS = {
    1: ["Model training pipeline", "Inference API", "Data labeling tooling", "Evaluation harness"],
    2: ["Rewrite navigation", "Offline sync", "Push notifications", "Performance pass"],
    3: ["Runbook automation", "On-call tooling", "Access workflows", "Reporting dashboard"],
    4: ["Cluster hardening", "Backup and restore", "Monitoring rollout", "Failover drills"],
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

            # 2) The untagged approved entries on this project, ordered so the
            # round-robin split is deterministic across re-runs.
            untagged = (await db.execute(
                select(TimeEntry).where(
                    TimeEntry.project_id == pid,
                    TimeEntry.status == TimeEntryStatus.APPROVED,
                    TimeEntry.task_id.is_(None),
                ).order_by(TimeEntry.user_id, TimeEntry.entry_date, TimeEntry.id)
            )).scalars().all()

            # 3) Spread each author's entries across the project's tasks. Each
            # author starts on a different task (so authors don't all pile onto
            # task 0) and then round-robins through the rest, giving every task
            # real time from multiple people and a believable breakdown split.
            authors = sorted({e.user_id for e in untagged})
            start_for_author = {uid: idx % len(tasks) for idx, uid in enumerate(authors)}
            per_author_seen: dict[int, int] = {uid: 0 for uid in authors}

            assignments: dict[tuple[int, int], None] = {}  # (task_id, uid) to add
            for e in untagged:
                uid = e.user_id
                k = (start_for_author[uid] + per_author_seen[uid]) % len(tasks)
                per_author_seen[uid] += 1
                t = tasks[k]
                e.task_id = t.id
                retagged += 1
                assignments[(t.id, uid)] = None

            # Roster every author on the project; assign them to each task they
            # actually logged time on.
            for uid in authors:
                if (uid, pid) not in existing_roster:
                    db.add(UserProjectAccess(user_id=uid, project_id=pid))
                    existing_roster.add((uid, pid))
                    added_roster += 1
            for (task_id, uid) in assignments:
                if (task_id, uid) not in existing_assignee:
                    db.add(TaskAssignee(task_id=task_id, user_id=uid, tenant_id=tenant_id))
                    existing_assignee.add((task_id, uid))
                    added_assignee += 1

            await db.flush()

        await db.commit()
        print(f"projects {list(PROJECT_TASKS)}: +{created_tasks} tasks, "
              f"+{added_roster} roster, +{added_assignee} task-assignees, "
              f"re-tagged {retagged} approved entries to tasks.")
        print("done (additive).")


if __name__ == "__main__":
    asyncio.run(main())
