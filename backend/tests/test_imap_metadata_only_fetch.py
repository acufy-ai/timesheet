"""
Unit tests for the two-stage IMAP fetch helpers.

Stage 1 (metadata-only) is the bandwidth-saving change: pull ENVELOPE +
BODYSTRUCTURE + headers + small body preview, leaving attachment bytes
on the server. Stage 2 (`fetch_attachment_bytes`) is called only after
the classifier accepts an email.

These tests do not talk to a real IMAP server. They feed
`_walk_bodystructure` and `_parse_metadata_only_message` the same
shape of data `imapclient` produces, plus a stub `server` object that
records what FETCH commands were issued — so we can assert that
attachment bytes are NEVER requested in stage 1.
"""
from unittest.mock import MagicMock

import pytest

from app.services.imap import (
    _BODY_PREVIEW_BYTES,
    _fetch_attachment_part_sync,
    _parse_metadata_only_message,
    _walk_bodystructure,
)


def test_walk_bodystructure_simple_multipart_mixed():
    """A typical "email body + one PDF" message yields two leaves:
    the text/plain body at part 1 and the PDF at part 2."""
    # Tuple layout per RFC3501 BODYSTRUCTURE:
    #   text:     (type, subtype, params, id, desc, encoding, size, LINES,
    #              md5, disposition, lang, location)
    #   non-text: (type, subtype, params, id, desc, encoding, size,
    #              md5, disposition, lang, location)
    structure = [
        # part 1: text/plain (note 'lines=5' at position 7)
        (b"text", b"plain", (b"charset", b"utf-8"), None, None, b"7bit", 123, 5),
        # part 2: application/pdf with filename + attachment disposition
        (b"application", b"pdf",
         (b"name", b"Timesheet_May.pdf"),
         None, None, b"base64", 4096,
         None,  # md5
         (b"attachment", (b"filename", b"Timesheet_May.pdf"))),
        b"mixed",
    ]
    leaves = _walk_bodystructure(structure)
    assert len(leaves) == 2

    body = leaves[0]
    assert body["main_type"] == "text"
    assert body["sub_type"] == "plain"
    assert body["part_path"] == "1"
    assert body["size_bytes"] == 123

    pdf = leaves[1]
    assert pdf["main_type"] == "application"
    assert pdf["sub_type"] == "pdf"
    assert pdf["part_path"] == "2"
    assert pdf["filename"] == "Timesheet_May.pdf"
    assert pdf["size_bytes"] == 4096
    assert pdf["disposition"] == "attachment"


def test_walk_bodystructure_nested_multipart_alternative_with_attachment():
    """Common shape: multipart/mixed containing [multipart/alternative
    (plain + html), PDF attachment]. Part paths must be 1.1, 1.2, 2.
    """
    structure = [
        # part 1: multipart/alternative
        [
            (b"text", b"plain", (b"charset", b"utf-8"), None, None, b"7bit", 50, 3),
            (b"text", b"html", (b"charset", b"utf-8"), None, None, b"7bit", 200, 5),
            b"alternative",
        ],
        # part 2: PDF
        (b"application", b"pdf",
         (b"name", b"sheet.pdf"),
         None, None, b"base64", 8000,
         None,  # md5
         (b"attachment", (b"filename", b"sheet.pdf"))),
        b"mixed",
    ]
    leaves = _walk_bodystructure(structure)
    assert len(leaves) == 3

    plain = leaves[0]
    assert plain["sub_type"] == "plain"
    assert plain["part_path"] == "1.1"

    html = leaves[1]
    assert html["sub_type"] == "html"
    assert html["part_path"] == "1.2"

    pdf = leaves[2]
    assert pdf["sub_type"] == "pdf"
    assert pdf["part_path"] == "2"
    assert pdf["filename"] == "sheet.pdf"


