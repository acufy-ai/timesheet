"""CRUD + graph helpers for task dependencies (Phase 2, part 4).

An edge ``(task_id -> depends_on_task_id)`` means depends_on_task_id BLOCKS
task_id (predecessor must finish first). Edges live within a single project. The
create path validates both tasks belong to the same project and rejects cycles
so the blocking graph stays a DAG (needed for safe traversal in the health
"why").
"""
from typing import Optional

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import Task
from app.models.task_dependency import TaskDependency


async def list_dependencies_for_project(
    db: AsyncSession, project_id: int, tenant_id: int
) -> list[TaskDependency]:
    """All dependency edges whose dependent task is in this project."""
    rows = (await db.execute(
        select(TaskDependency)
        .join(Task, Task.id == TaskDependency.task_id)
        .where(Task.project_id == project_id, TaskDependency.tenant_id == tenant_id)
    )).scalars().all()
    return list(rows)


async def _would_create_cycle(
    db: AsyncSession, task_id: int, depends_on_task_id: int
) -> bool:
    """True if adding (task_id -> depends_on_task_id) introduces a cycle.

    A cycle forms iff task_id is already reachable FROM depends_on_task_id by
    following existing dependency edges (predecessor links). We walk the
    predecessor graph starting at depends_on_task_id and look for task_id.
    """
    # Adjacency: for each task, the tasks it depends on (its predecessors).
    edges = (await db.execute(
        select(TaskDependency.task_id, TaskDependency.depends_on_task_id)
    )).all()
    preds: dict[int, list[int]] = {}
    for t, dep in edges:
        preds.setdefault(t, []).append(dep)

    # DFS from depends_on_task_id over predecessor edges; if we reach task_id the
    # new edge closes a loop.
    seen: set[int] = set()
    stack = [depends_on_task_id]
    while stack:
        node = stack.pop()
        if node == task_id:
            return True
        if node in seen:
            continue
        seen.add(node)
        stack.extend(preds.get(node, []))
    return False


async def create_dependency(
    db: AsyncSession,
    tenant_id: int,
    task_id: int,
    depends_on_task_id: int,
    reason: Optional[str] = None,
) -> TaskDependency:
    """Create a dependency edge. Raises ValueError on a bad request (self-edge,
    cross-project, unknown task, duplicate, or cycle)."""
    if task_id == depends_on_task_id:
        raise ValueError("A task cannot depend on itself.")

    tasks = {
        t.id: t
        for t in (await db.execute(
            select(Task).where(
                Task.id.in_([task_id, depends_on_task_id]),
                Task.tenant_id == tenant_id,
            )
        )).scalars().all()
    }
    if task_id not in tasks or depends_on_task_id not in tasks:
        raise ValueError("Both tasks must exist in this workspace.")
    if tasks[task_id].project_id != tasks[depends_on_task_id].project_id:
        raise ValueError("Dependencies can only link tasks in the same project.")

    existing = (await db.execute(
        select(TaskDependency).where(
            and_(
                TaskDependency.task_id == task_id,
                TaskDependency.depends_on_task_id == depends_on_task_id,
            )
        )
    )).scalars().first()
    if existing is not None:
        raise ValueError("That dependency already exists.")

    if await _would_create_cycle(db, task_id, depends_on_task_id):
        raise ValueError("That dependency would create a cycle.")

    dep = TaskDependency(
        tenant_id=tenant_id,
        task_id=task_id,
        depends_on_task_id=depends_on_task_id,
        reason=(reason.strip() or None) if reason else None,
    )
    db.add(dep)
    await db.commit()
    await db.refresh(dep)
    return dep


async def delete_dependency(
    db: AsyncSession, dependency_id: int, tenant_id: int
) -> bool:
    dep = (await db.execute(
        select(TaskDependency).where(
            TaskDependency.id == dependency_id,
            TaskDependency.tenant_id == tenant_id,
        )
    )).scalars().first()
    if dep is None:
        return False
    await db.delete(dep)
    await db.commit()
    return True
