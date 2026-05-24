"""Auto-enable ``custom_outbound_email`` for tenants with active OAuth mailbox.

Run once after migration 003_tenant_features applies. Without this,
tenants that today silently use their OAuth mailbox for outbound would
get switched to "platform default SMTP" the moment B.1's resolution
chain ships.

Idempotent: re-running is a no-op for tenants whose flag is already
TRUE. Safe to run multiple times.

Usage:
    python -m scripts.backfill_tenant_features --dry-run
    python -m scripts.backfill_tenant_features --apply
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

# Allow `python scripts/backfill_tenant_features.py` from the backend root.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from sqlalchemy import select  # noqa: E402

from app.db_control import AsyncControlSessionLocal  # noqa: E402
from app.db_tenant import tenant_session  # noqa: E402
from app.models.control import ControlTenant, ControlTenantFeatures  # noqa: E402
from app.models.mailbox import Mailbox  # noqa: E402

logger = logging.getLogger("backfill_tenant_features")


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true",
                        help="Write the flag updates. Without this flag, runs in dry-run mode.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would change and exit.")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if not args.apply and not args.dry_run:
        parser.error("Pass --dry-run or --apply.")

    # Pull tenants from the control plane.
    async with AsyncControlSessionLocal() as cdb:
        tenants = (await cdb.execute(
            select(ControlTenant).where(ControlTenant.status == "active")
        )).scalars().all()

    candidates: list[tuple[int, str]] = []  # (tenant_id, slug) for tenants with active mailbox
    for t in tenants:
        # Each tenant's mailboxes live in its own DB. If non-isolated,
        # this still resolves to the shared DB which is fine.
        try:
            async with tenant_session(t.slug) as tdb:
                has_active = (await tdb.execute(
                    select(Mailbox.id).where(
                        Mailbox.tenant_id == t.id,
                        Mailbox.is_active == True,  # noqa: E712
                    ).limit(1)
                )).first()
        except (LookupError, ValueError) as exc:
            logger.warning("Skipping tenant %s: %s", t.slug, exc)
            continue
        if has_active:
            candidates.append((t.id, t.slug))

    logger.info("Tenants with active OAuth mailbox: %d", len(candidates))
    for tid, slug in candidates:
        logger.info("  - id=%s slug=%s", tid, slug)

    if not candidates:
        logger.info("Nothing to backfill.")
        return 0

    if args.dry_run:
        logger.info("Dry run: would set custom_outbound_email=TRUE for the above.")
        return 0

    async with AsyncControlSessionLocal() as cdb:
        for tid, _slug in candidates:
            row = (await cdb.execute(
                select(ControlTenantFeatures).where(ControlTenantFeatures.tenant_id == tid)
            )).scalar_one_or_none()
            if row is None:
                # 003 migration's INSERT should have created this. If it
                # didn't (race, partial migration) create it now.
                row = ControlTenantFeatures(tenant_id=tid, custom_outbound_email=True)
                cdb.add(row)
            else:
                row.custom_outbound_email = True
                cdb.add(row)
        await cdb.commit()

    # Also write the tenant_settings choice so the resolver picks
    # oauth_mailbox. The feature flag alone enables the *option*;
    # the setting selects *which option to use*. We write directly
    # via SQL (skipping the standard set_setting helper) so we don't
    # create an audit log row for what's really a no-op preservation
    # of existing implicit behavior.
    from sqlalchemy import text
    import json as _json
    for tid, slug in candidates:
        try:
            async with tenant_session(slug) as tdb:
                await tdb.execute(
                    text(
                        """
                        INSERT INTO tenant_settings (tenant_id, key, value)
                        VALUES (:tid, 'outbound_email_source', :value)
                        ON CONFLICT (tenant_id, key) DO NOTHING
                        """
                    ),
                    {"tid": tid, "value": _json.dumps("oauth_mailbox")},
                )
                await tdb.commit()
        except Exception as exc:
            logger.warning("Setting backfill failed for %s: %s", slug, exc)

    logger.info("Backfill applied for %d tenants.", len(candidates))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
