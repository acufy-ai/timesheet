from sqlalchemy import Boolean, CheckConstraint, Index, String, ForeignKey, Text, Enum as SQLEnum, DateTime, Numeric, Integer, Time
from sqlalchemy.orm import Mapped, mapped_column, relationship
from enum import Enum
from typing import Optional, TYPE_CHECKING
from datetime import date, datetime, time
from decimal import Decimal
from .base import Base, TimestampMixin

if TYPE_CHECKING:
    from .project import Project
    from .task import Task
    from .user import User


class TimeEntryStatus(str, Enum):
    """Status enumeration for time entries."""
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class TimeEntry(Base, TimestampMixin):
    """TimeEntry model for tracking billable hours."""

    __tablename__ = "time_entries"
    __table_args__ = (
        CheckConstraint(
            "approved_by IS NULL OR approved_by <> user_id",
            name="ck_time_entries_no_self_approve",
        ),
        Index("ix_time_entries_user_date", "user_id", "entry_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), nullable=False, index=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id"), nullable=False, index=True)
    task_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("tasks.id"), nullable=True, index=True)
    entry_date: Mapped[date] = mapped_column(nullable=False, index=True)
    # Optional explicit time block. Both are nullable: an entry can be
    # hours-only (e.g. "4h on project X today") or it can be a precise
    # block (8:00 AM - 10:00 AM). The frontend computes hours from the
    # block when the user enters one; the hours column remains the
    # source of truth for billing / approval / reports.
    start_time: Mapped[Optional[time]] = mapped_column(Time, nullable=True)
    end_time: Mapped[Optional[time]] = mapped_column(Time, nullable=True)
    hours: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), nullable=False)  # 0.00 to 999.99
    description: Mapped[str] = mapped_column(Text, nullable=False)
    # Private free-text notes authored by the entry owner. Distinct from
    # ``description``: notes do not appear in approval views, exports, or
    # client-facing invoices — they are the owner's personal scratchpad.
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_billable: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True)
    # Frozen rate snapshot, stamped at approval (role-rate card -> project rate
    # fallback). NULL until approved; once set, a later rate-card/project edit
    # never re-prices this entry. Reporting reads this when present, else falls
    # back to the live project rate.
    billed_rate: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(12, 2), nullable=True)
    billed_currency: Mapped[Optional[str]] = mapped_column(
        String(10), nullable=True)
    # Frozen COST snapshot, stamped at approval from the user's cost_rate —
    # PARALLEL to billed_rate and equally immutable. Cost is what the person
    # costs the firm (loaded hourly), vs. billed_rate (what the client pays).
    # margin = billed_amount - cost_amount. NULL until approved / when no cost
    # rate is set on the user. Never mutates the revenue path.
    cost_rate: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(12, 2), nullable=True)
    cost_currency: Mapped[Optional[str]] = mapped_column(
        String(10), nullable=True)
    status: Mapped[TimeEntryStatus] = mapped_column(SQLEnum(
        TimeEntryStatus), nullable=False, default=TimeEntryStatus.DRAFT, index=True)

    # Per-entry approval routing (multi-manager). When set, only this manager
    # may approve the entry; NULL = any of the employee's managers. Honored only
    # when the approval_by_assigned_manager tenant setting is on.
    approver_manager_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)

    # Approval tracking
    submitted_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True)
    approved_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id"), nullable=True)
    approved_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True)
    rejection_reason: Mapped[Optional[str]
                             ] = mapped_column(Text, nullable=True)
    created_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id"), nullable=True)
    updated_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id"), nullable=True)
    last_edit_reason: Mapped[Optional[str]
                             ] = mapped_column(Text, nullable=True)
    last_history_summary: Mapped[Optional[str]] = mapped_column(
        Text, nullable=True)

    # QuickBooks integration (future)
    quickbooks_time_activity_id: Mapped[Optional[str]] = mapped_column(
        String(255), nullable=True)

    # Ingestion platform cross-reference
    ingestion_timesheet_id: Mapped[Optional[str]] = mapped_column(
        String(36), nullable=True, index=True
    )
    ingestion_line_item_id: Mapped[Optional[str]] = mapped_column(
        String(36), nullable=True, unique=True, index=True
    )
    ingestion_approved_by_name: Mapped[Optional[str]] = mapped_column(
        String(255), nullable=True
    )
    ingestion_source_tenant: Mapped[Optional[str]] = mapped_column(
        String(255), nullable=True
    )
    # Free-form supervisor name (typically a client contact, no FK).
    supervisor_name: Mapped[Optional[str]] = mapped_column(
        String(255), nullable=True
    )

    # Relationships
    user: Mapped["User"] = relationship(
        "User", back_populates="time_entries", foreign_keys=[user_id])
    project: Mapped["Project"] = relationship(
        "Project", back_populates="time_entries")
    task: Mapped[Optional["Task"]] = relationship(
        "Task", back_populates="time_entries")
    approved_by_user: Mapped[Optional["User"]] = relationship(
        "User", back_populates="approved_entries", foreign_keys=[approved_by])
    edit_history: Mapped[list["TimeEntryEditHistory"]] = relationship(
        "TimeEntryEditHistory",
        back_populates="time_entry",
        cascade="all, delete-orphan",
    )

    @property
    def approved_by_name(self) -> Optional[str]:
        """Convenience for response serialization. Requires approved_by_user to be eager-loaded."""
        try:
            return self.approved_by_user.full_name if self.approved_by_user else None
        except Exception:
            return None

    def __repr__(self) -> str:
        return f"<TimeEntry(id={self.id}, user_id={self.user_id}, project_id={self.project_id}, date={self.entry_date}, status={self.status})>"


class TimeEntryEditHistory(Base):
    __tablename__ = "time_entry_edit_history"
    __table_args__ = (
        Index(
            "ix_time_entry_edit_history_tenant_entry",
            "tenant_id",
            "time_entry_id",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # Defense-in-depth. Today the per-tenant DB connection is the real
    # boundary; this column lets queries filter by tenant_id directly
    # and keeps the schema uniform for the eventual Phase 3.F cleanup.
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id"), nullable=False, index=True
    )
    time_entry_id: Mapped[int] = mapped_column(
        ForeignKey("time_entries.id"), nullable=False, index=True)
    edited_by: Mapped[int] = mapped_column(
        ForeignKey("users.id"), nullable=False, index=True)
    edited_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False)
    edit_reason: Mapped[str] = mapped_column(Text, nullable=False)
    history_summary: Mapped[str] = mapped_column(Text, nullable=False)
    previous_project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id"), nullable=False)
    previous_entry_date: Mapped[date] = mapped_column(nullable=False)
    previous_hours: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), nullable=False)
    previous_description: Mapped[str] = mapped_column(Text, nullable=False)

    time_entry: Mapped["TimeEntry"] = relationship(
        "TimeEntry", back_populates="edit_history")
