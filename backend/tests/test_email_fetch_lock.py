"""
H6 regression test: concurrent ingestion runs for the same tenant+mode
must not both proceed. The scheduled timer plus a manual UI trigger
firing within seconds of each other previously double-ingested every
email; the lock around ``fetch_emails_for_tenant`` is what stops it.

These exercise the lock helpers directly with a fake Redis. The full
worker job is covered by other tests; we don't need to spin up SQLite
or IMAP mocks just to verify the lock semantics.
"""
import asyncio

import pytest

from app.workers.email_fetch import (
    _fetch_lock_key,
    _release_fetch_lock,
    _try_acquire_fetch_lock,
)


class FakeRedis:
    """Minimal Redis stand-in implementing the two ops we use:
    ``set(key, value, nx=..., ex=...)`` and the Lua CAS-delete via
    ``eval``. Enough to exercise the lock contract without pulling in
    fakeredis or a real Redis server.
    """

    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    async def set(self, key: str, value: str, *, nx: bool = False, ex: int | None = None):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    async def eval(self, script: str, numkeys: int, *args):
        # We only call eval with our one CAS-delete script.
        key = args[0]
        expected = args[1]
        if self.store.get(key) == expected:
            del self.store[key]
            return 1
        return 0


@pytest.mark.asyncio
async def test_second_concurrent_acquire_fails():
    """Two workers racing for the same (tenant, mode) lock: only one wins."""
    redis = FakeRedis()
    key = _fetch_lock_key(1, "fetch")

    first = await _try_acquire_fetch_lock(redis, key, "token-a")
    second = await _try_acquire_fetch_lock(redis, key, "token-b")

    assert first is True
    assert second is False


@pytest.mark.asyncio
async def test_lock_releases_and_can_be_reacquired():
    """After release, a new worker can acquire the same lock."""
    redis = FakeRedis()
    key = _fetch_lock_key(1, "fetch")

    assert await _try_acquire_fetch_lock(redis, key, "token-a") is True
    await _release_fetch_lock(redis, key, "token-a")

    assert await _try_acquire_fetch_lock(redis, key, "token-b") is True


@pytest.mark.asyncio
async def test_release_with_wrong_token_is_a_noop():
    """A slow worker whose TTL expired and whose lock was re-acquired by
    another worker must NOT delete the new owner's lock when it finally
    runs its release."""
    redis = FakeRedis()
    key = _fetch_lock_key(1, "fetch")

    # Worker A acquires, then a slow path makes us simulate worker B
    # acquiring the same key (in real life that's because A's TTL fired).
    await _try_acquire_fetch_lock(redis, key, "token-a")
    # Simulate TTL: drop A's value, let B in.
    redis.store.pop(key)
    await _try_acquire_fetch_lock(redis, key, "token-b")

    # A finally runs its release with its own (now stale) token. Must
    # leave B's token intact.
    await _release_fetch_lock(redis, key, "token-a")
    assert redis.store.get(key) == "token-b"


@pytest.mark.asyncio
async def test_lock_keys_are_scoped_per_mode():
    """A `fetch` and a `reprocess` for the same tenant touch different
    row sets, so they don't share a lock."""
    redis = FakeRedis()
    fetch_key = _fetch_lock_key(1, "fetch")
    reprocess_key = _fetch_lock_key(1, "reprocess")

    assert await _try_acquire_fetch_lock(redis, fetch_key, "token-a") is True
    # reprocess for the same tenant should NOT block on the fetch lock.
    assert await _try_acquire_fetch_lock(redis, reprocess_key, "token-b") is True


@pytest.mark.asyncio
async def test_redis_unavailable_falls_back_to_unlocked():
    """In Redis-less dev environments (single worker, no concurrency),
    skipping the lock is safe and avoids hard-failing the worker."""
    assert await _try_acquire_fetch_lock(None, "anything", "tok") is True
    # Release on missing redis must be a quiet no-op, not a raise.
    await _release_fetch_lock(None, "anything", "tok")


@pytest.mark.asyncio
async def test_many_concurrent_acquires_only_one_wins():
    """Stress check: launch 20 acquires in parallel, exactly one returns True."""
    redis = FakeRedis()
    key = _fetch_lock_key(1, "fetch")

    results = await asyncio.gather(*[
        _try_acquire_fetch_lock(redis, key, f"token-{i}") for i in range(20)
    ])

    assert sum(1 for r in results if r) == 1
