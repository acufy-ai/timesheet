import enum

from sqlalchemy import Enum as SAEnum, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .base import Base, TimestampMixin


class ClientAssignmentRole(str, enum.Enum):
    pm = "pm"
    member = "member"


class UserClientAssignment(Base, TimestampMixin):
    """Many-to-many: employees assigned to clients they work at.
    ``assignment_role`` marks PMs vs. plain members on this client."""

    __tablename__ = "user_client_assignments"
    __table_args__ = (
        UniqueConstraint("user_id", "client_id", name="uq_user_client"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True
    )
    assignment_role: Mapped[ClientAssignmentRole] = mapped_column(
        SAEnum(ClientAssignmentRole, name="clientassignmentrole"),
        nullable=False, default=ClientAssignmentRole.member, server_default="member",
    )

    user: Mapped["User"] = relationship("User", back_populates="client_assignments")
    client: Mapped["Client"] = relationship("Client", back_populates="user_assignments")
