"""Shadow-mode comparison logger for the two-stage IMAP fetch rollout.

Goal: prove that the classifier produces the SAME decision on a
metadata-only fetch as it does on the full-body fetch we use today,
BEFORE we let the metadata-only path gate the attachment download in
production.

Workflow per fetch tick (when ``settings.ingestion_shadow_log_path`` is
set to a writable file path):

  1. Worker runs the normal ``fetch_messages`` (today's path, unchanged).
  2. Worker calls ``run_shadow_comparison`` with the resulting messages
     and the same mailbox/session.
  3. Shadow code fetches the SAME UIDs via ``fetch_messages_metadata_only``
     and runs the classifier on both outputs.
  4. Each per-message comparison is appended to the configured log file
     as one JSON line. Divergences are also logged at WARNING level so
     they're visible in the regular log stream.
  5. The shadow code NEVER mutates DB state, NEVER influences whether
     a message is processed, NEVER downloads attachment bytes. It is
     observation only.

Once N consecutive ticks across the soak window show zero divergences,
we flip ``ingestion_fetch_headers_first=true`` and the metadata-only
fetch becomes the gate. The classifier sees the same data either way;
the difference is whether the attachment bytes are pulled before or
after the decision.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.mailbox import Mailbox

logger = logging.getLogger(__name__)


async def run_shadow_comparison(
    mailbox: Mailbox,
    session: AsyncSession,
    full_messages: list[dict],
    *,
    log_path: str,
) -> dict:
    """Compare classifier decisions between metadata-only and full-fetch
    paths for the messages in ``full_messages``.

    Returns a small summary dict (counts, divergences) for the caller to
    surface in worker logs. The per-message detail goes to ``log_path``
    as JSONL.

    Failures here are swallowed (logged at WARNING). Shadow mode must
    NEVER affect production behavior — if the comparison itself errors,
    we accept the missed observation and move on.
    """
    from app.services.imap import fetch_messages_metadata_only
    from app.services.llm_ingestion import classify_email

    summary: dict[str, Any] = {
        "mailbox_id": mailbox.id,
        "full_count": len(full_messages),
        "metadata_count": 0,
        "matched": 0,
        "diverged": 0,
        "missing_in_metadata": 0,
        "missing_in_full": 0,
        "errors": 0,
    }

    try:
        meta_messages = await fetch_messages_metadata_only(mailbox, session)
        summary["metadata_count"] = len(meta_messages)
    except Exception as exc:
        logger.warning(
            "Shadow mode: metadata-only fetch failed for mailbox %s: %s",
            mailbox.id, exc,
        )
        summary["errors"] += 1
        return summary

    # Index both lists by message_id to align them.
    by_mid_full = {m.get("message_id"): m for m in full_messages if m.get("message_id")}
    by_mid_meta = {m.get("message_id"): m for m in meta_messages if m.get("message_id")}

    all_mids = set(by_mid_full) | set(by_mid_meta)

    rows: list[dict] = []
    for mid in all_mids:
        full = by_mid_full.get(mid)
        meta = by_mid_meta.get(mid)

        if full is None:
            summary["missing_in_full"] += 1
            rows.append(_row(mailbox.id, mid, full=None, meta=meta, status="only_in_meta"))
            continue
        if meta is None:
            summary["missing_in_metadata"] += 1
            rows.append(_row(mailbox.id, mid, full=full, meta=None, status="only_in_full"))
            continue

        try:
            full_decision = await classify_email(
                subject=full.get("subject") or "",
                body_text=full.get("body_text") or "",
                attachment_filenames=[a["filename"] for a in full.get("attachments", [])],
                attachment_mime_types=[a["mime_type"] for a in full.get("attachments", [])],
            )
            meta_decision = await classify_email(
                subject=meta.get("subject") or "",
                body_text=meta.get("body_text") or "",
                attachment_filenames=[a["filename"] for a in meta.get("attachments", [])],
                attachment_mime_types=[a["mime_type"] for a in meta.get("attachments", [])],
            )
        except Exception as exc:
            summary["errors"] += 1
            logger.warning(
                "Shadow mode: classifier failed for mailbox=%s mid=%s: %s",
                mailbox.id, mid, exc,
            )
            continue

        diverged = bool(full_decision.get("is_timesheet_email")) != bool(
            meta_decision.get("is_timesheet_email")
        )
        if diverged:
            summary["diverged"] += 1
            logger.warning(
                "Shadow mode DIVERGENCE mailbox=%s mid=%s full=%s meta=%s",
                mailbox.id, mid,
                full_decision.get("is_timesheet_email"),
                meta_decision.get("is_timesheet_email"),
            )
        else:
            summary["matched"] += 1

        rows.append(_row(
            mailbox.id, mid, full=full, meta=meta,
            status="diverged" if diverged else "matched",
            full_decision=full_decision, meta_decision=meta_decision,
        ))

    try:
        _append_jsonl(log_path, rows)
    except Exception as exc:
        logger.warning("Shadow mode: log append failed (%s): %s", log_path, exc)
        summary["errors"] += 1

    logger.info(
        "Shadow mode mailbox=%s: matched=%s diverged=%s missing_full=%s missing_meta=%s errors=%s",
        mailbox.id,
        summary["matched"],
        summary["diverged"],
        summary["missing_in_full"],
        summary["missing_in_metadata"],
        summary["errors"],
    )
    return summary


def _row(
    mailbox_id: int,
    message_id: str | None,
    *,
    full: dict | None,
    meta: dict | None,
    status: str,
    full_decision: dict | None = None,
    meta_decision: dict | None = None,
) -> dict:
    def _att_summary(message: dict | None) -> list[dict]:
        if not message:
            return []
        return [
            {
                "filename": a.get("filename"),
                "mime_type": a.get("mime_type"),
                "size_bytes": a.get("size_bytes")
                              if "size_bytes" in a
                              else (len(a["content"]) if isinstance(a.get("content"), bytes) else None),
            }
            for a in message.get("attachments", [])
        ]

    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "mailbox_id": mailbox_id,
        "message_id": message_id,
        "status": status,
        "full": {
            "subject": (full or {}).get("subject"),
            "sender_email": (full or {}).get("sender_email"),
            "body_chars": len((full or {}).get("body_text") or ""),
            "attachments": _att_summary(full),
            "decision": _decision_summary(full_decision),
        } if full else None,
        "meta": {
            "subject": (meta or {}).get("subject"),
            "sender_email": (meta or {}).get("sender_email"),
            "body_chars": len((meta or {}).get("body_text") or ""),
            "attachments": _att_summary(meta),
            "decision": _decision_summary(meta_decision),
        } if meta else None,
    }


def _decision_summary(decision: dict | None) -> dict | None:
    if not decision:
        return None
    return {
        "is_timesheet_email": decision.get("is_timesheet_email"),
        "intent": decision.get("intent"),
        "confidence": decision.get("confidence"),
    }


def _append_jsonl(path: str, rows: list[dict]) -> None:
    """Append rows as JSON lines. Create parent dirs if needed. Best-effort
    fsync each batch so partial logs survive crashes (small worker, small
    rows; the latency hit is negligible)."""
    p = Path(path).expanduser()
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, default=str))
            f.write("\n")
        try:
            f.flush()
            os.fsync(f.fileno())
        except Exception:
            pass
