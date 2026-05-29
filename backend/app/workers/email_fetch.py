"""
Email fetch and reprocess worker jobs.
Called by arq when a reviewer triggers email ingestion or reprocessing.
"""

import json
import logging
import secrets
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ingested_email import IngestedEmail
from app.models.mailbox import Mailbox
from app.models.tenant import Tenant
from app.services.imap import fetch_messages, update_last_fetched_at
from app.services.ingestion_pipeline import process_email, reprocess_stored_email

logger = logging.getLogger(__name__)

JOB_STATUS_TTL_SECONDS = 86400


def _fetch_lock_ttl_seconds() -> int:
    """Lock TTL is derived from the per-job timeout so a crashed worker
    can't hold the lock longer than the longest legitimate run + a small
    grace period.

    Previously hard-coded to 900s (15 min), which left a crashed-worker
    lock alive long enough that the next manual fetch click silently
    skipped with "another run in progress" — see audit finding F-04 on
    2026-05-29. Now ties the lock TTL to ``worker_job_timeout`` (default
    300s) + 60s buffer so a stuck lock clears within ~6 min of the worker
    going down.

    Released to a function so tests can monkey-patch ``settings``.
    """
    from app.core.config import settings as _s
    return int(_s.worker_job_timeout) + 60

# A mailbox that has failed to fetch this many times in a row is
# auto-disabled by the worker. 5 is loose enough that a single bad
# afternoon won't trip it, tight enough that a permanently-broken
# mailbox stops logging the same failure on every scheduled run.
MAILBOX_AUTO_DISABLE_THRESHOLD = 5


def _status_key(job_id: str) -> str:
    return f"ingestion:job-status:{job_id}"


def _fetch_lock_key(tenant_id: int, mode: str) -> str:
    # Lock is per (tenant, mode) so a fetch and a reprocess for the same
    # tenant don't block each other — they touch different sets of rows.
    return f"ingestion:fetch-lock:{tenant_id}:{mode}"


async def _try_acquire_fetch_lock(redis, key: str, token: str) -> bool:
    """SET NX EX — atomic acquire-or-fail with TTL. Returns True if we got it."""
    if redis is None:
        # Redis-less dev: skip locking. Single-worker dev environments
        # don't have the concurrency the lock protects against.
        return True
    result = await redis.set(key, token, nx=True, ex=_fetch_lock_ttl_seconds())
    return bool(result)


async def _release_fetch_lock(redis, key: str, token: str) -> None:
    """Release the lock only if our token still owns it. Uses a Lua CAS so a
    slow job whose TTL has expired (and whose lock was re-acquired by
    another worker) can't accidentally release the new owner's lock."""
    if redis is None:
        return
    script = (
        "if redis.call('get', KEYS[1]) == ARGV[1] then "
        "return redis.call('del', KEYS[1]) "
        "else return 0 end"
    )
    try:
        await redis.eval(script, 1, key, token)
    except Exception as exc:
        # Best-effort release; if Redis is unavailable at job end the
        # lock will TTL out on its own.
        logger.warning("Failed to release fetch lock %s: %s", key, exc)


def _build_summary(tenant_id: int, mode: str) -> dict[str, Any]:
    return {
        "tenant_id": tenant_id,
        "mode": mode,
        "mailboxes_processed": 0,
        "mailboxes_failed": 0,
        "total_fetched": 0,
        "total_new": 0,
        "total_skipped": 0,
        "total_timesheets_created": 0,
        "skip_reasons": {},
        "message_diagnostics": [],
        "errors": [],
        "completed_at": None,
    }


async def _write_job_status(
    ctx: dict,
    *,
    job_id: str,
    tenant_id: int,
    mode: str,
    status: str,
    progress: int,
    message: str,
    result: dict[str, Any] | None = None,
    error: str | None = None,
    counters: dict[str, int] | None = None,
) -> None:
    """Write the job status row to Redis.

    Optional ``counters`` are real work-done numbers (audit F-09):
    ``messages_processed`` / ``messages_total`` /
    ``mailboxes_processed`` / ``mailboxes_total``. They let the frontend
    surface honest "5 of 12 emails from mailbox.com" text alongside the
    rough percentage bar. None means "no update to existing counters";
    individual fields can be omitted to update only some.
    """
    redis = ctx.get("redis")
    if redis is None:
        logger.warning("Redis unavailable, cannot write job status for job_id=%s", job_id)
        return

    # Preserve started_at AND counters across status writes for the same
    # job. started_at is set once on the first write (audit F-04); counters
    # accumulate over the job lifetime so partial updates merge into the
    # running state rather than replace it (audit F-09).
    now_iso = datetime.now(timezone.utc).isoformat()
    started_at = now_iso
    merged_counters: dict[str, int] = {}
    try:
        prior = await redis.get(_status_key(job_id))
        if prior:
            try:
                prior_payload = json.loads(prior)
                existing_started = prior_payload.get("started_at")
                if existing_started:
                    started_at = existing_started
                prior_counters = prior_payload.get("counters")
                if isinstance(prior_counters, dict):
                    merged_counters.update(
                        {k: int(v) for k, v in prior_counters.items()
                         if isinstance(v, (int, float))}
                    )
            except (ValueError, TypeError):
                # Corrupt prior payload — treat as a new job and overwrite.
                pass
    except Exception as exc:
        # If Redis read fails, keep going with the current time as
        # started_at. The lost continuity is harmless — frontend's
        # staleness threshold is generous (job_timeout + buffer).
        logger.debug("Could not read prior status for job_id=%s: %s", job_id, exc)

    if counters:
        # Caller-supplied counters override prior values for the keys
        # they touch. Lets the worker bump messages_processed without
        # resetting mailboxes_total (set earlier when the prefetch
        # completed).
        merged_counters.update({k: int(v) for k, v in counters.items()})

    payload = {
        "job_id": job_id,
        "tenant_id": tenant_id,
        "mode": mode,
        "status": status,
        "progress": progress,
        "message": message,
        "result": result,
        "error": error,
        "counters": merged_counters or None,
        "started_at": started_at,
        "updated_at": now_iso,
    }
    await redis.setex(
        _status_key(job_id),
        JOB_STATUS_TTL_SECONDS,
        json.dumps(payload, default=str),
    )


