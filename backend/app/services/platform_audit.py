"""Write-side helper for the control-plane audit log.

Platform-admin endpoints call ``record_platform_audit_event`` after a
mutation succeeds. The Dashboard's activity widget and the
/platform/audit page both read the table this writes to.

Design notes:
  - All writes happen on the control-plane session, NOT on the tenant
    DB. This is why the helper takes its own session arg.
  - The helper is best-effort: a failed audit write should never block
    the primary action. We catch + log + move on, never raise.
  - ``request_ip`` is best-effort extracted from common reverse-proxy
    headers; never trusted blindly.

Usage:
    await record_platform_audit_event(
        control_db,
        request=request,                # optional FastAPI Request
        actor=current_user,              # PlatformAdmin or None
        category=PlatformAuditCategory.tenant,
        event="tenant.created",
        summary=f"Tenant {tenant.name} provisioned",
        tenant=tenant,                  # optional ControlTenant
        before_state=None,
        after_state={"slug": tenant.slug, "isolated": True},
    )
"""
from __future__ import annotations

import logging
from typing import Any, Mapping, Optional, Union

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.control.platform_audit import (
    PlatformAuditCategory,
    PlatformAuditEvent,
    PlatformAuditSeverity,
)
from app.models.control.platform_admin import PlatformAdmin
from app.models.control.tenant import ControlTenant
from app.models.user import User

logger = logging.getLogger(__name__)


def _client_ip(request: Optional[Request]) -> Optional[str]:
    """Best-effort client IP from common proxy headers.

    The reverse proxy in front of the API (nginx in dev/prod) sets
    X-Forwarded-For; we take the first hop. Never trust raw client
    headers without that proxy in place - a malicious caller could
    spoof them. The IP is for human review in the audit log, not for
    authorization.
    """
    if request is None:
        return None
    xff = request.headers.get("x-forwarded-for")
    if xff:
        # XFF is comma-separated; the first entry is the original client.
        return xff.split(",")[0].strip() or None
    if request.client is not None:
        return request.client.host
    return None


def _user_agent(request: Optional[Request]) -> Optional[str]:
    if request is None:
        return None
    ua = request.headers.get("user-agent")
    if not ua:
        return None
    # Truncate to fit the column. Long UA strings are rare but possible.
    return ua[:500]


def _resolve_actor(
    actor: Optional[Union[User, PlatformAdmin]],
) -> tuple[Optional[int], Optional[str]]:
    """Pull out (user_id, email) from either kind of actor.

    Platform endpoints sometimes hand back a User (when the PA logged
    in through the tenant-realm path) and sometimes a PlatformAdmin
    (when it's the dedicated PA realm). Both expose ``id`` and
    ``email``; ``actor_label`` is left for system-actor callers.
    """
    if actor is None:
        return None, None
    user_id = getattr(actor, "id", None)
    email = getattr(actor, "email", None)
    return user_id, email


async def record_platform_audit_event(
    control_db: AsyncSession,
    *,
    category: PlatformAuditCategory,
    event: str,
    summary: str,
    actor: Optional[Union[User, PlatformAdmin]] = None,
    actor_label: Optional[str] = None,
    severity: PlatformAuditSeverity = PlatformAuditSeverity.info,
    tenant: Optional[ControlTenant] = None,
    tenant_id: Optional[int] = None,
    tenant_slug: Optional[str] = None,
    tenant_name: Optional[str] = None,
    before_state: Optional[Mapping[str, Any]] = None,
    after_state: Optional[Mapping[str, Any]] = None,
    request: Optional[Request] = None,
    route: Optional[str] = None,
    auto_flush: bool = True,
) -> Optional[PlatformAuditEvent]:
    """Insert one audit event on the control-plane session.

    Never raises. A failed audit write is logged at ERROR but the
    caller's primary mutation is preserved. Callers should still call
    ``await control_db.commit()`` as part of their own transaction
    boundary; this helper only flushes (so the row is visible within
    the same transaction).

    Returns the inserted row on success, None on failure.
    """
    actor_user_id, actor_email = _resolve_actor(actor)

    # Convenience: when a tenant object is passed, fill the three
    # denormalized columns from it. Callers can also pass them
    # individually for events bound to a tenant that no longer exists
    # in the control plane (e.g., after a delete).
    if tenant is not None:
        tenant_id = tenant_id if tenant_id is not None else tenant.id
        tenant_slug = tenant_slug if tenant_slug is not None else tenant.slug
        tenant_name = tenant_name if tenant_name is not None else tenant.name

    row = PlatformAuditEvent(
        category=category,
        event=event,
        severity=severity,
        actor_user_id=actor_user_id,
        actor_email=actor_email,
        actor_label=actor_label,
        tenant_id=tenant_id,
        tenant_slug=tenant_slug,
        tenant_name=tenant_name,
        summary=summary,
        before_state=dict(before_state) if before_state is not None else None,
        after_state=dict(after_state) if after_state is not None else None,
        request_ip=_client_ip(request),
        user_agent=_user_agent(request),
        route=route or (request.url.path if request else None),
    )

    try:
        control_db.add(row)
        if auto_flush:
            await control_db.flush()
        return row
    except Exception as exc:  # noqa: BLE001 - best-effort audit write
        logger.error(
            "Failed to write platform audit event (%s/%s): %s",
            category.value,
            event,
            exc,
        )
        return None
