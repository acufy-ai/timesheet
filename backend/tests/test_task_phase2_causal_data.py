"""Phase 2 task causal-data: estimate + dates (2/3), blocked status + reason (1),
and dependencies (4). Covers the capture paths and that the data is additive —
existing tasks with no estimate/due/blocker are treated as "unknown", and the
new fields round-trip through create/update/progress and the dependency graph.
"""
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
from app.models.user import User
from app.models.task import Task, TaskStatus
from app.models.assignments import TaskAssignee


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


# ── #2 + #3: estimate + dates ────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_create_task_with_estimate_and_dates(task_app, seeded_data):
    admin = seeded_data["admin"]
    project = seeded_data["project"]
    r = task_app.post("/tasks", headers=_headers(admin), json={
        "project_id": project.id, "name": "ETL pipeline",
        "estimated_hours": "14.00", "due_date": "2026-06-01",
        "start_date": "2026-05-01",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["estimated_hours"] == "14.00"
    assert body["due_date"] == "2026-06-01"
    assert body["start_date"] == "2026-05-01"


@pytest.mark.asyncio
async def test_update_can_clear_due_date(task_app, seeded_data, db_session):
    """An explicit null clears a date; an omitted field leaves it untouched."""
    admin = seeded_data["admin"]
    project = seeded_data["project"]
    task = Task(tenant_id=admin.tenant_id, project_id=project.id,
                name="Has due date", due_date=__import__("datetime").date(2026, 6, 1),
                estimated_hours=10)
    db_session.add(task)
    await db_session.commit()

    h = _headers(admin)
    # Omitting due_date leaves it; only name changes.
    r = task_app.put(f"/tasks/{task.id}", headers=h, json={"name": "Renamed"})
    assert r.status_code == 200, r.text
    assert r.json()["due_date"] == "2026-06-01"
    assert r.json()["estimated_hours"] == "10.00"

    # Explicit null clears it.
    r = task_app.put(f"/tasks/{task.id}", headers=h, json={"due_date": None})
    assert r.status_code == 200, r.text
    assert r.json()["due_date"] is None


# ── #1: blocked status + reason ──────────────────────────────────────────────
@pytest.mark.asyncio
async def test_blocked_status_is_valid(task_app, seeded_data):
    admin = seeded_data["admin"]
    project = seeded_data["project"]
    r = task_app.post("/tasks", headers=_headers(admin), json={
        "project_id": project.id, "name": "Blocked task",
        "status": "blocked", "blocked_reason": "Waiting on API contract",
    })
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "blocked"
    assert r.json()["blocked_reason"] == "Waiting on API contract"


@pytest.mark.asyncio
async def test_progress_sets_and_clears_blocked_reason(task_app, seeded_data, db_session):
    """An assignee can mark their task blocked with a reason; moving off blocked
    clears the now-stale reason."""
    employee = seeded_data["employee"]
    project = seeded_data["project"]
    task = Task(tenant_id=employee.tenant_id, project_id=project.id, name="Mine")
    db_session.add(task)
    await db_session.flush()
    db_session.add(TaskAssignee(task_id=task.id, user_id=employee.id, tenant_id=employee.tenant_id))
    await db_session.commit()

    h = _headers(employee)
    r = task_app.patch(f"/tasks/{task.id}/progress", headers=h, json={
        "status": "blocked", "blocked_reason": "Need DB credentials"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "blocked"
    assert r.json()["blocked_reason"] == "Need DB credentials"

    # Moving to in_progress (without sending a reason) clears the stale reason.
    r = task_app.patch(f"/tasks/{task.id}/progress", headers=h, json={"status": "in_progress"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "in_progress"
    assert r.json()["blocked_reason"] is None


# ── #4: dependencies ─────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_dependency_create_list_and_cycle_rejected(task_app, seeded_data, db_session):
    admin = seeded_data["admin"]
    project = seeded_data["project"]
    a = Task(tenant_id=admin.tenant_id, project_id=project.id, name="ETL pipeline")
    b = Task(tenant_id=admin.tenant_id, project_id=project.id, name="Integration testing")
    db_session.add_all([a, b])
    await db_session.commit()

    h = _headers(admin)
    # b depends on a (a blocks b).
    r = task_app.post("/tasks/dependencies", headers=h, json={
        "task_id": b.id, "depends_on_task_id": a.id, "reason": "needs ETL output"})
    assert r.status_code == 201, r.text
    assert r.json()["depends_on_task_name"] == "ETL pipeline"

    # The reverse edge (a depends on b) would create a cycle -> 400.
    r = task_app.post("/tasks/dependencies", headers=h, json={
        "task_id": a.id, "depends_on_task_id": b.id})
    assert r.status_code == 400, r.text
    assert "cycle" in r.json()["detail"].lower()

    # Self-edge rejected.
    r = task_app.post("/tasks/dependencies", headers=h, json={
        "task_id": a.id, "depends_on_task_id": a.id})
    assert r.status_code == 400, r.text

    # List shows the one valid edge.
    r = task_app.get(f"/tasks/dependencies/project/{project.id}", headers=h)
    assert r.status_code == 200, r.text
    edges = r.json()
    assert len(edges) == 1
    assert edges[0]["task_name"] == "Integration testing"


@pytest.mark.asyncio
async def test_dependency_cross_project_rejected(task_app, seeded_data, db_session):
    admin = seeded_data["admin"]
    p1 = seeded_data["project"]
    p2 = seeded_data["second_project"]
    a = Task(tenant_id=admin.tenant_id, project_id=p1.id, name="A")
    b = Task(tenant_id=admin.tenant_id, project_id=p2.id, name="B")
    db_session.add_all([a, b])
    await db_session.commit()

    r = task_app.post("/tasks/dependencies", headers=_headers(admin), json={
        "task_id": a.id, "depends_on_task_id": b.id})
    assert r.status_code == 400, r.text
    assert "same project" in r.json()["detail"].lower()
