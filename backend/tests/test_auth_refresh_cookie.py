"""H5: the refresh-token cookie helpers should set HttpOnly + Secure
(in prod) + SameSite=Lax + Path=/auth + the right TTL, and clearing
should target the same Path so the browser actually drops the cookie.

These pin the helper contract — if the values ever drift (e.g. someone
loosens SameSite to None without thinking through the cross-origin
implications), the test surfaces it.
"""
import pytest
from fastapi import Response

from app.api.auth import (
    REFRESH_COOKIE_NAME,
    REFRESH_COOKIE_PATH,
    REFRESH_COOKIE_MAX_AGE_SECONDS,
    _set_refresh_cookie,
    _clear_refresh_cookie,
)


def _set_cookie_headers(resp: Response) -> list[str]:
    """FastAPI's Response stores Set-Cookie headers as a list of tuples
    in resp.raw_headers — pull them out as strings for assertions."""
    return [
        v.decode() for k, v in resp.raw_headers if k == b"set-cookie"
    ]


def test_set_refresh_cookie_pins_httponly_lax_path():
    resp = Response()
    _set_refresh_cookie(resp, "tok-1")
    headers = _set_cookie_headers(resp)
    assert len(headers) == 1
    h = headers[0]
    assert h.startswith(f"{REFRESH_COOKIE_NAME}=tok-1")
    assert "HttpOnly" in h
    assert "SameSite=lax" in h.lower() or "SameSite=Lax" in h
    assert f"Path={REFRESH_COOKIE_PATH}" in h
    assert f"Max-Age={REFRESH_COOKIE_MAX_AGE_SECONDS}" in h


def test_set_refresh_cookie_secure_in_prod_mode(monkeypatch):
    """When debug is off (prod), the cookie must be Secure-only so it
    never travels over plaintext HTTP."""
    from app.api import auth
    monkeypatch.setattr(auth.settings, "debug", False)
    resp = Response()
    _set_refresh_cookie(resp, "tok-2")
    h = _set_cookie_headers(resp)[0]
    assert "Secure" in h


def test_set_refresh_cookie_not_secure_in_debug(monkeypatch):
    """In dev (debug=True), the cookie can ride over http://localhost
    without Secure. Otherwise we couldn't test the flow at all without
    HTTPS in dev."""
    from app.api import auth
    monkeypatch.setattr(auth.settings, "debug", True)
    resp = Response()
    _set_refresh_cookie(resp, "tok-3")
    h = _set_cookie_headers(resp)[0]
    assert "Secure" not in h


def test_clear_refresh_cookie_targets_same_path():
    """If the cleared cookie's Path differs from the set Path, browsers
    keep the original cookie alongside the cleared one and the session
    survives — pinning this protects against a subtle 'logout doesn't
    log out' bug."""
    resp = Response()
    _clear_refresh_cookie(resp)
    h = _set_cookie_headers(resp)[0]
    assert f"{REFRESH_COOKIE_NAME}=" in h
    assert f"Path={REFRESH_COOKIE_PATH}" in h
    # max-age=0 (or expires in the past) signals deletion
    assert "Max-Age=0" in h or "expires=" in h.lower()
