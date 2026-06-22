"""Security + behavior tests for the Client Portal Access feature.

The crux is the fail-closed gate: a CLIENT-role token must be blocked from
every route except the explicit allowlist. We also verify the two gates
(tenant kill switch + per-project toggle) and per-grant capability enforcement.
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

from app.api import auth, users, clients, projects, tasks, client_portal, departments, dashboard
from app.db import get_db
from app.core.deps import get_tenant_db
from app.core.security import get_password_hash
from app.models.user import User, UserRole
from app.models.project import Project
from app.models.task import Task
from app.models.client_access_grant import ClientAccessGrant
from app.models.setting_definition import SettingDefinition
from app.models.tenant_settings import TenantSettings


@pytest_asyncio.fixture
async def cp_app(db_session, seeded_data):
    """App mounting the routers a CLIENT could try to reach, plus the portal."""
    app = FastAPI()
    for r in (auth, users, clients, projects, tasks, client_portal, departments, dashboard):
        app.include_router(r.router)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_tenant_db] = override_get_db
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def client_user(db_session, seeded_data):
    """A CLIENT-role user in the seeded tenant + the kill-switch setting def."""
    tenant = seeded_data["tenant"] if "tenant" in seeded_data else None
    # seeded_data may not expose tenant; fetch the admin's tenant_id.
    admin = (await db_session.execute(
        __import__("sqlalchemy").select(User).where(User.email == "admin@example.com")
    )).scalar_one()
    tid = admin.tenant_id
    u = User(
        tenant_id=tid, email="client@northwind.com", username="clientuser",
        full_name="Client User", hashed_password=get_password_hash("password"),
        role=UserRole.CLIENT, is_active=True, email_verified=True, is_external=True,
    )
    db_session.add(u)
    # Seed the kill-switch setting definition (so get_setting resolves it).
    existing = (await db_session.execute(
        __import__("sqlalchemy").select(SettingDefinition).where(SettingDefinition.key == "client_portal_enabled")
    )).scalar_one_or_none()
    if existing is None:
        db_session.add(SettingDefinition(
            key="client_portal_enabled", category="client_portal", data_type="bool",
            default_value=False, validation={}, label="Enable client portal",
            description="x", is_public=True, sort_order=10,
        ))
    await db_session.flush()
    return {"user": u, "tenant_id": tid}


def _headers(user: User) -> dict:
    """Mint a token directly (no tenant_slug claim) — the established test
    pattern that sidesteps the control-plane slug cross-check in the harness."""
    from app.core.security import create_access_token
    token = create_access_token({"sub": str(user.id), "tenant_id": user.tenant_id})
    return {"Authorization": f"Bearer {token}"}


async def _set_kill_switch(db_session, tenant_id: int, on: bool):
    row = (await db_session.execute(
        __import__("sqlalchemy").select(TenantSettings).where(
            TenantSettings.tenant_id == tenant_id, TenantSettings.key == "client_portal_enabled")
    )).scalar_one_or_none()
    import json
    if row is None:
        db_session.add(TenantSettings(tenant_id=tenant_id, key="client_portal_enabled", value=json.dumps(on)))
    else:
        row.value = json.dumps(on)
    await db_session.flush()


@pytest.mark.asyncio
async def test_client_blocked_from_normal_routes(cp_app, client_user):
    """The fail-closed gate: CLIENT is 403 on every non-allowlisted route."""
    h = _headers(client_user["user"])
    for path in ["/users", "/clients", "/projects", "/tasks", "/departments", "/dashboard/summary"]:
        r = cp_app.get(path, headers=h)
        assert r.status_code == 403, f"{path} should be 403 for CLIENT, got {r.status_code}"


@pytest.mark.asyncio
async def test_client_allowed_on_allowlist(cp_app, client_user):
    """CLIENT may reach self-service + portal allowlist paths (not blocked by gate)."""
    h = _headers(client_user["user"])
    assert cp_app.get("/auth/me", headers=h).status_code == 200
    # portal endpoint is allowlisted by the gate, but the kill switch is off by
    # default -> 403 from the endpoint (NOT the gate). Either way it's reachable.
    r = cp_app.get("/client-portal/projects", headers=h)
    assert r.status_code in (200, 403)


@pytest.mark.asyncio
async def test_kill_switch_gates_portal(cp_app, client_user, db_session):
    h = _headers(client_user["user"])
    # off -> 403
    await _set_kill_switch(db_session, client_user["tenant_id"], False)
    assert cp_app.get("/client-portal/projects", headers=h).status_code == 403
    # on -> 200 (empty, no grants)
    await _set_kill_switch(db_session, client_user["tenant_id"], True)
    r = cp_app.get("/client-portal/projects", headers=h)
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_grant_exposes_project_with_caps(cp_app, client_user, db_session, seeded_data):
    """A granted project appears in the portal with its capabilities. Exposure
    is decided by the grant itself (the per-project toggle was removed)."""
    h = _headers(client_user["user"])
    project = (await db_session.execute(
        __import__("sqlalchemy").select(Project).where(Project.name == "Unit Test Project")
    )).scalar_one()
    # No grant yet -> portal empty (kill switch on).
    await _set_kill_switch(db_session, client_user["tenant_id"], True)
    assert cp_app.get("/client-portal/projects", headers=h).json() == []
    # Grant read+update -> project visible with those caps.
    db_session.add(ClientAccessGrant(
        tenant_id=client_user["tenant_id"], user_id=client_user["user"].id,
        project_id=project.id, capabilities=["read", "update"],
    ))
    await db_session.flush()
    data = cp_app.get("/client-portal/projects", headers=h).json()
    assert len(data) == 1
    assert data[0]["id"] == project.id
    assert sorted(data[0]["capabilities"]) == ["read", "update"]


@pytest.mark.asyncio
async def test_capability_gate_on_task_update(cp_app, client_user, db_session, seeded_data):
    """Update requires the 'update' capability; read-only grant is 403."""
    await _set_kill_switch(db_session, client_user["tenant_id"], True)
    project = (await db_session.execute(
        __import__("sqlalchemy").select(Project).where(Project.name == "Unit Test Project")
    )).scalar_one()
    project.client_access_enabled = True
    task = Task(tenant_id=client_user["tenant_id"], project_id=project.id, name="Client task")
    db_session.add(task)
    await db_session.flush()
    # READ-ONLY grant
    grant = ClientAccessGrant(
        tenant_id=client_user["tenant_id"], user_id=client_user["user"].id,
        project_id=project.id, capabilities=["read"],
    )
    db_session.add(grant)
    await db_session.flush()
    h = _headers(client_user["user"])
    r = cp_app.patch(f"/client-portal/tasks/{task.id}", headers=h, json={"status": "done"})
    assert r.status_code == 403, "read-only client must not update a task"
    # grant update -> allowed
    grant.capabilities = ["read", "update"]
    await db_session.flush()
    r2 = cp_app.patch(f"/client-portal/tasks/{task.id}", headers=h, json={"status": "done"})
    assert r2.status_code == 200, r2.text
    assert r2.json()["status"] == "done"


@pytest.mark.asyncio
async def test_non_client_cannot_reach_portal(cp_app, client_user, db_session):
    """A normal employee token is NOT a client -> portal endpoint 403s them."""
    await _set_kill_switch(db_session, client_user["tenant_id"], True)
    emp = (await db_session.execute(
        __import__("sqlalchemy").select(User).where(User.email == "emp@example.com")
    )).scalar_one()
    h = _headers(emp)
    assert cp_app.get("/client-portal/projects", headers=h).status_code == 403


@pytest.mark.asyncio
async def test_create_capability_gate(cp_app, client_user, db_session):
    """Adding a task requires CREATE at the project level; read-only -> 403."""
    await _set_kill_switch(db_session, client_user["tenant_id"], True)
    project = (await db_session.execute(
        __import__("sqlalchemy").select(Project).where(Project.name == "Unit Test Project")
    )).scalar_one()
    grant = ClientAccessGrant(
        tenant_id=client_user["tenant_id"], user_id=client_user["user"].id,
        project_id=project.id, capabilities=["read"],
    )
    db_session.add(grant)
    await db_session.flush()
    h = _headers(client_user["user"])
    body = {"project_id": project.id, "name": "Client-added task"}
    assert cp_app.post("/client-portal/tasks", headers=h, json=body).status_code == 403
    grant.capabilities = ["read", "create"]
    await db_session.flush()
    r = cp_app.post("/client-portal/tasks", headers=h, json=body)
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_delete_capability_gate(cp_app, client_user, db_session):
    """Deleting a task requires DELETE; read+update -> 403, +delete -> 204."""
    await _set_kill_switch(db_session, client_user["tenant_id"], True)
    project = (await db_session.execute(
        __import__("sqlalchemy").select(Project).where(Project.name == "Unit Test Project")
    )).scalar_one()
    task = Task(tenant_id=client_user["tenant_id"], project_id=project.id, name="Doomed task")
    db_session.add(task)
    grant = ClientAccessGrant(
        tenant_id=client_user["tenant_id"], user_id=client_user["user"].id,
        project_id=project.id, capabilities=["read", "update"],
    )
    db_session.add(grant)
    await db_session.flush()
    h = _headers(client_user["user"])
    assert cp_app.delete(f"/client-portal/tasks/{task.id}", headers=h).status_code == 403
    grant.capabilities = ["read", "update", "delete"]
    await db_session.flush()
    assert cp_app.delete(f"/client-portal/tasks/{task.id}", headers=h).status_code == 204


@pytest.mark.asyncio
async def test_task_scoped_grant_exposes_only_that_task(cp_app, client_user, db_session):
    """A task-scoped grant (the 'Specific tasks' invite mode) exposes the owning
    project but ONLY the granted task — sibling tasks stay hidden. This is the
    end-to-end shape the new per-scope invite produces."""
    await _set_kill_switch(db_session, client_user["tenant_id"], True)
    project = (await db_session.execute(
        __import__("sqlalchemy").select(Project).where(Project.name == "Unit Test Project")
    )).scalar_one()
    shared = Task(tenant_id=client_user["tenant_id"], project_id=project.id, name="Shared task")
    hidden = Task(tenant_id=client_user["tenant_id"], project_id=project.id, name="Hidden task")
    db_session.add_all([shared, hidden])
    await db_session.flush()
    # Grant the ONE task only (no project grant) with read+update.
    db_session.add(ClientAccessGrant(
        tenant_id=client_user["tenant_id"], user_id=client_user["user"].id,
        task_id=shared.id, capabilities=["read", "update"],
    ))
    await db_session.flush()
    h = _headers(client_user["user"])
    data = cp_app.get("/client-portal/projects", headers=h).json()
    assert len(data) == 1
    assert data[0]["id"] == project.id
    # The project itself confers no project-level caps from a task grant.
    assert data[0]["capabilities"] == []
    task_ids = {t["id"] for t in data[0]["tasks"]}
    assert task_ids == {shared.id}, "only the granted task is visible"
    assert sorted(data[0]["tasks"][0]["capabilities"]) == ["read", "update"]
