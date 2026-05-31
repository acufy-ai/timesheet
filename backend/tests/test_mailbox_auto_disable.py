"""H6: A mailbox that fails to fetch repeatedly should auto-disable so
the worker isn't logging the same failure on every scheduled run.

The actual fetch path is full of IMAP + session machinery; here we
exercise the state-transition logic directly with a stand-in mailbox
and the threshold constant. The worker change is a simple loop:
  - on success: counter -> 0, reason -> None
  - on failure: counter += 1
  - if counter >= threshold and is_active: flip is_active off, set reason
"""
from datetime import datetime, timezone

import pytest

from app.workers.email_fetch import MAILBOX_AUTO_DISABLE_THRESHOLD


class _StubMailbox:
    """Mirrors the columns the worker writes; intentionally not a real
    SQLAlchemy model so the test stays away from the SQLite/JSONB shim
    machinery the other tests need."""
    def __init__(self) -> None:
        self.id = 1
        self.label = "Test Mailbox"
        self.is_active = True
        self.last_fetch_error: str | None = None
        self.last_fetch_failed_at: datetime | None = None
        self.consecutive_fetch_failures = 0
        self.auto_disabled_reason: str | None = None


def _record_failure(mailbox: _StubMailbox, exc_message: str) -> None:
    """Mirrors the worker's failure branch. If the worker ever drifts
    from this contract, this test will start to lie — keep the two in
    sync (or extract the logic into a helper)."""
    mailbox.last_fetch_error = exc_message[:1024]
    mailbox.last_fetch_failed_at = datetime.now(timezone.utc)
    mailbox.consecutive_fetch_failures = (mailbox.consecutive_fetch_failures or 0) + 1
    if (
        mailbox.consecutive_fetch_failures >= MAILBOX_AUTO_DISABLE_THRESHOLD
        and mailbox.is_active
    ):
        mailbox.is_active = False
        mailbox.auto_disabled_reason = (
            f"Couldn't connect to this mailbox {mailbox.consecutive_fetch_failures} "
            f"times in a row. Last error: {exc_message[:200]}"
        )


def _record_success(mailbox: _StubMailbox) -> None:
    """Mirrors the worker's success branch."""
    mailbox.last_fetch_error = None
    mailbox.last_fetch_failed_at = None
    mailbox.consecutive_fetch_failures = 0
    mailbox.auto_disabled_reason = None


def test_threshold_constant_is_loose_enough_for_dev_blips():
    """Tightening the threshold to <3 would auto-disable on a single bad
    afternoon. If a future change drops it under 3, the test forces a
    deliberate decision."""
    assert MAILBOX_AUTO_DISABLE_THRESHOLD >= 3


def test_single_failure_does_not_auto_disable():
    mailbox = _StubMailbox()
    _record_failure(mailbox, "Connection refused")
    assert mailbox.is_active is True
    assert mailbox.consecutive_fetch_failures == 1
    assert mailbox.auto_disabled_reason is None


def test_failures_below_threshold_do_not_auto_disable():
    mailbox = _StubMailbox()
    for _ in range(MAILBOX_AUTO_DISABLE_THRESHOLD - 1):
        _record_failure(mailbox, "Connection refused")
    assert mailbox.is_active is True
    assert mailbox.auto_disabled_reason is None


def test_threshold_hit_flips_is_active_and_sets_reason():
    mailbox = _StubMailbox()
    for _ in range(MAILBOX_AUTO_DISABLE_THRESHOLD):
        _record_failure(mailbox, "Connection refused")
    assert mailbox.is_active is False
    assert mailbox.auto_disabled_reason is not None
    assert "Couldn't connect" in mailbox.auto_disabled_reason


def test_success_resets_counter_and_clears_reason():
    mailbox = _StubMailbox()
    for _ in range(3):
        _record_failure(mailbox, "Connection refused")
    _record_success(mailbox)
    assert mailbox.consecutive_fetch_failures == 0
    assert mailbox.last_fetch_error is None
    assert mailbox.auto_disabled_reason is None


def test_re_enable_then_fail_re_disables():
    """Admin clicks 'Try again' (the endpoint resets counter + flips
    is_active back on). If the underlying problem isn't fixed, the next
    fetch fails, counter climbs back to the threshold, mailbox
    auto-disables again. This is the recovery semantics."""
    mailbox = _StubMailbox()
    for _ in range(MAILBOX_AUTO_DISABLE_THRESHOLD):
        _record_failure(mailbox, "auth")
    assert mailbox.is_active is False

    # Simulate the /try-again endpoint
    mailbox.is_active = True
    mailbox.consecutive_fetch_failures = 0
    mailbox.auto_disabled_reason = None

    # Underlying problem persists
    for _ in range(MAILBOX_AUTO_DISABLE_THRESHOLD):
        _record_failure(mailbox, "auth")
    assert mailbox.is_active is False
    assert mailbox.auto_disabled_reason is not None
