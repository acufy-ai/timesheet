"""Gmail REST API mailbox fetcher.

Drop-in alternative to the IMAP path for ``oauth_provider=google``
mailboxes. Sidesteps Gmail's opaque mid-stream IMAP FETCH throttle (the
one that returns a few messages then silently hangs the socket) by
using per-message HTTPS calls with explicit 429/Retry-After handling.

Public surface: ``fetch_messages_via_gmail_api`` returns the SAME shape
as :func:`app.services.imap.fetch_messages` (a list of dicts with the
same keys), so the worker downstream — parser, dedupe, classifier,
ingestion sync — is unchanged.

Existing OAuth scope on the mailbox row already grants Gmail API access:
the requested scope ``https://mail.google.com/`` is a superset that
covers ``users.messages.list`` and ``users.messages.get``. No re-consent.

Caller is expected to handle DB persistence of the parsed dicts —
exactly as the IMAP caller already does.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.mailbox import Mailbox

logger = logging.getLogger(__name__)

GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1"

# Per-request HTTP timeout. Each call is a single HTTPS round trip, so
# this is the wall-clock budget for "list one page" or "get one message
# raw bytes." Anything stuck here is a real outage, not a throttle.
HTTP_TIMEOUT_SECONDS = 30.0

# Page size for messages.list. Google caps maxResults at 500 but smaller
# pages reduce the blast radius of a partial-page failure.
LIST_PAGE_SIZE = 100

# Safety cap on total messages fetched in one run, mirrored from the
# Microsoft Graph path. First-fetch backlogs above this size will roll
# forward across multiple cron ticks rather than burning quota in one shot.
MAX_MESSAGES_PER_RUN = 500

# Default retry/backoff knobs. 429 responses respect Retry-After when set.
MAX_RETRIES_PER_REQUEST = 5
BACKOFF_BASE_SECONDS = 2.0
BACKOFF_CAP_SECONDS = 60.0


def _last_fetched_cutoff(last_fetched_at: datetime | None) -> datetime:
    """Mirror the IMAP path: subtract 5 minutes of slack from the cursor
    so a clock-skew or in-flight delivery doesn't get missed, or fall
    back to the configured initial-window if there's no cursor."""
    if last_fetched_at is not None:
        return last_fetched_at - timedelta(minutes=5)
    return datetime.now(timezone.utc) - timedelta(
        days=settings.email_fetch_initial_days
    )


def _gmail_q_after(cutoff: datetime) -> str:
    """Gmail's search ``after:`` operator takes YYYY/MM/DD and is
    inclusive. Matches the IMAP ``SEARCH SINCE`` behavior we replaced."""
    return f"after:{cutoff.strftime('%Y/%m/%d')}"


async def _request_with_retry(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    params: dict[str, Any] | None = None,
    on_unauthorized=None,
) -> httpx.Response:
    """One Gmail API request with bounded exponential backoff on
    429 / 5xx, and a single 401-driven token refresh hook.

    ``on_unauthorized`` is an async callable that returns a fresh bearer
    token. Called at most once per request when the server returns 401.
    Any other 4xx is raised straight through — we don't retry client
    errors blindly because they usually mean the request is malformed.
    """
    attempt = 0
    refreshed_auth = False
    while True:
        attempt += 1
        try:
            resp = await client.request(
                method,
                url,
                headers=headers,
                params=params,
                timeout=HTTP_TIMEOUT_SECONDS,
            )
        except (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.RemoteProtocolError) as exc:
            if attempt >= MAX_RETRIES_PER_REQUEST:
                raise
            delay = min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)))
            logger.warning(
                "Gmail API %s %s: %s — retrying in %.1fs (attempt %d/%d)",
                method, url, exc, delay, attempt, MAX_RETRIES_PER_REQUEST,
            )
            await asyncio.sleep(delay)
            continue

        if resp.status_code == 401 and on_unauthorized is not None and not refreshed_auth:
            new_token = await on_unauthorized()
            headers = {**headers, "Authorization": f"Bearer {new_token}"}
            refreshed_auth = True
            continue

        if resp.status_code == 429 or resp.status_code >= 500:
            if attempt >= MAX_RETRIES_PER_REQUEST:
                resp.raise_for_status()
                return resp  # unreachable, kept for type checker
            retry_after = resp.headers.get("Retry-After")
            if retry_after and retry_after.isdigit():
                delay = min(BACKOFF_CAP_SECONDS, float(retry_after))
            else:
                delay = min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)))
            logger.warning(
                "Gmail API %s %s: %d — retrying in %.1fs (attempt %d/%d)",
                method, url, resp.status_code, delay, attempt, MAX_RETRIES_PER_REQUEST,
            )
            await asyncio.sleep(delay)
            continue

        return resp


