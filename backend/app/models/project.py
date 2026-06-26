import enum
from datetime import date

from sqlalchemy import String, Boolean, ForeignKey, Numeric, Date, Text, Integer, Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship
from typing import Optional, List
from decimal import Decimal
from .base import Base, TimestampMixin


class ProjectStatus(str, enum.Enum):
    planning = "planning"
    in_progress = "in_progress"
    on_hold = "on_hold"
    completed = "completed"


class Project(Base, TimestampMixin):
    """Project model for time tracking by project."""

    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey("tenants.id"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id"), nullable=False, index=True)
    billable_rate: Mapped[Decimal] = mapped_column(
        Numeric(10, 2), nullable=False)
    quickbooks_project_id: Mapped[Optional[str]
                                  ] = mapped_column(String(255), nullable=True)
    ingestion_project_id: Mapped[Optional[str]] = mapped_column(
        String(36), nullable=True, unique=True, index=True
    )
    code: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    start_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    end_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    estimated_hours: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(10, 2), nullable=True)
    budget_amount: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(12, 2), nullable=True)
    currency: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    # PSA revenue-recognition method: how recognized revenue is computed.
    #   as_billed        = approved billable hours x rate (T&M; the default).
    #   percent_complete = (contract value or budget) x (hours done / planned),
    #                      for fixed-fee work — uses the project baseline.
    revenue_recognition: Mapped[str] = mapped_column(
        String(20), nullable=False, default="as_billed", server_default="as_billed")
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True)
    # Per-project PM toggle: when true, this project may be shared with CLIENT
    # users via ClientAccessGrant. Off by default (feature dark until opted in).
    client_access_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false")
    status: Mapped[ProjectStatus] = mapped_column(
        SAEnum(ProjectStatus, name="projectstatus"), nullable=False,
        default=ProjectStatus.planning, server_default="planning")
    # The internal user (a manager) who runs this project. Constrained in the
    # app to the client's assigned PMs; FK only enforces a real user.
    manager_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    # The contract (MSA/SOW) this project is delivered under. Optional; used for
    # contract value burn (approved billed amounts vs contract.value).
    contract_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("contracts.id", ondelete="SET NULL"), nullable=True, index=True)

    # Relationships
    tenant: Mapped["Tenant"] = relationship("Tenant", back_populates="projects")
    client: Mapped["Client"] = relationship(
        "Client", back_populates="projects")
    manager: Mapped[Optional["User"]] = relationship(
        "User", foreign_keys=[manager_id])
    contract: Mapped[Optional["Contract"]] = relationship(
        "Contract", foreign_keys=[contract_id])
    managers: Mapped[List["ProjectManager"]] = relationship(
        "ProjectManager", back_populates="project", cascade="all, delete-orphan")
    user_access: Mapped[List["UserProjectAccess"]] = relationship(
        "UserProjectAccess",
        back_populates="project",
        cascade="all, delete-orphan",
    )
    time_entries: Mapped[List["TimeEntry"]] = relationship(
        "TimeEntry", back_populates="project", cascade="all, delete-orphan")
    tasks: Mapped[List["Task"]] = relationship(
        "Task", back_populates="project", cascade="all, delete-orphan")

    def __repr__(self) -> str:
        return f"<Project(id={self.id}, name={self.name}, client_id={self.client_id}, is_active={self.is_active})>"
