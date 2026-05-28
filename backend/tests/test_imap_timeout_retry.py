"""
Regression test for the IMAP timeout retry.

Before today's change, ``_run_imap_operation`` raised on the first
timeout. Gmail's IMAP endpoint hiccups for a few seconds occasionally
and a single transient stall would tank an entire scheduled fetch,
flip the cursor-failure path, and surface a red banner to the user
even though the next attempt would have worked.

The new behaviour: on the first timeout we sleep
``IMAP_TIMEOUT_RETRY_BACKOFF`` seconds and retry once. Only a SECOND
timeout surfaces as a failure. This test pins both halves of that.
"""
import asyncio
from unittest.mock import patch

import pytest

from app.services import imap as imap_module
from app.services.imap import _run_imap_operation


class _StubMailbox:
    """Just enough surface for _run_imap_operation to do its thing on
    a basic-auth (non-OAuth) mailbox so we skip the token-refresh path."""
    id = 99
    label = "Stub"
    auth_type = imap_module.MailboxAuthType.basic
    host = "imap.example"
    port = 993
    use_ssl = True
    username = "u"
    password = "p"
    oauth_provider = None


@pytest.mark.asyncio
async def test_first_timeout_retries_and_then_succeeds():
    """One timeout, then success on the retry -> no exception."""
    mailbox = _StubMailbox()
    call_count = {"n": 0}

    def _fake_fn(server, *args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            # Simulate a stall longer than the timeout. asyncio.wait_for
            # will translate this into asyncio.TimeoutError for the
            # caller.
            import time
            time.sleep(imap_module.IMAP_OPERATION_TIMEOUT + 0.5)
            return "should not reach"
        return "ok"

    # Skip the actual IMAP connect/login and the retry sleep.
    with (
        patch.object(imap_module, "_imap_connect_sync", return_value=object()),
        patch.object(imap_module, "IMAP_OPERATION_TIMEOUT", 0.05),
        patch.object(imap_module, "IMAP_TIMEOUT_RETRY_BACKOFF", 0.0),
    ):
        result = await _run_imap_operation(mailbox, None, _fake_fn)

    assert result == "ok"
    assert call_count["n"] == 2  # first stalled, second succeeded


@pytest.mark.asyncio
async def test_second_timeout_raises():
    """Two timeouts in a row -> TimeoutError surfaces."""
    mailbox = _StubMailbox()
    call_count = {"n": 0}

    def _always_stalls(server, *args, **kwargs):
        call_count["n"] += 1
        import time
        time.sleep(imap_module.IMAP_OPERATION_TIMEOUT + 0.5)
        return "never"

    with (
        patch.object(imap_module, "_imap_connect_sync", return_value=object()),
        patch.object(imap_module, "IMAP_OPERATION_TIMEOUT", 0.05),
        patch.object(imap_module, "IMAP_TIMEOUT_RETRY_BACKOFF", 0.0),
        pytest.raises(TimeoutError) as exc_info,
    ):
        await _run_imap_operation(mailbox, None, _always_stalls)

    assert "retried once" in str(exc_info.value)
    assert call_count["n"] == 2  # original + one retry, then surface


@pytest.mark.asyncio
async def test_success_on_first_attempt_does_not_retry():
    """Happy path: no timeout, no retry, no backoff sleep."""
    mailbox = _StubMailbox()
    call_count = {"n": 0}

    def _fast(server, *args, **kwargs):
        call_count["n"] += 1
        return {"ok": True}

    sleep_calls = []

    async def _track_sleep(delay):
        sleep_calls.append(delay)

    with (
        patch.object(imap_module, "_imap_connect_sync", return_value=object()),
        patch.object(asyncio, "sleep", _track_sleep),
    ):
        result = await _run_imap_operation(mailbox, None, _fast)

    assert result == {"ok": True}
    assert call_count["n"] == 1
    assert sleep_calls == []
