"""Per-tenant feature flags, control-plane edition.

Acufy-owned billing / entitlement flags. The platform admin flips
these per tenant; tenant admins can read them (their settings UI
reads to decide whether to show the upgrade hint vs the live editor)
but cannot change them.

Adding a new flag is a column add here, not a new table. Keeps
migrations and code paths tight.
"""
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.control import ControlBase


class ControlTenantFeatures(ControlBase):
    """One row per tenant; every flag column defaults FALSE."""

    __tablename__ = "tenant_features"

    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        primary_key=True,
    )

    # Allows the tenant to pick non-default outbound (OAuth mailbox or
    # custom SMTP) instead of platform default SMTP. UI in the tenant's
    # admin settings page is gated by this.
    custom_outbound_email: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false",
    )

    # Allows the tenant to override the invitation email template
    # content. Without this flag, tenant uses the platform default.
    custom_email_template: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false",
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_by: Mapped[Optional[int]] = mapped_column(
        Integer, nullable=True,
    )
