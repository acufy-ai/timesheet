"""Per-tenant database engine registry.

Resolves a tenant slug to its async SQLAlchemy engine, reading the
control-plane ``tenants`` row to pick the shared DB or an isolated
``acufy_tenant_<slug>`` URL based on ``is_isolated``.

Cutover note: cached engines aren't re-resolved on flip; restart the
process or call ``dispose_all`` after toggling ``is_isolated``.
"""
from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from typing import Optional
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import settings

logger = logging.getLogger(__name__)


# Cap on live tenant engines; oldest IDLE is evicted past this.
# An engine with active sessions (inuse > 0) is never evicted — a long
# ingestion job can't have its connection ripped out from under it just
# because a new tenant hit the API.
_MAX_LIVE_ENGINES = 64


class _EngineRecord:
    """AsyncEngine + bound sessionmaker + in-use refcount."""

    __slots__ = ("engine", "session_factory", "inuse")

    def __init__(self, engine: AsyncEngine):
        self.engine = engine
        self.session_factory = async_sessionmaker(
            engine,
            class_=AsyncSession,
            expire_on_commit=False,
            autocommit=False,
            autoflush=False,
        )
        # Bumped on tenant_session __aenter__, decremented on __aexit__.
        # Only engines with inuse == 0 are eviction candidates.
        self.inuse = 0


# slug -> engine record. OrderedDict for insertion-order LRU eviction.
_registry: "OrderedDict[str, _EngineRecord]" = OrderedDict()
_registry_lock = asyncio.Lock()


def _build_isolated_url(db_name: str, db_host: str | None, db_port: int | None) -> str:
    """Build the asyncpg URL for an isolated tenant DB.

    Reuses shared user/password/scheme; host/port from the control-plane
    row override when present.
    """
    base = urlparse(settings.database_url)
    host = db_host or base.hostname
    port = db_port or base.port or 5432
    userinfo = base.netloc.split("@", 1)[0] if "@" in base.netloc else ""
    netloc = f"{userinfo}@{host}:{port}" if userinfo else f"{host}:{port}"
    return f"{base.scheme}://{netloc}/{db_name}"


async def _resolve_db_url_for_slug(slug: str) -> str:
    """Return the asyncpg URL for the given tenant slug.

    Routes to the isolated DB when ``is_isolated`` and ``db_name`` are set;
    otherwise returns the shared URL. Raises LookupError on unknown slug.
    """
    from app.db_control import AsyncControlSessionLocal
    from app.models.control import ControlTenant

    async with AsyncControlSessionLocal() as session:
        tenant = (await session.execute(
            select(ControlTenant).where(ControlTenant.slug == slug)
        )).scalar_one_or_none()

    if tenant is None:
        raise LookupError(f"tenant slug={slug!r} not found in control plane")

    if tenant.is_isolated and tenant.db_name:
        return _build_isolated_url(tenant.db_name, tenant.db_host, tenant.db_port)

    # Half-provisioned tenants stay on the shared DB.
    return settings.database_url


async def get_engine_for_slug(slug: str) -> AsyncEngine:
    """Return (and lazily create) the engine for a tenant slug."""
    if not slug:
        raise ValueError("tenant slug must be a non-empty string")

    async with _registry_lock:
        existing = _registry.get(slug)
        if existing is not None:
            _registry.move_to_end(slug)
            return existing.engine

        url = await _resolve_db_url_for_slug(slug)
        is_sqlite = "sqlite" in url
        engine = create_async_engine(
            url,
            echo=False,
            future=True,
            pool_pre_ping=True,
            **({} if is_sqlite else {
                "pool_size": 3,
                "max_overflow": 2,
            }),
        )
        _registry[slug] = _EngineRecord(engine)

        # Eviction policy: scan oldest-first for the first IDLE entry
        # (inuse == 0) and drop it. Engines with active sessions are
        # skipped — a long ingestion job that's mid-fetch can't have its
        # connection killed because a new tenant hit the API. If every
        # engine is busy we just keep the cache over-cap and log a
        # warning; that's the right tradeoff (memory cost vs. data loss).
        if len(_registry) > _MAX_LIVE_ENGINES:
            evicted_slug: str | None = None
            for candidate_slug, candidate_record in list(_registry.items()):
                if candidate_slug == slug:
                    continue  # don't evict the one we just inserted
                if candidate_record.inuse == 0:
                    evicted_slug = candidate_slug
                    break
            if evicted_slug is not None:
                evicted_record = _registry.pop(evicted_slug)
                logger.info(
                    "tenant_registry: evicting idle engine for slug=%s (cap=%s)",
                    evicted_slug, _MAX_LIVE_ENGINES,
                )
                asyncio.create_task(evicted_record.engine.dispose())
            else:
                logger.warning(
                    "tenant_registry: cache over cap (%d entries, cap=%d) but every engine "
                    "has active sessions; deferring eviction",
                    len(_registry), _MAX_LIVE_ENGINES,
                )

        return engine


