"""
Email verification service.

Generates secure tokens, stores them on the User record, and sends
(or logs, when SMTP is not configured) the verification email.
"""
import logging
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.user import User
from app.services.email_service import send_email

logger = logging.getLogger(__name__)

TOKEN_EXPIRY_HOURS = 48


def generate_verification_token() -> str:
    """Return a 64-char URL-safe random token."""
    return secrets.token_urlsafe(48)


def set_verification_token(user: User) -> str:
    """Attach a fresh token + expiry to the user object (caller must commit)."""
    token = generate_verification_token()
    user.email_verification_token = token
    user.email_verification_token_expires_at = datetime.now(timezone.utc) + timedelta(
        hours=TOKEN_EXPIRY_HOURS
    )
    user.email_verified = False
    user.email_verified_at = None
    return token


def build_verification_url(token: str) -> str:
    frontend_base = getattr(settings, "frontend_base_url", "http://localhost:5174")
    return f"{frontend_base}/verify-account?token={token}"


async def send_verification_email(
    user: User,
    token: str,
    temporary_password: str,
    smtp_config: dict | None = None,
    tenant_name: str | None = None,
    tenant_id: int | None = None,
    via_tenant_oauth: bool = False,
    resend: bool = False,
) -> None:
    """
    Send (or log) the account verification email containing the temp password.
    smtp_config: pre-resolved SMTP dict (pass this when calling from a background
    task so the DB session doesn't need to stay open).
    tenant_name: display name of the tenant, shown in the email body.
    via_tenant_oauth: True when sent from the tenant's own OAuth mailbox.
    resend: True when this is a re-invite. Subject gets a timestamp suffix so
    Gmail doesn't thread it with the earlier (now-invalidated) email — otherwise
    the original "Verify my account" button stays visible at top of thread and
    the new email gets collapsed/hidden.
    """
    verify_url = build_verification_url(token)
    org = tenant_name or "your organisation"

    # Tenant OAuth → branded subject; platform SMTP → generic invite subject
    if via_tenant_oauth:
        subject = f"{org} · You've been invited to Acufy AI"
    else:
        subject = f"{org} has invited you to Acufy AI"

    if resend:
        # Unique suffix breaks Gmail threading so the newest email is the one
        # the user sees first, with a functioning button.
        from datetime import datetime as _dt
        subject = f"[Re-invite {_dt.now().strftime('%b %d %H:%M')}] {subject}"

    body_text = f"""Hello {user.full_name},

{org} has created a Acufy AI account for you.

Your temporary password is: {temporary_password}

To activate your account and set a permanent password, click the link below
(valid for {TOKEN_EXPIRY_HOURS} hours):

{verify_url}

After clicking the link, you will be asked to enter the temporary password above
and choose a new password before you can access the application.

If you were not expecting this email, please ignore it.

-- The Acufy AI Team
"""

    body_html = f"""
<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1e293b;">
  <p>Hello {user.full_name},</p>
  <p><strong>{org}</strong> has created a Acufy AI account for you.</p>
  <p>Your temporary password is:</p>
  <p style="font-family:monospace;font-size:16px;background:#f1f5f9;padding:10px 16px;border-radius:6px;display:inline-block;">{temporary_password}</p>
  <p>Click the button below to verify your account and set a permanent password:</p>
  <p>
    <a href="{verify_url}" style="display:inline-block;padding:12px 24px;background:#2563EB;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">
      Verify my account
    </a>
  </p>
  <p style="color:#64748b;font-size:13px;">This link expires in {TOKEN_EXPIRY_HOURS} hours.</p>
  <p style="color:#64748b;font-size:13px;">If you were not expecting this email, please ignore it.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:12px;">Acufy AI · Sent by {org}</p>
</div>
"""

    # Try tenant OAuth first (opens its own DB session)
    sent = False
    if tenant_id is not None:
        try:
            from app.db import AsyncSessionLocal
            from app.services.tenant_email_service import send_email_for_tenant
            async with AsyncSessionLocal() as db:
                sent = await send_email_for_tenant(db, tenant_id, user.email, subject, body_text, body_html)
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning("Tenant OAuth send failed: %s", exc)

    # Fall back to platform SMTP
    if not sent:
        sent = await send_email(
            to_address=user.email,
            subject=subject,
            body_text=body_text,
            body_html=body_html,
            smtp_config=smtp_config,
        )

    if not sent:
        # SMTP not configured — print to stdout so it's always visible in container logs.
        print(
            f"\n{'='*60}\n"
            f"[EMAIL VERIFICATION: SMTP NOT CONFIGURED]\n"
            f"  User:          {user.email}\n"
            f"  Temp password: {temporary_password}\n"
            f"  Verify URL:    {verify_url}\n"
            f"{'='*60}\n",
            flush=True,
        )


