"""M4: the per-tenant engine cache used to evict the oldest entry
unconditionally when it crossed the cap. A long-running job holding a
session on the oldest engine would then have its connection ripped
out. The refcount makes eviction only target idle engines.

This test exercises the bookkeeping directly. We can't easily mock
``_resolve_db_url_for_slug`` from inside the module without dragging
in the whole control-plane DB, so we manipulate the registry as the
real code would and assert state transitions.
"""
import asyncio

import pytest

from app import db_tenant


@pytest.fixture(autouse=True)
def _clean_registry():
    """Each test starts with an empty registry, and any records we add
    are cleared out at end (without disposing — we don't have real
    engines)."""
    db_tenant._registry.clear()
    yield
    db_tenant._registry.clear()


def _fake_record():
    """Drop a no-engine record into the registry slot. We never call
    methods on the engine in these tests."""
    class _Stub:
        async def dispose(self):
            pass
    rec = db_tenant._EngineRecord.__new__(db_tenant._EngineRecord)
    rec.engine = _Stub()
    rec.session_factory = None  # not used in these tests
    rec.inuse = 0
    return rec


def test_inuse_starts_at_zero():
    db_tenant._registry["t1"] = _fake_record()
    assert db_tenant._registry["t1"].inuse == 0


@pytest.mark.asyncio
async def test_session_context_manager_bumps_and_drops_inuse(monkeypatch):
    """A successful ``async with tenant_session(slug)`` must increment
    inuse on enter and decrement it on exit."""

    rec = _fake_record()
    db_tenant._registry["t1"] = rec

    # Stand-in for the session factory and the session it produces.
    class _FakeSession:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return None

    async def _fake_factory_lookup(slug):
        # Mimic get_session_factory_for_slug: just return a callable
        # that yields a fake session. We don't touch real engines.
        return _FakeSession

    monkeypatch.setattr(db_tenant, "get_session_factory_for_slug", _fake_factory_lookup)

    async with db_tenant.tenant_session("t1") as _session:
        # Inside the context, refcount is 1.
        assert db_tenant._registry["t1"].inuse == 1
    # On exit, refcount is back to 0.
    assert db_tenant._registry["t1"].inuse == 0


@pytest.mark.asyncio
async def test_session_drops_inuse_even_on_exception(monkeypatch):
    rec = _fake_record()
    db_tenant._registry["t1"] = rec

    class _FakeSession:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return None

    async def _fake_factory_lookup(slug):
        return _FakeSession

    monkeypatch.setattr(db_tenant, "get_session_factory_for_slug", _fake_factory_lookup)

    with pytest.raises(RuntimeError):
        async with db_tenant.tenant_session("t1"):
            assert db_tenant._registry["t1"].inuse == 1
            raise RuntimeError("boom")
    assert db_tenant._registry["t1"].inuse == 0


def test_max_live_engines_is_room_for_growth():
    """64 is the current cap. Lower than 32 would trip eviction at our
    current 3-tenant scale; >128 is wasteful memory. If this changes,
    a deliberate decision is required."""
    assert db_tenant._MAX_LIVE_ENGINES >= 32
    assert db_tenant._MAX_LIVE_ENGINES <= 128
