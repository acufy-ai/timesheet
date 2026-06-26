"""The refresh-token cookie helpers should set HttpOnly + Secure (in prod)
+ SameSite=Lax + Path=/ + the right TTL, and clearing should target the
same Path so the browser actually drops the cookie.

Path is "/" (not "/auth"): the dev Vite proxy serves the API under /api/*
and rewrites /api away before the backend sees it, so the browser issues
the refresh request as /api/auth/refresh. A Path=/auth cookie would never
be sent on that URL. Path=/ is reliably sent; HttpOnly keeps it unreadable
regardless of which requests carry it.

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
    _refresh_cookie_name,
    _sanitize_tab_id,
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
    assert "httponly" in h.lower()
    assert "samesite=lax" in h.lower()
    assert f"path={REFRESH_COOKIE_PATH}".lower() in h.lower()
    assert f"max-age={REFRESH_COOKIE_MAX_AGE_SECONDS}" in h.lower()


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
    log out' bug. With no tab id, clearing emits exactly the legacy cookie."""
    resp = Response()
    _clear_refresh_cookie(resp)
    headers = _set_cookie_headers(resp)
    # No tab id => clearing the legacy cookie name only (the tab-name set
    # collapses to the legacy name, deduped).
    assert len(headers) == 1
    h = headers[0]
    assert f"{REFRESH_COOKIE_NAME}=" in h
    assert f"Path={REFRESH_COOKIE_PATH}" in h
    # max-age=0 (or expires in the past) signals deletion
    assert "Max-Age=0" in h or "expires=" in h.lower()


# ── Per-tab cookie scoping (two accounts in two tabs of one browser) ──

def test_refresh_cookie_name_is_per_tab():
    """A tab id yields a tab-scoped cookie name; no tab id yields the
    legacy name. This is what stops two tabs from sharing one cookie."""
    assert _refresh_cookie_name(None) == REFRESH_COOKIE_NAME
    assert _refresh_cookie_name("") == REFRESH_COOKIE_NAME
    assert _refresh_cookie_name("tabAAA") == f"{REFRESH_COOKIE_NAME}__tabAAA"
    assert _refresh_cookie_name("tabAAA") != _refresh_cookie_name("tabBBB")


def test_sanitize_tab_id_strips_junk_and_caps_length():
    """The tab id becomes part of a cookie name, so it must be sanitized
    to alphanumerics (no chars that could inject cookie attributes) and
    length-capped."""
    assert _sanitize_tab_id(None) is None
    assert _sanitize_tab_id("") is None
    # non-alphanumerics stripped
    assert _sanitize_tab_id("a;b=c\nd") == "abcd"
    # capped at 32 chars
    assert _sanitize_tab_id("x" * 100) == "x" * 32
    # all-junk collapses to None rather than an empty name
    assert _sanitize_tab_id(";;;") is None


def test_set_refresh_cookie_with_tab_id_uses_scoped_name():
    resp = Response()
    _set_refresh_cookie(resp, "tok-A", "tabAAA")
    h = _set_cookie_headers(resp)[0]
    assert h.startswith(f"{REFRESH_COOKIE_NAME}__tabAAA=tok-A")
    assert "httponly" in h.lower()


def test_clear_refresh_cookie_with_tab_id_clears_both_scoped_and_legacy():
    """Logout on a tab must clear THIS tab's cookie and the legacy cookie
    (so an upgraded session logs out cleanly), but not other tabs'."""
    resp = Response()
    _clear_refresh_cookie(resp, "tabAAA")
    headers = _set_cookie_headers(resp)
    names = {h.split("=", 1)[0] for h in headers}
    assert f"{REFRESH_COOKIE_NAME}__tabAAA" in names
    assert REFRESH_COOKIE_NAME in names
    # must NOT touch a different tab's cookie
    assert f"{REFRESH_COOKIE_NAME}__tabBBB" not in names
