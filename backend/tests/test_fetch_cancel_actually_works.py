"""
Tests for the cancel-actually-works fix.

The first cancel implementation only flipped status in Redis and called
``arq.Job.abort()``. In production we observed cancel returning 200 but
the worker finishing the full batch (3 minutes for 45 emails) anyway,
because:

  1. arq's ``allow_abort_jobs`` wasn't enabled, so abort was effectively
     a no-op for in-flight jobs.
  2. The worker kept writing per-message ``status=in_progress`` rows,
     overwriting the ``status=cancelled`` row our endpoint had stamped.
  3. Nothing inside the per-message loop checked whether the user had
     asked to cancel.

This batch fixes all three. These tests pin the two pieces that live in
this module:

  A. ``_is_job_cancelled(ctx, job_id)`` returns True when the status
     row is terminal (cancelled / complete / failed), False otherwise.
  B. ``_write_job_status`` refuses to overwrite a terminal status with
     a non-terminal one (the "lockout" behavior).
  C. ``_write_job_status`` DOES allow writing a new terminal status on
     top of an existing terminal one (e.g. cancel after a job has
     already failed, or a late completion). The lockout only blocks
     in_progress / queued writes from clobbering a terminal row.

The arq ``allow_abort_jobs`` flag is on the worker settings module and
not unit-testable in isolation; this batch ships it together with the
worker code changes that are covered.
"""
import json

import pytest

from app.workers.email_fetch import (
    _is_job_cancelled,
    _status_key,
    _write_job_status,
)


class _FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    async def get(self, key):
        return self.store.get(key)

    async def setex(self, key, ttl, value):
        self.store[key] = value


# ── _is_job_cancelled ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_is_job_cancelled_true_when_status_is_cancelled():
    redis = _FakeRedis()
    redis.store[_status_key("fetch_tenant_1")] = json.dumps({
        "status": "cancelled", "job_id": "fetch_tenant_1",
    })
    assert await _is_job_cancelled({"redis": redis}, "fetch_tenant_1") is True


@pytest.mark.asyncio
async def test_is_job_cancelled_true_when_status_is_complete_or_failed():
    redis = _FakeRedis()
    redis.store[_status_key("a")] = json.dumps({"status": "complete"})
    redis.store[_status_key("b")] = json.dumps({"status": "failed"})
    assert await _is_job_cancelled({"redis": redis}, "a") is True
    assert await _is_job_cancelled({"redis": redis}, "b") is True


@pytest.mark.asyncio
async def test_is_job_cancelled_false_when_status_is_in_progress():
    redis = _FakeRedis()
    redis.store[_status_key("x")] = json.dumps({"status": "in_progress"})
    assert await _is_job_cancelled({"redis": redis}, "x") is False


@pytest.mark.asyncio
async def test_is_job_cancelled_false_when_no_status_row():
    redis = _FakeRedis()
    assert await _is_job_cancelled({"redis": redis}, "no_such_job") is False


@pytest.mark.asyncio
async def test_is_job_cancelled_false_on_redis_error():
    """If Redis errors mid-fetch, we'd rather complete the job than
    abort it spuriously. Returns False on any read failure."""
    class _BrokenRedis:
        async def get(self, key):
            raise RuntimeError("redis down")

    assert await _is_job_cancelled({"redis": _BrokenRedis()}, "x") is False


@pytest.mark.asyncio
async def test_is_job_cancelled_false_on_corrupt_payload():
    redis = _FakeRedis()
    redis.store[_status_key("x")] = "{not valid json"
    assert await _is_job_cancelled({"redis": redis}, "x") is False


@pytest.mark.asyncio
async def test_is_job_cancelled_returns_false_when_no_redis_in_ctx():
    assert await _is_job_cancelled({"redis": None}, "x") is False
    assert await _is_job_cancelled({}, "x") is False


# ── Terminal-status overwrite lockout ──────────────────────────────


