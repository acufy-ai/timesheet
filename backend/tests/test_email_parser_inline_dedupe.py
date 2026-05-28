"""
Unit test for inline-vs-attachment dedupe in email_parser.

Forwarded emails (especially from Gmail) frequently list the same image
twice in the MIME tree: once Content-Disposition: inline (so it renders
in the email body) and once Content-Disposition: attachment (so it can
be downloaded). The bytes are identical. Without dedupe, the ingestion
pipeline saves each image twice as separate email_attachments rows and
the LLM extracts the same timesheet twice, producing phantom duplicate
timesheets on the reviewer queue.

Real-world trigger: email 289 on Webilent Test ldev (2026-05-27) had
5 unique PNG screenshots saved as 10 attachments -> 10 ingestion
timesheets for 5 actual weeks.

The dedupe keys on SHA256 of the decoded payload. Different files with
the same hours still produce different bytes and are kept; only true
byte-identical duplicates collapse.
"""
from __future__ import annotations

from email.message import EmailMessage

from app.services.email_parser import parse_email


def _build_email_with_dup_image(
    image_bytes: bytes, second_disposition: str = "inline"
) -> bytes:
    """Build a multipart/related email with the same image twice: once
    as Content-Disposition: attachment, once as the given disposition."""
    msg = EmailMessage()
    msg["Subject"] = "Fwd: timesheet"
    msg["From"] = "sender@example.com"
    msg["To"] = "inbox@example.com"
    msg["Message-ID"] = "<dup-test@example.com>"
    msg.set_content("see attached")

    msg.add_attachment(
        image_bytes,
        maintype="image",
        subtype="png",
        filename="image001.png",
        disposition="attachment",
    )
    msg.add_attachment(
        image_bytes,
        maintype="image",
        subtype="png",
        filename="image001.png",
        disposition=second_disposition,
    )
    return msg.as_bytes()


def test_inline_duplicate_of_attachment_is_dropped():
    """Same bytes attached twice -> only one ParsedAttachment kept."""
    image = b"\x89PNG\r\n\x1a\n" + b"FAKEPNGBODYBYTES" * 50
    raw = _build_email_with_dup_image(image, second_disposition="inline")

    parsed = parse_email(raw)

    assert len(parsed.attachments) == 1, (
        f"expected 1 attachment after dedupe, got {len(parsed.attachments)}: "
        f"{[(a.filename, len(a.content)) for a in parsed.attachments]}"
    )
    assert parsed.attachments[0].content == image
    assert parsed.has_attachments is True


def test_two_attachments_same_bytes_dropped_to_one():
    """Even attachment+attachment with identical bytes collapses (catches
    the case where Gmail emits both copies as attachment disposition)."""
    image = b"\x89PNG\r\n\x1a\n" + b"ANOTHERBODY" * 80
    raw = _build_email_with_dup_image(image, second_disposition="attachment")

    parsed = parse_email(raw)

    assert len(parsed.attachments) == 1


def test_two_different_attachments_both_kept():
    """Genuine separate files with different bytes are both kept, even
    when filenames and hours could coincide downstream."""
    img_a = b"\x89PNG\r\n\x1a\n" + b"FILE_A_BODY" * 30
    img_b = b"\x89PNG\r\n\x1a\n" + b"FILE_B_BODY" * 30

    msg = EmailMessage()
    msg["Subject"] = "two timesheets"
    msg["From"] = "sender@example.com"
    msg["To"] = "inbox@example.com"
    msg["Message-ID"] = "<two-files@example.com>"
    msg.set_content("two timesheets attached")
    msg.add_attachment(
        img_a, maintype="image", subtype="png",
        filename="end_client.png", disposition="attachment",
    )
    msg.add_attachment(
        img_b, maintype="image", subtype="png",
        filename="middle_client.png", disposition="attachment",
    )

    parsed = parse_email(msg.as_bytes())

    assert len(parsed.attachments) == 2
    filenames = sorted(a.filename for a in parsed.attachments)
    assert filenames == ["end_client.png", "middle_client.png"]


def test_five_images_each_listed_twice_collapses_to_five():
    """Reproduces the Aishwarya / email 289 shape: 5 unique PNGs, each
    listed inline AND as attachment -> 5 attachments after dedupe."""
    msg = EmailMessage()
    msg["Subject"] = "Fwd: January 2026 Timesheets"
    msg["From"] = "forwarder@example.com"
    msg["To"] = "inbox@example.com"
    msg["Message-ID"] = "<five-doubled@example.com>"
    msg.set_content("see attached")

    images = [
        b"\x89PNG\r\n\x1a\n" + (f"WEEK_{i}_BODY".encode() * 50)
        for i in range(5)
    ]
    # First pass: the "real" attachments
    for i, img in enumerate(images):
        msg.add_attachment(
            img, maintype="image", subtype="png",
            filename=f"image00{i + 1}.png", disposition="attachment",
        )
    # Second pass: inline copies of the same five images
    for i, img in enumerate(images):
        msg.add_attachment(
            img, maintype="image", subtype="png",
            filename=f"image00{i + 1}.png", disposition="inline",
        )

    parsed = parse_email(msg.as_bytes())

    assert len(parsed.attachments) == 5, (
        f"expected 5 unique attachments, got {len(parsed.attachments)}"
    )
    # Each kept attachment's content should be a distinct image
    kept_contents = sorted(a.content for a in parsed.attachments)
    assert kept_contents == sorted(images)