async def fetch_emails_for_tenant(
    ctx: dict,
    tenant_id: int,
    mode: str = "fetch",
    email_id: int | None = None,
    attachment_ids: list[int] | None = None,
    tenant_slug: str | None = None,
) -> dict:
    """arq job: fetch and process emails for a tenant (or reprocess).

    ``tenant_slug`` routes DB sessions to the tenant DB; resolved from the
    control plane when absent.
    """
    from app.db import AsyncSessionLocal
    from app.db_tenant import resolve_slug_for_tenant_id, tenant_session

    if tenant_slug is None:
        try:
            tenant_slug = await resolve_slug_for_tenant_id(tenant_id)
        except LookupError:
            tenant_slug = None

    def _open_session():
        # One callable that workers below can invoke per session-open.
        # When we have a slug we route through the registry; without
        # one we keep the legacy behaviour so manual / replay paths
        # still function.
        if tenant_slug:
            return tenant_session(tenant_slug)
        return AsyncSessionLocal()

    job_id = ctx.get("job_id") or f"fetch_tenant_{tenant_id}"
    summary = _build_summary(tenant_id, mode)

    # Per-(tenant, mode) lock prevents concurrent runs from double-ingesting
    # the same emails when the scheduled timer and a manual UI trigger fire
    # within seconds of each other. Non-blocking: if another worker holds
    # the lock we record a skip and return immediately, so the duplicate
    # job doesn't pile up retries in the arq queue.
    redis = ctx.get("redis")
    lock_key = _fetch_lock_key(tenant_id, mode)
    lock_token = secrets.token_hex(16)
    if not await _try_acquire_fetch_lock(redis, lock_key, lock_token):
        logger.info(
            "Skipping duplicate ingestion job for tenant=%s mode=%s; another worker holds the lock",
            tenant_id, mode,
        )
        summary["errors"].append("Another ingestion run is already in progress for this tenant.")
        summary["completed_at"] = datetime.now(timezone.utc).isoformat()
        await _write_job_status(
            ctx,
            job_id=job_id,
            tenant_id=tenant_id,
            mode=mode,
            status="skipped",
            progress=100,
            message="Another ingestion run is already in progress for this tenant.",
            result=summary,
        )
        return summary

    try:
        return await _fetch_emails_for_tenant_body(
            ctx, tenant_id, mode, email_id, attachment_ids,
            tenant_slug=tenant_slug,
            job_id=job_id,
            summary=summary,
            open_session=_open_session,
        )
    finally:
        await _release_fetch_lock(redis, lock_key, lock_token)


async def _fetch_emails_for_tenant_body(
    ctx: dict,
    tenant_id: int,
    mode: str,
    email_id: int | None,
    attachment_ids: list[int] | None,
    *,
    tenant_slug: str | None,
    job_id: str,
    summary: dict,
    open_session,
) -> dict:
    """Inner body of fetch_emails_for_tenant. Extracted so the lock acquire/
    release in the wrapper stays uncluttered and easy to audit."""
    _open_session = open_session

    await _write_job_status(
        ctx,
        job_id=job_id,
        tenant_id=tenant_id,
        mode=mode,
        status="in_progress",
        progress=5,
        message="Loading tenant ingestion context...",
    )

    # Validate tenant in a short session, then close before any IMAP work.
    async with _open_session() as session:
        tenant = await session.get(Tenant, tenant_id)
        if not tenant:
            summary["errors"].append(f"Tenant {tenant_id} not found")
            summary["completed_at"] = datetime.now(timezone.utc).isoformat()
            await _write_job_status(
                ctx,
                job_id=job_id,
                tenant_id=tenant_id,
                mode=mode,
                status="failed",
                progress=100,
                message=f"Tenant {tenant_id} not found.",
                result=summary,
                error=summary["errors"][0],
            )
            return summary

        if not tenant.ingestion_enabled:
            summary["errors"].append(f"Tenant {tenant_id} does not have ingestion enabled")
            summary["completed_at"] = datetime.now(timezone.utc).isoformat()
            await _write_job_status(
                ctx,
                job_id=job_id,
                tenant_id=tenant_id,
                mode=mode,
                status="failed",
                progress=100,
                message="Ingestion is not enabled for this tenant.",
                result=summary,
                error=summary["errors"][0],
            )
            return summary
    # Pre-fetch IMAP messages outside any session so asyncio.to_thread
    # never runs inside one.
    prefetched: list[tuple[Mailbox, list[dict] | None]] | None = None
    if mode == "fetch":
        prefetched = await _prefetch_mailbox_messages(
            ctx, tenant_id, job_id, summary, tenant_slug=tenant_slug
        )

    try:
        async with _open_session() as session:
            if mode == "fetch":
                await _run_fetch_job(
                    ctx, session, tenant_id, job_id, summary,
                    prefetched=prefetched,
                    tenant_slug=tenant_slug,
                )
            else:
                await _run_reprocess_job(
                    ctx,
                    session,
                    tenant_id,
                    job_id,
                    summary,
                    mode=mode,
                    email_id=email_id,
                    attachment_ids=attachment_ids or [],
                )
    except Exception as exc:
        logger.exception("Worker job failed for tenant %s", tenant_id)
        summary["errors"].append(str(exc))
        summary["completed_at"] = datetime.now(timezone.utc).isoformat()
        await _write_job_status(
            ctx,
            job_id=job_id,
            tenant_id=tenant_id,
            mode=mode,
            status="failed",
            progress=100,
            message=str(exc),
            result=summary,
            error=str(exc),
        )
        return summary

    summary["completed_at"] = datetime.now(timezone.utc).isoformat()
    await _write_job_status(
        ctx,
        job_id=job_id,
        tenant_id=tenant_id,
        mode=mode,
        status="complete",
        progress=100,
        message=(
            f"Done: {summary['total_fetched']} fetched, "
            f"{summary['total_timesheets_created']} staged, "
            f"{summary['total_skipped']} skipped."
        ),
        result=summary,
    )
    return summary


