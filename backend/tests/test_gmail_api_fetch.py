"""
Unit tests for the Gmail REST API fetch path.

The IMAP path used to silently hang mid-stream when Gmail's per-account
throttle kicked in, discarding every message already fetched. The REST
path replaces it with explicit per-message HTTPS calls + bounded
retries; these tests pin the behaviors we depend on:

  - Pagination across multiple list pages.
  - 401 triggers exactly one token refresh, then the request succeeds.
  - 429 with a Retry-After header backs off, then the request succeeds.
  - A single message that fails to GET is logged and skipped — the rest
    of the batch still lands. (This is the property the IMAP path could
    not give us.)
  - 404 on GET (message deleted between list and get) is a benign skip.
"""
from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.services import gmail_api as gmail_api_module
from app.services.gmail_api import (
    GMAIL_API_BASE,
    fetch_messages_via_gmail_api,
)


# A minimal but valid RFC822 message that the real ``parse_email`` can
# parse without raising. Keeps the test focused on the API layer.
_SAMPLE_RFC822 = (
    b"Message-ID: <gmail-api-test@example.com>\r\n"
    b"From: \"Test Sender\" <sender@example.com>\r\n"
    b"To: recipient@example.com\r\n"
    b"Subject: Hello from Gmail API\r\n"
    b"Date: Thu, 29 May 2026 10:00:00 +0000\r\n"
    b"Content-Type: text/plain; charset=utf-8\r\n"
    b"\r\n"
    b"Body of the test email.\r\n"
)


class _StubMailbox:
    """Minimal attributes the Gmail API path reads off the mailbox."""
    id = 999
    label = "Stub Google Mailbox"
    last_fetched_at = None  # forces the initial-window cutoff path


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _make_route(handler):
    """Wrap a callable as an httpx MockTransport handler. The handler
    receives the request and returns an httpx.Response."""
    return httpx.MockTransport(handler)


@pytest.fixture
def stub_token():
    """Patch _get_fresh_access_token so the API path does not try to
    refresh a real OAuth token. Returns the AsyncMock so tests can
    assert refresh-was-called-once etc."""
    with patch(
        "app.services.imap._get_fresh_access_token",
        new=AsyncMock(return_value="initial-token"),
    ) as mock:
        yield mock


def _install_transport(handler):
    """Replace the AsyncClient used inside fetch_messages_via_gmail_api
    with one that routes through our handler. Done by patching
    httpx.AsyncClient to a thin wrapper that injects ``transport=``."""
    real_async_client = httpx.AsyncClient

    def _factory(*args, **kwargs):
        kwargs["transport"] = _make_route(handler)
        return real_async_client(*args, **kwargs)

    return patch.object(gmail_api_module.httpx, "AsyncClient", _factory)


@pytest.mark.asyncio
async def test_list_pagination_walks_all_pages(stub_token):
    """messages.list returns two pages; the API path follows
    nextPageToken until exhausted and GETs every message."""
    pages = [
        {"messages": [{"id": "m1"}, {"id": "m2"}], "nextPageToken": "PAGE2"},
        {"messages": [{"id": "m3"}]},
    ]
    list_calls: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.startswith(f"{GMAIL_API_BASE}/users/me/messages?") or url.endswith(
            "/users/me/messages"
        ):
            token = request.url.params.get("pageToken")
            list_calls.append(token)
            page = pages[len(list_calls) - 1]
            return httpx.Response(200, json=page)
        # message GET
        return httpx.Response(200, json={"raw": _b64url(_SAMPLE_RFC822)})

    with _install_transport(handler):
        result = await fetch_messages_via_gmail_api(_StubMailbox(), session=None)

    assert [c or None for c in list_calls] == [None, "PAGE2"]
    assert len(result) == 3
    assert {r["uid"] for r in result} == {"m1", "m2", "m3"}


