from datetime import date as _date
from enum import Enum
from typing import Optional

from sqlalchemy import Date, Enum as SQLEnum, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class HolidayType(str, Enum):
    """Two industry-standard categories:

    - PUBLIC: government / statutory holidays (Memorial Day, Diwali, etc.).
    - COMPANY: org-defined non-working days (founder's day, company offsite).

    Both excuse a working day for the manager-dashboard late signal.
    """
    PUBLIC = "PUBLIC"
    COMPANY = "COMPANY"


class Holiday(Base, TimestampMixin):
    """Org-wide non-working day.

    A row applies to every employee in the tenant. The ``country``
    column is reserved for a future per-region split (e.g. an Indian
    dev team observing IN holidays while the US headquarters
    observes US ones) — for v1 it is always ``NULL`` (org-wide) and
    is ignored when reading. Adding a non-null ``country`` later is
    additive: rows with NULL stay org-wide, rows with a country
    filter on the employee's location.
    """

    __tablename__ = "holidays"
    __table_args__ = (
        # A tenant can only have one holiday per date; admins use the
        # name to clarify when two observances fall on the same day.
        UniqueConstraint("tenant_id", "date", name="uq_holidays_tenant_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    date: Mapped[_date] = mapped_column(Date, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    holiday_type: Mapped[HolidayType] = mapped_column(
        SQLEnum(HolidayType, name="holiday_type"),
        nullable=False,
        default=HolidayType.COMPANY,
    )
    country: Mapped[Optional[str]] = mapped_column(
        String(2), nullable=True
    )
    created_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    tenant: Mapped["Tenant"] = relationship("Tenant")
    creator: Mapped[Optional["User"]] = relationship("User", foreign_keys=[created_by])
