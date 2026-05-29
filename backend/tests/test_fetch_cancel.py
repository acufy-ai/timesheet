"""
Tests for the cancel-fetch-job feature.

Two layers:

  1. ``cancel_fetch_job`` (per-job cancel) — covers the audit
     recommendation alongside F-04. Verifies:
       * arq's Job.abort() is called
       * the per-(tenant, mode) Redis lock is released
       * the status row flips to ``cancelled`` immediately
       * the helper survives prior-status read failures,
         already-finished jobs, and Redis errors gracefully
  2. ``cancel_all_fetch_jobs_for_tenant`` (admin kill switch) —
     verifies the SCAN-based sweep correctly identifies in-flight jobs
     for the target tenant, skips terminal-status rows, skips other
     tenants' rows, and reports an accurate count.

Network mocks: arq's create_pool and Job are imported INSIDE the
helpers, so the patch target is the source module ``arq`` /
``arq.jobs`` (same pattern as the F-04 tests).
"""
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.workers.email_fetch import (
    _fetch_lock_key,
    _status_key,
    cancel_all_fetch_jobs_for_tenant,
    cancel_fetch_job,
)


def _make_fake_pool(stored: dict[str, str] | None = None) -> MagicMock:
    """Build a fake arq pool that supports the small surface our cancel
    functions touch: get, delete, setex, scan, close."""
    stored = dict(stored or {})
    pool = MagicMock()
    pool.get = AsyncMock(side_effect=lambda k: stored.get(k))
    pool.delete = AsyncMock(side_effect=lambda *ks: [stored.pop(k, None) for k in ks])
    pool.setex = AsyncMock(side_effect=lambda k, ttl, v: stored.__setitem__(k, v))
    pool.close = AsyncMock()

    # SCAN: return all keys matching the glob in one shot (cursor=0).
    async def _scan(cursor=0, match="*", count=100):
        import fnmatch
        keys = [k for k in stored.keys() if fnmatch.fnmatch(k, match)]
        return 0, keys

    pool.scan = AsyncMock(side_effect=_scan)
    pool._stored = stored
    return pool


@pytest.mark.asyncio
async def test_cancel_fetch_job_aborts_job_and_releases_lock():
    """Happy path: an in_progress job exists, status row in Redis,
    lock held. Cancel must call abort(), delete the lock, and write
    a cancelled status row."""
    job_id = "fetch_tenant_1"
    tenant_id = 1
    lock_key = _fetch_lock_key(tenant_id, "fetch")
    status_key = _status_key(job_id)

    initial_status = json.dumps({
        "job_id": job_id,
        "tenant_id": tenant_id,
        "mode": "fetch",
        "status": "in_progress",
        "progress": 45,
        "message": "Processing...",
        "started_at": "2026-05-29T15:00:00Z",
        "updated_at": "2026-05-29T15:03:00Z",
    })
    pool = _make_fake_pool({
        status_key: initial_status,
        lock_key: "some_lock_token",
    })

    fake_job = MagicMock()
    fake_job.abort = AsyncMock(return_value=True)
    fake_job.status = AsyncMock(return_value="in_progress")

    with (
        patch("arq.create_pool", AsyncMock(return_value=pool)),
        patch("arq.jobs.Job", lambda *a, **kw: fake_job),
    ):
        result = await cancel_fetch_job(job_id, tenant_id)

    fake_job.abort.assert_awaited_once()
    # Lock key was deleted (kicked out of the store).
    assert lock_key not in pool._stored
    # Status row was rewritten with status=cancelled.
    final = json.loads(pool._stored[status_key])
    assert final["status"] == "cancelled"
    assert final["message"] == "Cancelled by user."
    # Returned payload comes from get_job_status which reads the same row.
    assert result["status"] == "cancelled"


@pytest.mark.asyncio
async def test_cancel_fetch_job_preserves_started_at():
    """started_at should NOT change on cancel — it's the original job's
    start time and the UI relies on it for total-runtime calculations."""
    job_id = "fetch_tenant_2"
    tenant_id = 2
    status_key = _status_key(job_id)

    pool = _make_fake_pool({
        status_key: json.dumps({
            "job_id": job_id,
            "tenant_id": tenant_id,
            "mode": "fetch",
            "status": "in_progress",
            "progress": 10,
            "message": "x",
            "started_at": "2026-05-29T14:00:00Z",
            "updated_at": "2026-05-29T14:05:00Z",
        }),
    })
    fake_job = MagicMock()
    fake_job.abort = AsyncMock(return_value=True)
    fake_job.status = AsyncMock(return_value="in_progress")

    with (
        patch("arq.create_pool", AsyncMock(return_value=pool)),
        patch("arq.jobs.Job", lambda *a, **kw: fake_job),
    ):
        await cancel_fetch_job(job_id, tenant_id)

    final = json.loads(pool._stored[status_key])
    assert final["started_at"] == "2026-05-29T14:00:00Z"


