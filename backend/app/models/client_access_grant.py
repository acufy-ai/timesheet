from typing import Any, Optional

from sqlalchemy import CheckConstraint, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class ClientAccessGrant(Base, TimestampMixin):
    """A grant of scoped access to a CLIENT-role user.

    Each row grants ONE scope — either a whole project (project_id set) or a
    single task (task_id set), never both — with its own CRUD capability set
    (a JSONB list drawn from {"create","read","update","delete"}). A project
    grant implicitly covers that project's tasks; a task grant covers just the
    task. tenant_id is carried for defense in depth (the project/task already
    scopes the tenant). created_by records the PM/admin who issued the grant.
    """

    __tablename__ = "client_access_grants"

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id"), nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    project_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True)
    task_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=True, index=True)
    # CRUD capabilities granted on this scope, e.g. ["read", "update"].
    capabilities: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]")
    created_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    user = relationship("User", foreign_keys=[user_id])
    project = relationship("Project")
    task = relationship("Task")

    __table_args__ = (
        # Exactly one of project_id / task_id must be set.
        CheckConstraint(
            "(project_id IS NOT NULL) <> (task_id IS NOT NULL)",
            name="ck_client_access_grant_one_scope",
        ),
        Index("ix_client_access_grants_user_tenant", "user_id", "tenant_id"),
    )
