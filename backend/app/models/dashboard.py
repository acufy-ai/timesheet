from datetime import datetime
from typing import Any, Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class CustomDashboard(Base, TimestampMixin):
    """A user-built, configurable dashboard for the Insights tab.

    Smartsheet-style: the owner arranges widgets (KPI tiles, charts, tables,
    health summary) on a grid and saves it. A dashboard can be shared to the
    whole tenant (read-only for everyone but the owner). The widget layout is an
    opaque JSONB array of widget instances owned by the frontend:

        [{ "id", "type", "x", "y", "w", "h", "title"?, "config"? }]

    The backend doesn't interpret `layout` — it stores/serves it. Widgets render
    from the existing dashboard metric endpoints, so no new metric data lives
    here.
    """

    __tablename__ = "custom_dashboards"

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # The creator. SET NULL so deleting a user keeps a shared dashboard alive.
    owner_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Shared = visible (read-only) to the whole tenant; private = owner only.
    is_shared: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    # Opaque widget-instance array (see class docstring). Default empty list.
    layout: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, server_default="[]")

    # ── Public share (Smartsheet-style, no-login link) ───────────────────────
    # NULL token = not published. Setting it back to NULL revokes the link.
    share_token: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, unique=True, index=True)
    # 'live' = re-query the owner's metrics each load; 'snapshot' = serve frozen data.
    share_mode: Mapped[str] = mapped_column(String(16), nullable=False, server_default="live")
    # Frozen widget data for snapshot mode (None in live mode). Shape:
    # { "widgets": { "<widget_id>": <data> }, "captured_at": <iso> }.
    share_snapshot: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    share_created_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    owner = relationship("User", foreign_keys=[owner_user_id])
