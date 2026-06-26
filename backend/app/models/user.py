from sqlalchemy import String, Boolean, Integer, Numeric, Enum as SQLEnum, ForeignKey, Text, DateTime, UniqueConstraint, Index
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from enum import Enum
from decimal import Decimal
from typing import Optional, List
from datetime import datetime
from .base import Base, TimestampMixin


class UserRole(str, Enum):
    """User role enumeration."""
    EMPLOYEE = "EMPLOYEE"
    MANAGER = "MANAGER"
    VIEWER = "VIEWER"
    ADMIN = "ADMIN"           # Tenant-scoped admin
    PLATFORM_ADMIN = "PLATFORM_ADMIN"  # Global admin — no tenant_id
    # External client-side person with scoped access to specific projects/tasks
    # via ClientAccessGrant. Locked out of every other surface by a fail-closed
    # global gate (see app/core/deps.py require_not_client / client allowlist).
    CLIENT = "CLIENT"
    # Two-tier client portal. A CLIENT_MANAGER is the senior person on the
    # client's side: they receive grants from our side and can re-assign their
    # own client employees to that shared work, review it, and (per-client
    # toggle) invite their own employees. A CLIENT_EMPLOYEE is assigned by their
    # client manager to specific tasks (read+update only, never create/delete).
    # All three client roles share the same fail-closed portal allowlist.
    CLIENT_MANAGER = "CLIENT_MANAGER"
    CLIENT_EMPLOYEE = "CLIENT_EMPLOYEE"