def test_walk_bodystructure_inline_image_filename_in_content_type():
    """Inline images (like Gmail-forwarded screenshots) sometimes have
    the filename in Content-Type's ``name`` parameter and disposition
    ``inline``. We want to surface them as attachments anyway."""
    structure = [
        (b"text", b"plain", (b"charset", b"utf-8"), None, None, b"7bit", 50, 3),
        (b"image", b"png",
         (b"name", b"image001.png"),
         b"<inline-id@x>", None, b"base64", 10240,
         None,  # md5
         (b"inline", (b"filename", b"image001.png"))),
        b"related",
    ]
    leaves = _walk_bodystructure(structure)
    assert len(leaves) == 2
    img = leaves[1]
    assert img["main_type"] == "image"
    assert img["sub_type"] == "png"
    assert img["filename"] == "image001.png"
    assert img["disposition"] == "inline"


def test_parse_metadata_only_message_does_not_fetch_attachment_bytes():
    """The whole point of stage 1: parse a message into our dict shape
    WITHOUT issuing a FETCH for the attachment body."""
    # Fake imapclient server: records every fetch() call.
    fetches: list[tuple[list[int], list[str]]] = []
    server = MagicMock()

    def _fake_fetch(uids, items):
        fetches.append((list(uids), [str(i) for i in items]))
        # The body preview fetch returns a small text preview.
        # imapclient returns bytes keyed by something like b"BODY[1]<0>".
        return {uids[0]: {b"BODY[1]<0>": b"Hi here is my timesheet, attached."}}

    server.fetch = _fake_fetch

    raw_headers = (
        b"From: emp@example.com\r\n"
        b"To: inbox@example.com\r\n"
        b"Subject: Timesheet for May\r\n"
        b"Message-ID: <abc@example.com>\r\n"
        b"Date: Wed, 28 May 2026 10:00:00 +0000\r\n"
        b"Content-Type: multipart/mixed; boundary=BOUNDARY\r\n"
        b"\r\n"
    )
    bodystructure = [
        (b"text", b"plain", (b"charset", b"utf-8"), None, None, b"7bit", 100, 4),
        (b"application", b"pdf",
         (b"name", b"timesheet.pdf"),
         None, None, b"base64", 50000,
         None,  # md5
         (b"attachment", (b"filename", b"timesheet.pdf"))),
        b"mixed",
    ]
    data = {
        b"BODY[HEADER]": raw_headers,
        b"BODYSTRUCTURE": bodystructure,
        b"ENVELOPE": None,
        b"RFC822.SIZE": 50_500,
    }

    result = _parse_metadata_only_message(server, uid=42, data=data)
    assert result is not None
    assert result["subject"] == "Timesheet for May"
    assert result["sender_email"] == "emp@example.com"
    assert result["body_text"] == "Hi here is my timesheet, attached."
    assert result["_metadata_only"] is True

    # One attachment, with content=None and the part path filled in.
    assert len(result["attachments"]) == 1
    att = result["attachments"][0]
    assert att["filename"] == "timesheet.pdf"
    assert att["mime_type"] == "application/pdf"
    assert att["content"] is None
    assert att["part_path"] == "2"
    assert att["size_bytes"] == 50000

    # The fetch we issued must have been for the body preview only.
    # NEVER for the attachment part path "2".
    for uids, items in fetches:
        for item in items:
            assert "[2]" not in item, (
                f"stage 1 fetched attachment bytes: {item}"
            )
    # And the one fetch we DID issue should be the body preview window.
    assert any("BODY.PEEK[1]" in item and f"<0.{_BODY_PREVIEW_BYTES}>" in item
               for _, items in fetches for item in items)


