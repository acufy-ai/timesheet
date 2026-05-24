"""Invitation / password-set / forgot-password endpoints.

Kept in a separate module from ``auth.py`` only because that file is
already very long. The router below is mounted alongside the main auth
router with the same ``/auth`` prefix, so paths look the same to the
frontend.

Flow:
  1. Admin creates a user (or user clicks "forgot password" themselves)
  2. Backend mints a JWT, stores its jti in the per-tenant
     ``password_invite_tokens`` table for one-time-use tracking, emails
     the user a link to our own /set-password page.
  3. User opens the page, enters a password.
  4. ``/auth/invitation/set-password`` verifies the token, calls Auth0
     Management API to set the password, marks the token consumed.
  5. Frontend redirects the user to /login.
"""
import logging
from datetime import datetime, timezone
from typing import Optional, Tuple

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from jose import jwt as _jwt, JWTError as _JWTError

from app.core.config import settings
from app.core.rate_limit import limiter
from app.models.user import User
from app.schemas import (
    SetPasswordRequest,
    SetPasswordResponse,
    InvitationStatusResponse,
    ForgotPasswordRequest,
    MessageResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["authentication"])


async def _find_user_across_tenant_dbs(email: str) -> tuple[User, str | None]:
    """Resolve an email to (user, tenant_slug) by checking shared + tenants.

    Forgot-password starts from "just an email" with no JWT to tell us
    which DB the user lives in. We check the shared DB first (cheap),
    then scan isolated tenants in the control plane until we find a
    match. Raises ``HTTPException(404)`` when not found.
    """
    from app.crud.user import get_user_by_email as _get
    from app.db import AsyncSessionLocal
    from app.db_tenant import tenant_session
    from app.db_control import AsyncControlSessionLocal
    from app.models.control import ControlTenant

    normalized = email.strip().lower()
    async with AsyncSessionLocal() as shared_db:
        user = await _get(shared_db, normalized)
    if user is not None:
        async with AsyncControlSessionLocal() as cdb:
            row = (await cdb.execute(
                select(ControlTenant).where(ControlTenant.id == user.tenant_id)
            )).scalar_one_or_none()
        if row and row.is_isolated and row.db_name:
            try:
                async with tenant_session(row.slug) as tdb:
                    refreshed = await _get(tdb, normalized)
                if refreshed is not None:
                    return refreshed, row.slug
            except (LookupError, ValueError):
                pass
        return user, (row.slug if row else None)

    # Not in shared. Rare path: only happens if the shared-DB mirror
    # failed at create time. Scan isolated tenants.
    async with AsyncControlSessionLocal() as cdb:
        rows = (await cdb.execute(
            select(ControlTenant).where(
                ControlTenant.is_isolated == True,  # noqa: E712
                ControlTenant.status == "active",
            )
        )).scalars().all()
    for trow in rows:
        if not trow.db_name:
            continue
        try:
            async with tenant_session(trow.slug) as tdb:
                u = await _get(tdb, normalized)
            if u is not None:
                return u, trow.slug
        except (LookupError, ValueError):
            continue

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="User not found",
    )


@router.get("/invitation/verify", response_model=InvitationStatusResponse)
@limiter.limit("60/minute")
async def verify_invitation_token(
    request: Request,
    token: str,
) -> dict:
    """Validate a /set-password token without consuming it.

    The frontend calls this on page load so it can show the user their
    email and the right copy ("Welcome, set your password" vs "Reset
    your password") and surface specific errors (expired, already-used)
    before they fill the form.
    """
    from app.services.password_invite import verify_invite_token, PasswordInviteError
    from app.db import AsyncSessionLocal
    from app.db_tenant import tenant_session

    try:
        peek = _jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        email = peek.get("email")
    except _JWTError:
        return {"valid": False, "reason": "malformed"}
    if not email:
        return {"valid": False, "reason": "malformed"}

    try:
        user, tenant_slug = await _find_user_across_tenant_dbs(email)
    except HTTPException:
        return {"valid": False, "reason": "user_gone"}

    if tenant_slug:
        try:
            async with tenant_session(tenant_slug) as tdb:
                try:
                    _, row = await verify_invite_token(tdb, token)
                    return {"valid": True, "email": user.email, "purpose": row.purpose}
                except PasswordInviteError as exc:
                    return {"valid": False, "email": user.email, "reason": exc.code}
        except (LookupError, ValueError):
            pass

    async with AsyncSessionLocal() as sdb:
        try:
            _, row = await verify_invite_token(sdb, token)
            return {"valid": True, "email": user.email, "purpose": row.purpose}
        except PasswordInviteError as exc:
            return {"valid": False, "email": user.email, "reason": exc.code}