async def _prefetch_mailbox_messages(
    ctx: dict,
    tenant_id: int,
    job_id: str,
    summary: dict[str, Any],
    *,
    tenant_slug: str | None = None,
) -> list[tuple[Mailbox, list[dict] | None]]:
    """Load mailboxes and fetch raw messages; sessions close before IMAP work.

    The ``messages`` element is ``None`` when the IMAP fetch FAILED for
    that mailbox (timeout, auth, network) — callers MUST treat None as
    "do not advance the cursor". An empty list ``[]`` means the fetch
    succeeded and the server returned no new messages, which is the
    correct condition to advance the cursor to now.
    """
    from app.db import AsyncSessionLocal
    from app.db_tenant import tenant_session

    def _open_session():
        return tenant_session(tenant_slug) if tenant_slug else AsyncSessionLocal()

    async with _open_session() as session:
        result = await session.execute(
            select(Mailbox).where(
                (Mailbox.tenant_id == tenant_id) & (Mailbox.is_active == True)
            )
        )
        mailboxes = list(result.scalars().all())

    if not mailboxes:
        return []

    mailbox_messages: list[tuple[Mailbox, list[dict] | None]] = []
    for index, mailbox in enumerate(mailboxes, start=1):
        progress = 10 + int(((index - 1) / max(len(mailboxes), 1)) * 35)
        await _write_job_status(
            ctx,
            job_id=job_id,
            tenant_id=tenant_id,
            mode="fetch",
            status="in_progress",
            progress=progress,
            message=f"Connecting to {mailbox.label}...",
        )
        try:
            async with _open_session() as fetch_session:
                messages = await fetch_messages(mailbox, fetch_session)
            # Shadow-mode comparison (opt-in via INGESTION_SHADOW_LOG_PATH).
            # Logs the metadata-only vs full-fetch classifier divergence to
            # a JSONL file. NEVER affects production behavior — observation
            # only — so we ignore its result and swallow its errors.
            try:
                from app.core.config import settings as _shadow_settings
                if _shadow_settings.ingestion_shadow_log_path:
                    from app.services.ingestion_shadow import run_shadow_comparison
                    async with _open_session() as shadow_session:
                        await run_shadow_comparison(
                            mailbox, shadow_session, messages,
                            log_path=_shadow_settings.ingestion_shadow_log_path,
                        )
            except Exception as shadow_exc:
                logger.debug(
                    "Shadow mode comparison failed for mailbox %s: %s",
                    mailbox.id, shadow_exc,
                )
            # Clear any prior error on success — best-effort. If this
            # maintenance write fails (e.g. tenant DB is missing the
            # last_fetch_error column from a partially-applied migration)
            # we still keep the messages we just fetched.
            try:
                async with _open_session() as err_session:
                    fresh = await err_session.get(Mailbox, mailbox.id)
                    if fresh is not None:
                        fresh.last_fetch_error = None
                        fresh.last_fetch_failed_at = None
                        # Reset the consecutive-failure counter and clear
                        # any auto-disable reason now that fetch works.
                        fresh.consecutive_fetch_failures = 0
                        fresh.auto_disabled_reason = None
                        await err_session.commit()
            except Exception as clear_exc:
                logger.debug("Could not clear mailbox fetch error: %s", clear_exc)
            mailbox_messages.append((mailbox, messages))
        except Exception as exc:
            logger.error("Failed to fetch messages from mailbox %s: %s", mailbox.id, exc)
            summary["mailboxes_failed"] += 1
            summary["errors"].append(f"Mailbox {mailbox.id} ({mailbox.label}): {exc}")
            # Persist error + increment the consecutive-failure counter.
            # When the counter crosses the threshold, flip is_active off and
            # set auto_disabled_reason so the UI shows a clear banner.
            try:
                async with _open_session() as err_session:
                    fresh = await err_session.get(Mailbox, mailbox.id)
                    if fresh is not None:
                        fresh.last_fetch_error = str(exc)[:1024]
                        fresh.last_fetch_failed_at = datetime.now(timezone.utc)
                        fresh.consecutive_fetch_failures = (
                            (fresh.consecutive_fetch_failures or 0) + 1
                        )
                        if fresh.consecutive_fetch_failures >= MAILBOX_AUTO_DISABLE_THRESHOLD and fresh.is_active:
                            fresh.is_active = False
                            fresh.auto_disabled_reason = (
                                f"Couldn't connect to this mailbox {fresh.consecutive_fetch_failures} "
                                f"times in a row. Last error: {str(exc)[:200]}"
                            )
                            logger.warning(
                                "Auto-disabled mailbox %s (%s) after %d consecutive failures",
                                mailbox.id, mailbox.label, fresh.consecutive_fetch_failures,
                            )
                        await err_session.commit()
            except Exception as persist_exc:
                logger.debug("Could not persist mailbox fetch error: %s", persist_exc)
            # None (not []) so the downstream cursor-advance logic can
            # distinguish "fetch failed" from "fetch succeeded, 0 new".
            mailbox_messages.append((mailbox, None))

    return mailbox_messages


