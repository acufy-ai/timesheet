from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class ProjectBaseline(Base, TimestampMixin):
    """A frozen snapshot of a project's PLAN at a point in time (PSA / EVM).

    EVM is meaningless without a baseline to measure against: it compares the
    plan (planned value, BAC) to what's earned and what's actually spent. A
    project can have several baselines over its life (re-baselining); exactly one
    is the active/current one used by EVM.

    Planned value (PV) at any date is derived by linear interpolation between
    ``baseline_start`` (PV=0) and ``baseline_end`` (PV=BAC=planned_cost) unless a
    richer phased curve is added later. This keeps EVM v1 simple while leaving
    room to grow.
    """

    __tablename__ = "project_baselines"

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Human label + which baseline is the live one used by EVM. A partial unique
    # index (one active per project) is enforced in the migration.
    name: Mapped[str] = mapped_column(String(120), nullable=False, default="Baseline")
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )

    # The plan, frozen at baseline time.
    planned_hours: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2), nullable=True)
    # Budget at completion (BAC) — the total planned COST of the work.
    planned_cost: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2), nullable=True)
    # Planned revenue (for margin-at-plan), optional.
    planned_revenue: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2), nullable=True)
    currency: Mapped[Optional[str]] = mapped_column(String(10), nullable=True, default="USD")
    baseline_start: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    baseline_end: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # When this snapshot was taken (defaults to row creation).
    captured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    project: Mapped["Project"] = relationship("Project")