@router.post("/invitation/set-password", response_model=SetPasswordResponse)
@limiter.limit("10/minute")
async def set_password_via_invitation(
    request: Request,
    body: SetPasswordRequest,
) -> dict:
    """Consume an invite token; push the new password into Auth0.

    The user has clicked their invite link and submitted a chosen
    password from the /set-password page. We verify the token's jti
    one-time-use status in the same DB transaction that marks it
    consumed, then call Auth0 Management API to set the password.

    If Auth0 rejects (policy violation), we surface its message and
    DO NOT consume the token, so the user can retry with a better
    password.
    """
    from app.services.password_invite import (
        verify_invite_token, consume_invite_token, PasswordInviteError,
    )
    from app.services import auth0_mgmt
    from app.db import AsyncSessionLocal
    from app.db_tenant import tenant_session

    try:
        peek = _jwt.decode(body.token, settings.secret_key, algorithms=[settings.algorithm])
        email = peek.get("email")
    except _JWTError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired link.")
    if not email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid link.")

    user, tenant_slug = await _find_user_across_tenant_dbs(email)

    async def _do(session: AsyncSession) -> tuple[User, str]:
        try:
            u, row = await verify_invite_token(session, body.token)
        except PasswordInviteError as exc:
            code_to_status = {
                "consumed": status.HTTP_410_GONE,
                "expired": status.HTTP_410_GONE,
                "unknown": status.HTTP_400_BAD_REQUEST,
                "malformed": status.HTTP_400_BAD_REQUEST,
                "user_gone": status.HTTP_404_NOT_FOUND,
            }
            raise HTTPException(
                status_code=code_to_status.get(exc.code, status.HTTP_400_BAD_REQUEST),
                detail=str(exc),
            )
        if not u.auth0_sub:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This account is not bound to Auth0. Contact your admin.",
            )

        # Try to set the password BEFORE consuming the token so a
        # policy rejection lets the user retry.
        try:
            await auth0_mgmt.set_user_password(
                sub=u.auth0_sub,
                password=body.new_password,
                mark_email_verified=True,
            )
        except auth0_mgmt.Auth0MgmtError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            )

        # Auth0 said yes — consume token, flip flags, commit.
        await consume_invite_token(session, row)
        u.has_changed_password = True
        if not u.email_verified:
            u.email_verified = True
            u.email_verified_at = datetime.now(timezone.utc)
        session.add(u)
        await session.commit()
        return u, row.purpose

    if tenant_slug:
        async with tenant_session(tenant_slug) as tdb:
            user_out, purpose = await _do(tdb)
    else:
        async with AsyncSessionLocal() as sdb:
            user_out, purpose = await _do(sdb)

    return {"success": True, "email": user_out.email, "purpose": purpose}


@router.post("/forgot-password", response_model=MessageResponse)
@limiter.limit("5/minute")
async def forgot_password(
    request: Request,
    body: ForgotPasswordRequest,
) -> dict:
    """Issue a password-reset link via email.

    Anti-enumeration: always returns success regardless of whether the
    email exists. Real users get the email; non-existent ones get
    nothing (with a hidden warning logged server-side).
    """
    from app.services.password_invite import issue_invite_token, build_set_password_url
    from app.services.email_verification import send_local_password_reset_email
    from app.api.platform_settings import get_effective_smtp_config
    from app.crud.tenant import get_tenant
    from app.db import AsyncSessionLocal
    from app.db_tenant import tenant_session
    import asyncio as _asyncio

    try:
        user, tenant_slug = await _find_user_across_tenant_dbs(body.email)
    except HTTPException:
        logger.info("forgot_password: unknown email %s", body.email)
        return {"message": "If an account exists for that email, a reset link has been sent."}

    async def _emit(session: AsyncSession) -> str:
        tok = await issue_invite_token(session, user, purpose="reset")
        await session.commit()
        return tok

    if tenant_slug:
        async with tenant_session(tenant_slug) as tdb:
            token = await _emit(tdb)
    else:
        async with AsyncSessionLocal() as sdb:
            token = await _emit(sdb)

    invite_url = build_set_password_url(token, purpose="reset")

    async def _send_safe() -> None:
        try:
            async with AsyncSessionLocal() as cfg_db:
                smtp_config = await get_effective_smtp_config(cfg_db)
                tenant_name = None
                if user.tenant_id is not None:
                    t = await get_tenant(cfg_db, user.tenant_id)
                    tenant_name = t.name if t else None
            await send_local_password_reset_email(
                user,
                invite_url,
                smtp_config=smtp_config,
                tenant_name=tenant_name,
                tenant_id=user.tenant_id,
            )
        except Exception as exc:
            logger.warning("forgot_password email send failed for %s: %s", user.email, exc)

    _asyncio.create_task(_send_safe())

    return {"message": "If an account exists for that email, a reset link has been sent."}