async def _list_message_ids(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    *,
    cutoff: datetime,
    on_unauthorized,
) -> list[str]:
    """Walk users.messages.list pages until exhausted or the safety cap
    is hit. Returns a flat list of Gmail message IDs (strings)."""
    ids: list[str] = []
    page_token: str | None = None
    q = _gmail_q_after(cutoff)
    while True:
        params: dict[str, Any] = {
            "q": q,
            "maxResults": LIST_PAGE_SIZE,
        }
        if page_token:
            params["pageToken"] = page_token
        resp = await _request_with_retry(
            client,
            "GET",
            f"{GMAIL_API_BASE}/users/me/messages",
            headers=headers,
            params=params,
            on_unauthorized=on_unauthorized,
        )
        resp.raise_for_status()
        body = resp.json()
        for entry in body.get("messages", []) or []:
            mid = entry.get("id")
            if mid:
                ids.append(mid)
        page_token = body.get("nextPageToken")
        if not page_token:
            break
        if len(ids) >= MAX_MESSAGES_PER_RUN:
            logger.info(
                "Gmail API: hit MAX_MESSAGES_PER_RUN=%d; remaining messages roll over to next fetch",
                MAX_MESSAGES_PER_RUN,
            )
            break
    return ids[:MAX_MESSAGES_PER_RUN]


async def _get_raw_message(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    message_id: str,
    *,
    on_unauthorized,
) -> bytes | None:
    """Fetch one message in raw (RFC822) form. Returns the decoded bytes
    or None if the message no longer exists (404 / deleted between list
    and get)."""
    params = {"format": "raw"}
    resp = await _request_with_retry(
        client,
        "GET",
        f"{GMAIL_API_BASE}/users/me/messages/{message_id}",
        headers=headers,
        params=params,
        on_unauthorized=on_unauthorized,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    body = resp.json()
    raw_b64 = body.get("raw")
    if not raw_b64:
        return None
    # Gmail returns base64url-encoded RFC822. Standard base64 decoders
    # need '+'/'/' so we use urlsafe_b64decode which handles '-'/'_'.
    padding = "=" * (-len(raw_b64) % 4)
    return base64.urlsafe_b64decode(raw_b64 + padding)


async def fetch_messages_via_gmail_api(
    mailbox: Mailbox,
    session: AsyncSession,
) -> list[dict]:
    """Fetch all (recent) messages for ``mailbox`` via Gmail REST API.

    Returns a list of dicts with the SAME shape as
    :func:`app.services.imap.fetch_messages` for OAuth Gmail mailboxes.
    Callers ingest each dict identically — there is no protocol-specific
    branching downstream.

    Persists nothing itself. If a single message fails to decode or
    parse, it is logged and skipped so the rest of the batch still
    lands. This is the behavior the IMAP path could not give us: a
    mid-stream stall used to discard the entire batch.
    """
    # Local import keeps the dependency graph one-way: imap imports
    # gmail_api, not the reverse, so unit tests can stub each side.
    from app.services.imap import _get_fresh_access_token

    access_token = await _get_fresh_access_token(mailbox, session)

    async def _refresh_for_401() -> str:
        return await _get_fresh_access_token(mailbox, session, force_refresh=True)

    cutoff = _last_fetched_cutoff(mailbox.last_fetched_at)
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
    }

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        message_ids = await _list_message_ids(
            client,
            headers,
            cutoff=cutoff,
            on_unauthorized=_refresh_for_401,
        )
        logger.info(
            "Gmail API: mailbox %s listed %d candidate message(s) since %s",
            mailbox.id, len(message_ids), cutoff.isoformat(),
        )

        parsed_messages: list[dict] = []
        for idx, mid in enumerate(message_ids, 1):
            try:
                raw = await _get_raw_message(
                    client, headers, mid, on_unauthorized=_refresh_for_401,
                )
            except Exception as exc:
                logger.warning(
                    "Gmail API: mailbox %s message %s GET failed: %s — skipping",
                    mailbox.id, mid, exc,
                )
                continue
            if raw is None:
                continue
            try:
                # Reuse the IMAP parser — same RFC822 input, same output dict.
                from app.services.imap import _parse_raw_message
                parsed = _parse_raw_message(raw)
                # The IMAP path uses the IMAP UID as "uid". For Gmail API
                # the Gmail message ID plays that role (stable per message,
                # not per session, which is actually stronger than IMAP UID).
                parsed["uid"] = mid
                parsed_messages.append(parsed)
            except Exception as exc:
                logger.warning(
                    "Gmail API: mailbox %s message %s parse failed: %s — skipping",
                    mailbox.id, mid, exc,
                )
                continue

    logger.info(
        "Gmail API: mailbox %s returning %d parsed messages",
        mailbox.id, len(parsed_messages),
    )
    return parsed_messages