@pytest.mark.asyncio
async def test_401_triggers_single_refresh_then_succeeds(stub_token):
    """One 401 on the LIST call: API path swaps in a fresh token and
    retries the same request. The refresh is called exactly once."""
    refresh_count = {"n": 0}

    async def _fake_refresh(*args, **kwargs):
        refresh_count["n"] += 1
        return "refreshed-token"

    call_state = {"list_attempts": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/users/me/messages") and not request.url.path.endswith(
            "/users/me/messages/m1"
        ):
            call_state["list_attempts"] += 1
            auth = request.headers.get("Authorization", "")
            if call_state["list_attempts"] == 1:
                # First attempt: token is the initial one — reject it.
                assert auth == "Bearer initial-token"
                return httpx.Response(401, json={"error": "unauthorized"})
            # Second attempt: token must be the refreshed one.
            assert auth == "Bearer refreshed-token"
            return httpx.Response(200, json={"messages": [{"id": "m1"}]})
        # GET m1
        return httpx.Response(200, json={"raw": _b64url(_SAMPLE_RFC822)})

    with patch(
        "app.services.imap._get_fresh_access_token",
        side_effect=[
            "initial-token",   # initial token fetch
            "refreshed-token", # forced-refresh after 401
        ],
        new_callable=AsyncMock,
    ):
        with _install_transport(handler):
            result = await fetch_messages_via_gmail_api(_StubMailbox(), session=None)

    assert len(result) == 1
    assert result[0]["uid"] == "m1"


@pytest.mark.asyncio
async def test_429_with_retry_after_backs_off_then_succeeds(stub_token):
    """429 with Retry-After=1 backs off, then the same request returns
    200. Total call count is 2; no other side effects."""
    list_attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/users/me/messages"):
            list_attempts["n"] += 1
            if list_attempts["n"] == 1:
                return httpx.Response(
                    429,
                    headers={"Retry-After": "1"},
                    json={"error": "rate_limit"},
                )
            return httpx.Response(200, json={"messages": [{"id": "m1"}]})
        return httpx.Response(200, json={"raw": _b64url(_SAMPLE_RFC822)})

    # Patch asyncio.sleep so we don't actually wait. We still need to
    # confirm it was called with the Retry-After value.
    sleep_calls: list[float] = []

    async def _fast_sleep(delay):
        sleep_calls.append(delay)

    with patch.object(gmail_api_module.asyncio, "sleep", _fast_sleep):
        with _install_transport(handler):
            result = await fetch_messages_via_gmail_api(_StubMailbox(), session=None)

    assert list_attempts["n"] == 2
    assert sleep_calls and sleep_calls[0] == 1.0
    assert len(result) == 1


@pytest.mark.asyncio
async def test_one_failing_get_does_not_drop_the_batch(stub_token):
    """messages.list returns 3 IDs. The middle GET 500s and exhausts
    its retries. The other two must still come back parsed. This is the
    behavior the IMAP path could not give us."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/users/me/messages") and not request.url.path.startswith(
            f"{GMAIL_API_BASE.replace('https://', '')}/users/me/messages/"
        ) and "/users/me/messages/" not in request.url.path:
            return httpx.Response(
                200,
                json={"messages": [{"id": "m1"}, {"id": "m_fail"}, {"id": "m3"}]},
            )
        # GET path
        if request.url.path.endswith("/users/me/messages/m_fail"):
            return httpx.Response(500, json={"error": "boom"})
        return httpx.Response(200, json={"raw": _b64url(_SAMPLE_RFC822)})

    # Speed up the retries on the failing GET.
    async def _fast_sleep(delay):  # noqa: ARG001
        return None

    with patch.object(gmail_api_module.asyncio, "sleep", _fast_sleep):
        with _install_transport(handler):
            result = await fetch_messages_via_gmail_api(_StubMailbox(), session=None)

    assert {r["uid"] for r in result} == {"m1", "m3"}


@pytest.mark.asyncio
async def test_404_get_is_a_benign_skip(stub_token):
    """A message deleted between list-time and get-time returns 404.
    The path skips it without raising, so the rest of the batch still
    lands."""
    def handler(request: httpx.Request) -> httpx.Response:
        if "/users/me/messages/" in request.url.path:
            if request.url.path.endswith("/m_gone"):
                return httpx.Response(404, json={"error": "not_found"})
            return httpx.Response(200, json={"raw": _b64url(_SAMPLE_RFC822)})
        return httpx.Response(
            200, json={"messages": [{"id": "m_gone"}, {"id": "m_keeper"}]}
        )

    with _install_transport(handler):
        result = await fetch_messages_via_gmail_api(_StubMailbox(), session=None)

    assert [r["uid"] for r in result] == ["m_keeper"]


@pytest.mark.asyncio
async def test_progress_callback_emits_listed_then_per_message_fetched(stub_token):
    """When a progress callback is supplied, the API path calls it once
    with stage='listed' after the list pages resolve, then once per
    successfully-fetched message with stage='fetched'. This is what the
    worker uses to bump the UI status bar so a user staring at the
    Inbox page sees actual movement instead of 'Connecting... 10%'."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/users/me/messages") and "/users/me/messages/" not in request.url.path:
            return httpx.Response(
                200,
                json={"messages": [{"id": "m1"}, {"id": "m2"}, {"id": "m3"}]},
            )
        return httpx.Response(200, json={"raw": _b64url(_SAMPLE_RFC822)})

    progress_calls: list[tuple[str, int, int]] = []

    async def _capture(stage: str, fetched: int, total: int) -> None:
        progress_calls.append((stage, fetched, total))

    with _install_transport(handler):
        result = await fetch_messages_via_gmail_api(
            _StubMailbox(), session=None, progress_callback=_capture,
        )

    assert len(result) == 3
    # First call after list-pages resolves: stage='listed', fetched=0,
    # total=3 — so the worker can update the bar to "Fetching 3 emails..."
    # before the slow per-message loop starts.
    assert progress_calls[0] == ("listed", 0, 3)
    # Then one "fetched" call per successful GET, monotonically increasing.
    assert [c for c in progress_calls[1:]] == [
        ("fetched", 1, 3),
        ("fetched", 2, 3),
        ("fetched", 3, 3),
    ]


