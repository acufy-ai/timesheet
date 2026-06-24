from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class ClientTaskReview(Base, TimestampMixin):
    """A CLIENT_MANAGER's review of a CLIENT_EMPLOYEE's task update.

    One row per (task, employee); the latest update resets it to pending. The
    manager approves or rejects (with an optional note). Lightweight client-tier
    mirror of the internal approval flow.
    """

    __tablename__ = "client_task_reviews"
    __table_args__ = (
        UniqueConstraint("task_id", "employee_user_id", name="uq_client_task_review_task_employee"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id"), nullable=False, index=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True)
    employee_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    manager_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending", server_default="pending")
    note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    submitted_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True)
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True)

    task = relationship("Task")
    employee = relationship("User", foreign_keys=[employee_user_id])
    manager = relationship("User", foreign_keys=[manager_user_id])
