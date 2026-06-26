import enum
from datetime import date
from typing import List, Optional

from sqlalchemy import (
    Boolean,
    Date,
    Enum as SAEnum,
    ForeignKey,
    Numeric,
    String,
    Text,
    Integer,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class TaskPriority(str, enum.Enum):
    low = "low"
    medium = "medium"
    high = "high"


class TaskStatus(str, enum.Enum):
    to_do = "to_do"
    in_progress = "in_progress"
    blocked = "blocked"
    done = "done"


class Task(Base, TimestampMixin):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id"), nullable=False, index=True
    )
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    code: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, index=True)
    priority: Mapped[TaskPriority] = mapped_column(
        SAEnum(TaskPriority, name="taskpriority"), nullable=False,
        default=TaskPriority.medium, server_default="medium")
    status: Mapped[TaskStatus] = mapped_column(
        SAEnum(TaskStatus, name="taskstatus"), nullable=False,
        default=TaskStatus.to_do, server_default="to_do")

    # Phase 2 causal-data columns. All nullable / additive: existing tasks have
    # no estimate, dates, or blocker, and the project-health "why" logic must
    # treat NULL as "unknown" (never as zero hours or as overdue).
    estimated_hours: Mapped[Optional[float]] = mapped_column(
        Numeric(8, 2), nullable=True)
    start_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    due_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True, index=True)
    # Free-text "why blocked" — only meaningful when status == blocked, but kept
    # independent so a reason can be captured/cleared without a status round-trip.
    blocked_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    project: Mapped["Project"] = relationship(
        "Project", back_populates="tasks")
    time_entries: Mapped[List["TimeEntry"]] = relationship(
        "TimeEntry", back_populates="task")
    assignees: Mapped[List["TaskAssignee"]] = relationship(
        "TaskAssignee", back_populates="task", cascade="all, delete-orphan")

    def __repr__(self) -> str:
        return (
            f"<Task(id={self.id}, project_id={self.project_id}, "
            f"name={self.name}, is_active={self.is_active})>"
        )