class User(Base, TimestampMixin):
    """User model for authentication and role-based access."""

    __tablename__ = "users"

    # F-007: email and username uniqueness is scoped per-tenant so that
    # two different tenants can each have an "alice@example.com" without
    # blocking cross-tenant onboarding. Migration 054 drops the legacy
    # single-column unique indexes and adds composite ones. Non-unique
    # indexes on the bare columns are retained for email-lookup speed
    # during login.
    __table_args__ = (
        UniqueConstraint("tenant_id", "email", name="uq_users_tenant_email"),
        UniqueConstraint("tenant_id", "username", name="uq_users_tenant_username"),
        Index("ix_users_email", "email"),
        Index("ix_users_username", "username"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("tenants.id"), nullable=True, index=True
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    username: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Free-text job title (legacy). Kept alongside title_id during the additive
    # rollout; title_id (FK to the managed Title table) is the structured source.
    title: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    title_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("titles.id", ondelete="SET NULL"), nullable=True, index=True)
    # Free-text department label (legacy). Kept alongside department_id during
    # the additive rollout; department_id (FK to the managed Department table) is
    # the structured source for rollups/filtering. A later migration drops this.
    department: Mapped[Optional[str]] = mapped_column(
        String(255), nullable=True)
    department_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL"), nullable=True, index=True)
    timezone: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True, default="UTC")
    # Loaded hourly COST of this person to the firm (PSA). Distinct from what
    # they bill (project/role rates): cost feeds margin, WIP, EVM actual cost.
    # Snapshotted onto each time entry at approval (immutable), so later cost
    # edits never re-price approved work. NULL = no cost tracked for this user.
    cost_rate: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(12, 2), nullable=True)
    cost_currency: Mapped[Optional[str]] = mapped_column(
        String(10), nullable=True, default="USD")
    # PSA capacity: this person's available billable-ish hours per week. Drives
    # utilization-vs-capacity and over/under-allocation. Defaults to 40 (FT);
    # set lower for part-time. NULL falls back to the 40h default in code.
    weekly_capacity_hours: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(5, 2), nullable=True, default=Decimal("40"))
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    has_changed_password: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False)
    role: Mapped[UserRole] = mapped_column(
        SQLEnum(UserRole), nullable=False, default=UserRole.EMPLOYEE)
    # Allowed roles for /auth/switch-role; active one is `role` above.
    roles: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    # Phone numbers: index 0 is primary, remaining are extras (max 3 total).
    phones: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    # Per-user UI preferences (view modes, table densities, etc.).
    # Keys are free-form so the frontend can add new ones without backend
    # migrations. Reserved keys so far: "inbox_view_mode" ("cards" | "table").
    preferences: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True)
    can_review: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    is_external: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    timesheet_locked: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    timesheet_locked_reason: Mapped[Optional[str]] = mapped_column(
        Text, nullable=True
    )

    # Account lockout
    failed_login_attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    locked_until: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Bumped on force-logout / revoke-all-sessions. Every access token carries
    # the version it was minted at (``tv`` claim); a mismatch is rejected in
    # get_current_user. Incrementing this instantly invalidates ALL of the
    # user's outstanding access tokens, everywhere, with no per-token state.
    token_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )

    # Email verification
    email_verified: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    email_verified_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    email_verification_token: Mapped[Optional[str]] = mapped_column(
        String(128), nullable=True, unique=True, index=True
    )
    email_verification_token_expires_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    last_login_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Auth0 identity. Populated on first successful Auth0 login (or
    # during the bulk-import migration). Stays NULL for any user who
    # hasn't been migrated yet — those users fall through to the
    # legacy bcrypt path until cutover completes.
    auth0_sub: Mapped[Optional[str]] = mapped_column(
        String(128), nullable=True, unique=True, index=True
    )

    # Ingestion platform cross-reference
    ingestion_employee_id: Mapped[Optional[str]] = mapped_column(
        String(36), nullable=True, unique=True, index=True
    )
    ingestion_created_by: Mapped[Optional[str]] = mapped_column(
        String(255), nullable=True
    )

    # Optional pinning — if set, ingestion auto-assigns this client on any
    # timesheet resolved to this user without needing to match client signals.
    default_client_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("clients.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # Legacy column from the dual-account portal-handoff model. Kept
    # in the schema (the DB drop is a follow-up migration) but no
    # application code reads it; the multi-role refactor replaced
    # account linkage with the users.roles array.
    linked_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # Relationships
    tenant: Mapped[Optional["Tenant"]] = relationship("Tenant", back_populates="users")
    title_ref: Mapped[Optional["Title"]] = relationship("Title")
    department_ref: Mapped[Optional["Department"]] = relationship("Department")
    # The PRIMARY manager assignment. An employee may now have several manager
    # rows (multi-manager); this relationship resolves to the one flagged
    # is_primary so all legacy callers (selectinload + .manager_assignment.
    # manager_id) transparently keep seeing the primary manager. Read-only:
    # writes go through `manager_assignments` (the full list) in the CRUD.
    manager_assignment: Mapped[Optional["EmployeeManagerAssignment"]] = relationship(
        "EmployeeManagerAssignment",
        primaryjoin=(
            "and_(User.id == EmployeeManagerAssignment.employee_id, "
            "EmployeeManagerAssignment.is_primary == True)"
        ),
        foreign_keys="EmployeeManagerAssignment.employee_id",
        viewonly=True,
        uselist=False,
    )
    # All of the employee's manager assignments (multi-manager). This is the
    # writable collection; the CRUD reconciles it.
    manager_assignments: Mapped[List["EmployeeManagerAssignment"]] = relationship(
        "EmployeeManagerAssignment",
        back_populates="employee",
        foreign_keys="EmployeeManagerAssignment.employee_id",
        cascade="all, delete-orphan",
    )
    direct_report_assignments: Mapped[List["EmployeeManagerAssignment"]] = relationship(
        "EmployeeManagerAssignment",
        back_populates="manager",
        foreign_keys="EmployeeManagerAssignment.manager_id",
    )
    project_access: Mapped[List["UserProjectAccess"]] = relationship(
        "UserProjectAccess",
        back_populates="user",
        cascade="all, delete-orphan",
    )
    task_access: Mapped[List["UserTaskAccess"]] = relationship(
        "UserTaskAccess",
        back_populates="user",
        cascade="all, delete-orphan",
    )
    email_aliases: Mapped[List["UserEmailAlias"]] = relationship(
        "UserEmailAlias",
        back_populates="user",
        cascade="all, delete-orphan",
    )
    client_assignments: Mapped[List["UserClientAssignment"]] = relationship(
        "UserClientAssignment",
        back_populates="user",
        cascade="all, delete-orphan",
    )
    time_entries: Mapped[List["TimeEntry"]] = relationship(
        "TimeEntry", back_populates="user", foreign_keys="TimeEntry.user_id")
    approved_entries: Mapped[List["TimeEntry"]] = relationship(
        "TimeEntry", back_populates="approved_by_user", foreign_keys="TimeEntry.approved_by")
    time_off_requests: Mapped[List["TimeOffRequest"]] = relationship(
        "TimeOffRequest", back_populates="user", foreign_keys="TimeOffRequest.user_id")
    approved_time_off_requests: Mapped[List["TimeOffRequest"]] = relationship(
        "TimeOffRequest", back_populates="approved_by_user", foreign_keys="TimeOffRequest.approved_by")

    @property
    def manager_id(self) -> Optional[int]:
        """The PRIMARY manager's id (back-compat single-manager accessor).

        Resolves from the loaded manager list when available (avoids a second
        relationship load), else the primary-only relationship. Raises if
        neither was eager-loaded so a missing selectinload surfaces here rather
        than as a DetachedInstanceError deep in serialization.
        """
        from sqlalchemy import inspect as sa_inspect

        state = sa_inspect(self)
        if "manager_assignments" not in state.unloaded:
            primary = next((a for a in self.manager_assignments if a.is_primary), None)
            chosen = primary or (self.manager_assignments[0] if self.manager_assignments else None)
            return chosen.manager_id if chosen else None
        if "manager_assignment" not in state.unloaded:
            return self.manager_assignment.manager_id if self.manager_assignment else None
        raise RuntimeError(
            "User manager assignments were not eager-loaded. Add "
            "selectinload(User.manager_assignments) (or .manager_assignment) "
            "to the query, or populate the field via a DTO before serialization."
        )

    @property
    def manager_ids(self) -> List[int]:
        """All managers this employee reports to (multi-manager). Requires
        manager_assignments to be eager-loaded."""
        from sqlalchemy import inspect as sa_inspect

        if "manager_assignments" in sa_inspect(self).unloaded:
            return []
        return sorted(a.manager_id for a in self.manager_assignments)

    @property
    def primary_manager_id(self) -> Optional[int]:
        """The primary manager's id (alias of manager_id, explicit for clarity)."""
        return self.manager_id

    @property
    def project_ids(self) -> List[int]:
        return sorted(access.project_id for access in self.project_access)

    @property
    def task_ids(self) -> List[int]:
        return sorted(access.task_id for access in self.task_access)

    def __repr__(self) -> str:
        return f"<User(id={self.id}, email={self.email}, role={self.role}, is_active={self.is_active})>"