async def send_auth0_invitation_email(
    user: User,
    invite_url: str,
    smtp_config: dict | None = None,
    tenant_name: str | None = None,
    tenant_id: int | None = None,
    via_tenant_oauth: bool = False,
    resend: bool = False,
) -> None:
    """Send the "set your password" invitation backed by an Auth0 ticket.

    Used in place of :func:`send_verification_email` when Auth0 owns the
    user's password. The email points the user at the Auth0 hosted
    password-set page (one-time URL); after they pick a password Auth0
    redirects them to the app's login page.

    No temporary password is shared with the user — they pick one from
    scratch, end-to-end. That eliminates the security awkwardness of
    emailing temp passwords in plaintext.
    """
    org = tenant_name or "your organisation"

    if via_tenant_oauth:
        subject = f"{org} · You've been invited to Acufy AI"
    else:
        subject = f"{org} has invited you to Acufy AI"

    if resend:
        from datetime import datetime as _dt
        subject = f"[Re-invite {_dt.now().strftime('%b %d %H:%M')}] {subject}"

    body_text = f"""Hello {user.full_name},

{org} has created a Acufy AI account for you.

Click the link below to set your password and activate your account:

{invite_url}

This link is single-use and expires in 7 days. After choosing your
password, you'll be redirected to the application sign-in page.

If you were not expecting this email, please ignore it.

-- The Acufy AI Team
"""

    body_html = f"""
<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1e293b;">
  <p>Hello {user.full_name},</p>
  <p><strong>{org}</strong> has created a Acufy AI account for you.</p>
  <p>Click the button below to set your password and activate your account:</p>
  <p>
    <a href="{invite_url}" style="display:inline-block;padding:12px 24px;background:#2563EB;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">
      Set my password
    </a>
  </p>
  <p style="color:#64748b;font-size:13px;">This link is single-use and expires in 7 days.</p>
  <p style="color:#64748b;font-size:13px;">If you were not expecting this email, please ignore it.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:12px;">Acufy AI · Sent by {org}</p>
</div>
"""

    sent = False
    if tenant_id is not None:
        try:
            from app.db import AsyncSessionLocal
            from app.services.tenant_email_service import send_email_for_tenant
            async with AsyncSessionLocal() as db:
                sent = await send_email_for_tenant(db, tenant_id, user.email, subject, body_text, body_html)
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning("Tenant OAuth send failed: %s", exc)

    if not sent:
        sent = await send_email(
            to_address=user.email,
            subject=subject,
            body_text=body_text,
            body_html=body_html,
            smtp_config=smtp_config,
        )

    if not sent:
        # SMTP not configured — surface the invite URL in container logs
        # so dev environments can finish provisioning manually.
        print(
            f"\n{'='*60}\n"
            f"[AUTH0 INVITATION: SMTP NOT CONFIGURED]\n"
            f"  User:       {user.email}\n"
            f"  Invite URL: {invite_url}\n"
            f"{'='*60}\n",
            flush=True,
        )