@pytest.mark.asyncio
async def test_progress_callback_failure_does_not_break_fetch(stub_token):
    """If the progress callback raises (e.g. Redis is down briefly),
    the fetch still completes and returns all messages. A broken
    status-write must never abort a fetch in flight."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/users/me/messages") and "/users/me/messages/" not in request.url.path:
            return httpx.Response(200, json={"messages": [{"id": "m1"}, {"id": "m2"}]})
        return httpx.Response(200, json={"raw": _b64url(_SAMPLE_RFC822)})

    async def _explode(*args, **kwargs) -> None:
        raise RuntimeError("redis is down")

    with _install_transport(handler):
        result = await fetch_messages_via_gmail_api(
            _StubMailbox(), session=None, progress_callback=_explode,
        )

    # Fetch still returns all messages despite the callback exploding.
    assert {r["uid"] for r in result} == {"m1", "m2"}


@pytest.mark.asyncio
async def test_progress_callback_not_called_for_skipped_messages(stub_token):
    """A 404 (deleted between list and get) does not emit a 'fetched'
    event — the message was never fetched. The total count stays the
    same so the UI bar doesn't lie about progress."""
    def handler(request: httpx.Request) -> httpx.Response:
        if "/users/me/messages/" in request.url.path:
            if request.url.path.endswith("/m_gone"):
                return httpx.Response(404, json={"error": "not_found"})
            return httpx.Response(200, json={"raw": _b64url(_SAMPLE_RFC822)})
        return httpx.Response(
            200, json={"messages": [{"id": "m_keep_1"}, {"id": "m_gone"}, {"id": "m_keep_2"}]},
        )

    progress_calls: list[tuple[str, int, int]] = []

    async def _capture(stage: str, fetched: int, total: int) -> None:
        progress_calls.append((stage, fetched, total))

    with _install_transport(handler):
        result = await fetch_messages_via_gmail_api(
            _StubMailbox(), session=None, progress_callback=_capture,
        )

    assert {r["uid"] for r in result} == {"m_keep_1", "m_keep_2"}
    # 'listed' for 3, then only 2 'fetched' events (the 404'd one is skipped).
    fetched_events = [c for c in progress_calls if c[0] == "fetched"]
    assert len(fetched_events) == 2


@pytest.mark.asyncio
async def test_uses_existing_cursor_when_present(stub_token):
    """When mailbox.last_fetched_at is set, the q= parameter on
    messages.list reflects that cursor (minus 5 minutes slack) rather
    than the default initial-window."""
    cursor = datetime(2026, 5, 20, 12, 0, 0, tzinfo=timezone.utc)

    class _MailboxWithCursor(_StubMailbox):
        last_fetched_at = cursor

    seen_q: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/users/me/messages"):
            seen_q.append(request.url.params.get("q", ""))
            return httpx.Response(200, json={"messages": []})
        return httpx.Response(404)

    with _install_transport(handler):
        await fetch_messages_via_gmail_api(_MailboxWithCursor(), session=None)

    # Cursor minus 5 minutes = 2026-05-20 11:55Z, which is still 2026-05-20.
    assert seen_q == ["after:2026/05/20"]
