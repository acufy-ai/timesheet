"""Widget scoping for the configurable Insights dashboards.

A custom-dashboard widget can be scoped to a client, a project, a task, and/or a
resource (a person). The metric endpoints normally compute over the manager's
whole team/portfolio; a scope narrows that.

This module centralizes scope parsing + access resolution so every metric
endpoint applies it the same way and through the SAME access guards
(`_get_scoped_employee_ids`, `_filter_managed_project_ids`). A scope can never
widen a caller's reach: it can only intersect what they're already allowed to
see. An out-of-scope id resolves to "nothing", not an error, so a stale widget
just shows an empty state.

Resource scope has two modes (user choice):
  - 'contribution': only that person's own entries count (their hours/revenue).
  - 'projects':     the whole metric, filtered to projects that person works on.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from fastapi import Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, get_tenant_db
from app.models.user import User


@dataclass
class DashboardScope:
    """Raw scope as requested by a widget (query params).

    client_ids + project_ids are UNIONED: a widget scoped to client A plus
    project X consolidates every project under A together with project X. This
    is what powers "all projects of a client" and "these specific projects
    combined" in one metric. task_id stays single (a task-scoped widget is
    inherently one task) and pins its parent project.
    """
    client_ids: list[int] = field(default_factory=list)
    project_ids: list[int] = field(default_factory=list)
    task_id: Optional[int] = None
    user_id: Optional[int] = None
    # How a resource (user_id) scope is interpreted. See module docstring.
    resource_mode: str = "contribution"

    @property
    def is_empty(self) -> bool:
        return not (self.client_ids or self.project_ids or self.task_id or self.user_id)


@dataclass
class ResolvedScope:
    """Scope after access resolution. `None` means 'no restriction on this axis'.

    - project_ids: the projects the scope limits to (already intersected with
      what the caller manages). None = all the caller's managed projects.
    - user_ids: the people whose entries count. None = the caller's full team.
    - task_id: a single task to filter entries to, or None.
    - empty: True when the scope resolves to nothing the caller may see, so the
      endpoint should return its empty result rather than the whole portfolio.
    """
    project_ids: Optional[list[int]] = None
    user_ids: Optional[list[int]] = None
    task_id: Optional[int] = None
    empty: bool = False


def _csv_ints(raw: Optional[str]) -> list[int]:
    """Parse a comma-separated id list (e.g. '1,4,7') into ints, ignoring junk."""
    if not raw:
        return []
    out: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if part:
            try:
                out.append(int(part))
            except ValueError:
                pass
    return out


def get_dashboard_scope(
    # Lists are passed comma-separated (scope_client_ids=1,4). The singular
    # scope_client_id / scope_project_id are kept for back-compat with widgets
    # saved before multi-select and are merged in.
    scope_client_ids: Optional[str] = Query(None),
    scope_project_ids: Optional[str] = Query(None),
    scope_client_id: Optional[int] = Query(None),
    scope_project_id: Optional[int] = Query(None),
    scope_task_id: Optional[int] = Query(None),
    scope_user_id: Optional[int] = Query(None),
    scope_resource_mode: str = Query("contribution", pattern="^(contribution|projects)$"),
) -> DashboardScope:
    clients = _csv_ints(scope_client_ids)
    if scope_client_id is not None:
        clients.append(scope_client_id)
    projects = _csv_ints(scope_project_ids)
    if scope_project_id is not None:
        projects.append(scope_project_id)
    return DashboardScope(
        client_ids=sorted(set(clients)), project_ids=sorted(set(projects)),
        task_id=scope_task_id, user_id=scope_user_id,
        resource_mode=scope_resource_mode,
    )


async def resolve_scope(
    db: AsyncSession, current_user: User, scope: DashboardScope,
) -> ResolvedScope:
    """Turn a requested scope into project/user/task filters, access-checked.

    Every id is intersected with what the caller may already see. The caller's
    base reach (managed projects, scoped employees) is computed by the same
    helpers the endpoints use, so this never grants extra visibility.
    """
    if scope.is_empty:
        return ResolvedScope()

    # Imported here to avoid a circular import (dashboard.py imports this module).
    from app.api.dashboard import _get_scoped_employee_ids, _filter_managed_project_ids
    from app.models.project import Project
    from app.models.task import Task

    tenant_id = current_user.tenant_id
    team_ids = set(await _get_scoped_employee_ids(db, current_user))

    # ── Project axis: UNION of (all selected clients' projects) and (explicitly
    # selected projects). project_ids stays None only when neither was set.
    project_ids: Optional[set[int]] = None
    if scope.client_ids:
        rows = (await db.execute(
            select(Project.id).where(
                Project.client_id.in_(scope.client_ids), Project.tenant_id == tenant_id,
            )
        )).scalars().all()
        project_ids = set(rows)
    if scope.project_ids:
        project_ids = (project_ids or set()) | set(scope.project_ids)

    # A task pins its parent project too (intersection: a task-scoped widget is
    # one task within one project).
    task_id: Optional[int] = None
    if scope.task_id is not None:
        task = (await db.execute(
            select(Task).where(Task.id == scope.task_id, Task.tenant_id == tenant_id)
        )).scalar_one_or_none()
        if task is None:
            return ResolvedScope(empty=True)
        task_id = task.id
        project_ids = (project_ids & {task.project_id}) if project_ids is not None else {task.project_id}

    # Intersect the project set with what the caller actually manages.
    if project_ids is not None:
        managed = set(await _filter_managed_project_ids(db, list(project_ids), tenant_id))
        project_ids &= managed
        if not project_ids:
            return ResolvedScope(empty=True)

    # ── Resource axis.
    user_ids: Optional[set[int]] = None
    if scope.user_id is not None:
        if scope.user_id not in team_ids:
            # The person isn't in the caller's team scope -> nothing to show.
            return ResolvedScope(empty=True)
        if scope.resource_mode == "contribution":
            # Only this person's own entries count.
            user_ids = {scope.user_id}
        else:
            # 'projects' mode: widen the project set to the projects this person
            # works on (still inside the caller's managed set), keep the whole
            # team's entries on those projects.
            person_projects = await _projects_for_user(db, scope.user_id, tenant_id)
            person_projects = set(await _filter_managed_project_ids(db, list(person_projects), tenant_id))
            project_ids = (project_ids & person_projects) if project_ids is not None else person_projects
            if not project_ids:
                return ResolvedScope(empty=True)

    return ResolvedScope(
        project_ids=sorted(project_ids) if project_ids is not None else None,
        user_ids=sorted(user_ids) if user_ids is not None else None,
        task_id=task_id,
    )


async def _projects_for_user(db: AsyncSession, user_id: int, tenant_id: int) -> set[int]:
    """Projects a person works on: anything they have approved time on, plus any
    project they're rostered to (UserProjectAccess)."""
    from app.models.time_entry import TimeEntry
    from app.models.assignments import UserProjectAccess

    from_entries = set((await db.execute(
        select(TimeEntry.project_id).where(
            TimeEntry.user_id == user_id, TimeEntry.tenant_id == tenant_id,
        ).distinct()
    )).scalars().all())
    from_roster = set((await db.execute(
        select(UserProjectAccess.project_id).where(UserProjectAccess.user_id == user_id).distinct()
    )).scalars().all())
    return {p for p in (from_entries | from_roster) if p is not None}
