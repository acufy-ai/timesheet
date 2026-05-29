"""
Regression tests for audit finding F-04 (worker_processing_findings,
2026-05-29 audit).

Three things this pins:

  1. ``_write_job_status`` stamps ``started_at`` on the first write for
     a job and PRESERVES it across all subsequent writes for the same
     ``job_id``.
  2. Every write also stamps ``updated_at`` with the current time so
     the frontend can compute (now - updated_at) to detect a stalled
     worker.
  3. ``_fetch_lock_ttl_seconds`` derives from ``worker_job_timeout``
     rather than the previous hard-coded 900s. A crashed worker no
     longer monopolizes the lock for 15 minutes after dying.
"""
import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.workers.email_fetch import (
    _fetch_lock_ttl_seconds,
    _status_key,
    _try_acquire_fetch_lock,
    _write_job_status,
)


class _FakeRedis:
    """Tiny in-memory async Redis stub. Records every setex call so we
    can assert what was written, and supports get() so the started_at
    preservation logic can read the prior value."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.setex_calls: list[tuple[str, int, str]] = []
        self.set_calls: list[tuple[str, str, int]] = []

    async def setex(self, key, ttl, value) -> None:
        self.setex_calls.append((key, ttl, value))
        self.store[key] = value

    async def get(self, key) -> str | None:
        return self.store.get(key)

    async def set(self, key, value, nx=False, ex=None):
        self.set_calls.append((key, value, ex))
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True


@pytest.mark.asyncio
async def test_first_status_write_stamps_started_at():
    redis = _FakeRedis()
    ctx = {"redis": redis}
    await _write_job_status(
        ctx, job_id="fetch_tenant_1", tenant_id=1, mode="fetch",
        status="in_progress", progress=5, message="Loading...",
    )
    stored = json.loads(redis.store[_status_key("fetch_tenant_1")])
    assert stored["started_at"] is not None
    assert stored["updated_at"] is not None
    assert stored["started_at"] == stored["updated_at"], (
        "first write should have started_at == updated_at"
    )


@pytest.mark.asyncio
async def test_subsequent_writes_preserve_started_at_and_move_updated_at():
    redis = _FakeRedis()
    ctx = {"redis": redis}

    await _write_job_status(
        ctx, job_id="fetch_tenant_1", tenant_id=1, mode="fetch",
        status="in_progress", progress=5, message="Loading...",
    )
    first = json.loads(redis.store[_status_key("fetch_tenant_1")])

    # Yield long enough that the wall-clock second ticks. asyncio.sleep
    # is enough; we don't need real time.
    await asyncio.sleep(0.01)

    await _write_job_status(
        ctx, job_id="fetch_tenant_1", tenant_id=1, mode="fetch",
        status="in_progress", progress=45, message="Processing mailbox 1...",
    )
    second = json.loads(redis.store[_status_key("fetch_tenant_1")])

    assert second["started_at"] == first["started_at"], (
        "started_at must persist across writes for the same job_id"
    )
    assert second["updated_at"] >= first["updated_at"], (
        "updated_at should advance (or at least not regress) on each write"
    )
    # Progress did advance.
    assert second["progress"] == 45


@pytest.mark.asyncio
async def test_write_handles_redis_get_failure_gracefully():
    """If the read-prior-payload step fails (Redis hiccup), the write
    must still proceed with a fresh started_at — never raise."""
    class _GetFailsRedis(_FakeRedis):
        async def get(self, key):
            raise RuntimeError("simulated redis read failure")

    redis = _GetFailsRedis()
    ctx = {"redis": redis}
    # Must NOT raise.
    await _write_job_status(
        ctx, job_id="fetch_tenant_1", tenant_id=1, mode="fetch",
        status="in_progress", progress=5, message="x",
    )
    stored = json.loads(redis.store[_status_key("fetch_tenant_1")])
    assert stored["started_at"] is not None


@pytest.mark.asyncio
async def test_write_handles_corrupt_prior_payload():
    """If the prior payload in Redis isn't valid JSON, we fall back to
    treating the current write as a new job (set started_at to now).
    Never raise, never crash."""
    redis = _FakeRedis()
    redis.store[_status_key("fetch_tenant_1")] = "{this is not json"
    ctx = {"redis": redis}

    await _write_job_status(
        ctx, job_id="fetch_tenant_1", tenant_id=1, mode="fetch",
        status="in_progress", progress=10, message="x",
    )
    stored = json.loads(redis.store[_status_key("fetch_tenant_1")])
    assert stored["started_at"] is not None


@pytest.mark.asyncio
async def test_write_handles_no_redis_returns_silently():
    """When ctx has no redis (e.g. test harness, dev without Redis), the
    status write logs and returns — never raises."""
    # ctx with redis=None
    await _write_job_status(
        {"redis": None},
        job_id="x", tenant_id=1, mode="fetch",
        status="in_progress", progress=5, message="x",
    )


def test_fetch_lock_ttl_derived_from_worker_job_timeout():
    """Lock TTL = worker_job_timeout + 60s buffer. Critical: it must NOT
    be the old hard-coded 900s, because that left a crashed worker's
    lock alive long enough to silently skip the next manual click."""
    from app.core.config import settings
    original = settings.worker_job_timeout
    try:
        settings.worker_job_timeout = 300
        assert _fetch_lock_ttl_seconds() == 360
        settings.worker_job_timeout = 600
        assert _fetch_lock_ttl_seconds() == 660
    finally:
        settings.worker_job_timeout = original


@pytest.mark.asyncio
async def test_lock_acquire_uses_derived_ttl():
    """The Redis SET NX EX call should pass the derived TTL, not a
    hard-coded value."""
    from app.core.config import settings
    original = settings.worker_job_timeout
    try:
        settings.worker_job_timeout = 300  # → TTL 360
        redis = _FakeRedis()
        ok = await _try_acquire_fetch_lock(redis, "lock_key", "tok")
        assert ok is True
        _, _, ttl_arg = redis.set_calls[0]
        assert ttl_arg == 360, (
            f"expected lock TTL of 360s (worker_job_timeout 300 + 60), "
            f"got {ttl_arg}"
        )
    finally:
        settings.worker_job_timeout = original


@pytest.mark.asyncio
async def test_lock_acquire_skips_when_no_redis():
    """No Redis in dev → acquire silently succeeds. Tests assume single-
    worker dev where there's no concurrency to protect against."""
    ok = await _try_acquire_fetch_lock(None, "lock_key", "tok")
    assert ok is True


@pytest.mark.asyncio
async def test_get_job_status_synthesized_payloads_include_started_and_updated_at():
    """When no Redis-stored status row exists, get_job_status falls
    back to synthesizing a payload from arq's own job state. Those
    fallback payloads must include started_at and updated_at so the
    frontend's shape assumption holds.

    Job and create_pool are imported INSIDE the function, so the patch
    targets are the source modules ``arq`` and ``arq.jobs``.
    """
    from arq.jobs import JobStatus

    from app.workers import email_fetch

    fake_pool = MagicMock()
    fake_pool.get = AsyncMock(return_value=None)  # no stored row
    fake_pool.close = AsyncMock()

    fake_job = MagicMock()
    fake_job.status = AsyncMock(return_value=JobStatus.in_progress)

    with (
        patch("arq.create_pool", AsyncMock(return_value=fake_pool)),
        patch("arq.jobs.Job", lambda *a, **kw: fake_job),
    ):
        result = await email_fetch.get_job_status("fetch_tenant_1")

    assert result["status"] == "in_progress"
    assert "started_at" in result
    assert "updated_at" in result
    assert result["started_at"] is not None
    assert result["updated_at"] is not None