async def _run_fetch_job(
    ctx: dict,
    session: AsyncSession,
    tenant_id: int,
    job_id: str,
    summary: dict[str, Any],
    prefetched: list[tuple[Mailbox, list[dict] | None]] | None = None,
    *,
    tenant_slug: str | None = None,
) -> None:
    if prefetched is None:
        return

    if not prefetched:
        await _write_job_status(
            ctx,
            job_id=job_id,
            tenant_id=tenant_id,
            mode="fetch",
            status="complete",
            progress=100,
            message="No active mailboxes configured.",
            result=summary,
        )
        return

    # Initialize aggregate counters once we know mailbox count + a rough
    # message-total estimate (sum of pre-fetched message lists). Real
    # messages_processed bumps live inside _process_one.
    total_mailboxes = len(prefetched)
    total_messages = sum(
        len(m) for _, m in prefetched if isinstance(m, list)
    )
    await _write_job_status(
        ctx,
        job_id=job_id,
        tenant_id=tenant_id,
        mode="fetch",
        status="in_progress",
        progress=45,
        message=f"Starting processing across {total_mailboxes} mailbox(es)...",
        counters={
            "mailboxes_total": total_mailboxes,
            "mailboxes_processed": 0,
            "messages_total": total_messages,
            "messages_processed": 0,
        },
    )

    cumulative_messages_processed = 0
    for index, (mailbox, messages) in enumerate(prefetched, start=1):
        mailbox_label = mailbox.label
        progress = 45 + int(((index - 1) / max(len(prefetched), 1)) * 45)
        await _write_job_status(
            ctx,
            job_id=job_id,
            tenant_id=tenant_id,
            mode="fetch",
            status="in_progress",
            progress=progress,
            message=f"Processing {mailbox_label}...",
        )
        mailbox_progress_start = 45 + int(((index - 1) / max(len(prefetched), 1)) * 45)
        mailbox_progress_range = int(45 / max(len(prefetched), 1))
        mailbox_result = await _process_mailbox(
            mailbox=mailbox,
            messages=messages,
            tenant_id=tenant_id,
            session=session,
            ctx=ctx,
            job_id=job_id,
            base_progress=mailbox_progress_start,
            progress_range=mailbox_progress_range,
            tenant_slug=tenant_slug,
        )
        if mailbox_result["success"]:
            summary["mailboxes_processed"] += 1
            summary["total_fetched"] += mailbox_result["fetched"]
            summary["total_new"] += mailbox_result["new"]
            summary["total_skipped"] += mailbox_result["skipped"]
            summary["total_timesheets_created"] += mailbox_result["timesheets_created"]
            for reason, count in mailbox_result["skip_reasons"].items():
                summary["skip_reasons"][reason] = summary["skip_reasons"].get(reason, 0) + count
            summary["message_diagnostics"].extend(mailbox_result["message_diagnostics"])
        else:
            summary["mailboxes_failed"] += 1
            summary["errors"].append(
                f"Mailbox {mailbox.id} ({mailbox_label}): {mailbox_result['error']}"
            )

        # Track real per-mailbox completion. cumulative_messages_processed
        # advances by however many messages this mailbox had — even if
        # some were skipped/errored inside the per-message path, they
        # still count as "processed" from the user's perspective.
        cumulative_messages_processed += mailbox_result.get("fetched", 0)
        await _write_job_status(
            ctx,
            job_id=job_id,
            tenant_id=tenant_id,
            mode="fetch",
            status="in_progress",
            progress=min(90, progress + 10),
            message=(
                f"Processed {mailbox_label}: {mailbox_result['fetched']} fetched, "
                f"{mailbox_result['timesheets_created']} staged."
            ),
            result=summary,
            counters={
                "mailboxes_processed": index,
                "messages_processed": cumulative_messages_processed,
            },
        )


