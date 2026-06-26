from decimal import Decimal
from typing import Optional

from sqlalchemy import Boolean, ForeignKey, Numeric, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, TimestampMixin


class ProjectHealthConfig(Base, TimestampMixin):
    """Tunable rules for how project health is classified (PSA).

    Health differs org-to-org and team-to-team, so the thresholds behind the
    good / at-risk / needs-attention pills are configurable rather than
    hardcoded. Two scopes share one table:

    - ``user_id IS NULL`` → the **workspace default** for the tenant.
    - ``user_id`` set      → a **per-manager override** for that manager's view.

    Resolution at classify time: the manager's own row if present, else the
    workspace-default row, else the built-in fallbacks (which mirror these
    defaults). Each rule group can be toggled off so a team can judge health on,
    say, budget alone and ignore schedule.
    """

    __tablename__ = "project_health_configs"
    __table_args__ = (
        UniqueConstraint("tenant_id", "user_id", name="uq_project_health_config_scope"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # NULL = workspace default; set = this manager's personal override.
    user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )

    # Budget rules.
    budget_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    over_budget_pct: Mapped[Decimal] = mapped_column(Numeric(6, 2), nullable=False, server_default="100")
    high_burn_pct: Mapped[Decimal] = mapped_column(Numeric(6, 2), nullable=False, server_default="80")

    # Schedule rules (days relative to the project end date).
    schedule_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    ending_soon_days: Mapped[int] = mapped_column(Numeric(6, 0), nullable=False, server_default="7")
    overdue_days: Mapped[int] = mapped_column(Numeric(6, 0), nullable=False, server_default="30")

    # Margin rule (new health input; off by default).
    margin_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    low_margin_pct: Mapped[Decimal] = mapped_column(Numeric(6, 2), nullable=False, server_default="15")