@pytest.mark.asyncio
async def test_cancel_fetch_job_survives_abort_failure():
    """abort() raises (e.g. job already finished) — we still want to
    release the lock and stamp cancelled status. The user clicked
    cancel; the UI should NOT report an error."""
    job_id = "fetch_tenant_3"
    tenant_id = 3
    lock_key = _fetch_lock_key(tenant_id, "fetch")
    pool = _make_fake_pool({lock_key: "tok"})

    fake_job = MagicMock()
    fake_job.abort = AsyncMock(side_effect=RuntimeError("job not running"))
    fake_job.status = AsyncMock(return_value="complete")

    with (
        patch("arq.create_pool", AsyncMock(return_value=pool)),
        patch("arq.jobs.Job", lambda *a, **kw: fake_job),
    ):
        # Must NOT raise.
        await cancel_fetch_job(job_id, tenant_id)

    # Lock still released, status row written.
    assert lock_key not in pool._stored
    final = json.loads(pool._stored[_status_key(job_id)])
    assert final["status"] == "cancelled"


@pytest.mark.asyncio
async def test_cancel_all_for_tenant_finds_only_active_jobs_for_target_tenant():
    """The admin sweep must:
       * skip jobs from other tenants
       * skip jobs in terminal states (complete/failed/cancelled)
       * cancel only the matching in-flight rows
    """
    target_tenant = 7
    other_tenant = 99
    j_target_active = "fetch_tenant_7"
    j_target_done = "fetch_tenant_7_reprocess_abc"
    j_other = "fetch_tenant_99"

    pool = _make_fake_pool({
        _status_key(j_target_active): json.dumps({
            "job_id": j_target_active, "tenant_id": target_tenant,
            "mode": "fetch", "status": "in_progress", "progress": 30,
            "message": "x", "started_at": "x", "updated_at": "x",
        }),
        _status_key(j_target_done): json.dumps({
            "job_id": j_target_done, "tenant_id": target_tenant,
            "mode": "reprocess_email", "status": "complete", "progress": 100,
            "message": "x", "started_at": "x", "updated_at": "x",
        }),
        _status_key(j_other): json.dumps({
            "job_id": j_other, "tenant_id": other_tenant,
            "mode": "fetch", "status": "in_progress", "progress": 10,
            "message": "x", "started_at": "x", "updated_at": "x",
        }),
    })

    fake_job = MagicMock()
    fake_job.abort = AsyncMock(return_value=True)
    fake_job.status = AsyncMock(return_value="in_progress")

    with (
        patch("arq.create_pool", AsyncMock(return_value=pool)),
        patch("arq.jobs.Job", lambda *a, **kw: fake_job),
    ):
        count = await cancel_all_fetch_jobs_for_tenant(target_tenant)

    # Only the active target-tenant job got cancelled.
    assert count == 1

    # j_target_active flipped to cancelled.
    assert json.loads(pool._stored[_status_key(j_target_active)])["status"] == "cancelled"
    # j_target_done left alone (already complete).
    assert json.loads(pool._stored[_status_key(j_target_done)])["status"] == "complete"
    # j_other left alone (other tenant).
    assert json.loads(pool._stored[_status_key(j_other)])["status"] == "in_progress"


@pytest.mark.asyncio
async def test_cancel_all_for_tenant_returns_zero_when_no_active_jobs():
    """Empty Redis or only terminal-status rows → no work, returns 0."""
    pool = _make_fake_pool({
        _status_key("fetch_tenant_5"): json.dumps({
            "job_id": "fetch_tenant_5", "tenant_id": 5,
            "mode": "fetch", "status": "complete", "progress": 100,
            "message": "x", "started_at": "x", "updated_at": "x",
        }),
    })

    fake_job = MagicMock()
    fake_job.abort = AsyncMock(return_value=True)
    fake_job.status = AsyncMock(return_value="complete")

    with (
        patch("arq.create_pool", AsyncMock(return_value=pool)),
        patch("arq.jobs.Job", lambda *a, **kw: fake_job),
    ):
        count = await cancel_all_fetch_jobs_for_tenant(5)

    assert count == 0


@pytest.mark.asyncio
async def test_cancel_all_for_tenant_skips_corrupt_payloads():
    """A non-JSON status row should not blow up the sweep."""
    pool = _make_fake_pool({
        _status_key("garbage_job"): "this is not json",
        _status_key("fetch_tenant_8"): json.dumps({
            "job_id": "fetch_tenant_8", "tenant_id": 8,
            "mode": "fetch", "status": "in_progress", "progress": 10,
            "message": "x", "started_at": "x", "updated_at": "x",
        }),
    })

    fake_job = MagicMock()
    fake_job.abort = AsyncMock(return_value=True)
    fake_job.status = AsyncMock(return_value="in_progress")

    with (
        patch("arq.create_pool", AsyncMock(return_value=pool)),
        patch("arq.jobs.Job", lambda *a, **kw: fake_job),
    ):
        count = await cancel_all_fetch_jobs_for_tenant(8)

    assert count == 1