async def get_session_factory_for_slug(slug: str):
    """Return the session_factory for a tenant slug, creating the engine on first hit."""
    if not slug:
        raise ValueError("tenant slug must be a non-empty string")
    async with _registry_lock:
        existing = _registry.get(slug)
        if existing is not None:
            _registry.move_to_end(slug)
            return existing.session_factory
    await get_engine_for_slug(slug)
    return _registry[slug].session_factory


def tenant_session(slug: str):
    """Async-context-manager session bound to the tenant's DB.

    Workers use ``async with tenant_session(slug) as session:``. Routes
    should depend on ``get_tenant_db`` instead.

    Bumps the engine's inuse refcount on enter, decrements on exit, so
    the cache's LRU eviction can avoid disposing an engine that has
    a live session attached.
    """
    if not slug:
        raise ValueError("tenant slug must be a non-empty string")

    class _SessionCM:
        def __init__(self, slug: str):
            self._slug = slug
            self._session = None
            self._acquired = False

        async def __aenter__(self):
            factory = await get_session_factory_for_slug(self._slug)
            # Bump refcount while holding the lock so an evictor running
            # between get_session_factory and __aenter__ can't pick our
            # engine. We don't await between the lock release and the
            # session enter, so the engine can't be evicted in that gap
            # either (the engine reference is local).
            async with _registry_lock:
                record = _registry.get(self._slug)
                if record is not None:
                    record.inuse += 1
                    self._acquired = True
            self._session = factory()
            await self._session.__aenter__()
            return self._session

        async def __aexit__(self, exc_type, exc, tb):
            try:
                if self._session is not None:
                    await self._session.__aexit__(exc_type, exc, tb)
                    self._session = None
            finally:
                if self._acquired:
                    async with _registry_lock:
                        record = _registry.get(self._slug)
                        if record is not None and record.inuse > 0:
                            record.inuse -= 1
                    self._acquired = False

    return _SessionCM(slug)


async def resolve_slug_for_tenant_id(tenant_id: int) -> str:
    """Return the tenant's slug for a numeric id (LookupError if absent)."""
    from app.db_control import AsyncControlSessionLocal
    from app.models.control import ControlTenant

    async with AsyncControlSessionLocal() as session:
        slug = (await session.execute(
            select(ControlTenant.slug).where(ControlTenant.id == tenant_id)
        )).scalar_one_or_none()

    if slug is None:
        raise LookupError(f"tenant id={tenant_id} not found in control plane")
    return slug


async def dispose_all() -> None:
    """Dispose every registered engine. Idempotent."""
    async with _registry_lock:
        records = list(_registry.values())
        _registry.clear()
    for record in records:
        try:
            await record.engine.dispose()
        except Exception as exc:  # noqa: BLE001 - shutdown best-effort
            logger.warning("tenant_registry: dispose failed: %s", exc)


async def dispose_for_slug(slug: str) -> None:
    """Evict and dispose the cached engine for ``slug``.

    After flipping ``is_isolated`` on a tenant (or changing its
    ``db_name``), the registry's previously-resolved engine points
    at the wrong DB. Call this from the same request that flipped
    the flag so the next per-tenant query rebuilds against the new
    configuration. Without this the change only takes effect after
    the next api restart — see the CLAUDE.md gotcha.
    """
    record = _registry.pop(slug, None)
    if record is None:
        return
    try:
        await record.engine.dispose()
    except Exception as exc:
        logger.warning("tenant_registry: dispose_for_slug(%s) failed: %s", slug, exc)


def registered_slugs() -> list[str]:
    """Snapshot of currently-registered slugs. For diagnostics."""
    return list(_registry.keys())


# Test-only: drop a registered slug without disposing.
def _forget(slug: str) -> Optional[AsyncEngine]:
    record = _registry.pop(slug, None)
    return record.engine if record else None