async def _run_reprocess_job(
    ctx: dict,
    session: AsyncSession,
    tenant_id: int,
    job_id: str,
    summary: dict[str, Any],
    *,
    mode: str,
    email_id: int | None,
    attachment_ids: list[int],
) -> None:
    query = select(IngestedEmail).where(IngestedEmail.tenant_id == tenant_id)
    if mode == "reprocess_skipped":
        query = query.where(
            (IngestedEmail.has_attachments == True)
            & (~IngestedEmail.ingestion_timesheets.any())
        )
    elif mode in ("reprocess_attachments", "reprocess_email"):
        if email_id is None:
            raise ValueError(f"email_id is required for mode '{mode}'")
        query = query.where(IngestedEmail.id == email_id)
    else:
        if email_id is not None:
            query = query.where(IngestedEmail.id == email_id)

    query = query.order_by(IngestedEmail.received_at.desc().nullslast(), IngestedEmail.id.desc())
    email_result = await session.execute(query)
    emails = list(email_result.scalars().all())

    if not emails:
        await _write_job_status(
            ctx,
            job_id=job_id,
            tenant_id=tenant_id,
            mode=mode,
            status="complete",
            progress=100,
            message="No stored emails matched this reprocess request.",
            result=summary,
        )
        return

    summary["total_fetched"] = len(emails)
    for index, email_record in enumerate(emails, start=1):
        progress = 10 + int((index / max(len(emails), 1)) * 80)
        await _write_job_status(
            ctx,
            job_id=job_id,
            tenant_id=tenant_id,
            mode=mode,
            status="in_progress",
            progress=progress,
            message=f"Reprocessing {email_record.subject or email_record.sender_email}...",
            result=summary,
        )
        pipeline_result = await reprocess_stored_email(
            email_id=email_record.id,
            tenant_id=tenant_id,
            session=session,
            attachment_ids=attachment_ids if mode == "reprocess_attachments" else None,
        )
        if pipeline_result.skipped:
            summary["total_skipped"] += 1
            reason = pipeline_result.skip_reason or "unknown"
            summary["skip_reasons"][reason] = summary["skip_reasons"].get(reason, 0) + 1
        else:
            summary["total_new"] += 1
            summary["total_timesheets_created"] += pipeline_result.timesheets_created

        summary["message_diagnostics"].append(
            {
                "email_id": pipeline_result.email_id,
                "message_id": pipeline_result.message_id,
                "subject": pipeline_result.subject,
                "sender_email": pipeline_result.sender_email,
                "skipped": pipeline_result.skipped,
                "skip_reason": pipeline_result.skip_reason,
                "skip_detail": pipeline_result.skip_detail,
                "timesheets_created": pipeline_result.timesheets_created,
                "errors": pipeline_result.errors,
            }
        )

        if pipeline_result.errors:
            summary["errors"].extend(pipeline_result.errors)


async def _process_mailbox(
    mailbox: Mailbox,
    messages: list[dict] | None,
    tenant_id: int,
    session: AsyncSession,
    ctx: dict | None = None,
    job_id: str | None = None,
    base_progress: int = 10,
    progress_range: int = 70,
    *,
    tenant_slug: str | None = None,
) -> dict:
    """Process pre-fetched messages from one mailbox. Never raises.

    ``messages=None`` signals the upstream IMAP fetch FAILED for this
    mailbox — we must NOT advance the cursor in that case (doing so
    causes silent data loss: anything that was about to be re-pulled
    after a cursor rewind gets skipped on the next fetch). The mailbox
    is reported as failed and we return without touching the cursor.
    """
    mailbox_id = mailbox.id
    mailbox_label = mailbox.label
    result = {
        "success": False,
        "fetched": len(messages) if messages is not None else 0,
        "new": 0,
        "skipped": 0,
        "timesheets_created": 0,
        "skip_reasons": {},
        "message_diagnostics": [],
        "error": None,
    }

    if messages is None:
        # IMAP fetch failed upstream — error is already logged and
        # persisted on the mailbox row in _prefetch_mailbox_messages.
        result["error"] = "imap_fetch_failed"
        return result

    try:
        if not messages:
            await update_last_fetched_at(mailbox, session)
            await session.commit()
            result["success"] = True
            return result

        # Up to 5 in parallel; each message gets its own DB session.
        import asyncio
        from app.db import AsyncSessionLocal
        from app.db_tenant import tenant_session

        def _open_msg_session():
            return tenant_session(tenant_slug) if tenant_slug else AsyncSessionLocal()

        total_messages = len(messages)
        CONCURRENCY = 5
        sem = asyncio.Semaphore(CONCURRENCY)
        diagnostics_lock = asyncio.Lock()

        async def _process_one(msg_index: int, raw_message: dict):
            async with sem:
                if ctx and job_id and total_messages > 0:
                    msg_progress = base_progress + int(((msg_index) / total_messages) * progress_range)
                    await _write_job_status(
                        ctx,
                        job_id=job_id,
                        tenant_id=tenant_id,
                        mode="fetch",
                        status="in_progress",
                        progress=msg_progress,
                        message=f"Processing email {msg_index + 1}/{total_messages} from {mailbox_label}...",
                    )

                try:
                    async with _open_msg_session() as msg_session:
                        pipeline_result = await process_email(
                            raw_message=raw_message,
                            mailbox_id=mailbox.id,
                            tenant_id=tenant_id,
                            session=msg_session,
                        )
                        await msg_session.commit()

                    async with diagnostics_lock:
                        if pipeline_result.skipped:
                            result["skipped"] += 1
                            reason = pipeline_result.skip_reason or "unknown"
                            result["skip_reasons"][reason] = result["skip_reasons"].get(reason, 0) + 1
                        else:
                            result["new"] += 1
                            result["timesheets_created"] += pipeline_result.timesheets_created

                        result["message_diagnostics"].append(
                            {
                                "email_id": pipeline_result.email_id,
                                "message_id": pipeline_result.message_id,
                                "subject": pipeline_result.subject,
                                "sender_email": pipeline_result.sender_email,
                                "skipped": pipeline_result.skipped,
                                "skip_reason": pipeline_result.skip_reason,
                                "skip_detail": pipeline_result.skip_detail,
                                "timesheets_created": pipeline_result.timesheets_created,
                                "errors": pipeline_result.errors,
                            }
                        )

                except Exception as exc:
                    logger.error(
                        "Failed to process message in mailbox %s: %s",
                        mailbox_id,
                        exc,
                    )
                    async with diagnostics_lock:
                        result["skipped"] += 1
                        result["message_diagnostics"].append(
                            {
                                "email_id": None,
                                "message_id": None,
                                "subject": None,
                                "sender_email": None,
                                "skipped": True,
                                "skip_reason": "message_processing_failed",
                                "skip_detail": str(exc),
                                "timesheets_created": 0,
                                "errors": [str(exc)],
                            }
                        )

        await asyncio.gather(*[
            _process_one(idx, msg) for idx, msg in enumerate(messages)
        ])

        await update_last_fetched_at(mailbox, session)
        await session.commit()
        result["success"] = True
    except Exception as exc:
        logger.error("Mailbox %s fetch failed: %s", mailbox_id, exc)
        try:
            await session.rollback()
        except Exception:
            logger.debug("Rollback after mailbox failure also failed", exc_info=True)
        result["error"] = str(exc)

    return result


