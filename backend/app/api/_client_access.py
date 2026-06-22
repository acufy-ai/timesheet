"""Shared access policy for the Client Management surface.

ADMIN / PLATFORM_ADMIN: full access to all clients in the tenant.
MANAGER: access only to clients they are a PM on (UserClientAssignment with
assignment_role='pm'). Reads are scoped to that set; writes require the target
client to be in it. A manager who creates a client is auto-added as its PM.
Other roles: no access.
"""
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User, UserRole
from app.models.user_client_assignment import UserClientAssignment, ClientAssignmentRole

ADMIN_ROLES = (UserRole.ADMIN, UserRole.PLATFORM_ADMIN)


def is_admin(user: User) -> bool:
    return user.role in ADMIN_ROLES


def require_client_manager(user: User) -> None:
    """Gate the surface: admin or manager only."""
    if user.role in ADMIN_ROLES or user.role == UserRole.MANAGER:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Client management requires an admin or manager role.",
    )


async def manager_pm_client_ids(db: AsyncSession, user: User) -> set[int]:
    """Client ids where this user is an assigned PM (their manageable set)."""
    rows = await db.execute(
        select(UserClientAssignment.client_id)
        .where(UserClientAssignment.user_id == user.id)
        .where(UserClientAssignment.tenant_id == user.tenant_id)
        .where(UserClientAssignment.assignment_role == ClientAssignmentRole.pm)
    )
    return set(rows.scalars().all())


async def visible_client_ids(db: AsyncSession, user: User) -> Optional[set[int]]:
    """The set of client ids the user may see. None = all (admins)."""
    if is_admin(user):
        return None
    return await manager_pm_client_ids(db, user)


async def assert_client_access(db: AsyncSession, user: User, client_id: int) -> None:
    """Raise 403 unless the user may manage this client."""
    if is_admin(user):
        return
    if user.role == UserRole.MANAGER:
        pm_ids = await manager_pm_client_ids(db, user)
        if client_id in pm_ids:
            return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="You can only manage clients you are a project manager on.",
    )


async def add_creator_as_pm(db: AsyncSession, user: User, client_id: int) -> None:
    """Auto-assign a manager who created a client as its PM so they retain
    access. No-op for admins (they see everything anyway) and if already set."""
    if user.role != UserRole.MANAGER:
        return
    existing = await db.execute(
        select(UserClientAssignment).where(
            UserClientAssignment.user_id == user.id,
            UserClientAssignment.client_id == client_id,
        )
    )
    row = existing.scalars().first()
    if row is None:
        db.add(UserClientAssignment(
            tenant_id=user.tenant_id, user_id=user.id, client_id=client_id,
            assignment_role=ClientAssignmentRole.pm))
    elif row.assignment_role != ClientAssignmentRole.pm:
        row.assignment_role = ClientAssignmentRole.pm
        db.add(row)
    await db.commit()
