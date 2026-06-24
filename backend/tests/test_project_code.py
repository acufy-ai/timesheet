"""Auto project code (PR####): sequential, count-aware, collision-safe.

next_project_code returns max(highest PR#### suffix, project count) + 1, padded
to 4 digits. create_project auto-fills it when the caller sends a blank code,
and respects a code the caller did send."""
import pytest
import pytest_asyncio
from decimal import Decimal
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover - test shim
    return "JSON"

from app.models.project import Project
from app.crud.project import next_project_code, create_project
from app.schemas import ProjectCreate


@pytest.mark.asyncio
async def test_next_code_is_count_aware(db_session, seeded_data):
    """Seed has 2 projects (no PR codes) -> floor is the count -> PR0003."""
    tid = seeded_data["tenant"].id
    code = await next_project_code(db_session, tid)
    assert code == "PR0003"


@pytest.mark.asyncio
async def test_next_code_beats_highest_suffix(db_session, seeded_data):
    """A high PR#### suffix wins over the count, and never collides with it."""
    tid = seeded_data["tenant"].id
    db_session.add(Project(
        tenant_id=tid, name="Coded", code="PR0041",
        client_id=seeded_data["client"].id, billable_rate=Decimal("10")))
    await db_session.flush()
    assert await next_project_code(db_session, tid) == "PR0042"


@pytest.mark.asyncio
async def test_create_autofills_blank_code(db_session, seeded_data):
    tid = seeded_data["tenant"].id
    client = seeded_data["client"]
    p = await create_project(db_session, ProjectCreate(
        name="No code project", client_id=client.id, billable_rate=Decimal("100")), tenant_id=tid)
    assert p.code and p.code.startswith("PR") and p.code[2:].isdigit()


@pytest.mark.asyncio
async def test_create_respects_supplied_code(db_session, seeded_data):
    tid = seeded_data["tenant"].id
    client = seeded_data["client"]
    p = await create_project(db_session, ProjectCreate(
        name="Custom code", client_id=client.id, billable_rate=Decimal("100"), code="WEB"), tenant_id=tid)
    assert p.code == "WEB"