async def enqueue_reprocess_skipped_fanout(
    tenant_id: int,
    email_ids: list[int],
    *,
    tenant_slug: str | None = None,
) -> str:
    """Enqueue one reprocess job per email so a slow attachment can't
    consume the whole 300s budget. Umbrella status is marked complete
    immediately; per-email jobs track their own progress."""
    from arq import create_pool
    from app.workers.settings import get_redis_settings

    redis = await create_pool(get_redis_settings())
    try:
        timestamp = int(datetime.now(timezone.utc).timestamp())
        batch_id = f"reprocess_skipped_batch_tenant_{tenant_id}_{timestamp}"

        if not email_ids:
            await _write_job_status(
                {"redis": redis},
                job_id=batch_id,
                tenant_id=tenant_id,
                mode="reprocess_skipped",
                status="complete",
                progress=100,
                message="No skipped emails to reprocess.",
                result={"enqueued": 0},
            )
            return batch_id

        for email_id in email_ids:
            child_id = f"reprocess_email_tenant_{tenant_id}_{email_id}_{timestamp}"
            await _write_job_status(
                {"redis": redis},
                job_id=child_id,
                tenant_id=tenant_id,
                mode="reprocess_email",
                status="queued",
                progress=0,
                message=f"Reprocess job queued for email {email_id}.",
            )
            enqueue_kwargs = {"_job_id": child_id}
            if tenant_slug is not None:
                enqueue_kwargs["tenant_slug"] = tenant_slug
            await redis.enqueue_job(
                "fetch_emails_for_tenant",
                tenant_id,
                "reprocess_email",
                email_id,
                [],
                **enqueue_kwargs,
            )

        await _write_job_status(
            {"redis": redis},
            job_id=batch_id,
            tenant_id=tenant_id,
            mode="reprocess_skipped",
            status="complete",
            progress=100,
            message=(
                f"Dispatched {len(email_ids)} per-email reprocess jobs. "
                "Individual progress is tracked per child job; the skipped "
                "list will shrink as each completes."
            ),
            result={"enqueued": len(email_ids)},
        )
        return batch_id
    except Exception as exc:
        raise RuntimeError(f"Failed to enqueue reprocess-skipped fan-out: {exc}. Is Redis running?") from exc
    finally:
        await redis.close()


async def enqueue_fetch_job(
    tenant_id: int,
    *,
    mode: str = "fetch",
    email_id: int | None = None,
    attachment_ids: list[int] | None = None,
    tenant_slug: str | None = None,
) -> str:
    """Enqueue a fetch/reprocess job; ``tenant_slug`` lets the worker
    skip a control-plane lookup when known by the caller."""
    from arq import create_pool
    from arq.constants import (
        default_queue_name,
        in_progress_key_prefix,
        job_key_prefix,
        result_key_prefix,
        retry_key_prefix,
    )
    from arq.jobs import Job, JobStatus

    from app.workers.settings import get_redis_settings

    redis = await create_pool(get_redis_settings())
    try:
        if mode == "fetch":
            job_id = f"fetch_tenant_{tenant_id}"
            existing_job = Job(job_id, redis)
            existing_status = await existing_job.status()

            if existing_status in (JobStatus.deferred, JobStatus.queued, JobStatus.in_progress):
                return job_id

            if existing_status != JobStatus.not_found:
                await redis.delete(
                    job_key_prefix + job_id,
                    in_progress_key_prefix + job_id,
                    result_key_prefix + job_id,
                    retry_key_prefix + job_id,
                    _status_key(job_id),
                )
                await redis.zrem(default_queue_name, job_id)
        else:
            target_token = str(email_id or "all")
            timestamp = int(datetime.now(timezone.utc).timestamp())
            job_id = f"{mode}_tenant_{tenant_id}_{target_token}_{timestamp}"

        await _write_job_status(
            {"redis": redis},
            job_id=job_id,
            tenant_id=tenant_id,
            mode=mode,
            status="queued",
            progress=0,
            message=(
                "Fetch job queued for this tenant."
                if mode == "fetch"
                else "Reprocess job queued for this tenant."
            ),
        )

        enqueue_kwargs = {"_job_id": job_id}
        if tenant_slug is not None:
            enqueue_kwargs["tenant_slug"] = tenant_slug
        job = await redis.enqueue_job(
            "fetch_emails_for_tenant",
            tenant_id,
            mode,
            email_id,
            attachment_ids or [],
            **enqueue_kwargs,
        )
        if job is None:
            return job_id
        return job_id
    except Exception as exc:
        raise RuntimeError(f"Failed to enqueue fetch job: {exc}. Is Redis running?") from exc
    finally:
        await redis.close()


