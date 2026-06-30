"""Resource allocation (PSA capacity planning) management.

The WRITE side of the Resourcing view: managers/admins allocate a person to a
project over a date window at an intensity (percent of weekly capacity OR
hours/week). The read side (utilization %, over/under-capacity) lives in
dashboard.py's /team-resourcing and the resource detail endpoint.

    GET    /resource-allocations?user_id=    — list a person's allocations
    POST   /resource-allocations             — create
    PUT    /resource-allocations/{id}         — edit
    DELETE /resource-allocations/{id}         — remove
    POST   /resource-allocations/preview      — compute resulting % for a draft,
                                                so the UI can warn before saving

Manager/Admin only (VIEWER is read-only). Every row is tenant-scoped, and a
manager may only allocate people within their own team scope.
"""
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, get_tenant_db
from app.models.user import User, UserRole
from app.models.project import Project
from app.models.resource_allocation import ResourceAllocation
from app.schemas import (
    ResourceAllocationCreate,
    ResourceAllocationUpdate,
    ResourceAllocationResponse,
)

router = APIRouter(prefix="/resource-allocations", tags=["resource-allocations"])

_WRITE_ROLES = (UserRole.MANAGER, UserRole.ADMIN, UserRole.PLATFORM_ADMIN)
DEFAULT_CAP = Decimal("40")


def _require_write(user: User) -> None:
    if user.role not in _WRITE_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only managers and admins can manage allocations.",
        )


async def _scoped_user_ids(db: AsyncSession, user: User) -> Optional[set[int]]:
    """The user ids a caller may allocate. None = unrestricted (admin/PA).
    A manager is limited to their report chain."""
    if user.role in (UserRole.ADMIN, UserRole.PLATFORM_ADMIN):
        return None
    from app.api.dashboard import _get_scoped_employee_ids
    ids = await _get_scoped_employee_ids(db, user)
    return set(ids)


async def _assert_can_allocate(db: AsyncSession, user: User, target_user_id: int, project_id: int) -> None:
    scoped = await _scoped_user_ids(db, user)
    if scoped is not None and target_user_id not in scoped:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="That person isn't in your team.")
    # Project must exist in this tenant.
    proj = await db.get(Project, project_id)
    if proj is None or proj.tenant_id != user.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")


async def _to_response(db: AsyncSession, a: ResourceAllocation) -> ResourceAllocationResponse:
    u = await db.get(User, a.user_id)
    p = await db.get(Project, a.project_id)
    return ResourceAllocationResponse(
        id=a.id, user_id=a.user_id, user_name=u.full_name if u else None,
        project_id=a.project_id, project_name=p.name if p else None,
        start_date=a.start_date, end_date=a.end_date,
        percent=a.percent, hours_per_week=a.hours_per_week, role=a.role, notes=a.notes,
    )


@router.get("", response_model=list[ResourceAllocationResponse])
async def list_allocations(
    user_id: Optional[int] = Query(None),
    project_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """List allocations, optionally filtered to one person or project. Readable by
    manager/viewer/admin; a manager only sees their team's."""
    if current_user.role not in (UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN, UserRole.PLATFORM_ADMIN):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not available for your role.")
    where = [ResourceAllocation.tenant_id == current_user.tenant_id]
    if user_id is not None:
        where.append(ResourceAllocation.user_id == user_id)
    if project_id is not None:
        where.append(ResourceAllocation.project_id == project_id)
    # A manager is scoped to their team.
    scoped = await _scoped_user_ids(db, current_user)
    rows = (await db.execute(
        select(ResourceAllocation).where(*where).order_by(ResourceAllocation.start_date.desc())
    )).scalars().all()
    if scoped is not None:
        rows = [r for r in rows if r.user_id in scoped]
    return [await _to_response(db, r) for r in rows]


@router.post("", response_model=ResourceAllocationResponse, status_code=status.HTTP_201_CREATED)
async def create_allocation(
    payload: ResourceAllocationCreate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _require_write(current_user)
    await _assert_can_allocate(db, current_user, payload.user_id, payload.project_id)
    a = ResourceAllocation(
        tenant_id=current_user.tenant_id,
        user_id=payload.user_id, project_id=payload.project_id,
        start_date=payload.start_date, end_date=payload.end_date,
        percent=payload.percent, hours_per_week=payload.hours_per_week,
        role=payload.role, notes=payload.notes,
    )
    db.add(a)
    await db.commit()
    await db.refresh(a)
    return await _to_response(db, a)


@router.put("/{alloc_id}", response_model=ResourceAllocationResponse)
async def update_allocation(
    alloc_id: int,
    payload: ResourceAllocationUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _require_write(current_user)
    a = await db.get(ResourceAllocation, alloc_id)
    if a is None or a.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Allocation not found.")
    await _assert_can_allocate(db, current_user, a.user_id, payload.project_id or a.project_id)
    data = payload.model_dump(exclude_unset=True)
    # Intensity is one-of: setting percent clears hours, and vice versa.
    if "percent" in data and data["percent"] is not None:
        a.hours_per_week = None
    if "hours_per_week" in data and data["hours_per_week"] is not None:
        a.percent = None
    for field, value in data.items():
        setattr(a, field, value)
    # Re-validate date order after applying.
    if a.end_date < a.start_date:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="end_date cannot be before start_date")
    db.add(a)
    await db.commit()
    await db.refresh(a)
    return await _to_response(db, a)


@router.delete("/{alloc_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_allocation(
    alloc_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    _require_write(current_user)
    a = await db.get(ResourceAllocation, alloc_id)
    if a is None or a.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Allocation not found.")
    await db.delete(a)
    await db.commit()


@router.post("/preview")
async def preview_allocation(
    payload: ResourceAllocationCreate,
    exclude_id: Optional[int] = Query(None, description="An existing allocation to exclude (when editing)"),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Compute the resulting allocation % for a person if this draft were saved,
    over the standard 8-week window — so the UI can warn 'this puts them at X%'
    BEFORE saving. Does not write anything."""
    _require_write(current_user)
    await _assert_can_allocate(db, current_user, payload.user_id, payload.project_id)
    from app.api.dashboard import compute_capacity

    user = await db.get(User, payload.user_id)
    cap = (user.weekly_capacity_hours if user and user.weekly_capacity_hours else DEFAULT_CAP) or DEFAULT_CAP
    today = date.today()
    window_end = today + timedelta(weeks=8)

    # Existing allocations in the window (excluding the one being edited), plus
    # the draft, run through the same capacity math the resourcing view uses.
    existing = (await db.execute(
        select(ResourceAllocation).where(
            ResourceAllocation.user_id == payload.user_id,
            ResourceAllocation.tenant_id == current_user.tenant_id,
            ResourceAllocation.start_date <= window_end,
            ResourceAllocation.end_date >= today,
        )
    )).scalars().all()
    allocs = [a for a in existing if exclude_id is None or a.id != exclude_id]
    # A lightweight stand-in for the draft (compute_capacity reads the same attrs).
    draft = ResourceAllocation(
        user_id=payload.user_id, project_id=payload.project_id,
        start_date=payload.start_date, end_date=payload.end_date,
        percent=payload.percent, hours_per_week=payload.hours_per_week,
    )
    before = compute_capacity(allocs, cap, today, window_end)
    after = compute_capacity(allocs + [draft], cap, today, window_end)
    return {
        "weekly_capacity_hours": int(cap),
        "before_pct": before["allocated_pct"],
        "after_pct": after["allocated_pct"],
        "after_state": after["state"],
    }
