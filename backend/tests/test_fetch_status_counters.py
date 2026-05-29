"""
Regression tests for audit finding F-09 — real progress counters.

Pre-fix: the ``progress`` percentage was the only quantitative signal,
and it was a hardcoded ladder (5/10/45/90/100) anchored to mailbox
index rather than actual work. The user could see "Processing 7/12"
but couldn't tell whether that was honest or invented.

Post-fix: the worker writes a ``counters`` dict into the Redis status
row with ``messages_processed``, ``messages_total``,
``mailboxes_processed``, ``mailboxes_total``. The frontend renders the
honest text alongside the (still-approximate) bar.

Three properties this test pins:

  1. Counters round-trip through ``_write_job_status`` via Redis.
  2. Multiple calls MERGE — caller-supplied counters override prior
     keys but DON'T clobber keys the caller didn't touch.
  3. A call without ``counters`` preserves whatever the prior write
     stored (so a mailbox-level status update doesn't wipe the
     accumulated message counts).
"""
import json

import pytest

from app.workers.email_fetch import _status_key, _write_job_status


class _FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    async def get(self, key):
        return self.store.get(key)

    async def setex(self, key, ttl, value):
        self.store[key] = value


@pytest.mark.asyncio
async def test_first_write_persists_supplied_counters():
    redis = _FakeRedis()
    ctx = {"redis": redis}
    await _write_job_status(
        ctx, job_id="fetch_tenant_1", tenant_id=1, mode="fetch",
        status="in_progress", progress=45, message="Starting...",
        counters={"mailboxes_total": 3, "messages_total": 47,
                  "mailboxes_processed": 0, "messages_processed": 0},
    )
    stored = json.loads(redis.store[_status_key("fetch_tenant_1")])
    assert stored["counters"] == {
        "mailboxes_total": 3,
        "messages_total": 47,
        "mailboxes_processed": 0,
        "messages_processed": 0,
    }


@pytest.mark.asyncio
async def test_subsequent_write_merges_partial_counters():
    """Mailbox-level updates should bump mailboxes_processed and
    messages_processed without clobbering mailboxes_total /
    messages_total set by the initial write."""
    redis = _FakeRedis()
    ctx = {"redis": redis}

    # Initial write sets totals.
    await _write_job_status(
        ctx, job_id="fetch_tenant_1", tenant_id=1, mode="fetch",
        status="in_progress", progress=45, message="Starting...",
        counters={"mailboxes_total": 3, "messages_total": 47,
                  "mailboxes_processed": 0, "messages_processed": 0},
    )
    # Partial update: only the "processed" keys.
    await _write_job_status(
        ctx, job_id="fetch_tenant_1", tenant_id=1, mode="fetch",
        status="in_progress", progress=55, message="Processed mailbox 1...",
        counters={"mailboxes_processed": 1, "messages_processed": 12},
    )
    stored = json.loads(redis.store[_status_key("fetch_tenant_1")])
    assert stored["counters"] == {
        "mailboxes_total": 3,
        "messages_total": 47,
        "mailboxes_processed": 1,
        "messages_processed": 12,
    }


@pytest.mark.asyncio
async def test_write_without_counters_preserves_prior_counters():
    """A status update that doesn't include counters (e.g. a mailbox
    failure message) should NOT wipe the accumulated counts."""
    redis = _FakeRedis()
    ctx = {"redis": redis}

    await _write_job_status(
        ctx, job_id="fetch_tenant_1", tenant_id=1, mode="fetch",
        status="in_progress", progress=45, message="x",
        counters={"mailboxes_total": 2, "mailboxes_processed": 1,
                  "messages_total": 30, "messages_processed": 15},
    )
    # No counters arg this time.
    await _write_job_status(
        ctx, job_id="fetch_tenant_1", tenant_id=1, mode="fetch",
        status="in_progress", progress=70, message="Mailbox 2 failed",
    )
    stored = json.loads(redis.store[_status_key("fetch_tenant_1")])
    # Counters preserved from the earlier write.
    assert stored["counters"] == {
        "mailboxes_total": 2,
        "mailboxes_processed": 1,
        "messages_total": 30,
        "messages_processed": 15,
    }


@pytest.mark.asyncio
async def test_first_write_without_counters_emits_null():
    """When no counters have ever been written, the payload's ``counters``
    field is None — the frontend treats absence as "no real numbers yet"
    and falls back to the message text."""
    redis = _FakeRedis()
    ctx = {"redis": redis}
    await _write_job_status(
        ctx, job_id="fetch_tenant_99", tenant_id=99, mode="fetch",
        status="queued", progress=0, message="Queued...",
    )
    stored = json.loads(redis.store[_status_key("fetch_tenant_99")])
    assert stored["counters"] is None


@pytest.mark.asyncio
async def test_corrupt_prior_counters_treated_as_empty():
    """If the prior payload's counters field is something we can't
    parse (e.g. accidentally written as a string by a future bug), we
    fall back to treating it as empty rather than crashing."""
    redis = _FakeRedis()
    redis.store[_status_key("fetch_tenant_5")] = json.dumps({
        "started_at": "2026-05-29T15:00:00Z",
        "counters": "this should be a dict but isn't",
    })
    ctx = {"redis": redis}
    await _write_job_status(
        ctx, job_id="fetch_tenant_5", tenant_id=5, mode="fetch",
        status="in_progress", progress=50, message="x",
        counters={"mailboxes_processed": 2},
    )
    stored = json.loads(redis.store[_status_key("fetch_tenant_5")])
    assert stored["counters"] == {"mailboxes_processed": 2}