async def scheduled_fetch_emails(ctx: dict) -> None:
    """arq cron task: every 15 min, fan out fetch jobs over active tenants."""
    from app.workers.reminder_worker import _load_tenant_settings
    from app.db_control import AsyncControlSessionLocal
    from app.db_tenant import tenant_session
    from app.models.control import ControlTenant

    async with AsyncControlSessionLocal() as control_session:
        result = await control_session.execute(
            select(ControlTenant).where(ControlTenant.status == "active")
        )
        control_tenants = list(result.scalars().all())

    # Evaluate each tenant's fetch window in its own timezone. The
    # source of truth is the per-tenant ``tenant_default_timezone``
    # setting (that's what the Settings UI writes and what the system
    # health probe reads). ``control_tenant.timezone`` is a coarser
    # fallback for tenants that haven't picked one yet — evaluating in
    # UTC silently when the user configured the window in a local
    # timezone made the cron skip every tick while the health card
    # complained.
    from app.core.timezone_utils import now_for_tenant

    for control_tenant in control_tenants:
        try:
            async with tenant_session(control_tenant.slug) as session:
                tenant_settings = await _load_tenant_settings(
                    control_tenant.id, session
                )

            if tenant_settings.get("fetch_emails_enabled") != "true":
                continue

            tenant_tz = (
                tenant_settings.get("tenant_default_timezone")
                or control_tenant.timezone
            )
            now = now_for_tenant(tenant_tz)

            if not _should_fetch_now(tenant_settings, now):
                continue

            await enqueue_fetch_job(
                control_tenant.id, tenant_slug=control_tenant.slug
            )
            logger.info(
                "Auto-fetch enqueued for tenant %s (%s)",
                control_tenant.id, control_tenant.slug,
            )
        except Exception as exc:
            logger.error(
                "Auto-fetch enqueue failed for tenant %s (%s): %s",
                control_tenant.id, control_tenant.slug, exc,
            )


def _should_fetch_now(tenant_settings: dict, now: datetime) -> bool:
    """
    Returns True if the current time falls within a cron window
    that matches the tenant's fetch schedule.
    Defaults are read from app settings (configurable via .env).
    """
    from app.core.config import settings as app_settings

    interval = int(tenant_settings.get(
        "fetch_emails_interval_minutes",
        str(app_settings.email_fetch_interval_minutes),
    ))
    days_str = tenant_settings.get(
        "fetch_emails_days",
        app_settings.email_fetch_days,
    )
    start_time_str = tenant_settings.get(
        "fetch_emails_start_time",
        app_settings.email_fetch_start_time,
    )
    end_time_str = tenant_settings.get(
        "fetch_emails_end_time",
        app_settings.email_fetch_end_time,
    )

    # Strip stray quotes/whitespace defensively — JSON-encoded rows that
    # bypassed _load_tenant_settings's decoder would otherwise sneak in
    # values like '"08:00"' (literal quotes included).
    def _clean(s: str) -> str:
        return (s or "").strip().strip('"').strip("'")

    days_str = _clean(days_str)
    start_time_str = _clean(start_time_str)
    end_time_str = _clean(end_time_str)

    day_names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    allowed_days = [d.strip().lower() for d in days_str.split(",") if d.strip()]
    current_day = day_names[now.weekday()]
    if current_day not in allowed_days:
        return False

    current_minutes = now.hour * 60 + now.minute
    try:
        start_h, start_m = map(int, start_time_str.split(":"))
        end_h, end_m = map(int, end_time_str.split(":"))
    except (ValueError, AttributeError):
        logger.warning(
            "Auto-fetch skipped: malformed time-window settings "
            "(start_time=%r end_time=%r). Check fetch_emails_start_time / "
            "fetch_emails_end_time in tenant_settings.",
            start_time_str, end_time_str,
        )
        return False
    start_total = start_h * 60 + start_m
    end_total = end_h * 60 + end_m
    if not (start_total <= current_minutes <= end_total):
        return False

    minutes_since_start = current_minutes - start_total
    if minutes_since_start < 0:
        return False
    # Cron window width: derive from the cron schedule so we don't miss a
    # tick.  Parse the configured minutes and use the smallest gap, capped
    # at 15 as a sensible floor.
    try:
        cron_mins = sorted(
            int(m.strip())
            for m in app_settings.worker_cron_minutes.split(",")
            if m.strip()
        )
        if len(cron_mins) >= 2:
            cron_window = min(cron_mins[i + 1] - cron_mins[i] for i in range(len(cron_mins) - 1))
        else:
            cron_window = 15
    except (ValueError, AttributeError):
        cron_window = 15
    return minutes_since_start % interval < cron_window


