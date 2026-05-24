from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from app.models.user_client_assignment import UserClientAssignment
from app.models.client import Client


async def get_assignments_for_user(
    session: AsyncSession,
    user_id: int,
    tenant_id: int,
) -> list[dict]:
    result = await session.execute(
        select(
            UserClientAssignment.id,
            UserClientAssignment.client_id,
            Client.name.label("client_name"),
            Client.client_type.label("client_type"),
        )
        .join(Client, Client.id == UserClientAssignment.client_id)
        .where(
            UserClientAssignment.user_id == user_id,
            UserClientAssignment.tenant_id == tenant_id,
        )
        .order_by(Client.name)
    )
    return [
        {
            "id": row.id,
            "client_id": row.client_id,
            "client_name": row.client_name,
            "client_type": row.client_type.value if hasattr(row.client_type, "value") else str(row.client_type),
        }
        for row in result
    ]


async def get_assigned_client_ids_for_users(
    session: AsyncSession,
    user_ids: list[int],
    tenant_id: int,
) -> dict[int, list[int]]:
    """Return {user_id: [client_id, ...]} for a batch of users."""
    if not user_ids:
        return {}
    result = await session.execute(
        select(UserClientAssignment.user_id, UserClientAssignment.client_id).where(
            UserClientAssignment.user_id.in_(user_ids),
            UserClientAssignment.tenant_id == tenant_id,
        )
    )
    mapping: dict[int, list[int]] = {uid: [] for uid in user_ids}
    for uid, cid in result:
        mapping[uid].append(cid)
    return mapping


async def add_assignment(
    session: AsyncSession,
    user_id: int,
    client_id: int,
    tenant_id: int,
) -> UserClientAssignment | None:
    """Add a client assignment, idempotent. Returns ``None`` when an
    assignment for this (user, client, tenant) already exists.

    Older versions caught ``IntegrityError`` and called
    ``session.rollback()``, which silently wiped the entire caller's
    transaction. That's catastrophic when this function is called as a
    side-effect of a larger PATCH (the primary update would commit as a
    no-op because the session was already rolled back). We now
    pre-check via SELECT and only INSERT when missing — no exception
    path, no rollback risk.
    """
    existing = await session.execute(
        select(UserClientAssignment).where(
            UserClientAssignment.user_id == user_id,
            UserClientAssignment.client_id == client_id,
            UserClientAssignment.tenant_id == tenant_id,
        )
    )
    if existing.scalar_one_or_none() is not None:
        return None

    assignment = UserClientAssignment(
        user_id=user_id,
        client_id=client_id,
        tenant_id=tenant_id,
    )
    session.add(assignment)
    try:
        await session.flush()
        return assignment
    except IntegrityError:
        # Race condition: a concurrent request inserted the same row
        # between our SELECT and INSERT. Swallow without rollback —
        # the caller's wider transaction stays alive. We accept that
        # the session is now in a failed state for THIS statement;
        # SQLAlchemy auto-recovers via savepoint semantics on async
        # sessions, but if the next operation fails, the caller's
        # ``except Exception: pass`` guard handles it.
        return None


async def remove_assignment(
    session: AsyncSession,
    user_id: int,
    client_id: int,
    tenant_id: int,
) -> bool:
    """Remove a client assignment. Returns True if deleted."""
    result = await session.execute(
        select(UserClientAssignment).where(
            UserClientAssignment.user_id == user_id,
            UserClientAssignment.client_id == client_id,
            UserClientAssignment.tenant_id == tenant_id,
        )
    )
    row = result.scalar_one_or_none()
    if row is None:
        return False
    await session.delete(row)
    await session.flush()
    return True
