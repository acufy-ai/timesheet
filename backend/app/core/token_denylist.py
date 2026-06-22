"""Short-lived access-token revocation denylist (Redis-backed).

Access tokens are stateless JWTs valid until their ``exp``. Logout previously
revoked only the refresh token, so a leaked/stolen access token stayed usable
for up to its full TTL. This denylist lets logout (and admin force-logout)
invalidate an access token immediately by storing its ``jti`` until the token
would have expired anyway — so the key self-cleans and the set stays tiny.

Redis is best-effort: if it's unavailable, revoke is a no-op and the check
fails open (token remains valid until expiry). That matches the pre-existing
behavior, so an outage degrades to "old behavior" rather than locking everyone
out. Mirrors the fail-soft pattern already used for PA refresh tokens.
"""
from __future__ import annotations

import logging
import time

from app.core.config import settings

logger = logging.getLogger(__name__)

_KEY = "access_denylist:{jti}"


async def _redis():
    import redis.asyncio as redis_async
    return redis_async.from_url(settings.redis_url, decode_responses=True)


async def revoke_access_jti(jti: str, exp: int | None) -> None:
    """Add an access-token jti to the denylist until its expiry.

    ``exp`` is the token's epoch-seconds expiry; the Redis key TTL is set to the
    remaining lifetime so it disappears exactly when the token would. If exp is
    missing or already past, we still set a short floor TTL to cover clock skew.
    """
    if not jti:
        return
    ttl = 60
    if exp is not None:
        ttl = max(1, int(exp) - int(time.time()))
    try:
        r = await _redis()
        await r.set(_KEY.format(jti=jti), "1", ex=ttl)
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("access denylist revoke failed for jti=%s: %s", jti, exc)


async def is_access_jti_revoked(jti: str | None) -> bool:
    """True if this access-token jti has been revoked and is still within TTL.

    Fails open (returns False) when Redis is unavailable, so an outage doesn't
    reject otherwise-valid tokens.
    """
    if not jti:
        return False
    try:
        r = await _redis()
        return await r.exists(_KEY.format(jti=jti)) == 1
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("access denylist check failed for jti=%s: %s", jti, exc)
        return False