async def cancel_fetch_job(job_id: str, tenant_id: int) -> dict:
    """Abort an in-flight fetch/reprocess job and release its lock.

    Cooperative cancel via arq's ``Job.abort()``: the worker may still
    finish processing the current message before stopping, which is
    fine — each message commits independently so there's no half-state.
    The status flips to ``cancelled`` in Redis immediately regardless,
    so the UI shows the new state on the next poll.

    Also clears the per-(tenant, mode) Redis fetch lock so a fresh
    fetch can start right away. Without this the lock would sit until
    its TTL expired (~6 min) and the next click would silently skip
    with "another run in progress".

    Returns the final status payload. Raises RuntimeError if Redis is
    unreachable.
    """
    from arq import create_pool
    from arq.jobs import Job, JobStatus

    from app.workers.settings import get_redis_settings

    redis = await create_pool(get_redis_settings())
    try:
        job = Job(job_id, redis)
        prior_status = await job.status()

        # Best-effort abort. arq's abort flips an abort-signal key the
        # worker checks between steps; the worker honors it cooperatively.
        # If the job already finished (complete / not_found / failed),
        # abort() returns False but we still want to release the lock
        # and flip status, so we don't gate on its return value.
        try:
            await job.abort(timeout=0)
        except Exception as exc:
            # arq raises if the job isn't running; that's fine — we
            # still want to mark the status row.
            logger.debug("Job.abort() raised on job_id=%s: %s", job_id, exc)

        # Derive the mode from the job_id (best-effort; fetch is the
        # common case). Used to compute the lock key to release.
        if job_id.startswith("fetch_tenant_"):
            mode = "fetch"
        elif job_id.startswith("reprocess_tenant_") or "_reprocess_" in job_id:
            mode = "reprocess_email"
        else:
            mode = "fetch"
        lock_key = _fetch_lock_key(tenant_id, mode)
        try:
            # Best-effort lock release. We don't have the lock token so we
            # can't use the safe Lua CAS — but cancel is an explicit user
            # action, and the alternative is leaving a dead worker's lock
            # in place for the full TTL. Use a direct DELETE.
            await redis.delete(lock_key)
        except Exception as exc:
            logger.debug("Lock release on cancel failed for key=%s: %s", lock_key, exc)

        # Flip status to cancelled. _write_job_status preserves
        # started_at and updates updated_at, so the UI sees a fresh
        # tick (no longer "stale") with the new state.
        await _write_job_status(
            {"redis": redis},
            job_id=job_id,
            tenant_id=tenant_id,
            mode=mode,
            status="cancelled",
            progress=100,
            message="Cancelled by user.",
        )

        logger.info(
            "Cancelled job_id=%s tenant_id=%s (prior_status=%s)",
            job_id, tenant_id, prior_status,
        )
        return await get_job_status(job_id)
    except Exception as exc:
        raise RuntimeError(f"Failed to cancel job: {exc}. Is Redis running?") from exc
    finally:
        await redis.close()


async def cancel_all_fetch_jobs_for_tenant(tenant_id: int) -> int:
    """Admin kill-switch: scan Redis for any active job status rows
    keyed to this tenant and cancel each. Used by the Settings →
    Mailboxes admin panel when the user wants to clear a wedged worker
    queue.

    Returns the count of jobs cancelled. Best-effort: each cancel runs
    in its own try/except so one bad job doesn't poison the sweep.
    """
    from arq import create_pool
    from app.workers.settings import get_redis_settings

    redis = await create_pool(get_redis_settings())
    cancelled_count = 0
    try:
        # Scan for status rows of this tenant. Status key shape:
        # ingestion:job-status:<job_id>. We can't filter by tenant in the
        # key, so we read each row's payload and match tenant_id.
        cursor = 0
        prefix = "ingestion:job-status:"
        candidate_job_ids: list[str] = []
        while True:
            cursor, keys = await redis.scan(cursor=cursor, match=f"{prefix}*", count=100)
            for key in keys:
                try:
                    raw = await redis.get(key)
                    if not raw:
                        continue
                    payload = json.loads(raw)
                    if payload.get("tenant_id") != tenant_id:
                        continue
                    if payload.get("status") in ("complete", "failed", "cancelled", "not_found"):
                        continue
                    candidate_job_ids.append(payload.get("job_id"))
                except Exception as inner_exc:
                    logger.debug("Skipped key %s during admin sweep: %s", key, inner_exc)
            if cursor == 0:
                break
    finally:
        await redis.close()

    # Cancel each candidate using the per-job function (handles lock
    # release + status flip + arq abort).
    for job_id in candidate_job_ids:
        if not job_id:
            continue
        try:
            await cancel_fetch_job(job_id, tenant_id)
            cancelled_count += 1
        except Exception as exc:
            logger.warning("Admin sweep: failed to cancel job_id=%s: %s", job_id, exc)

    logger.info(
        "Admin sweep cancelled %d jobs for tenant_id=%s",
        cancelled_count, tenant_id,
    )
    return cancelled_count


async def get_job_status(job_id: str) -> dict:
    """
    Poll the status of a job by job_id.
    """
    from arq import create_pool
    from arq.jobs import Job, JobStatus

    from app.workers.settings import get_redis_settings

    redis = await create_pool(get_redis_settings())
    try:
        stored_status = await redis.get(_status_key(job_id))
        if stored_status:
            payload = json.loads(stored_status)
            return payload

        job = Job(job_id, redis)
        status = await job.status()

        # Synthesized payloads when no per-job status row is found. Fill in
        # started_at/updated_at with the current time so the schema shape
        # stays consistent and the frontend's staleness check has data to
        # work with (these synthesized rows are by definition "fresh"
        # because we just observed them via arq state).
        now_iso = datetime.now(timezone.utc).isoformat()
        if status == JobStatus.complete:
            result = await job.result()
            return {
                "status": "complete", "job_id": job_id, "progress": 100,
                "message": "Done", "result": result,
                "started_at": now_iso, "updated_at": now_iso,
            }
        if status == JobStatus.in_progress:
            return {
                "status": "in_progress", "job_id": job_id, "progress": 50,
                "message": "Processing...",
                "started_at": now_iso, "updated_at": now_iso,
            }
        if status in (JobStatus.deferred, JobStatus.queued):
            return {
                "status": "queued", "job_id": job_id, "progress": 0,
                "message": "Queued...",
                "started_at": now_iso, "updated_at": now_iso,
            }
        return {
            "status": "not_found", "job_id": job_id, "progress": 0,
            "message": "Job not found.",
            "started_at": now_iso, "updated_at": now_iso,
        }
    except Exception as exc:
        raise RuntimeError(f"Failed to get job status: {exc}. Is Redis running?") from exc
    finally:
        await redis.close()
