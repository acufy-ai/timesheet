from sqlalchemy import ForeignKey, Integer, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class ClientEmployeeLink(Base, TimestampMixin):
    """Maps a CLIENT_EMPLOYEE to their CLIENT_MANAGER within a client org.

    A client employee reports to exactly one client manager (uq on
    employee_user_id). The manager invited/owns the employee and is the approver
    for their work. client_id records which client org the pair belongs to.
    """

    __tablename__ = "client_employee_links"
    __table_args__ = (
        UniqueConstraint("employee_user_id", name="uq_client_employee_one_manager"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id"), nullable=False, index=True)
    employee_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    manager_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)

    employee = relationship("User", foreign_keys=[employee_user_id])
    manager = relationship("User", foreign_keys=[manager_user_id])
    client = relationship("Client")
