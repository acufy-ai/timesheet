"""One-shot: rename users with random ``user-<hex>`` usernames to readable
slugs derived from ``full_name`` (or email-local-part as fallback).

Background: prior to the F-007/username-derivation fix, the CSV bulk
import path in ``POST /users/import/commit`` did not supply a username
and ``create_user`` synthesized ``user-<random-hex>``. Those rows are
cosmetically ugly but otherwise functional. This script reads each
affected row, computes the same readable username the new code would
have produced, and renames the row in BOTH the per-tenant DB and the
shared ``timesheet_db.users`` email-index mirror.

Behavior:
  * Tenant-scoped uniqueness via ``2``, ``3``, ... suffix on collision.
  * Skips when the row already has a non-hex username.
  * Skips when both ``full_name`` and ``email`` slug as empty - the
    safe choice is to leave the random hex in place.
  * Updates the per-tenant DB first; only then updates the shared DB
    mirror keyed by ``(tenant_id, old_username)`` so any race with a
    live update_user is handled by the existing helper, which
    re-mirrors with the post-state.

Usage (inside the api container)::

    docker compose exec -T api sh -c \\
        "cd /app && PYTHONPATH=/app python scripts/backfill_random_usernames.py --dry-run"
    docker compose exec -T api sh -c \\
        "cd /app && PYTHONPATH=/app python scripts/backfill_random_usernames.py --apply"
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import re
import sys
from typing import Iterable

from sqlalchemy import select, update, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import AsyncSessionLocal
from app.db_tenant import resolve_slug_for_tenant_id, tenant_session
from app.db_control import AsyncControlSessionLocal
from app.models.control import ControlTenant
from app.models.user import User


logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("backfill_random_usernames")


HEX_USERNAME_RE = re.compile(r"^user-[0-9a-f]+$")


def _slugify_for_username(value: str) -> str:
    """Same algorithm as crud.user._slugify_for_username; duplicated
    here so the script doesn't depend on import wiring."""
    lowered = (value or "").strip().lower()
    parts = [p for p in re.split(r"[^a-z0-9]+", lowered) if p]
    return ".".join(parts)


async def _pick_new_username(
    db: AsyncSession,
    *,
    user_id: int,
    tenant_id: int | None,
    full_name: str | None,
    email: str | None,
) -> str | None:
    """Return the desired new username, or None to leave the row alone."""
    base = _slugify_for_username(full_name or "")
    if not base and email:
        local_part = email.split("@", 1)[0]
        if not local_part.startswith("no-email+"):
            base = _slugify_for_username(local_part)
    if not base:
        return None  # caller will skip

    candidate = base
    suffix = 1
    while True:
        stmt = select(User.id).where(User.username == candidate)
        if tenant_id is not None:
            stmt = stmt.where(User.tenant_id == tenant_id)
        # Exclude the row we're renaming from collision check, otherwise
        # a no-change rename would always 'collide' with itself.
        stmt = stmt.where(User.id != user_id)
        taken = (await db.execute(stmt)).scalar_one_or_none()
        if taken is None:
            return candidate
        suffix += 1
        candidate = f"{base}{suffix}"
        if suffix > 50:
            return None  # absurd collision count; safer to skip than spin


async def _enumerate_target_tenants() -> list[ControlTenant]:
    async with AsyncControlSessionLocal() as control_db:
        rows = (await control_db.execute(
            select(ControlTenant).where(ControlTenant.is_isolated == True)  # noqa: E712
        )).scalars().all()
    return list(rows)


async def _backfill_for_tenant(
    tenant: ControlTenant,
    *,
    apply: bool,
) -> tuple[int, int]:
    """Returns (renamed, skipped)."""
    if not tenant.is_isolated or not tenant.db_name:
        logger.info("skip slug=%s (not isolated)", tenant.slug)
        return (0, 0)

    renamed = 0
    skipped = 0

    async with tenant_session(tenant.slug) as tenant_db:
        # Snapshot the affected rows up front so concurrent writes don't
        # change the iteration set. Pull only what we need.
        rows = (await tenant_db.execute(
            select(User.id, User.username, User.email, User.full_name, User.tenant_id)
            .where(User.username.regexp_match("^user-[0-9a-f]+$"))
            .order_by(User.id)
        )).all()

        for row in rows:
            user_id, old_username, email, full_name, tid = row
            new_username = await _pick_new_username(
                tenant_db,
                user_id=user_id,
                tenant_id=tid,
                full_name=full_name,
                email=email,
            )
            if not new_username or new_username == old_username:
                logger.info(
                    "[skip] slug=%s id=%s old=%s reason=%s",
                    tenant.slug, user_id, old_username,
                    "no usable slug" if not new_username else "would not change",
                )
                skipped += 1
                continue

            logger.info(
                "[%s] slug=%s id=%s '%s' -> '%s' (email=%s, full_name=%r)",
                "RENAME" if apply else "DRY",
                tenant.slug, user_id, old_username, new_username, email, full_name,
            )
            if apply:
                # Update per-tenant DB
                await tenant_db.execute(
                    update(User).where(User.id == user_id).values(username=new_username)
                )
                await tenant_db.commit()

                # Update the shared-DB mirror keyed by (tenant_id, email).
                # Using email rather than (tenant_id, old_username) to
                # match how the existing _mirror_user_update_to_shared_db
                # helper keys its lookups - and email-key has the
                # composite unique constraint to back it up.
                async with AsyncSessionLocal() as shared_db:
                    await shared_db.execute(
                        text(
                            "UPDATE users SET username = :new_username "
                            "WHERE tenant_id = :tenant_id AND email = :email"
                        ),
                        {"new_username": new_username, "tenant_id": tid, "email": email},
                    )
                    await shared_db.commit()
            renamed += 1

    return (renamed, skipped)


async def _run(*, apply: bool, slugs: Iterable[str] | None) -> int:
    tenants = await _enumerate_target_tenants()
    if slugs:
        wanted = set(slugs)
        tenants = [t for t in tenants if t.slug in wanted]
    if not tenants:
        logger.info("no isolated tenants matched")
        return 0

    total_renamed = 0
    total_skipped = 0
    for t in tenants:
        r, s = await _backfill_for_tenant(t, apply=apply)
        total_renamed += r
        total_skipped += s

    mode = "applied" if apply else "dry-run"
    logger.info(
        "done (%s): renamed=%d skipped=%d across %d tenant(s)",
        mode, total_renamed, total_skipped, len(tenants),
    )
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply", action="store_true",
        help="actually write the renames; otherwise dry-run only",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="alias for not passing --apply",
    )
    parser.add_argument(
        "--slug", action="append",
        help="limit to one slug; repeat to add more",
    )
    args = parser.parse_args()

    apply = args.apply and not args.dry_run
    try:
        rc = asyncio.run(_run(apply=apply, slugs=args.slug))
    except KeyboardInterrupt:
        rc = 130
    except Exception as exc:  # noqa: BLE001
        logger.exception("fatal: %s", exc)
        print(f"fatal: {exc}", file=sys.stderr)
        rc = 2
    raise SystemExit(rc)


if __name__ == "__main__":
    main()
