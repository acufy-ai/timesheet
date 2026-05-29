"""
Regression test for the ETag 304 path returning None.

Before this fix, ``respond_with_etag`` returned ``None`` on a cache hit
and mutated the passed-in ``Response.status_code`` to 304. FastAPI's
response_model validation then rejected the None payload as invalid,
the endpoint surfaced a 500, and the frontend treated the 500 on
``/auth/me`` / ``/tenants/mine`` as a session failure and logged the
user out — exposing a long-standing bug only when a real cache hit
occurred (i.e. after a successful prior visit).

The fix returns a Starlette ``Response`` object directly, which FastAPI
short-circuits past response_model entirely.
"""
from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient
from pydantic import BaseModel
from starlette.responses import Response as StarletteResponse

from app.core.etag import compute_etag, respond_with_etag


class _Payload(BaseModel):
    name: str
    n: int


def _build_app() -> FastAPI:
    app = FastAPI()

    @app.get("/cached", response_model=_Payload)
    def cached(request: Request, response: Response):
        # Hardcoded payload; the test inspects the ETag the route
        # would compute and uses that for the If-None-Match round-trip.
        payload = _Payload(name="x", n=1).model_dump()
        result = respond_with_etag(request, response, payload)
        return result

    return app


def test_first_call_returns_200_with_etag_header():
    client = TestClient(_build_app())
    response = client.get("/cached")
    assert response.status_code == 200
    assert response.headers.get("etag", "").startswith('W/"')
    body = response.json()
    assert body == {"name": "x", "n": 1}


def test_matching_if_none_match_returns_304_not_500():
    """The critical regression: a 304 round-trip must NOT bubble up as
    a 500 from response_model validation."""
    client = TestClient(_build_app())
    first = client.get("/cached")
    etag = first.headers["etag"]

    second = client.get("/cached", headers={"If-None-Match": etag})
    assert second.status_code == 304, (
        f"expected 304 on matching ETag, got {second.status_code}: {second.text}"
    )
    assert second.headers.get("etag") == etag
    # 304 must have empty body per RFC 7232.
    assert second.content == b""


def test_mismatching_if_none_match_returns_200():
    client = TestClient(_build_app())
    response = client.get("/cached", headers={"If-None-Match": 'W/"stale"'})
    assert response.status_code == 200
    assert response.json() == {"name": "x", "n": 1}


def test_response_function_returns_starlette_response_on_match():
    """Unit-level: respond_with_etag returns a Response object (not
    None) so FastAPI bypasses response_model validation."""
    from unittest.mock import MagicMock

    request = MagicMock()
    request.headers.get.return_value = compute_etag({"a": 1})
    response = Response()
    result = respond_with_etag(request, response, {"a": 1})
    assert isinstance(result, StarletteResponse)
    assert result.status_code == 304
