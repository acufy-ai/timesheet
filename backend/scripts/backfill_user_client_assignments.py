"""Backfill UserClientAssignment rows from pre-existing IngestionTimesheets.

The inbox cascade (PATCH /ingestion/timesheets/{id}) writes a
UserClientAssignment row whenever a reviewer assigns a client + employee
on the inbox card. That code shipped after some timesheets had already
been approved, so older approved rows can have matching ``employee_id``
and ``client_id`` columns without a corresponding row in
``user_client_assignments``. Admins then see an external employee on the
User Management page with an empty Clients list even though that user
has approved PDFs against that client in the inbox.

This script closes that gap. For every isolated tenant, scan
IngestionTimesheets that:

  - have ``employee_id IS NOT NULL`` (the inbox row was bound to a user)
  - have ``client_id IS NOT NULL`` (a client was picked)
  - have NO matching ``user_client_assignments`` row

and insert the missing row. Add-only: never removes anything.

Run inside the api container::

    docker compose exec api python -m scripts.backfill_user_client_assignments --dry-run
    docker compose exec api python -m scripts.backfill_user_client_assignments --apply

The dry-run prints what would change; --apply commits.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from typing import Iterable

# Allow `python scripts/backfill_user_client_assignments.py` from the backend root.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from sqlalchemy import exists, select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from app.db_control import AsyncControlSessionLocal  # noqa: E402
from app.db_tenant import tenant_session  # noqa: E402
from app.models.control import ControlTenant  # noqa: E402
from app.models.ingestion_timesheet import IngestionTimesheet  # noqa: E402
from app.models.user_client_assignment import UserClientAssignment  # noqa: E402

logger = logging.getLogger("backfill_user_client_assignments")


async def _gaps_for_tenant(
    db: AsyncSession,
    tenant_id: int,
) -> list[tuple[int, int, int]]:
    """Return ``(ts_id, employee_id, client_id)`` tuples that lack an assignment row."""
    result = await db.execute(
        select(
            IngestionTimesheet.id,
            IngestionTimesheet.employee_id,
            IngestionTimesheet.client_id,
        )
        .where(
            IngestionTimesheet.tenant_id == tenant_id,
            IngestionTimesheet.employee_id.is_not(None),
            IngestionTimesheet.client_id.is_not(None),
            ~exists().where(
                (UserClientAssignment.user_id == IngestionTimesheet.employee_id)
                & (UserClientAssignment.client_id == IngestionTimesheet.client_id)
            ),
        )
    )
    return [(row.id, row.employee_id, row.client_id) for row in result.all()]


def _pairs_to_add(gaps: Iterable[tuple[int, int, int]]) -> set[tuple[int, int]]:
    """Collapse the row-level gap list to unique (user_id, client_id) pairs.

    Multiple ingestion timesheets often share the same (employee, client),
    so we only want to insert one assignment row per pair.
    """
    return {(emp, cli) for _ts, emp, cli in gaps}


async def _backfill_tenant(slug: str, tenant_id: int, apply: bool) -> tuple[int, int]:
    """Returns (gap_row_count, inserted_pair_count). Inserted is 0 in dry-run."""
    async with tenant_session(slug) as db:
        gaps = await _gaps_for_tenant(db, tenant_id)
        pairs = _pairs_to_add(gaps)
        logger.info(
            "tenant=%s gap_rows=%d unique_pairs=%d", slug, len(gaps), len(pairs)
        )
        if not pairs:
            return (0, 0)
        for emp, cli in sorted(pairs):
            logger.info("  pair user_id=%s client_id=%s", emp, cli)

        if not apply:
            return (len(gaps), 0)

        for emp, cli in pairs:
            db.add(
                UserClientAssignment(
                    tenant_id=tenant_id,
                    user_id=emp,
                    client_id=cli,
                )
            )
        await db.commit()
        return (len(gaps), len(pairs))


async def _main(apply: bool) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    async with AsyncControlSessionLocal() as cdb:
        tenants = (await cdb.execute(
            select(ControlTenant).where(ControlTenant.status == "active")
        )).scalars().all()

    isolated = [t for t in tenants if t.is_isolated]
    logger.info("scanning %d isolated tenants (apply=%s)", len(isolated), apply)

    total_gaps = 0
    total_inserts = 0
    for t in isolated:
        gaps, inserts = await _backfill_tenant(t.slug, t.id, apply)
        total_gaps += gaps
        total_inserts += inserts
    logger.info(
        "done. tenants=%d gap_rows=%d inserted_pairs=%d",
        len(isolated),
        total_gaps,
        total_inserts,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--dry-run",
        action="store_true",
        help="Scan and log gaps without inserting anything.",
    )
    group.add_argument(
        "--apply",
        action="store_true",
        help="Insert missing UserClientAssignment rows and commit per tenant.",
    )
    args = parser.parse_args(argv)
    return asyncio.run(_main(apply=args.apply))


if __name__ == "__main__":
    sys.exit(main())
