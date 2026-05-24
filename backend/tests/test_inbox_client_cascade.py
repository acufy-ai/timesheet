"""Cascade-to-user-record contract for inbox client assignment.

When the reviewer assigns a client on an inbox row (either explicitly via
PATCH /timesheets/{id}/data, or transitively via POST /clients/from-domain),
the same client must also land on the matched user's client_assignments so
the User Management page reflects it as that user's client of record.

This is the *add-only* contract: existing assignments are never removed,
and duplicates are no-ops. Consultants commonly bill multiple clients in
the same period, so the user.client_assignments list is plural - we add,
we never replace.

The endpoint-level wiring lives in app/api/ingestion.py and
app/api/clients.py and is exercised via the Docker-based integration
suite. Here we lock the CRUD-layer contract that those handlers depend
on. We use a self-contained db_session fixture so the project conftest
doesn't pull in models with JSONB columns that SQLite can't compile.
"""
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover - test shim
    return "JSON"


from app.core.security import get_password_hash
from app.crud.user_client_assignment import (
    add_assignment,
    get_assignments_for_user,
    remove_assignment,
)
from app.models.base import Base
from app.models.client import Client, ClientType
from app.models.tenant import Tenant, TenantStatus
from app.models.user import User, UserRole


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    db_file = tmp_path / "inbox_cascade.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_file}")

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )

    async with session_factory() as session:
        yield session

    await engine.dispose()


async def _seed_user_and_clients(
    db_session: AsyncSession, client_names: list[str]
) -> tuple[Tenant, User, list[Client]]:
    tenant = Tenant(name="Test", slug="test", status=TenantStatus.active)
    db_session.add(tenant)
    await db_session.flush()

    user = User(
        tenant=tenant,
        email="u@example.com",
        username="u",
        full_name="U",
        hashed_password=get_password_hash("x"),
        role=UserRole.EMPLOYEE,
        is_active=True,
    )
    clients = [
        Client(
            tenant_id=tenant.id,
            name=name,
            client_type=ClientType.external,
        )
        for name in client_names
    ]
    db_session.add(user)
    db_session.add_all(clients)
    await db_session.flush()
    return tenant, user, clients


@pytest.mark.asyncio
async def test_inbox_cascade_add_assignment_is_idempotent(db_session: AsyncSession):
    """Repeating add_assignment with the same (user, client) is a no-op.

    This is what makes the inbox cascade safe to call on every PATCH -
    the second click on the same row doesn't error or double-write.
    """
    tenant, user, (client,) = await _seed_user_and_clients(db_session, ["Acme"])
    # Snapshot IDs upfront. Once we commit between adds, instance state
    # expires and reading .id would trigger a lazy refresh, which
    # async-SQLAlchemy refuses to do outside a greenlet context.
    tenant_id, user_id, client_id = tenant.id, user.id, client.id

    first = await add_assignment(db_session, user_id=user_id, client_id=client_id, tenant_id=tenant_id)
    assert first is not None
    # Production callers commit between attempts. Mirror that so the
    # second add sees the row through the unique-constraint, not just
    # in the same transaction's pending changes.
    await db_session.commit()

    second = await add_assignment(db_session, user_id=user_id, client_id=client_id, tenant_id=tenant_id)
    # Idempotent contract: duplicate add returns None, original row stays.
    assert second is None

    assignments = await get_assignments_for_user(db_session, user_id, tenant_id)
    assert len(assignments) == 1
    assert assignments[0]["client_id"] == client_id


@pytest.mark.asyncio
async def test_inbox_cascade_supports_multi_client_user(db_session: AsyncSession):
    """One user can be assigned to N clients via repeated cascades.

    Consultants billing multiple clients in the same period rely on this:
    every inbox cascade ADDS, never replaces. The User Management Client
    field becomes a multi-value pill list backed by this state.
    """
    tenant, user, clients = await _seed_user_and_clients(db_session, ["A", "B", "C"])

    for client in clients:
        result = await add_assignment(
            db_session, user_id=user.id, client_id=client.id, tenant_id=tenant.id
        )
        assert result is not None, f"first-time add for {client.name} should succeed"

    names = sorted(row["client_name"] for row in await get_assignments_for_user(db_session, user.id, tenant.id))
    assert names == ["A", "B", "C"]


@pytest.mark.asyncio
async def test_inbox_cascade_does_not_remove_existing_assignments(db_session: AsyncSession):
    """Adding client B never wipes the user's existing client A.

    The cascade is intentionally additive: removing a client from a user
    requires an explicit X click on the pill in User Management, never a
    side-effect of inbox activity.
    """
    tenant, user, (client_a, client_b) = await _seed_user_and_clients(db_session, ["A", "B"])

    await add_assignment(db_session, user_id=user.id, client_id=client_a.id, tenant_id=tenant.id)
    await add_assignment(db_session, user_id=user.id, client_id=client_b.id, tenant_id=tenant.id)

    deleted = await remove_assignment(
        db_session, user_id=user.id, client_id=client_a.id, tenant_id=tenant.id
    )
    assert deleted is True

    remaining = await get_assignments_for_user(db_session, user.id, tenant.id)
    assert [row["client_name"] for row in remaining] == ["B"]
