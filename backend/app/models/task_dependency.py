from typing import Optional

from sqlalchemy import CheckConstraint, ForeignKey, Integer, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class TaskDependency(Base, TimestampMixin):
    """A directed dependency edge between two tasks in the same project.

    Semantics: ``task_id`` depends on ``depends_on_task_id`` — i.e.
    ``depends_on_task_id`` blocks ``task_id`` (the predecessor must finish first).
    Used by the project-health "why" to surface blocking chains
    ("Integration testing can't start until ETL pipeline is done").

    tenant_id carried for defense in depth (both tasks already scope the tenant).
    A unique constraint prevents duplicate edges; a check constraint prevents a
    task depending on itself. Both endpoints cascade-delete with their task so a
    removed task takes its edges with it.
    """

    __tablename__ = "task_dependencies"

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id"), nullable=False, index=True)
    # The dependent task (the successor — blocked until its predecessor is done).
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True)
    # The predecessor task that must complete first (the blocker).
    depends_on_task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True)
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    task = relationship("Task", foreign_keys=[task_id])
    depends_on_task = relationship("Task", foreign_keys=[depends_on_task_id])

    __table_args__ = (
        UniqueConstraint("task_id", "depends_on_task_id", name="uq_task_dependency_edge"),
        CheckConstraint("task_id <> depends_on_task_id", name="ck_task_dependency_no_self"),
    )

    def __repr__(self) -> str:
        return (
            f"<TaskDependency(task_id={self.task_id} "
            f"depends_on={self.depends_on_task_id})>"
        )