def test_dsn_machinery_parts_are_not_counted_as_attachments():
    """DSN reports contain ``message/delivery-status`` and
    ``text/rfc822-headers`` parts. Those are MIME machinery, not real
    attachments — they have no filename and no attachment disposition.

    Without filtering them out, ``_parse_metadata_only_message`` would
    over-count attachments compared to the full-fetch path, which the
    classifier could interpret as ``has_candidate_attachment=true``
    and flip the decision.
    """
    server = MagicMock()
    server.fetch.return_value = {1: {b"BODY[1.1.1]<0>": b"bounce text"}}

    raw_headers = (
        b"From: mailer-daemon@googlemail.com\r\n"
        b"To: u@example.com\r\n"
        b"Subject: Delivery Status Notification (Failure)\r\n"
        b"Message-ID: <bounce@x>\r\n"
        b"Date: Wed, 28 May 2026 10:00:00 +0000\r\n"
        b"Content-Type: multipart/report; boundary=x\r\n"
        b"\r\n"
    )
    # multipart/report with an inline image, a delivery-status, a
    # rfc822-headers, AND a real attachment. Only the image and the
    # attachment should survive filtering.
    structure = (
        [
            (  # 1: multipart/related (body + inline image)
                [
                    (b"text", b"plain", (b"charset", b"utf-8"), None, None, b"7bit", 100, 5),
                    (b"image", b"png", (b"name", b"icon.png"),
                     b"<icon@x>", None, b"base64", 1986,
                     None, (b"attachment", (b"filename", b"icon.png"))),
                ],
                b"related",
                (b"boundary", b"rel"),
                None, None,
            ),
            # 2: DSN report — should NOT count as attachment
            (b"message", b"delivery-status", None, None, None, b"7bit", 559),
            # 3: rfc822 headers — should NOT count as attachment
            (b"text", b"rfc822-headers", None, None, None, b"7bit", 3216, 65),
        ],
        b"report",
        (b"boundary", b"top", b"report-type", b"delivery-status"),
        None, None,
    )
    data = {
        b"BODY[HEADER]": raw_headers,
        b"BODYSTRUCTURE": structure,
        b"ENVELOPE": None,
        b"RFC822.SIZE": 6000,
    }

    from app.services.imap import _parse_metadata_only_message
    result = _parse_metadata_only_message(server, uid=1, data=data)
    assert result is not None

    # Exactly 1 attachment: the icon. NOT the delivery-status or
    # rfc822-headers parts.
    assert len(result["attachments"]) == 1, (
        f"expected 1 attachment, got {len(result['attachments'])}: "
        f"{[(a['filename'], a['mime_type']) for a in result['attachments']]}"
    )
    att = result["attachments"][0]
    assert att["filename"] == "icon.png"
    assert att["mime_type"] == "image/png"


def test_walk_bodystructure_gmail_multipart_report():
    """Real Gmail DSN bounce shape: tuple-of-tuples-with-children-as-first.

    This is the shape we saw in production on 2026-05-29 — multipart/report
    containing a multipart/related (which contains a multipart/alternative,
    plus two inline images), a message/delivery-status, and a text/rfc822-
    headers. The old walker missed everything because it only handled
    list-shaped multiparts; this shape comes back as TUPLES.
    """
    structure = (
        [
            # part 1: multipart/related
            (
                [
                    # part 1.1: multipart/alternative
                    (
                        [
                            (b"text", b"plain", (b"charset", b"utf-8"), None, None, b"7bit", 503, 11),
                            (b"text", b"html", (b"charset", b"utf-8"), None, None, b"7bit", 1950, 39),
                        ],
                        b"alternative",
                        (b"boundary", b"abcd"),
                        None, None,
                    ),
                    # part 1.2: inline image
                    (b"image", b"png", (b"name", b"icon.png"),
                     b"<icon.png>", None, b"base64", 1986,
                     None,  # md5
                     (b"attachment", (b"filename", b"icon.png"))),
                    # part 1.3: inline image
                    (b"image", b"png", (b"name", b"warning_triangle.png"),
                     b"<warning_triangle.png>", None, b"base64", 640,
                     None,
                     (b"attachment", (b"filename", b"warning_triangle.png"))),
                ],
                b"related",
                (b"boundary", b"efgh"),
                None, None,
            ),
            # part 2: message/delivery-status
            (b"message", b"delivery-status", None, None, None, b"7bit", 657),
            # part 3: text/rfc822-headers
            (b"text", b"rfc822-headers", None, None, None, b"7bit", 3189, 64),
        ],
        b"report",
        (b"boundary", b"ijkl", b"report-type", b"delivery-status"),
        None, None,
    )

    from app.services.imap import _walk_bodystructure
    leaves = _walk_bodystructure(structure)
    # Six leaves total: plain, html, icon.png, warning_triangle.png,
    # delivery-status message, rfc822-headers
    assert len(leaves) == 6, (
        f"expected 6 leaves, got {len(leaves)}: "
        f"{[(l['main_type'], l['sub_type'], l['part_path']) for l in leaves]}"
    )

    # Verify the deep-nested text/plain body is found at 1.1.1.
    plain = next(
        l for l in leaves
        if l["main_type"] == "text" and l["sub_type"] == "plain"
        and l["part_path"] == "1.1.1"
    )
    assert plain["size_bytes"] == 503

    # Verify the two inline images come through with the right paths.
    icon = next(l for l in leaves if l.get("filename") == "icon.png")
    assert icon["part_path"] == "1.2"
    assert icon["disposition"] == "attachment"

    warning = next(l for l in leaves if l.get("filename") == "warning_triangle.png")
    assert warning["part_path"] == "1.3"