def _build_modern_invite_html(*, headline: str, intro: str, button_label: str, invite_url: str, footer_inviter: str) -> str:
    """Build the modern invite-style email HTML body.

    Card layout, white-on-light-gray, system font stack (no Google Fonts
    dependency since Outlook/Gmail strip those). Plain-text fallback is
    built separately so it stays readable in clients that block HTML.
    """
    return f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f1f5f9;padding:40px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
        <tr><td style="padding:48px 48px 0 48px;text-align:center;">
          <div style="font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.02em;">Acufy<span style="color:#2563EB;">AI</span></div>
        </td></tr>
        <tr><td style="padding:32px 48px 8px 48px;">
          <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:600;color:#0f172a;letter-spacing:-0.01em;">{headline}</h1>
        </td></tr>
        <tr><td style="padding:8px 48px 24px 48px;">
          <p style="margin:0;font-size:15px;line-height:1.6;color:#334155;">{intro}</p>
        </td></tr>
        <tr><td style="padding:8px 48px 24px 48px;" align="center">
          <a href="{invite_url}" style="display:inline-block;padding:14px 32px;background:#2563EB;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">{button_label} &rarr;</a>
        </td></tr>
        <tr><td style="padding:8px 48px 24px 48px;">
          <p style="margin:0 0 4px 0;font-size:13px;color:#64748b;">Or copy this link into your browser:</p>
          <p style="margin:0;font-size:13px;color:#475569;word-break:break-all;">{invite_url}</p>
        </td></tr>
        <tr><td style="padding:24px 48px 0 48px;">
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 16px 0;" />
        </td></tr>
        <tr><td style="padding:0 48px 32px 48px;">
          <p style="margin:0 0 8px 0;font-size:13px;color:#64748b;">This link expires in 7 days and can only be used once.</p>
          <p style="margin:0;font-size:13px;color:#64748b;">Didn't expect this email? You can safely ignore it.</p>
        </td></tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="margin-top:16px;">
        <tr><td style="padding:0 48px;text-align:center;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">Acufy AI</p>
          <p style="margin:4px 0 0 0;font-size:12px;color:#94a3b8;">{footer_inviter}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""


def _build_modern_invite_text(*, headline: str, intro: str, invite_url: str, footer_inviter: str) -> str:
    """Plain-text fallback that mirrors the HTML body."""
    return f"""{headline}
{'-' * len(headline)}

{intro}

{invite_url}

This link expires in 7 days and can only be used once.

Didn't expect this email? You can safely ignore it.

--
Acufy AI - {footer_inviter}
"""


