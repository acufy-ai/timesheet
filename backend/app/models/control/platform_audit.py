"""Control-plane audit event log.

Captures changes that happen at the control-plane scope: tenant
created/edited/suspended, tenant features toggled, platform admin
created/disabled, OAuth credential rotated, migration head bumped, etc.

This is intentionally separate from each tenant's own audit log. The
platform admin needs to see fleet-wide control-plane history without
fan-out across tenant DBs, and the tenant admin must not see
control-plane events at all (e.g., they shouldn't know which platform
admins exist).

The Dashboard's "Recent platform activity" widget reads the most
recent N rows; the /platform/audit page paginates the same table with
filters and CSV export.
"""
from __future__ import annotations

import enum
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    DateTime,
    Enum as SAEnum,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.models.control import ControlBase


class PlatformAuditCategory(str, enum.Enum):
    """High-level grouping shown in the audit page filter chip.

    Frontend "Event type" dropdown maps 1:1 to these values; each row
    carries a sub-type in the ``event`` column (e.g., "tenant.created",
    "tenant.feature.ingestion.toggled") for filtering at finer grain.
    """

    tenant = "tenant"          # lifecycle: created, edited, suspended, deleted
    feature = "feature"        # tenant feature toggles
    admin = "admin"            # platform admin lifecycle
    credentials = "credentials"  # OAuth / encryption key rotations
    migration = "migration"    # alembic head bumps
    system = "system"          # arq worker errors, fetch failures bubbled up


class PlatformAuditSeverity(str, enum.Enum):
    """Used to color the row in the audit table and the dashboard feed.

    ``info`` is the default (create/update/toggle); ``warn`` marks
    auto-recoverable issues (fetch failure, OAuth refresh expired);
    ``critical`` marks security-sensitive events (PA disabled,
    encryption key rotated, tenant deleted).
    """

    info = "info"
    warn = "warn"
    critical = "critical"


class PlatformAuditEvent(ControlBase):
    """One control-plane audit event.

    Append-only by convention - rows are never updated or deleted from
    application code (a future retention job may prune very old rows).
    """

    __tablename__ = "platform_audit_events"
    __table_args__ = (
        Index("ix_platform_audit_created_at", "created_at"),
        Index("ix_platform_audit_category_created", "category", "created_at"),
        Index("ix_platform_audit_tenant_created", "tenant_id", "created_at"),
        Index("ix_platform_audit_actor_created", "actor_user_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)

    # Bucket + machine-readable sub-event. ``category`` powers the
    # filter chip; ``event`` is the specific verb like "tenant.created".
    category: Mapped[PlatformAuditCategory] = mapped_column(
        SAEnum(PlatformAuditCategory, name="platform_audit_category"),
        nullable=False,
    )
    event: Mapped[str] = mapped_column(String(120), nullable=False)

    severity: Mapped[PlatformAuditSeverity] = mapped_column(
        SAEnum(PlatformAuditSeverity, name="platform_audit_severity"),
        nullable=False,
        default=PlatformAuditSeverity.info,
        server_default="info",
    )

    # Actor: platform admin user id (from acufy_control.platform_admins)
    # OR null if the actor is the system (background job, migration runner).
    # ``actor_email`` is denormalized so we still have something useful
    # to show after a PA account is deleted.
    actor_user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    actor_email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    actor_label: Mapped[Optional[str]] = mapped_column(
        String(120), nullable=True,
        comment="System actor name when actor_user_id is null (e.g., 'arq worker').",
    )

    # Optional tenant context. Null for events that aren't bound to a
    # specific tenant (e.g., a new platform admin is created).
    tenant_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    tenant_slug: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    tenant_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    # Short human-readable headline. The audit table's "Target" cell.
    summary: Mapped[str] = mapped_column(String(500), nullable=False)

    # Before / after payloads for the detail drawer. Free-form JSON so
    # different event types can shape them as needed; the frontend just
    # pretty-prints whatever it gets.
    before_state: Mapped[Optional[dict]] = mapped_column(
        JSONB().with_variant(Text(), "sqlite"),
        nullable=True,
    )
    after_state: Mapped[Optional[dict]] = mapped_column(
        JSONB().with_variant(Text(), "sqlite"),
        nullable=True,
    )

    # Request context. ``request_ip`` is best-effort (from X-Forwarded-For
    # via the reverse proxy); user-agent is truncated to 500 chars.
    request_ip: Mapped[Optional[str]] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    route: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        index=True,
    )

    def __repr__(self) -> str:
        return (
            f"<PlatformAuditEvent(id={self.id}, event={self.event!r}, "
            f"tenant_slug={self.tenant_slug!r}, actor={self.actor_email!r})>"
        )