@pytest.mark.asyncio
async def test_in_progress_write_blocked_after_cancelled():
    """The load-bearing test: after cancel writes status=cancelled,
    a subsequent in_progress write must be dropped on the floor so the
    UI keeps showing cancelled."""
    redis = _FakeRedis()
    ctx = {"redis": redis}
    job_id = "fetch_tenant_1"

    # Step 1: cancel writes terminal status.
    await _write_job_status(
        ctx, job_id=job_id, tenant_id=1, mode="fetch",
        status="cancelled", progress=100, message="Cancelled by user.",
    )

    cancelled_row = json.loads(redis.store[_status_key(job_id)])
    assert cancelled_row["status"] == "cancelled"

    # Step 2: a still-running worker tries to write an in_progress row.
    await _write_job_status(
        ctx, job_id=job_id, tenant_id=1, mode="fetch",
        status="in_progress", progress=60, message="Processing email 16/45...",
    )

    # The row in Redis is STILL the cancelled one — the worker's write
    # was dropped.
    final = json.loads(redis.store[_status_key(job_id)])
    assert final["status"] == "cancelled"
    assert final["message"] == "Cancelled by user."


@pytest.mark.asyncio
async def test_in_progress_write_blocked_after_complete():
    redis = _FakeRedis()
    ctx = {"redis": redis}
    job_id = "fetch_tenant_2"

    await _write_job_status(
        ctx, job_id=job_id, tenant_id=2, mode="fetch",
        status="complete", progress=100, message="Done.",
    )
    await _write_job_status(
        ctx, job_id=job_id, tenant_id=2, mode="fetch",
        status="in_progress", progress=50, message="should not stick",
    )

    final = json.loads(redis.store[_status_key(job_id)])
    assert final["status"] == "complete"


@pytest.mark.asyncio
async def test_in_progress_write_blocked_after_failed():
    redis = _FakeRedis()
    ctx = {"redis": redis}
    job_id = "fetch_tenant_3"

    await _write_job_status(
        ctx, job_id=job_id, tenant_id=3, mode="fetch",
        status="failed", progress=100, message="Oops.",
    )
    await _write_job_status(
        ctx, job_id=job_id, tenant_id=3, mode="fetch",
        status="in_progress", progress=70, message="should not stick",
    )

    final = json.loads(redis.store[_status_key(job_id)])
    assert final["status"] == "failed"


@pytest.mark.asyncio
async def test_terminal_to_terminal_overwrite_allowed():
    """One terminal write replacing another is allowed — e.g. a late
    completion notification after the user had already cancelled, or
    the cancel endpoint flipping a failed job. The lockout only blocks
    NON-terminal writes from clobbering a terminal row."""
    redis = _FakeRedis()
    ctx = {"redis": redis}
    job_id = "fetch_tenant_4"

    await _write_job_status(
        ctx, job_id=job_id, tenant_id=4, mode="fetch",
        status="cancelled", progress=100, message="Cancelled.",
    )
    # Same row, now flipped to a new terminal status (admin force-
    # complete, or operator running a recovery script).
    await _write_job_status(
        ctx, job_id=job_id, tenant_id=4, mode="fetch",
        status="complete", progress=100, message="Manually marked complete.",
    )

    final = json.loads(redis.store[_status_key(job_id)])
    assert final["status"] == "complete"
    assert final["message"] == "Manually marked complete."


@pytest.mark.asyncio
async def test_non_terminal_write_allowed_when_no_prior_status():
    """First write on a fresh job — no prior row to lock against, so
    the in_progress write lands normally."""
    redis = _FakeRedis()
    ctx = {"redis": redis}

    await _write_job_status(
        ctx, job_id="fetch_tenant_5", tenant_id=5, mode="fetch",
        status="in_progress", progress=10, message="Starting...",
    )

    final = json.loads(redis.store[_status_key("fetch_tenant_5")])
    assert final["status"] == "in_progress"


@pytest.mark.asyncio
async def test_non_terminal_to_non_terminal_overwrite_allowed():
    """Normal worker tick: in_progress → in_progress with a bumped
    counter is the happy path and must keep working."""
    redis = _FakeRedis()
    ctx = {"redis": redis}
    job_id = "fetch_tenant_6"

    await _write_job_status(
        ctx, job_id=job_id, tenant_id=6, mode="fetch",
        status="in_progress", progress=10, message="A",
    )
    await _write_job_status(
        ctx, job_id=job_id, tenant_id=6, mode="fetch",
        status="in_progress", progress=20, message="B",
    )

    final = json.loads(redis.store[_status_key(job_id)])
    assert final["status"] == "in_progress"
    assert final["message"] == "B"
    assert final["progress"] == 20
