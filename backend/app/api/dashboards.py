"""Configurable Insights dashboards — tenant-scoped CRUD.

A user builds a dashboard (name + widget layout) in the Insights tab. They own
it (edit/delete); they can share it read-only to the whole tenant. Listing
returns the caller's own dashboards plus every shared one in the tenant.

Distinct from the fixed manager-dashboard tiles in `app/api/dashboard.py` (no
'-s'): this is the user-built, saveable, shareable surface.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dashboards_public import compute_dashboard_data, make_share_token
from app.core.deps import get_current_user, get_tenant_db
from app.db_tenant import resolve_slug_for_tenant_id
from app.models.dashboard import CustomDashboard
from app.models.user import User, UserRole
from app.schemas import (
    CustomDashboardCreate, CustomDashboardResponse, CustomDashboardUpdate,
    DashboardShareRequest, DashboardShareResponse,
)

router = APIRouter(prefix="/dashboards", tags=["custom-dashboards"])

# Roles allowed to CREATE/own a dashboard. Everyone can VIEW shared ones.
_CREATOR_ROLES = {UserRole.MANAGER, UserRole.VIEWER, UserRole.ADMIN}


def _to_response(row: CustomDashboard, current_user: User, owner_name: str | None) -> dict:
    is_owner = row.owner_user_id == current_user.id
    return {
        "id": row.id, "name": row.name, "is_shared": row.is_shared,
        "owner_user_id": row.owner_user_id, "owner_name": owner_name,
        "is_owner": is_owner,
        "layout": row.layout or [],
        # Only the owner sees the share token (it's a capability secret).
        "share_token": row.share_token if is_owner else None,
        "share_mode": row.share_mode or "live",
        "share_snapshot_at": row.share_created_at if is_owner else None,
        "created_at": row.created_at, "updated_at": row.updated_at,
    }


async def _owner_names(db: AsyncSession, rows: list[CustomDashboard]) -> dict[int, str]:
    ids = {r.owner_user_id for r in rows if r.owner_user_id is not None}
    if not ids:
        return {}
    return {
        uid: name for uid, name in (await db.execute(
            select(User.id, User.full_name).where(User.id.in_(list(ids)))
        )).all()
    }


@router.get("", response_model=list[CustomDashboardResponse])
async def list_dashboards(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """The caller's own dashboards + every shared dashboard in the tenant."""
    rows = (await db.execute(
        select(CustomDashboard)
        .where(
            CustomDashboard.tenant_id == current_user.tenant_id,
            or_(CustomDashboard.owner_user_id == current_user.id, CustomDashboard.is_shared.is_(True)),
        )
        .order_by(CustomDashboard.name.asc())
    )).scalars().all()
    names = await _owner_names(db, rows)
    return [_to_response(r, current_user, names.get(r.owner_user_id)) for r in rows]


@router.post("", response_model=CustomDashboardResponse, status_code=status.HTTP_201_CREATED)
async def create_dashboard(
    payload: CustomDashboardCreate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role not in _CREATOR_ROLES:
        raise HTTPException(status_code=403, detail="Your role can't create dashboards.")
    row = CustomDashboard(
        tenant_id=current_user.tenant_id, owner_user_id=current_user.id,
        name=payload.name, is_shared=payload.is_shared, layout=payload.layout or [],
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _to_response(row, current_user, current_user.full_name)


async def _get_visible(db: AsyncSession, dash_id: int, current_user: User) -> CustomDashboard:
    row = (await db.execute(
        select(CustomDashboard).where(
            CustomDashboard.id == dash_id,
            CustomDashboard.tenant_id == current_user.tenant_id,
        )
    )).scalar_one_or_none()
    if row is None or not (row.owner_user_id == current_user.id or row.is_shared):
        raise HTTPException(status_code=404, detail="Dashboard not found")
    return row


@router.get("/{dash_id}", response_model=CustomDashboardResponse)
async def get_dashboard(
    dash_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    row = await _get_visible(db, dash_id, current_user)
    names = await _owner_names(db, [row])
    return _to_response(row, current_user, names.get(row.owner_user_id))


@router.put("/{dash_id}", response_model=CustomDashboardResponse)
async def update_dashboard(
    dash_id: int, payload: CustomDashboardUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    row = await _get_visible(db, dash_id, current_user)
    if row.owner_user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the owner can edit this dashboard.")
    sent = payload.model_dump(exclude_unset=True)
    for field, value in sent.items():
        setattr(row, field, value)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _to_response(row, current_user, current_user.full_name)


@router.delete("/{dash_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dashboard(
    dash_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    row = await _get_visible(db, dash_id, current_user)
    if row.owner_user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the owner can delete this dashboard.")
    await db.delete(row)
    await db.commit()


# ── Public share (Smartsheet-style no-login link) ───────────────────────────
async def _owned(db: AsyncSession, dash_id: int, current_user: User) -> CustomDashboard:
    row = await _get_visible(db, dash_id, current_user)
    if row.owner_user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the owner can manage sharing.")
    return row


async def _capture_snapshot(db: AsyncSession, row: CustomDashboard, owner: User) -> None:
    """Freeze the dashboard's current widget data onto the row (snapshot mode)."""
    data = await compute_dashboard_data(db, owner, row.layout or [])
    row.share_snapshot = {"data": data}
    row.share_created_at = datetime.now(timezone.utc)


@router.post("/{dash_id}/share", response_model=DashboardShareResponse)
async def publish_dashboard(
    dash_id: int, payload: DashboardShareRequest,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Publish (or re-publish) a dashboard behind a public no-login link.

    Re-publishing keeps the existing token (the link people already have stays
    valid) but applies the chosen mode. Snapshot mode captures current data now.
    """
    row = await _owned(db, dash_id, current_user)
    slug = await resolve_slug_for_tenant_id(current_user.tenant_id)
    if not row.share_token:
        row.share_token = make_share_token(slug)
    row.share_mode = payload.mode
    if payload.mode == "snapshot":
        await _capture_snapshot(db, row, current_user)
    else:
        row.share_snapshot = None
        row.share_created_at = datetime.now(timezone.utc)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return DashboardShareResponse(
        share_token=row.share_token, share_mode=row.share_mode, share_snapshot_at=row.share_created_at,
    )


@router.post("/{dash_id}/share/refresh", response_model=DashboardShareResponse)
async def refresh_dashboard_snapshot(
    dash_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Re-capture the frozen data for a snapshot-mode shared dashboard."""
    row = await _owned(db, dash_id, current_user)
    if not row.share_token:
        raise HTTPException(status_code=400, detail="This dashboard isn't shared yet.")
    if row.share_mode != "snapshot":
        raise HTTPException(status_code=400, detail="Refresh only applies to snapshot shares.")
    await _capture_snapshot(db, row, current_user)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return DashboardShareResponse(
        share_token=row.share_token, share_mode=row.share_mode, share_snapshot_at=row.share_created_at,
    )


@router.delete("/{dash_id}/share", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_dashboard_share(
    dash_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Revoke the public link. Anyone holding the old URL gets a 404 after this."""
    row = await _owned(db, dash_id, current_user)
    row.share_token = None
    row.share_snapshot = None
    row.share_created_at = None
    db.add(row)
    await db.commit()
