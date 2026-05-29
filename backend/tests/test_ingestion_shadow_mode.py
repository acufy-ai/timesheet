"""
Tests for the shadow-mode comparison harness.

Shadow mode runs the metadata-only fetch in parallel with the canonical
full fetch, classifies each, and writes a JSONL log of agreements and
divergences. It must be:

  1. Observation-only (never throws into the worker hot path).
  2. Correct (matched/diverged/missing counts add up).
  3. Self-contained (failures inside shadow don't surface upward).

We stub fetch_messages_metadata_only and classify_email so we don't
need a real IMAP server or OpenAI key.
"""
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.ingestion_shadow import run_shadow_comparison


def _msg(message_id: str, *, subject: str = "x", filenames=(), body="") -> dict:
    return {
        "message_id": message_id,
        "subject": subject,
        "sender_email": "a@b",
        "body_text": body,
        "attachments": [
            {"filename": f, "mime_type": "application/pdf"}
            for f in filenames
        ],
    }


@pytest.mark.asyncio
async def test_shadow_matched_when_classifier_agrees(tmp_path):
    log = tmp_path / "shadow.jsonl"
    mailbox = MagicMock(id=42)
    session = MagicMock()

    full = [_msg("<a>", subject="Timesheet May", filenames=["ts.pdf"])]
    meta = [_msg("<a>", subject="Timesheet May", filenames=["ts.pdf"])]

    decisions = [
        {"is_timesheet_email": True, "intent": "new_submission", "confidence": 0.9},
        {"is_timesheet_email": True, "intent": "new_submission", "confidence": 0.9},
    ]
    with (
        patch("app.services.imap.fetch_messages_metadata_only",
              new=AsyncMock(return_value=meta)),
        patch("app.services.llm_ingestion.classify_email",
              new=AsyncMock(side_effect=decisions)),
    ):
        summary = await run_shadow_comparison(
            mailbox, session, full, log_path=str(log),
        )

    assert summary["matched"] == 1
    assert summary["diverged"] == 0
    assert summary["missing_in_full"] == 0
    assert summary["missing_in_metadata"] == 0
    assert summary["errors"] == 0

    # One JSONL row written.
    contents = log.read_text().strip().splitlines()
    assert len(contents) == 1
    row = json.loads(contents[0])
    assert row["status"] == "matched"
    assert row["full"]["decision"]["is_timesheet_email"] is True
    assert row["meta"]["decision"]["is_timesheet_email"] is True


@pytest.mark.asyncio
async def test_shadow_diverged_when_classifier_disagrees(tmp_path):
    log = tmp_path / "shadow.jsonl"
    mailbox = MagicMock(id=42)
    session = MagicMock()

    full = [_msg("<a>")]
    meta = [_msg("<a>")]

    decisions = [
        {"is_timesheet_email": True, "intent": "new_submission", "confidence": 0.9},
        {"is_timesheet_email": False, "intent": "unrelated", "confidence": 0.2},
    ]
    with (
        patch("app.services.imap.fetch_messages_metadata_only",
              new=AsyncMock(return_value=meta)),
        patch("app.services.llm_ingestion.classify_email",
              new=AsyncMock(side_effect=decisions)),
    ):
        summary = await run_shadow_comparison(
            mailbox, session, full, log_path=str(log),
        )

    assert summary["matched"] == 0
    assert summary["diverged"] == 1

    row = json.loads(log.read_text().strip())
    assert row["status"] == "diverged"


@pytest.mark.asyncio
async def test_shadow_handles_messages_only_in_one_list(tmp_path):
    log = tmp_path / "shadow.jsonl"
    mailbox = MagicMock(id=42)
    session = MagicMock()

    full = [_msg("<a>"), _msg("<only_in_full>")]
    meta = [_msg("<a>"), _msg("<only_in_meta>")]

    with (
        patch("app.services.imap.fetch_messages_metadata_only",
              new=AsyncMock(return_value=meta)),
        patch("app.services.llm_ingestion.classify_email",
              new=AsyncMock(return_value={
                  "is_timesheet_email": True, "intent": "x", "confidence": 0.5,
              })),
    ):
        summary = await run_shadow_comparison(
            mailbox, session, full, log_path=str(log),
        )

    assert summary["matched"] == 1
    assert summary["missing_in_full"] == 1
    assert summary["missing_in_metadata"] == 1


@pytest.mark.asyncio
async def test_shadow_swallows_metadata_fetch_failure(tmp_path):
    log = tmp_path / "shadow.jsonl"
    mailbox = MagicMock(id=42)
    session = MagicMock()

    full = [_msg("<a>")]

    with patch(
        "app.services.imap.fetch_messages_metadata_only",
        new=AsyncMock(side_effect=RuntimeError("imap explosion")),
    ):
        # Must NOT raise — shadow mode is observation only.
        summary = await run_shadow_comparison(
            mailbox, session, full, log_path=str(log),
        )

    assert summary["errors"] == 1
    assert summary["matched"] == 0


@pytest.mark.asyncio
async def test_shadow_swallows_classifier_failure(tmp_path):
    log = tmp_path / "shadow.jsonl"
    mailbox = MagicMock(id=42)
    session = MagicMock()

    full = [_msg("<a>")]
    meta = [_msg("<a>")]

    with (
        patch("app.services.imap.fetch_messages_metadata_only",
              new=AsyncMock(return_value=meta)),
        patch("app.services.llm_ingestion.classify_email",
              new=AsyncMock(side_effect=RuntimeError("openai down"))),
    ):
        summary = await run_shadow_comparison(
            mailbox, session, full, log_path=str(log),
        )

    assert summary["errors"] == 1


@pytest.mark.asyncio
async def test_shadow_creates_parent_dirs_for_log(tmp_path):
    nested = tmp_path / "logs" / "ingestion" / "shadow.jsonl"
    mailbox = MagicMock(id=42)
    session = MagicMock()

    full = [_msg("<a>")]
    meta = [_msg("<a>")]

    with (
        patch("app.services.imap.fetch_messages_metadata_only",
              new=AsyncMock(return_value=meta)),
        patch("app.services.llm_ingestion.classify_email",
              new=AsyncMock(return_value={
                  "is_timesheet_email": True, "intent": "x", "confidence": 0.5,
              })),
    ):
        await run_shadow_comparison(mailbox, session, full, log_path=str(nested))

    assert nested.exists()
    assert nested.read_text().strip()
