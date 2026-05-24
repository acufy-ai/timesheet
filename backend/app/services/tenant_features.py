"""Feature-flag read/write helpers.

Reads are cheap and hit the control plane DB. Callers that need flags
for the current request should batch their fetch via :func:`get_features`
(returns a dict) rather than calling per-flag helpers in a loop.

No in-process cache yet — we ship correctness first. If profiling
shows hot reads, add a 30-second TTL cache here later.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db_control import AsyncControlSessionLocal
from app.models.control import ControlTenantFeatures

logger = logging.getLogger(__name__)


# Keep this in sync with the columns on ControlTenantFeatures. When
# you add a new flag column, add it here too.
KNOWN_FLAGS = (
    "custom_outbound_email",
    "custom_email_template",
)

# Default value when no row exists for the tenant yet (e.g., a tenant
# created before this table existed, before backfill runs).
DEFAULT_FLAGS = {flag: False for flag in KNOWN_FLAGS}


async def get_features(tenant_id: int) -> dict[str, bool]:
    """Return all feature flags for a tenant as a plain dict.

    Missing row → returns the all-False default. Callers can index by
    flag name; we never raise here so flag reads can't bring down a
    request path.
    """
    if tenant_id is None:
        return dict(DEFAULT_FLAGS)

    try:
        async with AsyncControlSessionLocal() as session:
            row = (await session.execute(
                select(ControlTenantFeatures).where(
                    ControlTenantFeatures.tenant_id == tenant_id
                )
            )).scalar_one_or_none()
    except Exception as exc:
        logger.warning("feature-flag read failed for tenant %s: %s", tenant_id, exc)
        return dict(DEFAULT_FLAGS)

    if row is None:
        return dict(DEFAULT_FLAGS)
    return {flag: bool(getattr(row, flag, False)) for flag in KNOWN_FLAGS}


async def has_feature(tenant_id: int, flag: str) -> bool:
    """Convenience for single-flag checks. Use ``get_features`` if you need more than one."""
    if flag not in KNOWN_FLAGS:
        logger.error("unknown feature flag requested: %s", flag)
        return False
    flags = await get_features(tenant_id)
    return flags.get(flag, False)


async def set_features(
    tenant_id: int,
    updates: dict[str, bool],
    *,
    actor_user_id: Optional[int] = None,
) -> dict[str, bool]:
    """Upsert flag values for a tenant.

    Validates keys against :data:`KNOWN_FLAGS` so a typo doesn't silently
    write to a non-existent column. Returns the resulting full flag
    dict so the platform admin UI can refresh from one round-trip.
    """
    bad = set(updates) - set(KNOWN_FLAGS)
    if bad:
        raise ValueError(f"Unknown feature flag(s): {sorted(bad)}")

    async with AsyncControlSessionLocal() as session:
        row = (await session.execute(
            select(ControlTenantFeatures).where(
                ControlTenantFeatures.tenant_id == tenant_id
            )
        )).scalar_one_or_none()

        if row is None:
            row = ControlTenantFeatures(tenant_id=tenant_id)
            for flag in KNOWN_FLAGS:
                setattr(row, flag, bool(updates.get(flag, False)))
            session.add(row)
        else:
            for flag, value in updates.items():
                setattr(row, flag, bool(value))

        row.updated_at = datetime.now(timezone.utc)
        row.updated_by = actor_user_id
        session.add(row)
        await session.commit()

        return {flag: bool(getattr(row, flag, False)) for flag in KNOWN_FLAGS}
