"""Regression: _is_actionable_skipped_email must surface body-only
timesheets — the classifier-said-yes-but-no-attachments case.

History: before 2026-06-04, a forwarded body-only submission like
Kalpana's January 2026 month landed with skip_reason=
``no_candidate_timesheet_attachment``. The actionable filter treated
that skip reason as 'noise' regardless of whether the LLM classifier
had said this WAS a submission, so the row never appeared in the
Skipped tab. The fix: if the classifier explicitly said
is_timesheet_email=True OR returned a submission-flavored intent,
short-circuit to True before the attachment-noise gates kick in.

This file covers the override and several non-override cases so the
fix doesn't accidentally widen actionability.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.api.ingestion import _is_actionable_skipped_email


def _make_email(
    *,
    classification: dict | None,
    has_attachments: bool = False,
    subject: str = "",
):
    """Lightweight stand-in. The filter only reads ``.subject``,
    ``.has_attachments``, and ``.llm_classification``; using a real
    SQLAlchemy model here breaks because ``__new__`` skips the
    instrumented mapper. SimpleNamespace gives us exactly the
    attribute shape the function needs without the ORM mechanics."""
    return SimpleNamespace(
        subject=subject,
        has_attachments=has_attachments,
        llm_classification=classification,
    )


def test_classifier_yes_overrides_no_attachment_noise():
    """Kalpana's exact shape: body-only submission flagged as a query by
    the OLD prompt would never reach here, but with the NEW prompt the
    LLM emits intent=new_submission. The pipeline then hits the
    no_candidate_timesheet_attachment gate. This filter must STILL
    surface the row because the classifier said yes."""
    email = _make_email(
        classification={
            "is_timesheet_email": True,
            "intent": "new_submission",
            "confidence": 0.9,
        },
        has_attachments=False,
    )
    assert _is_actionable_skipped_email(
        email, [], "no_candidate_timesheet_attachment"
    ) is True


def test_classifier_yes_via_intent_only():
    """``intent`` is a submission flavor even if is_timesheet_email
    happens to be False. Either signal is enough."""
    email = _make_email(
        classification={
            "is_timesheet_email": False,
            "intent": "resubmission",
            "confidence": 0.8,
        },
        has_attachments=False,
    )
    assert _is_actionable_skipped_email(
        email, [], "no_candidate_timesheet_attachment"
    ) is True


def test_classifier_no_with_no_attachments_still_noise():
    """The fix must NOT widen actionability for genuinely off-topic
    emails. When the classifier said unrelated AND there are no
    attachments, the row stays filtered as noise."""
    email = _make_email(
        classification={
            "is_timesheet_email": False,
            "intent": "unrelated",
            "confidence": 0.9,
        },
        has_attachments=False,
    )
    assert _is_actionable_skipped_email(
        email, [], "no_candidate_timesheet_attachment"
    ) is False


def test_classifier_no_with_not_timesheet_skip_reason_still_noise():
    """The existing 'not_timesheet_email:' skip-reason rule must keep
    working: even with empty classification, a row stamped with that
    skip reason is hidden from the actionable list."""
    email = _make_email(
        classification={
            "is_timesheet_email": False,
            "intent": "query",
        },
        has_attachments=False,
    )
    assert _is_actionable_skipped_email(
        email, [], "not_timesheet_email:query"
    ) is False


def test_subject_keyword_alone_does_not_trigger_override():
    """Subject keywords + no attachments + no classifier-yes is still
    noise. The override is intentionally tight to keep PTO-reminder /
    'timesheet question' / 'timesheet approved' emails out."""
    email = _make_email(
        classification={
            "is_timesheet_email": False,
            "intent": "query",
        },
        has_attachments=False,
        subject="Timesheet question",
    )
    # Even with a 'timesheet' keyword in the subject, no attachments
    # and no classifier-yes -> still filtered (the pre-2026-06-04
    # behavior for this case is preserved).
    assert _is_actionable_skipped_email(
        email, [], "no_candidate_timesheet_attachment"
    ) is False
