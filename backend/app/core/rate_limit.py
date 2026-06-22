from slowapi import Limiter
from slowapi.util import get_remote_address

# A global default limit (applied via SlowAPIMiddleware in main.py) covers
# every endpoint. Previously only auth routes were limited, leaving lists,
# exports and dashboards open to hammering by an authenticated client. The
# default is generous enough not to affect normal interactive use but stops a
# single client from spamming an endpoint hundreds of times a minute. Auth and
# other sensitive routes keep their own tighter per-route @limiter.limit, which
# slowapi enforces in addition to this default.
limiter = Limiter(key_func=get_remote_address, default_limits=["240/minute"])
