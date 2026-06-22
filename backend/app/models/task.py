import enum
from typing import List, Optional

from sqlalchemy import Boolean, Enum as SAEnum, ForeignKey, String, Text, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class TaskPriority(str, enum.Enum):
    low = "low"
    medium = "medium"
    high = "high"


class TaskStatus(str, enum.Enum):
    to_do = "to_do"
    in_progress = "in_progress"
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
