"""Public (no-login) rendering of a shared Insights dashboard.

A dashboard owner publishes their dashboard behind an opaque, revocable token
(see the publish/revoke/refresh routes in `app/api/dashboards.py`). This module
serves the read-only public view at:

    GET /public/dashboards/{share_token}

No authentication. The token IS the capability: whoever holds it sees the live
(or snapshotted) dashboard exactly as the owner sees it, read-only.

Token format is ``<tenant_slug>~<random>``. The slug prefix lets us route
straight to the owning tenant's DB in O(1) (no fleet scan) — slugs never contain
``~``. The random suffix is the unguessable secret. Resolution then matches the
FULL token against the row, so a forged slug with a wrong suffix resolves to
nothing.

Live data is produced by `compute_dashboard_data`, which calls the SAME metric
functions the authenticated Insights endpoints use, passing the dashboard's
owner as the acting user — so the public numbers reconcile with the owner's view
and no metric logic is duplicated.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Path
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db_tenant import tenant_session
from app.models.dashboard import CustomDashboard
from app.models.user import User
from app.schemas import PublicDashboardResponse

router = APIRouter(prefix="/public/dashboards", tags=["public-dashboards"])

_TOKEN_SEP = "~"


def make_share_token(tenant_slug: str) -> str:
    """A new opaque share token carrying its tenant slug for O(1) routing."""
    return f"{tenant_slug}{_TOKEN_SEP}{secrets.token_urlsafe(24)}"


def _slug_from_token(share_token: str) -> Optional[str]:
    slug, sep, _rest = share_token.partition(_TOKEN_SEP)
    return slug if (sep and slug) else None


def _which_bundles(layout: list[dict[str, Any]]) -> set[str]:
    """Only compute the metric bundles the dashboard's widgets actually use."""
    need: set[str] = set()
    for w in layout or []:
        t = w.get("type")
        cfg = w.get("config") or {}
        if t in ("kpi", "chart", "table", "health"):
            need.add("portfolio")
            need.add("financials")
        if t == "evm":
            need.add("evm")
        if t == "revrec" or (t == "kpi" and cfg.get("metric") in ("billed", "recognized")):
            need.add("revrec")
        if t == "utilization":
            need.add("financials")
            need.add("resourcing")
        if t == "ontime" or (t == "kpi" and cfg.get("metric") == "on_time") \
                or (t == "chart" and cfg.get("source") == "on_time_trend"):
            need.add("ontime")
    return need


async def compute_dashboard_data(
    db: AsyncSession, owner: User, layout: list[dict[str, Any]]
) -> dict[str, Any]:
    """Compute the metric bundles a dashboard's widgets need, AS the owner.

    Reuses the authenticated Insights endpoint functions directly (passing the
    owner as current_user) so the numbers match exactly. Each bundle is
    JSON-serialized so it can be stored (snapshot) or returned (live). A bundle
    that errors for this owner (role gate, etc.) is omitted; that widget then
    renders its own empty state.
    """
    from app.api import dashboard as dash  # local import avoids a cycle at load

    need = _which_bundles(layout)
    out: dict[str, Any] = {}

    async def run(key: str, coro):
        try:
            res = await coro
            out[key] = res.model_dump(mode="json") if hasattr(res, "model_dump") else res
        except HTTPException:
            pass
        except Exception:
            pass

    if "portfolio" in need:
        await run("portfolio", dash.get_portfolio(db=db, current_user=owner))
    if "financials" in need:
        await run("financials", dash.get_manager_financials(db=db, current_user=owner))
    if "evm" in need:
        await run("evm", dash.get_evm(db=db, current_user=owner))
    if "revrec" in need:
        await run("revrec", dash.get_revenue_recognition(db=db, current_user=owner))
    if "resourcing" in need:
        await run("resourcing", dash.get_team_resourcing(weeks_ahead=4, db=db, current_user=owner))
    if "ontime" in need:
        await run("ontime", dash.get_team_on_time_stats(days_back=90, db=db, current_user=owner))
    return out


@router.get("/{share_token}", response_model=PublicDashboardResponse)
async def get_public_dashboard(
    share_token: str = Path(..., min_length=8, max_length=64),
):
    """Render a shared dashboard read-only, no auth, by its share token."""
    slug = _slug_from_token(share_token)
    if not slug:
        raise HTTPException(status_code=404, detail="This dashboard link is not valid.")

    try:
        async with tenant_session(slug) as db:
            row = (await db.execute(
                select(CustomDashboard).where(CustomDashboard.share_token == share_token)
            )).scalar_one_or_none()
            if row is None or not row.share_token:
                raise HTTPException(status_code=404, detail="This dashboard link is not valid or was revoked.")

            owner = None
            if row.owner_user_id is not None:
                owner = (await db.execute(
                    select(User).where(User.id == row.owner_user_id)
                )).scalar_one_or_none()
            owner_name = owner.full_name if owner else None

            if row.share_mode == "snapshot":
                snap = row.share_snapshot or {}
                return PublicDashboardResponse(
                    name=row.name, layout=row.layout or [], owner_name=owner_name,
                    mode="snapshot", data=snap.get("data", {}),
                    captured_at=row.share_created_at,
                )

            # Live mode: compute now, as the owner.
            if owner is None:
                return PublicDashboardResponse(
                    name=row.name, layout=row.layout or [], owner_name=owner_name, mode="live", data={},
                )
            data = await compute_dashboard_data(db, owner, row.layout or [])
            return PublicDashboardResponse(
                name=row.name, layout=row.layout or [], owner_name=owner_name,
                mode="live", data=data, captured_at=datetime.now(timezone.utc),
            )
    except LookupError:
        # Unknown slug in the token prefix.
        raise HTTPException(status_code=404, detail="This dashboard link is not valid.")
