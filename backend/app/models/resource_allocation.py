from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy import Date, ForeignKey, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class ResourceAllocation(Base, TimestampMixin):
    """A PLANNED assignment of a person to a project over a date window (PSA).

    Distinct from time *logged* (TimeEntry) and from access grants
    (UserProjectAccess): this is forward-looking capacity planning — "Priya is
    booked 60% on Project X from Jul 1 to Sep 30." It drives utilization-vs-
    capacity, over/under-allocation detection, and coverage/hiring forecasts.

    Intensity is stored as ``percent`` (of the person's weekly capacity) OR
    ``hours_per_week`` — at least one should be set. Percent is the common case;
    hours_per_week is resolved against the user's weekly capacity when needed.
    """

    __tablename__ = "resource_allocations"

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    end_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    # Intensity: percent of weekly capacity (0-100+), and/or explicit hours/week.
    percent: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 2), nullable=True)
    hours_per_week: Mapped[Optional[Decimal]] = mapped_column(Numeric(6, 2), nullable=True)
    role: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    user: Mapped["User"] = relationship("User")
    project: Mapped["Project"] = relationship("Project")
