"""ETag-based conditional GET helper.

For endpoints that return data that's expensive to send and rarely
changes (e.g. /auth/me, /tenants/mine), wrap the response payload in
an ETag derived from a stable representation of its content. Clients
that send ``If-None-Match: <etag>`` matching the current value get a
304 with no body; otherwise the full response is sent with the ETag
in the response header.

The savings are on the wire and the JSON parse, not on the DB query
itself — we still need to compute the response to know its ETag. For
the M11 endpoints that's an acceptable tradeoff; if a DB-hit-free
short-circuit is wanted later, persist a version integer on the row
and short-circuit at the query layer instead.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from fastapi import Request, Response, status
from starlette.responses import Response as StarletteResponse


def compute_etag(payload: Any) -> str:
    """Stable ETag for a JSON-serializable payload. Output is a quoted
    string per RFC 7232 (e.g. ``"W/abc123"``) — fastapi will pass it
    through as-is in the ``ETag`` header."""
    serialized = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
    digest = hashlib.blake2s(serialized.encode("utf-8"), digest_size=12).hexdigest()
    # Weak ETag (``W/``) so middleboxes don't try byte-equal validation
    # — the JSON we serialize here isn't byte-stable across Python
    # versions (set ordering, decimal formatting).
    return f'W/"{digest}"'


def respond_with_etag(
    request: Request,
    response: Response,
    payload: Any,
) -> Any:
    """Return 304 if the client's If-None-Match matches the current
    ETag for the given payload; otherwise stamp the ETag header on the
    outgoing response and return the payload."""
    etag = compute_etag(payload)
    if_none_match = request.headers.get("if-none-match")
    if if_none_match and if_none_match.strip() == etag:
        # Return a Response object directly so FastAPI's response_model
        # validation is bypassed. Returning ``None`` here would otherwise
        # be rejected by Pydantic on routes that declare a non-Optional
        # response_model, surfacing as a 500 and (on the frontend)
        # an unexplained logout. Per RFC 7232 a 304 MUST include the
        # ETag so the client can re-pin its cache.
        return StarletteResponse(
            status_code=status.HTTP_304_NOT_MODIFIED,
            headers={"ETag": etag},
        )
    response.headers["ETag"] = etag
    return payload
