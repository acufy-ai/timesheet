import enum
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, Enum as SAEnum, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class AttendanceEventType(str, enum.Enum):
    clock_in = "clock_in"
    clock_out = "clock_out"


class AttendanceEvent(Base, TimestampMixin):
    """An append-only clock-in / clock-out event for a user (attendance only).

    This is a pure PRESENCE signal ("at work" / "left"): it never creates or
    affects time entries or billable hours. Each toggle appends one row; the
    user's current status is the latest row for today. The user's manager is
    notified (in-app + optional email) when a row is written.
    """

    __tablename__ = "attendance_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id"), nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)

    event_type: Mapped[AttendanceEventType] = mapped_column(
        SAEnum(AttendanceEventType, name="attendanceeventtype"), nullable=False)
    # Server-recorded moment (tenant timezone), when the user clocked in/out.
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True)
    note: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    user = relationship("User", foreign_keys=[user_id])

    def __repr__(self) -> str:
        return (
            f"<AttendanceEvent(id={self.id}, user_id={self.user_id}, "
            f"type={self.event_type}, at={self.occurred_at})>"
        )