async def _send_modern_invitation_email(
    *,
    user: User,
    invite_url: str,
    purpose: str,
    smtp_config: dict | None = None,
    tenant_name: str | None = None,
    tenant_id: int | None = None,
) -> None:
    """Send a modern, branded invitation email.

    Used by both the admin-create flow (purpose=invite) and the
    forgot-password flow (purpose=reset). Layout is identical; only
    the headline, body intro, and button label change.
    """
    org = tenant_name or "your organisation"
    first_name = (user.full_name or user.email or "").split(" ")[0] or "there"
    action_url = invite_url

    def _sub(text: str) -> str:
        return (
            text
            .replace("{{first_name}}", first_name)
            .replace("{{org}}", org)
            .replace("{{action_url}}", action_url)
        )

    if purpose == "reset":
        default_subject = "Reset your Acufy Timesheet password"
        headline = "Reset your password"
        default_greeting = f"Hi {first_name},"
        default_body = (
            "We received a request to reset your password on Acufy Timesheet. "
            "Click the button below to choose a new one."
        )
        default_button_label = "Reset my password"
        default_signoff = "Acufy AI Security"
        prefix = "reset_email"
    else:
        default_subject = "You're invited to Acufy Timesheet"
        headline = "Welcome to Acufy Timesheet"
        default_greeting = f"Hi {first_name},"
        default_body = f"{org} has set up your account on Acufy Timesheet. Set your password to get started."
        default_button_label = "Set my password"
        default_signoff = f"Sent on behalf of {org}"
        prefix = "invite_email"

    subject = default_subject
    greeting = default_greeting
    body_text_part = default_body
    button_label = default_button_label
    footer_inviter = default_signoff

    if tenant_id is not None:
        try:
            from app.db import AsyncSessionLocal
            from app.core.tenant_settings import get_setting
            from app.services.tenant_features import has_feature

            if await has_feature(tenant_id, "custom_email_template"):
                async with AsyncSessionLocal() as _db:
                    c_subject      = (await get_setting(_db, tenant_id, f"{prefix}_subject")      or "").strip()
                    c_greeting     = (await get_setting(_db, tenant_id, f"{prefix}_greeting")     or "").strip()
                    c_body         = (await get_setting(_db, tenant_id, f"{prefix}_body")         or "").strip()
                    c_button_label = (await get_setting(_db, tenant_id, f"{prefix}_button_label") or "").strip()
                    c_signoff      = (await get_setting(_db, tenant_id, f"{prefix}_signoff")      or "").strip()
                if c_subject:      subject        = c_subject
                if c_greeting:     greeting       = f"Hi {first_name}, {c_greeting}"
                if c_body:         body_text_part = c_body
                if c_button_label: button_label   = c_button_label
                if c_signoff:      footer_inviter = c_signoff
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning(
                "Could not load custom email template for tenant %s: %s", tenant_id, exc
            )

    intro = f"{greeting} {body_text_part}"

    body_html = _build_modern_invite_html(
        headline=headline,
        intro=intro,
        button_label=button_label,
        invite_url=invite_url,
        footer_inviter=footer_inviter,
    )
    # Plain-text intro strips the HTML tags from the invite version.
    intro_text = intro.replace("<strong>", "").replace("</strong>", "")
    body_text = _build_modern_invite_text(
        headline=headline,
        intro=intro_text,
        invite_url=invite_url,
        footer_inviter=footer_inviter,
    )

    sent = False
    if tenant_id is not None:
        try:
            from app.db import AsyncSessionLocal
            from app.services.tenant_email_service import send_email_for_tenant
            async with AsyncSessionLocal() as db:
                sent = await send_email_for_tenant(db, tenant_id, user.email, subject, body_text, body_html)
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning("Tenant OAuth send failed: %s", exc)

    if not sent:
        sent = await send_email(
            to_address=user.email,
            subject=subject,
            body_text=body_text,
            body_html=body_html,
            smtp_config=smtp_config,
        )

    if not sent:
        print(
            f"\n{'='*60}\n"
            f"[INVITATION EMAIL ({purpose.upper()}): SMTP NOT CONFIGURED]\n"
            f"  User:       {user.email}\n"
            f"  Invite URL: {invite_url}\n"
            f"{'='*60}\n",
            flush=True,
        )


async def send_local_invitation_email(
    user: User,
    invite_url: str,
    smtp_config: dict | None = None,
    tenant_name: str | None = None,
    tenant_id: int | None = None,
) -> None:
    """First-time invitation (admin created the user)."""
    await _send_modern_invitation_email(
        user=user,
        invite_url=invite_url,
        purpose="invite",
        smtp_config=smtp_config,
        tenant_name=tenant_name,
        tenant_id=tenant_id,
    )


async def send_local_password_reset_email(
    user: User,
    invite_url: str,
    smtp_config: dict | None = None,
    tenant_name: str | None = None,
    tenant_id: int | None = None,
) -> None:
    """User-initiated forgot-password."""
    await _send_modern_invitation_email(
        user=user,
        invite_url=invite_url,
        purpose="reset",
        smtp_config=smtp_config,
        tenant_name=tenant_name,
        tenant_id=tenant_id,
    )


async def mark_email_verified(db: AsyncSession, user: User) -> None:
    """Mark the user as verified (caller must commit).

    We leave email_verification_token in place until it naturally expires so
    page-refresh during the set-password step doesn't kick the user out with
    an "invalid token" error. The token is still useless after verify — the
    verify endpoint returns a no-op for already-verified users — but keeping
    it around makes the flow idempotent.
    """
    user.email_verified = True
    user.email_verified_at = datetime.now(timezone.utc)
    user.has_changed_password = True
    db.add(user)
