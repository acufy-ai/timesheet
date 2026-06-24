from sqlalchemy import Boolean, ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class EmployeeManagerAssignment(Base, TimestampMixin):
    """An employee->manager reporting edge. Multi-manager: an employee may have
    several rows (composite PK on employee_id + manager_id); exactly one may be
    flagged is_primary (enforced by a partial unique index)."""

    __tablename__ = "employee_manager_assignments"

    employee_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), primary_key=True)
    manager_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), primary_key=True, index=True)
    is_primary: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false")

    employee = relationship(
        "User",
        foreign_keys=[employee_id],
        back_populates="manager_assignments",
    )
    manager = relationship(
        "User",
        foreign_keys=[manager_id],
        back_populates="direct_report_assignments",
    )


class UserProjectAccess(Base, TimestampMixin):
    __tablename__ = "user_project_access"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id"), primary_key=True)

    user = relationship("User", back_populates="project_access")
    project = relationship("Project", back_populates="user_access")


class UserTaskAccess(Base, TimestampMixin):
    """Per-user task-level access grant. Mirrors UserProjectAccess but at the
    task grain, so a user can be granted specific tasks within a project
    (the user form's project & task access tree). tenant_id carried for
    defense in depth (the task already scopes the tenant)."""

    __tablename__ = "user_task_access"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id"), nullable=False, index=True)

    user = relationship("User", back_populates="task_access")
    task = relationship("Task")


class ProjectManager(Base, TimestampMixin):
    """Many-to-many: the manager(s) who run a project. A project can have more
    than one PM. tenant_id carried for defense in depth."""

    __tablename__ = "project_managers"

    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id"), nullable=False, index=True)

    project = relationship("Project", back_populates="managers")
    user = relationship("User")


class TaskAssignee(Base, TimestampMixin):
    """Many-to-many: employees assigned to a task. tenant_id carried for
    defense in depth (the task already scopes the tenant)."""

    __tablename__ = "task_assignees"

    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id"), nullable=False, index=True)

    task = relationship("Task", back_populates="assignees")
    user = relationship("User")
