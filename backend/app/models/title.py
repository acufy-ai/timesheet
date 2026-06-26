from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin


class Title(Base, TimestampMixin):
    """A managed job title within a tenant. Mirrors Department: a curated list
    the Add-user form's Title dropdown is bound to. The user still carries a
    free-text ``title`` during the additive rollout; ``title_id`` is the
    structured source."""

    __tablename__ = "titles"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_titles_tenant_name"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)

    tenant: Mapped["Tenant"] = relationship("Tenant")
