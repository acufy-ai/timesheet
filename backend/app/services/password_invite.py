"""Local password-invite token helpers.

Replaces Auth0's hosted password-change ticket with an in-app flow:
the backend issues a signed JWT, the user clicks an email link to our
``/set-password`` page, picks a password, and we call Auth0's
Management API to set it server-side.

Token format: standard JWT signed with ``settings.secret_key``.

  - ``sub``     : local user id (int, as string)
  - ``email``   : user email (denormalized for display on the frontend)
  - ``purpose`` : ``invite`` (first-time setup) or ``reset`` (forgot-password)
  - ``jti``     : random 32-byte url-safe id; row in ``password_invite_tokens``
                  tracks one-time-use
  - ``exp``     : 7 days by default
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.password_invite_token import PasswordInviteToken
from app.models.user import User

InvitePurpose = Literal["invite", "reset"]

# 7-day TTL by default; matches Auth0 ticket TTL we used previously,
# and what the email template promises.
DEFAULT_TTL = timedelta(days=7)


class PasswordInviteError(Exception):
    """Raised when an invite token is invalid, consumed, or expired.

    Carries a short ``code`` so the API layer can return a specific
    400/410 to the frontend, which surfaces a matching error to the
    user (expired vs. already-used vs. malformed).
    """

    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code


async def issue_invite_token(
    session: AsyncSession,
    user: User,
    purpose: InvitePurpose,
    *,
    ttl: timedelta = DEFAULT_TTL,
) -> str:
    """Mint a JWT, persist its jti, return the encoded token.

    Caller must commit the session.
    """
    now = datetime.now(timezone.utc)
    expires_at = now + ttl
    jti = secrets.token_urlsafe(32)

    payload = {
        "sub": str(user.id),
        "email": user.email,
        "purpose": purpose,
        "jti": jti,
        "exp": int(expires_at.timestamp()),
        "iat": int(now.timestamp()),
    }
    token = jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)

    session.add(PasswordInviteToken(
        jti=jti,
        user_id=user.id,
        purpose=purpose,
        expires_at=expires_at,
    ))
    return token


async def verify_invite_token(
    session: AsyncSession,
    token: str,
) -> tuple[User, PasswordInviteToken]:
    """Decode and verify; return (user, token_row) on success.

    Raises :class:`PasswordInviteError` with a specific ``code``:

      - ``malformed`` : signature or decode failure (also includes expired)
      - ``unknown``   : token signature OK but jti not in DB (forged or rotated)
      - ``consumed``  : already used
      - ``expired``   : DB row marks it expired
      - ``user_gone`` : user deleted between issue and use
    """
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    except JWTError:
        raise PasswordInviteError("Invalid or expired link", code="malformed")

    jti = payload.get("jti")
    sub = payload.get("sub")
    if not jti or not sub:
        raise PasswordInviteError("Invalid link", code="malformed")

    row = (await session.execute(
        select(PasswordInviteToken).where(PasswordInviteToken.jti == jti)
    )).scalar_one_or_none()
    if row is None:
        raise PasswordInviteError("Invalid link", code="unknown")

    if row.consumed_at is not None:
        raise PasswordInviteError("This link has already been used.", code="consumed")

    now = datetime.now(timezone.utc)
    expires = row.expires_at if row.expires_at.tzinfo is not None else row.expires_at.replace(tzinfo=timezone.utc)
    if expires < now:
        raise PasswordInviteError("This link has expired.", code="expired")

    from app.crud.user import get_user_by_id
    user = await get_user_by_id(session, int(sub))
    if user is None:
        raise PasswordInviteError("Account no longer exists.", code="user_gone")

    return user, row


async def consume_invite_token(
    session: AsyncSession,
    token_row: PasswordInviteToken,
) -> None:
    """Mark the token as used. Caller commits."""
    token_row.consumed_at = datetime.now(timezone.utc)
    session.add(token_row)


def build_set_password_url(token: str, purpose: InvitePurpose = "invite") -> str:
    """Construct the public URL the user clicks in the invite email.

    Frontend reads ``token`` from the query string and ``purpose`` to
    pick the right copy (e.g., "Set your password" vs "Reset your
    password" on the same page).
    """
    base = (settings.frontend_base_url or "").rstrip("/")
    return f"{base}/set-password?token={token}&purpose={purpose}"
