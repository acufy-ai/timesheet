"""Regression: a MANAGER who is a client PM sees that client's project tasks
even when they are NOT on the project's roster (UserProjectAccess).

The bug: list_tasks_for_user filtered EVERY non-admin by their project roster.
A manager assigned as a client PM (UserClientAssignment role=pm) but not rostered
on a given project saw "No tasks yet" for that project, while a client-portal
user granted the same project DID see its tasks. The fix scopes the roster
filter to EMPLOYEE only; manager task visibility is governed by the /tasks
endpoint's visible_client_ids post-filter (matching list_projects_for_user)."""
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover - test shim
    return "JSON"

from app.api import auth, tasks
from app.db import get_db
from app.core.deps import get_tenant_db
from app.core.security import create_access_token
from app.models.user import User, UserRole
from app.models.project import Project
from app.models.task import Task
from app.models.assignments import UserProjectAccess
from app.models.user_client_assignment import UserClientAssignment, ClientAssignmentRole


@pytest_asyncio.fixture
async def task_app(db_session, seeded_data):
    app = FastAPI()
    for r in (auth, tasks):
        app.include_router(r.router)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_tenant_db] = override_get_db
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def _headers(user: User) -> dict:
    token = create_access_token({"sub": str(user.id), "tenant_id": user.tenant_id})
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_manager_pm_sees_tasks_on_unrostered_project(task_app, seeded_data, db_session):
    manager = seeded_data["manager"]
    client = seeded_data["client"]
    project = seeded_data["project"]            # "Unit Test Project"
    other = seeded_data["second_project"]       # "Restricted Project"

    # Manager is a PM on the CLIENT (so they can manage it on the Clients page),
    # but rostered only on the OTHER project — not on `project`.
    db_session.add(UserClientAssignment(
        tenant_id=manager.tenant_id, user_id=manager.id,
        client_id=client.id, assignment_role=ClientAssignmentRole.pm))
    db_session.add(UserProjectAccess(user_id=manager.id, project_id=other.id))
    task = Task(tenant_id=manager.tenant_id, project_id=project.id, name="Client-portal task")
    db_session.add(task)
    await db_session.flush()
    await db_session.commit()

    h = _headers(manager)
    r = task_app.get(f"/tasks?project_id={project.id}", headers=h)
    assert r.status_code == 200, r.text
    names = {t["name"] for t in r.json()}
    assert "Client-portal task" in names, "manager PM must see the unrostered project's task"


@pytest.mark.asyncio
async def test_manager_cannot_see_tasks_for_unmanaged_client(task_app, seeded_data, db_session):
    """The broadened visibility still respects client scope: a manager with NO
    PM assignment on the client sees none of its tasks (visible_client_ids gate)."""
    manager = seeded_data["manager"]
    project = seeded_data["project"]
    task = Task(tenant_id=manager.tenant_id, project_id=project.id, name="Hidden task")
    db_session.add(task)
    await db_session.flush()
    await db_session.commit()

    # No UserClientAssignment -> manager_pm_client_ids is empty -> sees nothing.
    h = _headers(manager)
    r = task_app.get(f"/tasks?project_id={project.id}", headers=h)
    assert r.status_code == 200, r.text
    assert r.json() == [], "manager with no client PM assignment sees no tasks"


@pytest.mark.asyncio
async def test_task_create_staffs_pmless_project(task_app, seeded_data, db_session):
    """Creating a task on a PM-less project as a MANAGER auto-assigns the acting
    manager as the project PM and adds the assignees to the project roster."""
    from app.crud.project import get_project_manager_ids, get_project_resource_ids
    manager = seeded_data["manager"]
    client = seeded_data["client"]
    project = seeded_data["project"]
    employee = seeded_data["employee"]  # reports to manager in the seed
    # Manager must be able to manage the client to reach the endpoint.
    db_session.add(UserClientAssignment(
        tenant_id=manager.tenant_id, user_id=manager.id,
        client_id=client.id, assignment_role=ClientAssignmentRole.pm))
    await db_session.flush()
    await db_session.commit()
    assert await get_project_manager_ids(db_session, project.id) == []

    h = _headers(manager)
    r = task_app.post("/tasks", headers=h, json={
        "project_id": project.id, "name": "Staffed task", "assignee_ids": [employee.id],
    })
    assert r.status_code == 201, r.text
    assert await get_project_manager_ids(db_session, project.id) == [manager.id]
    assert employee.id in await get_project_resource_ids(db_session, project.id)


@pytest.mark.asyncio
async def test_task_create_rejects_unmanaged_assignee_on_pmless_project(task_app, seeded_data, db_session):
    """A manager staffing a PM-less project may only assign people they manage;
    assigning someone outside their org subtree is 403."""
    manager = seeded_data["manager"]
    client = seeded_data["client"]
    project = seeded_data["project"]
    # senior_manager is ABOVE manager in the chain -> not assignable by manager.
    outsider = seeded_data["senior_manager"]
    db_session.add(UserClientAssignment(
        tenant_id=manager.tenant_id, user_id=manager.id,
        client_id=client.id, assignment_role=ClientAssignmentRole.pm))
    await db_session.flush()
    await db_session.commit()

    h = _headers(manager)
    r = task_app.post("/tasks", headers=h, json={
        "project_id": project.id, "name": "Bad task", "assignee_ids": [outsider.id],
    })
    assert r.status_code == 403, r.text
