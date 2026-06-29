"""Phase C client sub-entities: contacts, role rates, notes."""
from datetime import date
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import Boolean, Date, ForeignKey, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class ClientContact(Base, TimestampMixin):
    """A person at the client. emails/phones are JSONB arrays of
    {label, address} / {label, number} owned entirely by the contact."""

    __tablename__ = "client_contacts"

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id"), nullable=False, index=True)
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    emails: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    phones: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    # Marks the client's primary point of contact. Backfilled from the legacy
    # inline clients.contact_* fields. (The inline contact_email is kept as the
    # email-ingestion routing key.)
    is_primary: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false")

    client = relationship("Client")


class ClientRoleRate(Base, TimestampMixin):
    """Per-client billable rate card row."""

    __tablename__ = "client_role_rates"

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id"), nullable=False, index=True)
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(255), nullable=False)
    rate: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(10), nullable=False, default="USD", server_default="USD")
    effective_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)

    client = relationship("Client")


class ClientNote(Base, TimestampMixin):
    """A freeform note on a client."""

    __tablename__ = "client_notes"

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id"), nullable=False, index=True)
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    # Denormalized display name, server-stamped from the author at create time
    # (never caller-supplied). author_user_id is the provable link to the user.
    author: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    author_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    note_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    # Optional target: a note can be attached to a specific project + task. When
    # a task is set, the note body is mirrored into that task's blocked_reason
    # (done in the notes API). ON DELETE SET NULL keeps the note if the
    # project/task is removed.
    project_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True)
    task_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True, index=True)

    client = relationship("Client")
    author_user = relationship("User", foreign_keys=[author_user_id])
