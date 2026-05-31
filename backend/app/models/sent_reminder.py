"""Record of reminder emails the worker has sent.

M9: the reminder worker iterates a list of recipients on every 15-min
tick. Without persistence, a transient send failure (SMTP blip, Auth0
hiccup) in the middle of the loop causes the next tick to re-notify
employees who *did* get the previous email — they receive duplicates,
sometimes several across the window.

This table records `(tenant_id, user_id, period_start, reminder_kind)`
on successful send. The worker filters out any recipient with a row
matching the current (period_start, kind) before sending. So an
employee still gets both reminders in a normal week (early window + final
window each create their own row with a different ``kind``), but a
retry within the same window is a no-op.

Rows older than 90 days are pruned by a separate housekeeping job
(scheduled with the same arq worker that runs the reminder check).
"""
from datetime import datetime, date

from sqlalchemy import Date, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base


class SentReminder(Base):
    __tablename__ = "sent_reminders"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "user_id",
            "period_start",
            "reminder_kind",
            name="uq_sent_reminders_recipient_period_kind",
        ),
        Index(
            "ix_sent_reminders_tenant_sent_at",
            "tenant_id",
            "sent_at",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), nullable=False, index=True
    )
    # Start of the period the reminder is for. For weekly internal
    # reminders this is the Monday of the target week; for monthly
    # external reminders this is the 1st of the target month.
    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    # One of: internal_early, internal_final, external_2day, external_3h.
    reminder_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    sent_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
