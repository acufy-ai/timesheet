"""Regression: the classifier prompt must teach the LLM that a body-only
timesheet (weekly date ranges paired with hour totals, no attachments)
is a valid submission shape.

History: before 2026-06-04, classify_email's system prompt only had a
positive hint for attachment-shaped submissions. Body-only forwards
like Kalpana's January 2026 submission classified as ``unrelated``
with reasoning that pointed at the missing attachment, and the
ingestion pipeline's hard skip-on-classifier-no gate dropped them.

These tests are structural (assert that the relevant prompt text is
still there) rather than LLM-output tests, because LLM behavior is
non-deterministic and live calls are slow + cost money in CI. A
separate opt-in live-call test at the bottom of this file exercises
the actual classifier when OPENAI_API_KEY is set in the dev shell;
it self-skips otherwise so it never costs anything in CI.
"""
import os

import pytest

from app.services import llm_ingestion


# ─────────────────────────────────────────────────────────────────────────
# Prompt-shape tests (deterministic, free)
# ─────────────────────────────────────────────────────────────────────────


def _extract_system_prompt() -> str:
    """Re-build the classify_email system prompt by patching the inner
    _call_llm and capturing the system message. Avoids depending on the
    private structure of the prompt string."""
    captured = {}

    async def fake_call_llm(system_prompt, user_content, **_kw):
        captured["system"] = system_prompt
        captured["user"] = user_content
        return {
            "is_timesheet_email": False,
            "intent": "unknown",
            "confidence": 0.0,
            "reasoning": "stub",
        }

    return fake_call_llm, captured


@pytest.mark.asyncio
async def test_prompt_explicitly_handles_body_only_timesheets(monkeypatch):
    """The system prompt must instruct the LLM that body-only
    submissions are valid when the body contains weekly date ranges
    plus hour totals."""
    fake, captured = _extract_system_prompt()
    monkeypatch.setattr(llm_ingestion, "_call_llm", fake)

    await llm_ingestion.classify_email(
        subject="Fwd: Regarding Jan 2026 Timesheets",
        body_text="Hi Team, please find the attached screenshots for Jan 2026.\n"
                  "01/01/2026 to 01/04/2026 - 8 hrs\n"
                  "01/05/2026 to 01/11/2026 - 41.5 hrs\n",
        attachment_filenames=[],
        attachment_mime_types=[],
        has_candidate_attachment=False,
    )

    system = captured["system"]
    # Must NOT be silent about body-only timesheets anymore.
    assert "body-only" in system.lower() or (
        "body itself contains" in system.lower()
        and "weekly date ranges" in system.lower()
    ), "system prompt must explicitly cover body-only timesheets"
    # Must show the concrete shape the LLM should look for.
    assert "hrs" in system.lower() or "hours" in system.lower(), (
        "system prompt must mention the 'hours' token the LLM should "
        "anchor on when looking for body-only submissions"
    )
    # Must include the counter-case rule so PTO/HR/approval emails don't
    # get re-classified as submissions by accident.
    assert "pto" in system.lower(), (
        "system prompt must call out PTO notices as a counter-case"
    )


@pytest.mark.asyncio
async def test_body_truncation_is_2000_chars(monkeypatch):
    """Before 2026-06-04 the body was truncated to 500 chars, which hid
    weekly rows in any submission longer than a short opener + 3-4 rows.
    Bumped to 2000 chars so a full month of weekly rows is visible."""
    fake, captured = _extract_system_prompt()
    monkeypatch.setattr(llm_ingestion, "_call_llm", fake)

    long_body = "Line\n" * 500  # 2500 chars, sample needs to be longer than cap
    await llm_ingestion.classify_email(
        subject="x",
        body_text=long_body,
        attachment_filenames=[],
        attachment_mime_types=[],
    )

    user = captured["user"]
    # The body shows up after "Body (first 2000 chars):" — confirm the new
    # label is there and that the LLM sees ~2000 chars not ~500.
    assert "Body (first 2000 chars):" in user, (
        "user prompt should label the body cap as 2000, not 500"
    )
    # Pull the body chunk out and check the length matches the new cap.
    body_marker = "Body (first 2000 chars): "
    body_start = user.index(body_marker) + len(body_marker)
    body_seen = user[body_start : user.rindex("</untrusted_input>")].strip()
    # 2000-char cap (the sanitizer strips control chars but our input is
    # plain ASCII so no shrink). Loose lower bound is enough.
    assert len(body_seen) > 1500, (
        f"body sent to LLM must reflect the 2000-char cap, got {len(body_seen)}"
    )


@pytest.mark.asyncio
async def test_attachment_hint_still_present_after_body_rule(monkeypatch):
    """The body-only rule is ADDITIVE. The original 'lean toward
    submission when attachments look like timesheets' hint must remain,
    otherwise attachment-shaped submissions could regress to
    lower confidence."""
    fake, captured = _extract_system_prompt()
    monkeypatch.setattr(llm_ingestion, "_call_llm", fake)

    await llm_ingestion.classify_email(
        subject="Timesheet",
        body_text="See attached",
        attachment_filenames=["timesheet_jan.xlsx"],
        attachment_mime_types=["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
        has_candidate_attachment=True,
    )

    system = captured["system"]
    assert "lean towards classifying" in system.lower() or (
        "lean toward classifying" in system.lower()
    ), "the attachment-shaped lean-toward-submission rule must remain"


# ─────────────────────────────────────────────────────────────────────────
# Live OpenAI smoke (opt-in; self-skips when no key)
# ─────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.environ.get("OPENAI_API_KEY")
    or os.environ.get("OPENAI_LIVE_CLASSIFIER_TEST") != "1",
    reason="Live classifier test only runs when OPENAI_API_KEY is set "
    "AND OPENAI_LIVE_CLASSIFIER_TEST=1. Costs ~$0.0001 per run.",
)
async def test_live_kalpana_body_only_classifies_as_submission():
    """Hit OpenAI for real and confirm the exact Kalpana shape now
    classifies as a submission. Opt-in via env var so CI doesn't pay."""
    result = await llm_ingestion.classify_email(
        subject="Fwd: Regarding Jan 2026 Timesheets",
        body_text=(
            "FYI\n\n"
            "From: PULI, KALPANA <kalpana.puli@state.mn.us>\n"
            "Date: February 4, 2026 at 3:45:12 PM CST\n"
            "To: kalpanapuli@gmail.com\n"
            "Subject: Regarding Jan 2026 Timesheets\n\n"
            "Hi Team,\n\n"
            "Please find the attached screenshots for Jan 2026. Total 162 hrs\n\n"
            "01/01/2026 to 01/04/2026 - 8 hrs\n"
            "01/05/2026 to 01/11/2026 - 41.5 hrs\n"
            "01/12/2026 to 01/18/2026 - 40 hrs\n"
            "01/19/2026 to 01/25/2026 - 32.5 hrs\n"
            "01/26/2026 to 02/01/2026 - 40 hrs\n\n"
            "Thanks,\nKalpana\n"
        ),
        attachment_filenames=[],
        attachment_mime_types=[],
        has_candidate_attachment=False,
    )
    assert result is not None, "LLM call must not return None"
    assert result.get("is_timesheet_email") is True, (
        f"Kalpana's body-only submission must classify as a timesheet; "
        f"got {result}"
    )
    assert result.get("intent") in {"new_submission", "resubmission", "correction"}, (
        f"intent must be a submission flavor; got {result.get('intent')}"
    )
