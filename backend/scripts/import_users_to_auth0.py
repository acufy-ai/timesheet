"""Bulk-import existing users into Auth0.

Reads users from the shared DB (and, optionally, each isolated tenant
DB) and submits them to Auth0's ``POST /api/v2/jobs/users-imports``
endpoint. Auth0 accepts bcrypt password hashes natively, so users keep
their existing passwords with no reset prompt on first Auth0 login.

Usage:
    python -m app.scripts.import_users_to_auth0 --dry-run
    python -m app.scripts.import_users_to_auth0 --apply
    python -m app.scripts.import_users_to_auth0 --apply --tenant-slug acuent

The script is idempotent: ``upsert=true`` is passed so re-running is
safe, and we skip rows that already have ``auth0_sub`` populated by a
prior run.

Required environment (in addition to the standard backend .env):
    AUTH0_DOMAIN, AUTH0_CONNECTION
    AUTH0_MGMT_CLIENT_ID, AUTH0_MGMT_CLIENT_SECRET
        Machine-to-machine app authorized for the Management API with
        ``create:users`` and ``read:users`` scopes.

Auth0's bulk import is asynchronous: we submit the job, poll until it
finishes, then write back ``auth0_sub`` for every successfully imported
user. Failures are logged but never abort the job; partial success is
the expected case.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import tempfile
import time
from typing import Any, Iterable

import httpx
from sqlalchemy import select

# Allow `python scripts/import_users_to_auth0.py` from the backend root.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.config import settings  # noqa: E402
from app.db import AsyncSessionLocal  # noqa: E402
from app.models.user import User  # noqa: E402

logger = logging.getLogger("import_users_to_auth0")


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Missing required env var: {name}")
    return value


async def _management_token() -> str:
    """Exchange the M2M client credentials for a Management API token."""
    domain = settings.auth0_domain or _require_env("AUTH0_DOMAIN")
    client_id = _require_env("AUTH0_MGMT_CLIENT_ID")
    client_secret = _require_env("AUTH0_MGMT_CLIENT_SECRET")

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"https://{domain}/oauth/token",
            json={
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
                "audience": f"https://{domain}/api/v2/",
            },
        )
    resp.raise_for_status()
    return resp.json()["access_token"]


def _build_import_record(user: User) -> dict[str, Any]:
    """Shape one User row into the Auth0 bulk-import schema."""
    record: dict[str, Any] = {
        "email": user.email,
        "email_verified": bool(user.email_verified),
        "blocked": not bool(user.is_active),
        # We attach our local user id in app_metadata so an Auth0
        # Action could read it back if we ever want to inject custom
        # claims at token-issue time.
        "app_metadata": {
            "local_user_id": user.id,
            "tenant_id": user.tenant_id,
        },
    }
    if user.full_name:
        record["name"] = user.full_name
    if user.username:
        record["username"] = user.username
    if user.hashed_password:
        # Auth0 accepts bcrypt hashes directly under custom_password_hash.
        record["custom_password_hash"] = {
            "algorithm": "bcrypt",
            "hash": {"value": user.hashed_password},
        }
    return record


async def _collect_users(tenant_slug: str | None) -> list[User]:
    """Pull users from the shared DB or a specific tenant DB."""
    if tenant_slug:
        from app.db_tenant import tenant_session
        async with tenant_session(tenant_slug) as session:
            rows = (await session.execute(
                select(User).where(User.auth0_sub.is_(None))
            )).scalars().all()
            return list(rows)

    async with AsyncSessionLocal() as session:
        rows = (await session.execute(
            select(User).where(User.auth0_sub.is_(None))
        )).scalars().all()
        return list(rows)


async def _submit_import(token: str, records: list[dict[str, Any]]) -> str:
    """Submit a users-import job; returns the job id."""
    domain = settings.auth0_domain or _require_env("AUTH0_DOMAIN")
    connection_id = _require_env("AUTH0_CONNECTION_ID")

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as fh:
        json.dump(records, fh)
        path = fh.name

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            with open(path, "rb") as upload:
                resp = await client.post(
                    f"https://{domain}/api/v2/jobs/users-imports",
                    headers={"Authorization": f"Bearer {token}"},
                    data={
                        "connection_id": connection_id,
                        "upsert": "true",
                        "send_completion_email": "false",
                    },
                    files={"users": ("users.json", upload, "application/json")},
                )
        resp.raise_for_status()
    finally:
        os.unlink(path)

    return resp.json()["id"]


async def _wait_for_job(token: str, job_id: str) -> dict[str, Any]:
    """Poll the job status endpoint until it terminates."""
    domain = settings.auth0_domain or _require_env("AUTH0_DOMAIN")
    url = f"https://{domain}/api/v2/jobs/{job_id}"
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(timeout=15.0) as client:
        while True:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            status = data.get("status")
            if status in {"completed", "failed"}:
                return data
            time.sleep(2)
            await asyncio.sleep(0)  # cooperative yield


async def _fetch_imported_subs(
    token: str, emails: Iterable[str]
) -> dict[str, str]:
    """Look up Auth0 ``user_id`` for each email we imported."""
    domain = settings.auth0_domain or _require_env("AUTH0_DOMAIN")
    out: dict[str, str] = {}

    async with httpx.AsyncClient(timeout=10.0) as client:
        for email in emails:
            resp = await client.get(
                f"https://{domain}/api/v2/users-by-email",
                headers={"Authorization": f"Bearer {token}"},
                params={"email": email},
            )
            if resp.status_code != 200:
                logger.warning("users-by-email %s: %s", email, resp.status_code)
                continue
            arr = resp.json()
            if arr:
                out[email.lower()] = arr[0]["user_id"]
    return out


async def _write_back_subs(
    tenant_slug: str | None, mapping: dict[str, str]
) -> int:
    """Set ``auth0_sub`` on local user rows for everyone we imported."""
    if not mapping:
        return 0
    updated = 0
    if tenant_slug:
        from app.db_tenant import tenant_session
        async with tenant_session(tenant_slug) as session:
            for email, sub in mapping.items():
                user = (await session.execute(
                    select(User).where(User.email == email)
                )).scalar_one_or_none()
                if user and not user.auth0_sub:
                    user.auth0_sub = sub
                    session.add(user)
                    updated += 1
            await session.commit()
        return updated

    async with AsyncSessionLocal() as session:
        for email, sub in mapping.items():
            user = (await session.execute(
                select(User).where(User.email == email)
            )).scalar_one_or_none()
            if user and not user.auth0_sub:
                user.auth0_sub = sub
                session.add(user)
                updated += 1
        await session.commit()
    return updated


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true",
                        help="Submit the import to Auth0. Without this, runs in dry-run mode.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print the records that would be imported and exit.")
    parser.add_argument("--tenant-slug", default=None,
                        help="Import users from a specific tenant DB. Default is the shared DB.")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if not args.apply and not args.dry_run:
        parser.error("Pass --dry-run or --apply.")

    users = await _collect_users(args.tenant_slug)
    if not users:
        logger.info("No users to import (all rows already have auth0_sub).")
        return 0

    records = [_build_import_record(u) for u in users]
    logger.info("Prepared %d users for import.", len(records))

    if args.dry_run:
        for r in records:
            logger.info("  - %s (verified=%s, blocked=%s)",
                        r["email"], r["email_verified"], r["blocked"])
        return 0

    token = await _management_token()
    job_id = await _submit_import(token, records)
    logger.info("Submitted Auth0 import job %s", job_id)

    result = await _wait_for_job(token, job_id)
    summary = result.get("summary", {})
    logger.info("Job finished: status=%s summary=%s", result.get("status"), summary)

    emails = [r["email"] for r in records]
    sub_map = await _fetch_imported_subs(token, emails)
    written = await _write_back_subs(args.tenant_slug, sub_map)
    logger.info("Wrote auth0_sub back to %d local user rows.", written)

    return 0 if result.get("status") == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
