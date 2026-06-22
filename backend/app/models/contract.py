import enum
from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy import Date, Enum as SAEnum, ForeignKey, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class ContractStatus(str, enum.Enum):
    draft = "draft"
    active = "active"
    on_hold = "on_hold"
    completed = "completed"
    churned = "churned"


class Contract(Base, TimestampMixin):
    """An agreement with a client (MSA / SOW etc.). The signed document is
    stored via the storage service; only its key + metadata live here."""

    __tablename__ = "contracts"

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id"), nullable=False, index=True)
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    start_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    end_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    value: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2), nullable=True)
    status: Mapped[ContractStatus] = mapped_column(
        SAEnum(ContractStatus, name="contractstatus"), nullable=False,
        default=ContractStatus.draft, server_default="draft")

    document_key: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    document_name: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    document_size: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    client = relationship("Client")

    def __repr__(self) -> str:
        return f"<Contract(id={self.id}, client_id={self.client_id}, title={self.title})>"
