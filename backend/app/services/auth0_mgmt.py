"""Thin Auth0 Management API client used for user provisioning.

Used at admin-create time so a new Timesheet user gets an Auth0 record
in the same flow. The login path (separate, in ``app.core.security``)
only needs the user-facing Auth0 app credentials; this module needs the
M2M app credentials configured under ``AUTH0_MGMT_*``.

We deliberately do not pull in ``auth0-python`` — its surface is much
larger than we need and brings opinionated retry/threading behavior
that doesn't compose with our async stack. A thin httpx wrapper with
in-process token caching is plenty.
"""
from __future__ import annotations

import hashlib
import logging
import secrets
import string
import time
from dataclasses import dataclass
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


class Auth0MgmtError(Exception):
    """Raised when the Auth0 Management API returns a failure.

    Carries the upstream HTTP status so callers can decide whether to
    treat the failure as transient (retry-able) or permanent (e.g.
    409 conflict on user-already-exists).
    """

    def __init__(self, message: str, status_code: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


@dataclass
class _CachedToken:
    """Management API token with the wallclock time at which it expires."""
    token: str
    expires_at: float


# Module-level cache. Auth0 tokens last 24h; we refresh ~5 min early to
# avoid clock-skew edge cases where we hand out an about-to-expire token.
_token_cache: Optional[_CachedToken] = None
_REFRESH_SLACK_SECONDS = 300


def _generate_throwaway_password() -> str:
    """Random password used for the initial Auth0 user record.

    The user never sees or uses this. They set their real password via
    the password-change ticket we generate immediately after. Picking
    something that satisfies any reasonable Auth0 password policy means
    we don't need to coordinate with whatever the connection's policy
    is configured to.
    """
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*"
    body = "".join(secrets.choice(alphabet) for _ in range(28))
    # Force-include one of each class so we satisfy strict policies.
    return f"Aa1!{body}"


async def _get_management_token() -> str:
    """Fetch (and cache) a Management API access token."""
    global _token_cache
    now = time.time()
    if _token_cache and _token_cache.expires_at - _REFRESH_SLACK_SECONDS > now:
        return _token_cache.token

    if not settings.auth0_mgmt_enabled:
        raise Auth0MgmtError("Auth0 Management API is not configured")

    url = f"https://{settings.auth0_domain}/oauth/token"
    body = {
        "grant_type": "client_credentials",
        "client_id": settings.auth0_mgmt_client_id,
        "client_secret": settings.auth0_mgmt_client_secret,
        "audience": f"https://{settings.auth0_domain}/api/v2/",
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=body)
    except httpx.HTTPError as exc:
        raise Auth0MgmtError(f"Auth0 token endpoint unreachable: {exc}") from exc

    if resp.status_code != 200:
        raise Auth0MgmtError(
            f"Auth0 token request failed: {resp.status_code} {resp.text[:200]}",
            status_code=resp.status_code,
        )

    data = resp.json()
    token = data.get("access_token")
    expires_in = int(data.get("expires_in") or 3600)
    if not token:
        raise Auth0MgmtError("Auth0 token response missing access_token")

    _token_cache = _CachedToken(token=token, expires_at=now + expires_in)
    return token


async def _request(method: str, path: str, *, params: dict | None = None, json: dict | None = None) -> httpx.Response:
    """Issue an authed Management API request."""
    token = await _get_management_token()
    url = f"https://{settings.auth0_domain}/api/v2{path}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            return await client.request(
                method,
                url,
                params=params,
                json=json,
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError as exc:
        raise Auth0MgmtError(f"Auth0 {method} {path} unreachable: {exc}") from exc


async def find_user_by_email(email: str) -> Optional[dict]:
    """Return the first Auth0 user record matching this email, or None.

    Auth0 emails are case-insensitive and the API normalizes them, but
    we still lowercase ours before sending to avoid tripping cache or
    rate-limit edge cases.
    """
    resp = await _request("GET", "/users-by-email", params={"email": email.strip().lower()})
    if resp.status_code != 200:
        raise Auth0MgmtError(
            f"users-by-email failed: {resp.status_code} {resp.text[:200]}",
            status_code=resp.status_code,
        )
    arr = resp.json()
    if not arr:
        return None
    # Filter to our database connection — a stray Google-OAuth shadow
    # record for the same email would otherwise mislead us.
    for record in arr:
        for identity in record.get("identities", []):
            if identity.get("connection") == settings.auth0_connection:
                return record
    return arr[0]


async def create_user(
    *,
    email: str,
    full_name: str | None = None,
) -> str:
    """Provision an Auth0 user; return the ``sub`` (e.g. ``auth0|abc123``).

    The user is created with ``email_verified=false`` and a random
    throwaway password. The caller should immediately follow up with
    :func:`create_password_change_ticket` so the user gets an email
    invitation to set their real password.

    Email is the only identity Auth0 needs from us — our ``users.username``
    column exists for legacy reasons but isn't used for login on either
    side. The Auth0 connection should have "Requires Username" turned
    OFF; with it on, Auth0 enforces 1–15 char limits that don't match
    our internal username shape, and there'd be no way to keep the two
    in sync after a rename anyway.
    """
    if not settings.auth0_mgmt_enabled:
        raise Auth0MgmtError("Auth0 Management API is not configured")

    payload: dict = {
        "email": email.strip().lower(),
        "password": _generate_throwaway_password(),
        "connection": settings.auth0_connection,
        "email_verified": False,
        "verify_email": False,  # we send our own invite email
    }
    if full_name:
        payload["name"] = full_name.strip()

    resp = await _request("POST", "/users", json=payload)
    if resp.status_code == 201:
        data = resp.json()
        sub = data.get("user_id")
        if not sub:
            raise Auth0MgmtError("Auth0 create-user response missing user_id")
        return sub

    if resp.status_code == 409:
        # Conflict: the email already exists in Auth0. Look it up and
        # treat as success — same outcome from the caller's perspective
        # (a sub bound to this email).
        existing = await find_user_by_email(email)
        if existing and existing.get("user_id"):
            logger.info(
                "Auth0 user already existed for fp=%s; reusing sub",
                hashlib.blake2s(email.strip().lower().encode("utf-8"), digest_size=8).hexdigest(),
            )
            return existing["user_id"]

    code: str | None = None
    try:
        code = resp.json().get("errorCode")
    except ValueError:
        pass
    raise Auth0MgmtError(
        f"Auth0 create-user failed: {resp.status_code} {resp.text[:200]}",
        status_code=resp.status_code,
        code=code,
    )


async def set_user_password(*, sub: str, password: str, mark_email_verified: bool = True) -> None:
    """Set a user's password in Auth0 server-side.

    Used by the local password-set flow: the user enters their chosen
    password on our /set-password page, the backend verifies the
    one-time token, then calls this to push the password into Auth0.
    Bypasses Auth0's hosted form entirely.

    Auth0 enforces the connection's password policy here, so a too-weak
    password surfaces as :class:`Auth0MgmtError` with the policy
    message — the API layer should propagate it to the frontend so the
    user can correct it.

    Requires the ``update:users`` Mgmt API scope on the M2M app.
    """
    if not settings.auth0_mgmt_enabled:
        raise Auth0MgmtError("Auth0 Management API is not configured")
    if not sub:
        raise Auth0MgmtError("set_user_password requires a sub")

    # Auth0 disallows setting ``password`` and ``email_verified`` in
    # the same PATCH (it errors with "Cannot update password and
    # email_verified simultaneously"). Issue two requests when both
    # are needed; the email-verified flip is best-effort and doesn't
    # fail the overall operation if it errors.
    pw_resp = await _request("PATCH", f"/users/{sub}", json={
        "password": password,
        "connection": settings.auth0_connection,
    })
    if pw_resp.status_code != 200:
        description: str | None = None
        code: str | None = None
        try:
            data = pw_resp.json()
            description = data.get("message") or data.get("description")
            code = data.get("errorCode")
        except ValueError:
            pass
        raise Auth0MgmtError(
            description or f"Auth0 set-password failed: {pw_resp.status_code}",
            status_code=pw_resp.status_code,
            code=code,
        )

    if mark_email_verified:
        verify_resp = await _request("PATCH", f"/users/{sub}", json={
            "email_verified": True,
        })
        if verify_resp.status_code != 200:
            # Don't fail the whole operation — password is already set,
            # and email_verified flag can be flipped later. Just log.
            logger.warning(
                "Auth0 email_verified flip returned %s for %s: %s",
                verify_resp.status_code, sub, verify_resp.text[:200],
            )


async def delete_user(sub: str, *, raise_on_error: bool = False) -> None:
    """Delete an Auth0 user.

    Two call sites with different failure semantics:

      - **Rollback** (default, ``raise_on_error=False``): used to undo a
        half-completed provisioning when the *original* operation
        already failed. Raising here would mask that original error;
        instead we log and let the orphan sit (admin can clean up).

      - **Admin-initiated** (``raise_on_error=True``): the user is
        cascading from a deliberate "delete this user" in the app UI.
        We want the local delete to abort if Auth0 fails, so the admin
        can retry rather than discover an Auth0 orphan later.

    A 404 from Auth0 is always success-equivalent (record already gone).
    """
    if not sub:
        return
    resp = await _request("DELETE", f"/users/{sub}")
    if resp.status_code in (200, 204, 404):
        return
    msg = f"Auth0 delete-user returned {resp.status_code} for {sub}: {resp.text[:200]}"
    if raise_on_error:
        raise Auth0MgmtError(msg, status_code=resp.status_code)
    logger.warning(msg)


async def create_password_change_ticket(
    *,
    sub: str,
    redirect_url: str | None = None,
    ttl_seconds: int = 86_400 * 7,
) -> str:
    """Generate a one-time URL the user clicks to set their password.

    The URL lands them on Auth0's hosted password-set page; on success
    Auth0 redirects them to ``redirect_url`` (typically the app's login
    page). Default TTL is 7 days, matching the typical "invite link
    expiry" expectation for B2B onboarding.
    """
    if not settings.auth0_mgmt_enabled:
        raise Auth0MgmtError("Auth0 Management API is not configured")

    body: dict = {
        "user_id": sub,
        "ttl_sec": ttl_seconds,
        "mark_email_as_verified": True,
    }
    if redirect_url:
        body["result_url"] = redirect_url

    resp = await _request("POST", "/tickets/password-change", json=body)
    if resp.status_code != 201:
        raise Auth0MgmtError(
            f"Auth0 password-change ticket failed: {resp.status_code} {resp.text[:200]}",
            status_code=resp.status_code,
        )
    ticket_url = resp.json().get("ticket")
    if not ticket_url:
        raise Auth0MgmtError("Auth0 ticket response missing 'ticket' field")
    return ticket_url
