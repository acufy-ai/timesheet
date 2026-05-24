from sqlalchemy import ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .base import Base, TimestampMixin


class UserClientAssignment(Base, TimestampMixin):
    """Many-to-many: employees assigned to clients they work at."""

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

    user: Mapped["User"] = relationship("User", back_populates="client_assignments")
    client: Mapped["Client"] = relationship("Client", back_populates="user_assignments")