def test_walk_bodystructure_gmail_forwarded_inline_images():
    """Real Gmail-forwarded shape: multipart/mixed at top, with
    multipart/alternative + multipart/related branches and several
    inline PNGs. This is the shape the Aishwarya forward produced —
    5 image attachments inside a multipart/related at part 1.1.x."""
    # Top: multipart/mixed
    #   1: multipart/alternative
    #     1.1: text/plain
    #     1.2: multipart/related
    #       1.2.1: text/html
    #       1.2.2..1.2.6: 5 inline PNGs
    structure = (
        [
            (
                [
                    (b"text", b"plain", (b"charset", b"utf-8"), None, None, b"7bit", 200, 5),
                    (
                        [
                            (b"text", b"html", (b"charset", b"utf-8"), None, None, b"7bit", 5000, 100),
                            (b"image", b"png", (b"name", b"image001.png"),
                             b"<i1>", None, b"base64", 112419,
                             None, (b"inline", (b"filename", b"image001.png"))),
                            (b"image", b"png", (b"name", b"image002.png"),
                             b"<i2>", None, b"base64", 103409,
                             None, (b"inline", (b"filename", b"image002.png"))),
                            (b"image", b"png", (b"name", b"image003.png"),
                             b"<i3>", None, b"base64", 102404,
                             None, (b"inline", (b"filename", b"image003.png"))),
                            (b"image", b"png", (b"name", b"image004.png"),
                             b"<i4>", None, b"base64", 122291,
                             None, (b"inline", (b"filename", b"image004.png"))),
                            (b"image", b"png", (b"name", b"image005.png"),
                             b"<i5>", None, b"base64", 105310,
                             None, (b"inline", (b"filename", b"image005.png"))),
                        ],
                        b"related",
                        (b"boundary", b"rel"),
                        None, None,
                    ),
                ],
                b"alternative",
                (b"boundary", b"alt"),
                None, None,
            ),
        ],
        b"mixed",
        (b"boundary", b"mix"),
        None, None,
    )

    from app.services.imap import _walk_bodystructure
    leaves = _walk_bodystructure(structure)
    # 7 leaves: 1 plain, 1 html, 5 PNGs
    assert len(leaves) == 7, (
        f"expected 7 leaves, got {len(leaves)}: "
        f"{[(l['main_type'], l['sub_type'], l['part_path']) for l in leaves]}"
    )

    pngs = [l for l in leaves if l["main_type"] == "image"]
    assert len(pngs) == 5
    expected_paths = ["1.2.2", "1.2.3", "1.2.4", "1.2.5", "1.2.6"]
    actual_paths = sorted(l["part_path"] for l in pngs)
    assert actual_paths == expected_paths
    for png in pngs:
        assert png["disposition"] == "inline"
        assert png["filename"].startswith("image00")


def test_fetch_attachment_part_sync_returns_bytes():
    """Stage 2: when called for a specific part path, returns the raw bytes
    the server yielded for that part."""
    server = MagicMock()
    server.fetch.return_value = {
        99: {b"BODY[2]": b"PDF-BYTES-HERE"},
    }
    server.select_folder.return_value = {b"EXISTS": 1}

    result = _fetch_attachment_part_sync(server, uid=99, part_path="2")
    assert result == b"PDF-BYTES-HERE"

    # select_folder must run first so the FETCH targets INBOX.
    server.select_folder.assert_called_once_with("INBOX")
    # The fetch call must request the specific part path with PEEK so we
    # don't accidentally mark the message \Seen.
    args, kwargs = server.fetch.call_args
    assert args[0] == [99]
    assert any("BODY.PEEK[2]" in str(item) for item in args[1])
