from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator
from datetime import datetime, date, time
from decimal import Decimal
from typing import Any, Optional, List
from enum import Enum


class UserRole(str, Enum):
    """User role enumeration."""
    EMPLOYEE = "EMPLOYEE"
    MANAGER = "MANAGER"
    VIEWER = "VIEWER"
    ADMIN = "ADMIN"
    PLATFORM_ADMIN = "PLATFORM_ADMIN"
    CLIENT = "CLIENT"
    CLIENT_MANAGER = "CLIENT_MANAGER"
    CLIENT_EMPLOYEE = "CLIENT_EMPLOYEE"


class TimeEntryStatus(str, Enum):
    """TimeEntry status enumeration."""
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class TimeOffType(str, Enum):
    SICK_DAY = "SICK_DAY"
    PTO = "PTO"
    HALF_DAY = "HALF_DAY"
    HOURLY_PERMISSION = "HOURLY_PERMISSION"
    OTHER_LEAVE = "OTHER_LEAVE"


class TimeOffStatus(str, Enum):
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


# ============================================================================
# User Schemas
# ============================================================================

class UserBase(BaseModel):
    # Plain str on the response so synthetic @local.invalid placeholders
    # round-trip; inbound paths still use EmailStr.
    email: str
    # No min_length here: this is the RESPONSE base (UserResponse), and a
    # legitimately short existing username (e.g. initials "ap") must not 500
    # the whole list on serialization. Length is enforced on INPUT only
    # (UserCreate / UserUpdate / UserSelfUpdate keep min_length=3).
    username: str = Field(..., max_length=255)
    full_name: str
    title: Optional[str] = None
    # FK to the managed Title table (structured), resolved server-side from
    # `title` when only the name is supplied; either may be sent.
    title_id: Optional[int] = None
    department: Optional[str] = None
    # FK to the managed Department table (structured). Populated server-side from
    # `department` when only the name is supplied; either may be sent.
    department_id: Optional[int] = None
    # PSA: loaded hourly cost of this person (sensitive — admin-editable; feeds
    # margin/EVM, never shown to employees).
    cost_rate: Optional[Decimal] = None
    cost_currency: Optional[str] = None
    timezone: Optional[str] = "UTC"
    role: UserRole = UserRole.EMPLOYEE
    is_active: bool = True
    manager_id: Optional[int] = None
    # Multi-manager: all managers this employee reports to, and which is primary.
    # manager_id (above) mirrors the primary for back-compat.
    manager_ids: List[int] = Field(default_factory=list)
    primary_manager_id: Optional[int] = None
    project_ids: List[int] = Field(default_factory=list)
    task_ids: List[int] = Field(default_factory=list)
    default_client_id: Optional[int] = None


class UserCreate(BaseModel):
    """Admin user creation. Only full_name + is_external are required."""
    full_name: str = Field(..., min_length=1)
    is_external: bool
    email: Optional[EmailStr] = None
    username: Optional[str] = Field(None, min_length=3, max_length=255)
    title: Optional[str] = None
    title_id: Optional[int] = None
    department: Optional[str] = None
    department_id: Optional[int] = None
    cost_rate: Optional[Decimal] = None
    cost_currency: Optional[str] = None
    timezone: Optional[str] = "UTC"
    role: UserRole = UserRole.EMPLOYEE
    is_active: bool = True
    manager_id: Optional[int] = None
    manager_ids: List[int] = Field(default_factory=list)
    primary_manager_id: Optional[int] = None
    project_ids: List[int] = Field(default_factory=list)
    task_ids: List[int] = Field(default_factory=list)
    default_client_id: Optional[int] = None
    password: Optional[str] = Field(None, min_length=8)
    can_review: bool = False
    phones: List[str] = Field(default_factory=list)
    # Only honored when PLATFORM_ADMIN creates a user in a specific tenant.
    tenant_id: Optional[int] = None


class UserSelfUpdate(BaseModel):
    full_name: Optional[str] = None
    title: Optional[str] = None
    timezone: Optional[str] = None
    username: Optional[str] = Field(None, min_length=3, max_length=255)
    # Email is self-editable only for platform admins (enforced in the route).
    email: Optional[EmailStr] = None


class UserUpdate(BaseModel):
    email: Optional[EmailStr] = None
    username: Optional[str] = Field(None, min_length=3, max_length=255)
    full_name: Optional[str] = None
    title: Optional[str] = None
    title_id: Optional[int] = None
    department: Optional[str] = None
    department_id: Optional[int] = None
    cost_rate: Optional[Decimal] = None
    cost_currency: Optional[str] = None
    timezone: Optional[str] = None
    role: Optional[UserRole] = None
    # CRUD layer dedupes and ensures the active role is included.
    roles: Optional[List[UserRole]] = None
    is_active: Optional[bool] = None
    can_review: Optional[bool] = None
    is_external: Optional[bool] = None
    manager_id: Optional[int] = None
    manager_ids: Optional[List[int]] = None
    primary_manager_id: Optional[int] = None
    project_ids: Optional[List[int]] = None
    task_ids: Optional[List[int]] = None
    default_client_id: Optional[int] = None
    phones: Optional[List[str]] = None


class UserResponse(UserBase):
    id: int
    tenant_id: Optional[int] = None
    has_changed_password: bool
    email_verified: bool = False
    can_review: bool = False
    is_external: bool = False
    # Roles the user can act as; portal-picker shows when len(roles) > 1.
    roles: List[UserRole] = Field(default_factory=list)
    phones: List[str] = Field(default_factory=list)
    # Per-user UI preferences (inbox_view_mode, etc.). Free-form dict so
    # the frontend can add keys without backend churn. Nullable on the
    # wire because the PA adapter and pre-migration users can carry None;
    # the validator coerces null -> {} so consumers always see a dict.
    preferences: dict = Field(default_factory=dict)

    @field_validator("preferences", mode="before")
    @classmethod
    def _coerce_preferences(cls, value: object) -> object:
        return value if value is not None else {}
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class UserCreateResponse(BaseModel):
    """Returned when an admin creates a new user."""
    user: UserResponse
    # Auto-generated password; admin hands this off when no verification
    # email is sent. Null when Auth0 owns the user's password (the new
    # default once Auth0 is configured): the user picks one themselves
    # via the invitation link, so the admin never sees it.
    temporary_password: Optional[str] = None
    verification_email_sent: bool = False


class UserSummaryResponse(BaseModel):
    id: int
    # Plain str (not EmailStr) so synthetic `@local.invalid` placeholder emails
    # for users without a real address round-trip on the response instead of
    # 500-ing serialization. Mirrors the UserBase decision. Input paths validate.
    email: str
    username: str
    full_name: str
    title: Optional[str] = None
    department: Optional[str] = None
    role: UserRole
    is_active: bool
    has_changed_password: bool
    email_verified: bool = False
    can_review: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class UserProfileResponse(BaseModel):
    id: int
    # Plain str so `@local.invalid` placeholder emails round-trip (see
    # UserSummaryResponse / UserBase). Input paths still validate via EmailStr.
    email: str
    username: str
    full_name: str
    title: Optional[str] = None
    department: Optional[str] = None
    timezone: Optional[str] = None
    role: UserRole
    # Back-compat single-manager fields (primary manager). Prefer `managers`.
    manager_id: Optional[int] = None
    manager_name: Optional[str] = None
    # All immediate managers this user reports to (primary first). Multi-manager.
    managers: List[UserSummaryResponse] = Field(default_factory=list)
    direct_reports: List[UserSummaryResponse] = Field(default_factory=list)
    supervisor_chain: List[UserSummaryResponse] = Field(default_factory=list)

    model_config = {"from_attributes": True}


class UserPreferences(BaseModel):
    """Per-user UI preferences. All fields optional; absent = default.

    Known keys are declared here for documentation and IDE help, but
    ``extra: "allow"`` keeps the schema forward-compatible — adding a
    new UI preference shouldn't require a schema migration.
    """
    # "cards" or "table". Persisted so the inbox view choice follows the
    # user across browsers and devices.
    inbox_view_mode: Optional[str] = None
    # ISO-2 country code (or None for "All locations"). Drives the
    # calendar's holiday filter — see HolidayCountryFilter.
    holiday_calendar_country: Optional[str] = None
    # UI defaults seeded from the tenant's customization settings on first
    # login; once the user changes one, the saved value wins. theme:
    # light/dark/system; palette: theme variant key or ""; landing: route
    # slug; page_size: rows per list page.
    theme: Optional[str] = None
    palette: Optional[str] = None
    landing: Optional[str] = None
    page_size: Optional[int] = None

    model_config = {"extra": "allow"}


class UserPreferencesUpdate(BaseModel):
    """Partial update for /users/me/preferences. Only sent keys are
    merged into ``users.preferences``. ``extra: "allow"`` lets new UI
    preferences flow through without a schema bump; the API handler
    still value-validates the known keys."""
    inbox_view_mode: Optional[str] = None
    holiday_calendar_country: Optional[str] = None
    theme: Optional[str] = None
    palette: Optional[str] = None
    landing: Optional[str] = None
    page_size: Optional[int] = None

    model_config = {"extra": "allow"}


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=8)


class AdminPasswordResetRequest(BaseModel):
    new_password: str = Field(..., min_length=8)


class MessageResponse(BaseModel):
    message: str


# ============================================================================
# Client Schemas
# ============================================================================

_CLIENT_TYPES = ("internal", "external")
_CLIENT_STATUSES = ("active", "prospect", "on_hold", "churned")


def _check_in(value, allowed, field):
    if value is not None and value not in allowed:
        raise ValueError(f"Invalid {field}: {value!r}. Allowed: {', '.join(allowed)}")
    return value


class ClientBase(BaseModel):
    name: str
    client_type: str = "external"
    status: str = "active"
    company: Optional[str] = None
    since: Optional[date] = None
    quickbooks_customer_id: Optional[str] = None
    contact_name: Optional[str] = None
    contact_email: Optional[EmailStr] = None
    contact_phone: Optional[str] = None
    client_self_manage_enabled: bool = False

    @field_validator("client_type")
    @classmethod
    def _valid_client_type(cls, v):
        return _check_in(v, _CLIENT_TYPES, "client_type")

    @field_validator("status")
    @classmethod
    def _valid_client_status(cls, v):
        return _check_in(v, _CLIENT_STATUSES, "client status")


class ClientCreate(ClientBase):
    pass


class ClientUpdate(BaseModel):
    name: Optional[str] = None
    client_type: Optional[str] = None
    status: Optional[str] = None
    company: Optional[str] = None
    since: Optional[date] = None
    quickbooks_customer_id: Optional[str] = None
    contact_name: Optional[str] = None
    contact_email: Optional[EmailStr] = None
    contact_phone: Optional[str] = None
    client_self_manage_enabled: Optional[bool] = None

    @field_validator("client_type")
    @classmethod
    def _valid_client_type(cls, v):
        return _check_in(v, _CLIENT_TYPES, "client_type")

    @field_validator("status")
    @classmethod
    def _valid_client_status(cls, v):
        return _check_in(v, _CLIENT_STATUSES, "client status")


class ClientResponse(ClientBase):
    id: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class UserClientAssignmentResponse(BaseModel):
    id: int
    client_id: int
    client_name: str
    client_type: str
    assignment_role: str = "member"

    model_config = {"from_attributes": True}


# A member of a client's team (for the client team roster).
class ClientTeamMember(BaseModel):
    user_id: int
    full_name: str
    role: str  # the user's org role (e.g. MANAGER / EMPLOYEE)
    assignment_role: str  # 'pm' | 'member' on this client

    model_config = {"from_attributes": True}


# ============================================================================
# Contract Schemas
# ============================================================================

class ContractBase(BaseModel):
    title: str
    kind: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    value: Optional[Decimal] = None
    status: str = "draft"


class ContractCreate(ContractBase):
    pass


class ContractUpdate(BaseModel):
    title: Optional[str] = None
    kind: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    value: Optional[Decimal] = None
    status: Optional[str] = None


class ContractResponse(ContractBase):
    id: int
    client_id: int
    document_name: Optional[str] = None
    document_size: Optional[int] = None
    has_document: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ============================================================================
# Client Contact / Role-rate / Note Schemas (Phase C)
# ============================================================================

class ContactChannel(BaseModel):
    label: Optional[str] = None
    # one of these is set depending on emails vs phones
    address: Optional[str] = None
    number: Optional[str] = None


class ClientContactBase(BaseModel):
    name: str
    role: Optional[str] = None
    emails: list[dict] = []
    phones: list[dict] = []
    is_primary: bool = False


class ClientContactCreate(ClientContactBase):
    pass


class ClientContactUpdate(BaseModel):
    name: Optional[str] = None
    role: Optional[str] = None
    emails: Optional[list[dict]] = None
    phones: Optional[list[dict]] = None
    is_primary: Optional[bool] = None


class ClientContactResponse(ClientContactBase):
    id: int
    client_id: int
    model_config = {"from_attributes": True}


class ClientRoleRateBase(BaseModel):
    role: str
    rate: Decimal
    currency: str = "USD"
    effective_date: Optional[date] = None


class ClientRoleRateCreate(ClientRoleRateBase):
    pass


class ClientRoleRateUpdate(BaseModel):
    role: Optional[str] = None
    rate: Optional[Decimal] = None
    currency: Optional[str] = None
    effective_date: Optional[date] = None


class ClientRoleRateResponse(ClientRoleRateBase):
    id: int
    client_id: int
    model_config = {"from_attributes": True}


class ClientNoteCreate(BaseModel):
    # `author` is intentionally NOT accepted — it's stamped server-side from the
    # logged-in user so a note can't claim someone else's name.
    body: str
    note_date: Optional[date] = None
    # Optional target. When task_id is set, task_status sets the task's status;
    # only when that status is 'blocked' does the note body become the task's
    # blocked_reason. task_status is transient (not stored on the note).
    project_id: Optional[int] = None
    task_id: Optional[int] = None
    task_status: Optional[str] = None


class ClientNoteUpdate(BaseModel):
    # Author is immutable after creation; only the content/date can be edited.
    body: Optional[str] = None
    note_date: Optional[date] = None
    project_id: Optional[int] = None
    task_id: Optional[int] = None
    task_status: Optional[str] = None


class ClientNoteResponse(BaseModel):
    id: int
    client_id: int
    # Server-stamped display name + the provable author link.
    author: Optional[str] = None
    author_user_id: Optional[int] = None
    body: str
    note_date: Optional[date] = None
    project_id: Optional[int] = None
    task_id: Optional[int] = None
    # Denormalized display labels for the note card + search (resolved server-side
    # from the linked project/task so the frontend needn't join).
    project_name: Optional[str] = None
    project_code: Optional[str] = None
    task_name: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    model_config = {"from_attributes": True}


# ============================================================================
# Project Schemas
# ============================================================================

_PROJECT_STATUSES = ("planning", "in_progress", "on_hold", "completed")
_TASK_STATUSES = ("to_do", "in_progress", "blocked", "done")


def _check_status(value, allowed, field):
    if value is not None and value not in allowed:
        raise ValueError(f"Invalid {field}: {value!r}. Allowed: {', '.join(allowed)}")
    return value


class ProjectBase(BaseModel):
    name: str
    client_id: int
    billable_rate: Decimal
    quickbooks_project_id: Optional[str] = None
    code: Optional[str] = None
    description: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    estimated_hours: Optional[Decimal] = None
    budget_amount: Optional[Decimal] = None
    currency: Optional[str] = None
    revenue_recognition: str = "as_billed"  # as_billed | percent_complete
    is_active: bool = True
    status: str = "planning"
    manager_id: Optional[int] = None
    # The contract (MSA/SOW) this project is delivered under, if any.
    contract_id: Optional[int] = None

    @field_validator("status")
    @classmethod
    def _valid_status(cls, v):
        return _check_status(v, _PROJECT_STATUSES, "project status")

    @field_validator("revenue_recognition")
    @classmethod
    def _valid_revrec(cls, v):
        if v not in ("as_billed", "percent_complete"):
            raise ValueError("revenue_recognition must be 'as_billed' or 'percent_complete'")
        return v


class ProjectCreate(ProjectBase):
    # Optional team roster on create (user ids); reconciled into user_project_access.
    resource_ids: Optional[List[int]] = None
    # Project managers (user ids). A project can have multiple PMs.
    manager_ids: Optional[List[int]] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    client_id: Optional[int] = None
    billable_rate: Optional[Decimal] = None
    quickbooks_project_id: Optional[str] = None
    code: Optional[str] = None
    description: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    estimated_hours: Optional[Decimal] = None
    budget_amount: Optional[Decimal] = None
    currency: Optional[str] = None
    revenue_recognition: Optional[str] = None
    is_active: Optional[bool] = None
    status: Optional[str] = None
    manager_id: Optional[int] = None
    contract_id: Optional[int] = None
    # When provided, replaces the project roster (user_project_access).
    resource_ids: Optional[List[int]] = None
    # When provided, replaces the project's managers.
    manager_ids: Optional[List[int]] = None

    @field_validator("status")
    @classmethod
    def _valid_status(cls, v):
        return _check_status(v, _PROJECT_STATUSES, "project status")


class ProjectResponse(ProjectBase):
    id: int
    created_at: datetime
    updated_at: datetime
    # Current team roster (user ids), from user_project_access.
    resource_ids: List[int] = []
    # Current project managers (user ids), from project_managers.
    manager_ids: List[int] = []

    model_config = {"from_attributes": True}


class ProjectWithClient(ProjectResponse):
    client: ClientResponse


class TaskBase(BaseModel):
    project_id: int
    name: str
    code: Optional[str] = None
    description: Optional[str] = None
    is_active: bool = True
    priority: str = "medium"
    status: str = "to_do"
    # Phase 2 causal-data fields. All optional/additive — a task created without
    # them has no estimate, no dates, and no blocker (treated as "unknown").
    estimated_hours: Optional[Decimal] = Field(default=None, ge=0)
    start_date: Optional[date] = None
    due_date: Optional[date] = None
    blocked_reason: Optional[str] = None

    @field_validator("status")
    @classmethod
    def _valid_status(cls, v):
        return _check_status(v, _TASK_STATUSES, "task status")


class TaskCreate(TaskBase):
    assignee_ids: Optional[List[int]] = None


class TaskUpdate(BaseModel):
    project_id: Optional[int] = None
    name: Optional[str] = None
    code: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None
    priority: Optional[str] = None
    status: Optional[str] = None
    estimated_hours: Optional[Decimal] = Field(default=None, ge=0)
    start_date: Optional[date] = None
    due_date: Optional[date] = None
    blocked_reason: Optional[str] = None
    # When provided, replaces the task's assignees.
    assignee_ids: Optional[List[int]] = None

    @field_validator("status")
    @classmethod
    def _valid_status(cls, v):
        return _check_status(v, _TASK_STATUSES, "task status")


class ClientAssigneeInfo(BaseModel):
    """A client employee assigned to a task (via a client access grant). Surfaced
    to the internal side so we can see which client person works on which task."""
    user_id: int
    full_name: str


class TaskResponse(TaskBase):
    id: int
    created_at: datetime
    updated_at: datetime
    assignee_ids: List[int] = []
    # Client employees assigned to this task (read-only context for our side).
    client_assignees: List[ClientAssigneeInfo] = []

    model_config = {"from_attributes": True}


class TaskWithProject(TaskResponse):
    project: ProjectResponse


# ── Task dependencies (Phase 2, part 4) ──────────────────────────────────────
class TaskDependencyCreate(BaseModel):
    """Create an edge: ``task_id`` depends on ``depends_on_task_id`` (the latter
    blocks the former). Both tasks must be in the same project; cycles rejected."""
    task_id: int
    depends_on_task_id: int
    reason: Optional[str] = None


class TaskDependencyResponse(BaseModel):
    id: int
    task_id: int
    depends_on_task_id: int
    reason: Optional[str] = None
    # Convenience labels so the UI/health "why" can render names without an extra
    # round-trip. Populated server-side; null only when a name lookup misses.
    task_name: Optional[str] = None
    depends_on_task_name: Optional[str] = None

    model_config = {"from_attributes": True}


# ============================================================================
# TimeEntry Schemas
# ============================================================================

def _validate_time_block(start, end):
    """When both a start and end time are given, the block must be forward
    (end strictly after start). ``hours`` stays the billing source of truth,
    so we don't force span==hours, but a reversed/zero block is always wrong."""
    if start is not None and end is not None and end <= start:
        raise ValueError("end_time must be after start_time")


class TimeEntryBase(BaseModel):
    project_id: int
    task_id: Optional[int] = None
    entry_date: date
    # Optional explicit time block (24h ``HH:MM:SS`` over the wire).
    # Both nullable: an entry can be hours-only OR a precise block.
    # ``hours`` is still the source of truth for billing.
    start_time: Optional[time] = None
    end_time: Optional[time] = None
    hours: Decimal = Field(..., gt=0, le=24)
    description: str
    # Private free-text notes for the entry owner. Never surfaced in approval
    # queues, exports, or client-facing views.
    notes: Optional[str] = None
    is_billable: bool = True


class TimeEntryCreate(TimeEntryBase):
    # Write-time validation only. The check lives here (not on TimeEntryBase) so
    # TimeEntryResponse, which also inherits the base, serializes already-stored
    # rows faithfully. A legacy/odd row with a reversed time block must still be
    # readable in approval queues; rejecting it on the response path would 500
    # the whole list for one bad row.
    @model_validator(mode="after")
    def _check_time_block(self):
        _validate_time_block(self.start_time, self.end_time)
        return self


class TimeEntryUpdate(BaseModel):
    project_id: Optional[int] = None
    task_id: Optional[int] = None
    entry_date: Optional[date] = None
    start_time: Optional[time] = None
    end_time: Optional[time] = None
    hours: Optional[Decimal] = Field(None, gt=0, le=24)
    description: Optional[str] = None
    notes: Optional[str] = None
    is_billable: Optional[bool] = None
    edit_reason: Optional[str] = Field(None, max_length=2000)
    history_summary: Optional[str] = Field(None, max_length=2000)

    @model_validator(mode="after")
    def _check_time_block(self):
        _validate_time_block(self.start_time, self.end_time)
        return self


class TimeEntryResponse(TimeEntryBase):
    id: int
    user_id: int
    status: TimeEntryStatus
    submitted_at: Optional[datetime] = None
    approved_by: Optional[int] = None
    approved_by_name: Optional[str] = None
    created_by: Optional[int] = None
    updated_by: Optional[int] = None
    approved_at: Optional[datetime] = None
    rejection_reason: Optional[str] = None
    quickbooks_time_activity_id: Optional[str] = None
    # Link back to the originating inbox-approved IngestionTimesheet
    # when this entry was materialised from a PDF submission. Lets
    # the frontend show the Client name instead of an internal
    # project label on rollup surfaces. Null for entries created
    # directly via the web form.
    ingestion_timesheet_id: Optional[str] = None
    last_edit_reason: Optional[str] = None
    last_history_summary: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class TimeEntryWithUser(TimeEntryResponse):
    user: UserSummaryResponse
    project: ProjectResponse
    task: Optional[TaskResponse] = None


class TimeEntrySubmitRequest(BaseModel):
    entry_ids: list[int]
    # Multi-manager routing: when the employee has several managers, the manager
    # these entries are being submitted to for approval. Ignored unless the
    # approval_by_assigned_manager setting is on. None = any of their managers.
    approver_manager_id: Optional[int] = None


class WeeklySubmissionStatusResponse(BaseModel):
    can_submit: bool
    reason: Optional[str] = None
    due_date: date


class TimeEntryApproveRequest(BaseModel):
    pass


class TimeEntryRejectRequest(BaseModel):
    rejection_reason: str = Field(..., min_length=1, max_length=1000)


class TimeEntryBatchApproveRequest(BaseModel):
    entry_ids: list[int]


class TimeEntryBatchRejectRequest(BaseModel):
    entry_ids: list[int]
    rejection_reason: str = Field(..., min_length=1, max_length=1000)


# ============================================================================
# TimeOff Schemas
# ============================================================================

class TimeOffRequestBase(BaseModel):
    request_date: date
    hours: Decimal = Field(..., gt=0, le=24)
    leave_type: str = Field(min_length=1, max_length=50)
    reason: str


class TimeOffRequestCreate(TimeOffRequestBase):
    pass


class TimeOffRequestUpdate(BaseModel):
    request_date: Optional[date] = None
    hours: Optional[Decimal] = Field(None, gt=0, le=24)
    leave_type: Optional[str] = Field(None, min_length=1, max_length=50)
    reason: Optional[str] = None


class TimeOffUsageSummaryRow(BaseModel):
    """One row per leave type for the caller's dashboard widget.
    ``hours_taken`` is the source of truth; ``days_taken`` is the
    widget's display value (hours / 8).
    """
    leave_type: str
    label: str
    color: str
    hours_taken: float
    days_taken: float


class LeaveTypeCreate(BaseModel):
    code: Optional[str] = Field(None, min_length=1, max_length=50)
    label: str = Field(min_length=1, max_length=100)
    color: Optional[str] = Field(default="#6b7280", max_length=20)


class LeaveTypeUpdate(BaseModel):
    label: Optional[str] = Field(None, min_length=1, max_length=100)
    color: Optional[str] = Field(None, max_length=20)
    is_active: Optional[bool] = None


class LeaveTypeResponse(BaseModel):
    id: int
    tenant_id: int
    code: str
    label: str
    color: str
    is_active: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ── Holidays ────────────────────────────────────────────────
# Org-wide non-working days. PUBLIC (statutory) and COMPANY
# (org-defined) both excuse a working day for the late signal.


class HolidayTypeEnum(str, Enum):
    PUBLIC = "PUBLIC"
    COMPANY = "COMPANY"


class HolidayCreate(BaseModel):
    date: date
    name: str = Field(min_length=1, max_length=120)
    holiday_type: HolidayTypeEnum = HolidayTypeEnum.COMPANY
    country: Optional[str] = Field(None, min_length=2, max_length=2)


class HolidayBulkCreate(BaseModel):
    """Used by the public-holiday import flow — ``python-holidays``
    returns multiple rows for a given country/year, and we want to
    create them in a single transaction."""
    holidays: list[HolidayCreate]


class HolidayUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    holiday_type: Optional[HolidayTypeEnum] = None


class HolidayResponse(BaseModel):
    id: int
    tenant_id: int
    date: date
    name: str
    holiday_type: HolidayTypeEnum
    country: Optional[str]
    created_by: Optional[int]
    created_at: datetime

    model_config = {"from_attributes": True}


class HolidaySuggestion(BaseModel):
    """A single public-holiday returned by the import endpoint.
    Not persisted yet — the admin picks which ones to add."""
    date: date
    name: str
    country: str


class HolidaySuggestionsResponse(BaseModel):
    country: str
    year: int
    holidays: list[HolidaySuggestion]


class TimeOffRequestResponse(TimeOffRequestBase):
    id: int
    user_id: int
    status: TimeOffStatus
    submitted_at: Optional[datetime] = None
    approved_by: Optional[int] = None
    created_by: Optional[int] = None
    updated_by: Optional[int] = None
    approved_at: Optional[datetime] = None
    rejection_reason: Optional[str] = None
    external_reference: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class TimeOffRequestWithUser(TimeOffRequestResponse):
    user: UserSummaryResponse


class TimeOffSubmitRequest(BaseModel):
    request_ids: list[int]


class TimeOffApproveRequest(BaseModel):
    pass


class TimeOffRejectRequest(BaseModel):
    rejection_reason: str = Field(..., min_length=1, max_length=1000)


# ============================================================================
# Dashboard Schemas
# ============================================================================

class DashboardSummaryResponse(BaseModel):
    hours_logged: Decimal
    approved_hours: Decimal
    pending_hours: Decimal
    pending_approvals: int
    team_members: int


class DashboardDayBreakdown(BaseModel):
    entry_date: date
    hours: Decimal
    formatted_date: str


class DashboardBarEntryDetail(BaseModel):
    entry_id: int
    project_id: int
    project_name: str
    client_name: str
    status: TimeEntryStatus
    description: str
    hours: Decimal
    entry_date: date


class DashboardDayProjectSegment(BaseModel):
    project_id: int
    project_name: str
    client_name: str
    hours: Decimal
    entries: list[DashboardBarEntryDetail]


class DashboardDayBreakdownDetailed(DashboardDayBreakdown):
    segments: list[DashboardDayProjectSegment] = []


class DashboardProjectBreakdown(BaseModel):
    project_id: int
    project_name: str
    client_name: str
    hours: Decimal
    percentage: float


class DashboardActivity(BaseModel):
    description: str
    project_name: str
    hours: Decimal


class DashboardAnalyticsResponse(BaseModel):
    total_hours: Decimal
    billable_hours: Decimal
    non_billable_hours: Decimal
    top_project_name: Optional[str]
    top_client_name: Optional[str]
    daily_breakdown: list[DashboardDayBreakdownDetailed]
    project_breakdown: list[DashboardProjectBreakdown]
    top_activities: list[DashboardActivity]


class DashboardRecentActivityItem(BaseModel):
    id: int
    activity_type: str
    entity_type: str
    entity_id: Optional[int] = None
    actor_id: Optional[int] = None
    actor_name: Optional[str] = None
    summary: str
    route: str
    route_params: Optional[dict[str, Any]] = None
    metadata: Optional[dict[str, Any]] = None
    severity: str = "info"
    created_at: datetime

    model_config = {"from_attributes": True}


class TeamDailyOverviewResponse(BaseModel):
    date: date
    submission_deadline_at: datetime
    has_time_remaining_until_deadline: bool
    team_size: int
    submitted_yesterday_count: int
    submitted_yesterday: list[UserSummaryResponse]
    draft_yesterday_count: int
    draft_yesterday: list[UserSummaryResponse]
    missing_yesterday_count: int
    missing_yesterday: list[UserSummaryResponse]
    pending_approvals_count: int
    pending_time_entries_count: int
    pending_time_off_count: int
    total_hours_logged_yesterday: Decimal


# ============================================================================
# Manager Team Overview (week-to-date roster + capacity)
# ============================================================================

class ManagerTeamMemberStatus(BaseModel):
    """Per-employee week-to-date submission status for the roster grid.

    `working_days_in_week` is the count of weekdays (Mon-Fri) up to and
    including today. `submitted_days` is how many of those days the
    employee already has a SUBMITTED or APPROVED time entry on (drives the
    on-track / behind status). `logged_days` additionally counts DRAFT days
    (any entry the employee has started), so the roster shows real in-progress
    activity ("4/5 days logged") while the STATUS still reflects what's
    actually been submitted for review.
    """

    user_id: int
    full_name: str
    working_days_in_week: int
    submitted_days: int
    # Days with ANY entry (DRAFT + SUBMITTED + APPROVED). Drives the "X/5 days
    # logged" display; submitted_days still drives the status label. Defaults to
    # submitted_days for back-compat if an older API omits it.
    logged_days: int = 0
    is_on_pto_today: bool
    is_on_pto_this_week: bool
    upcoming_pto_starts_at: Optional[date] = None
    # Pattern badge: did this employee miss the deadline at least 2 of
    # the last 3 working days? Surfaced as a "repeatedly late" badge in
    # the roster so the manager can act on patterns, not one-offs.
    is_repeatedly_late: bool


class ManagerTeamCapacityEntry(BaseModel):
    """One row per active PTO occurrence within the lookahead window."""

    user_id: int
    full_name: str
    leave_type: str
    days_in_window: int


class ManagerTeamOverviewResponse(BaseModel):
    week_start: date
    week_end: date
    today: date
    team_size: int
    members: list[ManagerTeamMemberStatus]
    pending_approvals_count: int
    pending_time_off_count: int
    rejected_recent_count: int
    # Hours-old of the oldest pending approval. Surfaced as the "Avg
    # approval age" / "oldest" tile on the dashboard. None when the
    # queue is empty.
    pending_approvals_oldest_hours: Optional[int] = None
    pending_approvals_avg_hours: Optional[int] = None
    capacity_this_week: list[ManagerTeamCapacityEntry]
    capacity_next_week: list[ManagerTeamCapacityEntry]


class ManagerProjectHealthRow(BaseModel):
    """Per-project row for the manager dashboard project-health table.

    Only includes projects that have time entries from the manager's
    scoped team within the last lookback window. We don't list every
    project in the tenant; that would be noise.
    """

    project_id: int
    project_name: str
    # Project code (e.g. PR0007) and lifecycle status — extra metadata the
    # dashboard widget search can match on.
    code: Optional[str] = None
    status: Optional[str] = None
    client_id: Optional[int] = None
    client_name: str
    # Days remaining until end_date. Negative when overdue. None when
    # the project has no end_date set ("Open").
    days_until_end: Optional[int]
    hours_this_week: Decimal
    # Budget consumed as percentage. None when no estimated_hours set.
    budget_pct: Optional[int]
    # Hours remaining against the budget. Negative when over.
    budget_hours_remaining: Optional[Decimal]
    # 'excellent'|'on-track'|'at-risk'|'critical'|'blocked'|'not-set'|'not-started'
    health: str
    # Plain-language explanation of the health state (for the pill tooltip).
    health_reason: Optional[str] = None


class ManagerProjectHealthResponse(BaseModel):
    rows: list[ManagerProjectHealthRow]


class ProjectFinancialRow(BaseModel):
    """Per-project financials computed from REAL approved time + resolved rates."""
    project_id: int
    project_name: str
    client_id: Optional[int] = None
    client_name: str
    currency: str = "USD"
    approved_hours: Decimal = Decimal("0")
    # Logged hours = submitted (awaiting approval) + approved. Lets the UI derive
    # pending-approval hours (logged - approved) without a second query.
    logged_hours: Decimal = Decimal("0")
    billable_hours: Decimal = Decimal("0")
    revenue: Decimal = Decimal("0")          # sum(hours x billed rate)
    # PSA margin: cost = sum(hours x cost rate, all hours); margin = revenue-cost.
    cost: Decimal = Decimal("0")
    margin: Decimal = Decimal("0")
    margin_pct: Optional[int] = None          # margin / revenue
    budget_amount: Optional[Decimal] = None
    budget_used_pct: Optional[int] = None     # revenue / budget
    budget_remaining: Optional[Decimal] = None
    contract_id: Optional[int] = None
    contract_title: Optional[str] = None
    contract_value: Optional[Decimal] = None
    contract_used_pct: Optional[int] = None


class FinancialSummary(BaseModel):
    total_revenue: Decimal = Decimal("0")
    total_budget: Decimal = Decimal("0")
    total_approved_hours: Decimal = Decimal("0")
    billable_hours: Decimal = Decimal("0")
    nonbillable_hours: Decimal = Decimal("0")
    utilization_pct: Optional[int] = None     # billable / total hours
    total_cost: Decimal = Decimal("0")
    total_margin: Decimal = Decimal("0")
    total_margin_pct: Optional[int] = None
    currency: str = "USD"


# ── Configurable Insights dashboards ─────────────────────────────────────────
# `layout` is an opaque list of widget instances owned by the frontend:
#   [{ "id", "type", "x", "y", "w", "h", "title"?, "config"? }]

class CustomDashboardCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    is_shared: bool = False
    layout: Optional[List[dict[str, Any]]] = None


class CustomDashboardUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    is_shared: Optional[bool] = None
    layout: Optional[List[dict[str, Any]]] = None


class CustomDashboardResponse(BaseModel):
    id: int
    name: str
    is_shared: bool
    owner_user_id: Optional[int] = None
    owner_name: Optional[str] = None
    is_owner: bool = False
    layout: List[dict[str, Any]] = Field(default_factory=list)
    # Public-share state (owner-facing). share_token is None when not published.
    share_token: Optional[str] = None
    share_mode: str = "live"
    share_snapshot_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    model_config = {"from_attributes": True}


class DashboardShareRequest(BaseModel):
    """Publish (or re-publish) a dashboard behind a public no-login link."""
    mode: str = Field("live", pattern="^(live|snapshot)$")


class DashboardShareResponse(BaseModel):
    share_token: str
    share_mode: str
    share_snapshot_at: Optional[datetime] = None


class PublicDashboardResponse(BaseModel):
    """What an unauthenticated viewer of a shared dashboard sees."""
    name: str
    layout: List[dict[str, Any]] = Field(default_factory=list)
    owner_name: Optional[str] = None
    mode: str = "live"
    # Shared metric bundles the widgets read from (portfolio, financials, evm,
    # revrec, resourcing, on-time). Mirrors what the live metric endpoints return.
    data: dict[str, Any] = Field(default_factory=dict)
    captured_at: Optional[datetime] = None


# ── Resourcing: per-employee detail (slide-over panel) ───────────────────────
class ResourceTaskRow(BaseModel):
    task_id: Optional[int] = None
    task_name: str
    project_id: int
    project_name: str
    client_name: Optional[str] = None
    hours: Decimal = Decimal("0")        # approved hours on this task
    assigned: bool = False               # is the person a TaskAssignee?


class ResourceProjectRow(BaseModel):
    project_id: int
    project_name: str
    client_name: Optional[str] = None
    hours: Decimal = Decimal("0")
    billable_hours: Decimal = Decimal("0")
    billed: Decimal = Decimal("0")
    # Approved hours on this project NOT logged against any task (so per-task +
    # untasked reconciles with the project total).
    untasked_hours: Decimal = Decimal("0")
    # Planned forward allocation on this project (% of weekly capacity). None
    # when the project has logged time but no current allocation. A project may
    # appear with planned_pct set and hours=0 (booked but not yet worked).
    planned_pct: Optional[int] = None


class ResourceDetailResponse(BaseModel):
    user_id: int
    full_name: str
    title: Optional[str] = None
    cost_rate: Optional[Decimal] = None
    # Totals across the window.
    submitted_hours: Decimal = Decimal("0")
    approved_hours: Decimal = Decimal("0")
    billable_hours: Decimal = Decimal("0")
    billed: Decimal = Decimal("0")       # approved billable × rate
    cost: Decimal = Decimal("0")         # approved hours × cost rate
    days_back: int = 90
    # Forward capacity (matches the resourcing row): total planned allocation %,
    # the bucket, and a plain-English explanation of why.
    allocated_pct: int = 0
    capacity_state: str = "ok"           # 'over' | 'ok' | 'under'
    capacity_summary: str = ""
    projects: List[ResourceProjectRow] = Field(default_factory=list)
    tasks: List[ResourceTaskRow] = Field(default_factory=list)


# ── Dashboard widget scope options (the pickers in the widget config) ─────────
class ScopeClientOption(BaseModel):
    id: int
    name: str


class ScopeProjectOption(BaseModel):
    id: int
    name: str
    client_id: Optional[int] = None


class ScopeTaskOption(BaseModel):
    id: int
    title: str
    project_id: int


class ScopePersonOption(BaseModel):
    id: int
    name: str


class DashboardScopeOptions(BaseModel):
    """Everything the caller may scope a widget to, access-checked server-side."""
    clients: List[ScopeClientOption] = Field(default_factory=list)
    projects: List[ScopeProjectOption] = Field(default_factory=list)
    tasks: List[ScopeTaskOption] = Field(default_factory=list)
    people: List[ScopePersonOption] = Field(default_factory=list)


class ResourcingAllocRow(BaseModel):
    project_id: int
    project_name: str
    percent: int
    start_date: str
    end_date: str


class ResourcingRow(BaseModel):
    user_id: int
    full_name: str
    title: Optional[str] = None
    capacity_hours: Decimal = Decimal("40")
    allocated_pct: int = 0
    state: str = "ok"  # over | ok | under
    allocations: list[ResourcingAllocRow] = []


class TeamResourcingResponse(BaseModel):
    weeks_ahead: int
    team_size: int
    over_allocated: int
    under_utilized: int
    rows: list[ResourcingRow] = []


class PortfolioRow(BaseModel):
    project_id: int
    project_name: str
    client_id: Optional[int] = None
    client_name: str
    health: str  # excellent | on-track | at-risk | critical | blocked | not-set
    health_reason: Optional[str] = None
    approved_hours: Decimal = Decimal("0")
    revenue: Decimal = Decimal("0")
    cost: Decimal = Decimal("0")
    margin: Decimal = Decimal("0")
    margin_pct: Optional[int] = None
    budget_amount: Optional[Decimal] = None
    budget_used_pct: Optional[int] = None
    days_until_end: Optional[int] = None
    currency: str = "USD"


class PortfolioResponse(BaseModel):
    project_count: int
    # Five-tier health counts (see _classify_health). 'blocked' is auto-derived
    # from tasks; 'not_set' = no budget & no end date.
    excellent: int = 0
    on_track: int = 0
    at_risk: int = 0
    critical: int = 0
    blocked: int = 0
    not_set: int = 0
    total_revenue: Decimal = Decimal("0")
    total_cost: Decimal = Decimal("0")
    total_margin_pct: Optional[int] = None
    rows: list[PortfolioRow] = []


class EvmRow(BaseModel):
    project_id: int
    project_name: str
    client_name: str
    bac: Decimal = Decimal("0")   # budget at completion (planned cost)
    pv: Decimal = Decimal("0")    # planned value
    ev: Decimal = Decimal("0")    # earned value
    ac: Decimal = Decimal("0")    # actual cost
    cpi: Optional[float] = None   # EV/AC
    spi: Optional[float] = None   # EV/PV
    cost_variance: Decimal = Decimal("0")      # EV-AC
    schedule_variance: Decimal = Decimal("0")  # EV-PV
    percent_complete: int = 0
    # Forecast (predictive): EAC = projected total cost; VAC = BAC-EAC (negative
    # = overrun); projected_overrun_pct; risk = low|medium|high.
    eac: Decimal = Decimal("0")
    vac: Decimal = Decimal("0")
    projected_overrun_pct: int = 0
    risk: str = "low"
    currency: str = "USD"


class EvmResponse(BaseModel):
    rows: list[EvmRow] = []


class RevRecRow(BaseModel):
    project_id: int
    project_name: str
    client_name: str
    method: str  # as_billed | percent_complete
    billed: Decimal = Decimal("0")       # what was billed (hours x rate)
    recognized: Decimal = Decimal("0")   # recognized per the method
    percent_complete: Optional[int] = None
    currency: str = "USD"


class RevRecResponse(BaseModel):
    total_billed: Decimal = Decimal("0")
    total_recognized: Decimal = Decimal("0")
    rows: list[RevRecRow] = []


class ManagerFinancialsResponse(BaseModel):
    summary: FinancialSummary
    projects: list[ProjectFinancialRow]


# ── Configurable project-health thresholds ──────────────────────────────────
class HealthConfigBody(BaseModel):
    """The tunable rules behind the five-tier health pills (critical / blocked /
    at-risk / on-track / excellent). Used for both the workspace default and a
    per-manager override."""
    budget_enabled: bool = True
    over_budget_pct: float = Field(100, ge=0, le=1000)
    high_burn_pct: float = Field(80, ge=0, le=1000)
    # Budget burn below which a healthy project is "excellent" (vs "on-track").
    excellent_under_pct: float = Field(50, ge=0, le=1000)
    schedule_enabled: bool = True
    ending_soon_days: int = Field(7, ge=0, le=365)
    overdue_days: int = Field(30, ge=0, le=3650)
    margin_enabled: bool = False
    low_margin_pct: float = Field(15, ge=-100, le=100)


class HealthConfigResponse(BaseModel):
    """Both scopes plus which one is currently in effect for this manager."""
    workspace: HealthConfigBody
    override: Optional[HealthConfigBody] = None
    # 'override' if the manager has a personal config, else 'workspace'.
    effective_scope: str = "workspace"
    can_edit_workspace: bool = False


class ProjectHealthOverrideBody(BaseModel):
    """Set or clear one project's manual health override. ``health=None``
    clears (falls back to the auto-computed tier). Settable values are
    excellent | on-track | at-risk | critical (validated in the endpoint)."""
    health: Optional[str] = None


class ProjectHealthOverrideResponse(BaseModel):
    project_id: int
    health_override: Optional[str] = None


# ── Project report: task-level "why" breakdown (existing data only) ─────────
class TaskBreakdownTask(BaseModel):
    task_id: int
    name: str
    status: str                       # to_do | in_progress | blocked | done
    hours: Decimal = Decimal("0")     # approved hours logged
    cost: Decimal = Decimal("0")      # approved cost (hours × cost rate)
    revenue: Decimal = Decimal("0")   # approved billable revenue
    pct_of_hours: int = 0             # share of the project's logged hours
    assignees: list[str] = []         # names, for "who's carrying it"
    # Phase 2 causal fields. All Optional — None means "not captured" (unknown),
    # which the "why" logic must never treat as zero/overdue.
    estimated_hours: Optional[Decimal] = None
    due_date: Optional[date] = None
    blocked_reason: Optional[str] = None
    # Derived: hours over estimate and the overrun as a percentage. Only set when
    # the task has an estimate AND logged hours exceed it.
    over_estimate_hours: Optional[Decimal] = None
    over_estimate_pct: Optional[int] = None
    # Derived: days past due_date (>0 only when due_date is set and in the past).
    days_overdue: Optional[int] = None


class TaskBlockingEdge(BaseModel):
    """A blocking chain link for the health "why": blocker_name blocks task_name."""
    task_id: int
    task_name: str
    depends_on_task_id: int
    depends_on_task_name: str
    reason: Optional[str] = None
    # True when the blocker (predecessor) is not yet done — i.e. it really is
    # holding the dependent task right now.
    blocker_open: bool = True
    # True when the dependent task already has logged time / is in progress even
    # though its prerequisite isn't done. The UI uses this to avoid the false
    # "can't start" framing and instead flag work happening ahead of readiness.
    dependent_started: bool = False


class TaskBreakdownPerson(BaseModel):
    user_id: int
    full_name: str
    hours: Decimal = Decimal("0")
    pct_of_hours: int = 0


class ProjectTaskBreakdownResponse(BaseModel):
    project_id: int
    project_name: str
    total_tasks: int = 0
    done_tasks: int = 0
    open_tasks: int = 0               # not done (to_do + in_progress)
    total_hours: Decimal = Decimal("0")
    is_overdue: bool = False
    days_overdue: int = 0
    # Where the effort/money went — top tasks by hours (each carries cost too).
    top_tasks: list[TaskBreakdownTask] = []
    # Open work while the project is at/past its end date — what's holding completion.
    unfinished_at_deadline: list[TaskBreakdownTask] = []
    # to_do with zero logged hours — not started / candidate blockers.
    stalled_tasks: list[TaskBreakdownTask] = []
    # Who's carrying the project.
    by_person: list[TaskBreakdownPerson] = []
    # Phase 2 cause signals (each empty until the data is captured).
    # Tasks explicitly marked blocked (status == blocked), with their reason.
    blocked_tasks: list[TaskBreakdownTask] = []
    # Tasks whose logged hours exceeded their estimate.
    over_estimate_tasks: list[TaskBreakdownTask] = []
    # Open tasks past their own due_date (independent of the project end date).
    overdue_tasks: list[TaskBreakdownTask] = []
    # Blocking chains: an open predecessor holding a dependent task.
    blocking_chains: list[TaskBlockingEdge] = []
    # True once any task carries an estimate / due date / blocker — lets the UI
    # drop the "detail will appear once tasks capture …" footnote.
    has_causal_data: bool = False
    # Plain-language headline lines summarising the cause (data-derived, no fabrication).
    notes: list[str] = []


# ── Manager dashboard: clients + their projects ─────────────────────────────
class ManagerClientProject(BaseModel):
    project_id: int
    project_name: str
    status: Optional[str] = None


class ManagerClientRow(BaseModel):
    client_id: int
    client_name: str
    project_count: int
    projects: list[ManagerClientProject] = []


class ManagerClientsResponse(BaseModel):
    client_count: int
    rows: list[ManagerClientRow] = []


# ── Employee "My Work" (assigned projects/tasks by client) ──────────────────
class MyWorkTask(BaseModel):
    task_id: int
    name: str
    status: Optional[str] = None
    priority: Optional[str] = None
    description: Optional[str] = None
    # The caller is assigned to this task, so they can update its status /
    # description from My Work (scoped /tasks/{id}/progress endpoint).
    can_edit: bool = True


class MyWorkProject(BaseModel):
    project_id: int
    project_name: str
    code: Optional[str] = None
    status: Optional[str] = None
    my_hours: Decimal = Decimal("0")       # the user's logged hours on this project
    approved_hours: Decimal = Decimal("0")
    tasks: list[MyWorkTask] = Field(default_factory=list)  # tasks assigned to the user


class MyWorkClient(BaseModel):
    client_id: int
    client_name: str
    projects: list[MyWorkProject] = Field(default_factory=list)


class MyWorkResponse(BaseModel):
    clients: list[MyWorkClient] = Field(default_factory=list)
    total_projects: int = 0
    total_tasks: int = 0
    total_hours: Decimal = Decimal("0")


# ============================================================================
# Manager team-stats Schemas (non-PSA, computed from existing time entries)
# ============================================================================

class TeamRejectionReason(BaseModel):
    """A rejection reason and how often it occurred across the team window."""
    reason: str
    count: int


class TeamRejectionRow(BaseModel):
    """Per-employee rejection stats over the lookback window."""
    user_id: int
    full_name: str
    # Entries that reached a terminal decision (approved or rejected) in
    # the window. The denominator for the rate.
    decided_count: int
    rejected_count: int
    # rejected_count / decided_count as a 0-100 percentage. None when the
    # employee had no decided entries in the window (rate is undefined, not 0).
    rejection_rate_pct: Optional[int]


class TeamRejectionStatsResponse(BaseModel):
    days_back: int
    rows: list[TeamRejectionRow]
    # Top rejection reasons across the whole scoped team, most frequent first.
    top_reasons: list[TeamRejectionReason]
    team_rejection_rate_pct: Optional[int]


class TeamBillableRow(BaseModel):
    """Per-employee billable split over the lookback window (approved hours)."""
    user_id: int
    full_name: str
    approved_hours: Decimal
    billable_hours: Decimal
    # billable_hours / approved_hours as 0-100. None when the employee logged
    # no approved hours in the window (undefined, not 0).
    billable_pct: Optional[int]


class TeamBillableStatsResponse(BaseModel):
    days_back: int
    rows: list[TeamBillableRow]
    team_billable_pct: Optional[int]
    team_approved_hours: Decimal
    team_billable_hours: Decimal


class TeamOnTimeWeek(BaseModel):
    """One recent week's on-time outcome for an employee. ``status`` is
    'on_time' | 'late' | 'none' (no activity that week). ``week_start`` is the
    Monday (ISO date) so the frontend can label/tooltip the dot."""
    week_start: date
    status: str


class TeamOnTimeRow(BaseModel):
    """Per-employee on-time submission trend over the lookback window.

    Measured at weekly grain: a week counts if the employee logged any time in
    it; the week is "on time" if their last submission for that week happened on
    or before the week's submission deadline.
    """
    user_id: int
    full_name: str
    weeks_with_activity: int
    on_time_weeks: int
    # on_time_weeks / weeks_with_activity as 0-100. None when no activity weeks.
    on_time_pct: Optional[int]
    # Most-recent N weeks (oldest->newest) for a trend sparkline. Includes
    # no-activity weeks (status 'none') so the timeline reads continuously.
    recent_weeks: list[TeamOnTimeWeek] = Field(default_factory=list)


class TeamOnTimeStatsResponse(BaseModel):
    days_back: int
    rows: list[TeamOnTimeRow]
    team_on_time_pct: Optional[int]


class TeamProjectMatrixProject(BaseModel):
    """A project column in the team hours matrix."""
    project_id: int
    project_name: str
    client_name: str
    total_hours: Decimal


class TeamProjectMatrixCell(BaseModel):
    project_id: int
    hours: Decimal


class TeamProjectMatrixRow(BaseModel):
    """One employee row: their hours per project plus a row total."""
    user_id: int
    full_name: str
    # The person's title (= the client role-rate name their rate resolves
    # against). Shown next to their name so a manager sees role context inline.
    title: Optional[str] = None
    total_hours: Decimal
    # All-time billed revenue this person generated on the displayed projects
    # (approved billable hours x rate) — "budget consumed" in dollars.
    revenue: Decimal = Decimal("0")
    cells: list[TeamProjectMatrixCell]


class TeamProjectMatrixResponse(BaseModel):
    days_back: int
    # Approved hours only, to match the financial source-of-truth rule.
    projects: list[TeamProjectMatrixProject]
    rows: list[TeamProjectMatrixRow]
    grand_total_hours: Decimal


# ============================================================================
# Email Verification Schemas
# ============================================================================

class VerifyEmailRequest(BaseModel):
    token: str


class VerifyEmailResponse(BaseModel):
    message: str
    email: str


class ResendVerificationRequest(BaseModel):
    email: EmailStr


# ============================================================================
# Auth Schemas
# ============================================================================

class LoginRequest(BaseModel):
    """Login request body.

    Always ``(email, password)``. The backend tries Auth0 first when
    configured and falls back to the legacy bcrypt path if the user
    isn't in Auth0 yet, all transparent to the frontend.
    """
    email: EmailStr
    # Capped so a giant password value can't be sent to bcrypt (which only
    # uses the first 72 bytes anyway). Belt-and-suspenders with the body-size
    # middleware.
    password: str = Field(..., max_length=1024)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: Optional[str] = None
    token_type: str = "bearer"
    user: UserResponse
    # ISO timestamp of the user's previous login; the dashboard uses this
    # for the "N new since last login" chip on Recent Org Activity.
    previous_last_login_at: Optional[str] = None


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=8)


class PasswordChangeResponse(BaseModel):
    success: bool = True
    message: str = "Password changed successfully"


class RefreshRequest(BaseModel):
    # Optional because the refresh token now lives in the HttpOnly ``rt``
    # cookie (preferred path). The body field is the rollout fallback for
    # legacy clients that still have a refresh token in sessionStorage.
    # If we required it, a fresh client sending ``{}`` body (no legacy
    # token to include) would 422 BEFORE the route's cookie-fallback
    # logic could run — surfacing as a session loss to the user.
    refresh_token: str | None = None


class SetPasswordRequest(BaseModel):
    """Body for POST /auth/invitation/set-password."""
    token: str = Field(..., min_length=10)
    new_password: str = Field(..., min_length=8)


class SetPasswordResponse(BaseModel):
    """Response after a successful local password-set / reset."""
    success: bool = True
    # Plain str: echoes the stored user email, which may be a synthetic
    # `@local.invalid` placeholder (see UserBase). Don't 500 on round-trip.
    email: str
    purpose: str  # 'invite' or 'reset'


class InvitationStatusResponse(BaseModel):
    """Response for GET /auth/invitation/verify?token=... so the
    frontend can show the user's email and purpose without making
    them submit a password against a token that's already invalid."""
    valid: bool
    # Plain str so a placeholder email round-trips (see UserBase).
    email: Optional[str] = None
    purpose: Optional[str] = None
    reason: Optional[str] = None


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class RoleSwitchRequest(BaseModel):
    """Body for POST /auth/switch-role. The requested role must be in
    current_user.roles; the endpoint flips the active role and mints
    a fresh access + refresh pair."""
    role: UserRole


class RoleHandoffIssueResponse(BaseModel):
    """Response for POST /auth/role-handoff. Carries the short-lived
    JWT that the new tab passes to /auth/role-handoff/exchange to
    obtain its own session for the same user with the requested role
    active."""
    handoff_token: str
    target_role: UserRole


class RoleHandoffExchangeRequest(BaseModel):
    handoff_token: str


# ============================================================================
# Tenant Schemas
# ============================================================================

class TenantStatus(str, Enum):
    active = "active"
    inactive = "inactive"
    suspended = "suspended"


class TenantCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    slug: str = Field(..., min_length=1, max_length=100, pattern=r"^[a-z0-9-]+$")
    # When true, the API provisions a per-tenant database during the
    # create call, sets ``is_isolated=true`` on the control row, and
    # the api routes this tenant's reads/writes to the new DB. Only
    # safe at onboarding (no data to migrate). For existing tenants,
    # use the migrate-then-flip procedure.
    is_isolated: bool = Field(default=False)
    # Optional first admin to seed at create time. When both are present the
    # API creates an ADMIN in the new tenant and emails a set-password invite.
    admin_full_name: Optional[str] = Field(None, min_length=1, max_length=255)
    admin_email: Optional[EmailStr] = None


class TenantAdminCreate(BaseModel):
    """Create an admin in an existing tenant (PLATFORM_ADMIN only)."""
    full_name: str = Field(..., min_length=1, max_length=255)
    email: EmailStr


class TenantUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    slug: Optional[str] = Field(None, min_length=1, max_length=100, pattern=r"^[a-z0-9-]+$")
    status: Optional[TenantStatus] = None
    ingestion_enabled: Optional[bool] = None
    max_mailboxes: Optional[int] = Field(None, ge=0)
    # IANA timezone name (e.g. "America/New_York"). ``None`` means "fall back
    # to UTC." Empty string is treated as clearing the value — the endpoint
    # already passes through via ``model_dump(exclude_unset=True)``.
    timezone: Optional[str] = Field(None, max_length=64)


class TenantLifecycleAction(str, Enum):
    """Lifecycle actions allowed via POST /tenants/{id}/lifecycle.

    Distinct from the free-form ``status`` field on PATCH so destructive
    actions get their own endpoint with the typed-confirmation gate
    enforced server-side, not just in the UI.
    """

    mark_inactive = "mark_inactive"
    suspend = "suspend"
    resume = "resume"
    delete = "delete"


class TenantLifecycleRequest(BaseModel):
    """Body for POST /tenants/{id}/lifecycle.

    The operator types the exact tenant name in the UI; the frontend
    forwards it as ``confirmation_token``. The backend re-validates
    against the live tenant row before performing the action so a stale
    UI can't bypass the gate.

    ``resume`` is the only action that doesn't require typing - it's
    reversing a previous suspension and the safety bar is already lower.
    All other actions reject when the token doesn't match exactly.
    """

    action: TenantLifecycleAction
    confirmation_token: Optional[str] = Field(
        None,
        max_length=255,
        description=(
            "The exact tenant name typed by the operator. Required for "
            "mark_inactive / suspend / delete; ignored for resume."
        ),
    )


class TenantResponse(BaseModel):
    id: int
    name: str
    slug: str
    status: TenantStatus
    ingestion_enabled: bool = False
    max_mailboxes: Optional[int] = None
    timezone: Optional[str] = None
    # Branding. We expose a boolean and the mime type but never the raw
    # storage key — that's an internal path with no business leaving
    # the server. The frontend fetches /admin/tenant/logo to read the
    # bytes when has_logo is true. Both fields are populated by the
    # route handler before serialization.
    has_logo: bool = False
    logo_mime_type: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class TenantFeaturesResponse(BaseModel):
    """Feature flags Acufy controls per tenant (platform-admin owned)."""
    tenant_id: int
    custom_outbound_email: bool
    custom_email_template: bool


class TenantFeaturesUpdate(BaseModel):
    """Partial update for feature flags. Any field omitted is left as-is."""
    custom_outbound_email: Optional[bool] = None
    custom_email_template: Optional[bool] = None


class DepartmentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class DepartmentResponse(BaseModel):
    id: int
    tenant_id: int
    name: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class TitleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class TitleResponse(BaseModel):
    id: int
    tenant_id: int
    name: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class NotificationItem(BaseModel):
    id: str
    title: str
    message: str
    route: str
    severity: str = "info"
    count: int = 1
    created_at: Optional[datetime] = None
    is_read: bool = False


class NotificationRouteCounts(BaseModel):
    my_time: int = 0
    time_off: int = 0
    approvals: int = 0
    admin: int = 0
    dashboard: int = 0


class NotificationSummaryResponse(BaseModel):
    total_count: int
    route_counts: NotificationRouteCounts
    items: list[NotificationItem]


class NotificationReadRequest(BaseModel):
    notification_id: str


class NotificationActionResponse(BaseModel):
    success: bool = True


# ── Client Portal Access ──────────────────────────────────────────────────────
CLIENT_CAPABILITIES = ("create", "read", "update", "delete")


class ClientGrantCreate(BaseModel):
    """Create one scoped grant for a CLIENT user (project XOR task)."""
    user_id: int
    project_id: Optional[int] = None
    task_id: Optional[int] = None
    capabilities: List[str] = Field(default_factory=lambda: ["read"])

    @field_validator("capabilities")
    @classmethod
    def _valid_caps(cls, v: List[str]) -> List[str]:
        bad = [c for c in v if c not in CLIENT_CAPABILITIES]
        if bad:
            raise ValueError(f"Invalid capabilities: {bad}")
        # Always include read if any capability is granted.
        caps = sorted(set(v))
        if caps and "read" not in caps:
            caps.append("read")
        return sorted(set(caps))


class ClientGrantUpdate(BaseModel):
    capabilities: List[str]

    @field_validator("capabilities")
    @classmethod
    def _valid_caps(cls, v: List[str]) -> List[str]:
        bad = [c for c in v if c not in CLIENT_CAPABILITIES]
        if bad:
            raise ValueError(f"Invalid capabilities: {bad}")
        caps = sorted(set(v))
        if caps and "read" not in caps:
            caps.append("read")
        return sorted(set(caps))


class ClientGrantResponse(BaseModel):
    id: int
    user_id: int
    project_id: Optional[int] = None
    task_id: Optional[int] = None
    capabilities: List[str] = Field(default_factory=list)
    created_by: Optional[int] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ClientPortalUser(BaseModel):
    """A client-side person who has at least one grant on a given client's
    projects, with those grants. Powers the per-client 'Client access' tab."""
    user_id: int
    full_name: str
    email: str
    label: Optional[str] = None   # client-side role label (stored on user.title)
    # False until they accept the invite and set a password. Drives the
    # Active/Invited pill and the "Resend invite" action in the grant manager.
    email_verified: bool = False
    grants: List[ClientGrantResponse] = Field(default_factory=list)




class ClientGrantSpec(BaseModel):
    """One scoped grant in an invite payload: a project (whole-project) XOR a
    task (specific-task), each carrying its own capability set. Mirrors the PM
    invite modal's per-project mode (Whole project / Specific tasks)."""
    scope: str  # "project" | "task"
    project_id: Optional[int] = None
    task_id: Optional[int] = None
    capabilities: List[str] = Field(default_factory=lambda: ["read"])

    @field_validator("capabilities")
    @classmethod
    def _valid_caps(cls, v: List[str]) -> List[str]:
        bad = [c for c in v if c not in CLIENT_CAPABILITIES]
        if bad:
            raise ValueError(f"Invalid capabilities: {bad}")
        caps = sorted(set(v))
        if caps and "read" not in caps:
            caps.append("read")
        return sorted(set(caps))


class ClientInviteRequest(BaseModel):
    """Invite a new client-side person: creates a CLIENT user + emails a
    set-password link. Optionally grants scoped access in the same call.

    Prefer `grants` (per-scope project/task with its own capabilities, matching
    the invite modal). `project_ids` + `capabilities` is the legacy flat form
    (every selected project gets the same caps) and is used only when `grants`
    is empty."""
    full_name: str = Field(..., min_length=1)
    email: EmailStr
    label: Optional[str] = None  # client-side role label, e.g. "Project Sponsor"
    # Which client-side role to create. "manager" => CLIENT_MANAGER (delegates to
    # their own employees), "employee" => CLIENT_EMPLOYEE (linked to the client's
    # manager; read/update only). Defaults to manager for back-compat.
    portal_role: str = "manager"  # "manager" | "employee"
    # Required when portal_role == "employee" and the client has multiple
    # managers (to choose which manager the employee reports to). When the client
    # has exactly one manager it's auto-linked and this is ignored.
    manager_user_id: Optional[int] = None
    grants: List[ClientGrantSpec] = Field(default_factory=list)
    project_ids: List[int] = Field(default_factory=list)
    capabilities: List[str] = Field(default_factory=lambda: ["read"])

    @field_validator("capabilities")
    @classmethod
    def _valid_caps(cls, v: List[str]) -> List[str]:
        bad = [c for c in v if c not in CLIENT_CAPABILITIES]
        if bad:
            raise ValueError(f"Invalid capabilities: {bad}")
        caps = sorted(set(v))
        if caps and "read" not in caps:
            caps.append("read")
        return sorted(set(caps))


class ClientInviteResponse(BaseModel):
    user_id: int
    email: str
    invited: bool = True
    message: str


class ClientUserUpdate(BaseModel):
    """Edit a CLIENT user's profile from the client-management side. All fields
    optional; only those supplied are changed."""
    full_name: Optional[str] = Field(default=None, min_length=1)
    email: Optional[EmailStr] = None
    title: Optional[str] = None  # the client-side role label, e.g. "Project Sponsor"


# Client-side portal DTOs (what a CLIENT user sees of their granted work).
class PortalTask(BaseModel):
    id: int
    project_id: int
    name: str
    description: Optional[str] = None
    status: Optional[str] = None
    capabilities: List[str] = Field(default_factory=list)


class PortalProject(BaseModel):
    id: int
    name: str
    code: Optional[str] = None
    client_id: int
    client_name: Optional[str] = None
    status: Optional[str] = None
    description: Optional[str] = None
    # Project-level capabilities (empty when the client only has task grants here).
    capabilities: List[str] = Field(default_factory=list)
    tasks: List[PortalTask] = Field(default_factory=list)


# Portal write payloads (capability-gated).
class PortalTaskUpdate(BaseModel):
    """Client editing a task they have UPDATE on (status and/or description)."""
    status: Optional[str] = None
    description: Optional[str] = None


class TaskProgressUpdate(BaseModel):
    """Internal assignee editing a task they're assigned to: status,
    description, and (when blocking) the blocker reason. Mirrors the
    client-employee portal scope."""
    status: Optional[str] = None
    description: Optional[str] = None
    blocked_reason: Optional[str] = None

    @field_validator("status")
    @classmethod
    def _valid_status(cls, v):
        if v is None:
            return v
        return _check_status(v, _TASK_STATUSES, "task status")


class PortalTaskCreate(BaseModel):
    """Client adding a task to a project they have CREATE on."""
    project_id: int
    name: str = Field(..., min_length=1)
    description: Optional[str] = None


class PortalTaskNoteCreate(BaseModel):
    """Client adding a note to a task they have UPDATE on."""
    body: str = Field(..., min_length=1)


class PortalProjectUpdate(BaseModel):
    """Client editing a project they have UPDATE on (description only — name,
    status, billing etc. stay manager-owned)."""
    description: Optional[str] = None


# ── Two-tier client portal (CLIENT_MANAGER manages CLIENT_EMPLOYEEs) ─────────
# Employees may only be granted read/update — never create/delete.
CLIENT_EMPLOYEE_CAPABILITIES = ("read", "update")


class ClientManagerContext(BaseModel):
    """The calling CLIENT_MANAGER's own context: which clients they manage,
    whether self-onboarding of employees is enabled, and the scopes they can
    delegate (their own grant set, the cap on what they can hand out)."""
    client_ids: List[int] = Field(default_factory=list)
    client_names: List[str] = Field(default_factory=list)
    can_invite_employees: bool = False  # any managed client has the toggle on
    employee_count: int = 0


class PortalContactInfo(BaseModel):
    name: str
    title: Optional[str] = None
    email: Optional[str] = None


class PortalContext(BaseModel):
    """Orienting context for ANY client-side user's portal: which client org this
    is, the user's role, their client manager (for employees), and the account
    team (our internal PMs) they can reach."""
    role: str                       # CLIENT | CLIENT_MANAGER | CLIENT_EMPLOYEE
    role_label: str                 # friendly: "Client manager" / "Client employee"
    client_names: List[str] = Field(default_factory=list)
    manager: Optional[PortalContactInfo] = None       # the employee's client manager
    account_team: List[PortalContactInfo] = Field(default_factory=list)  # our PMs


class ClientEmployeeAssignmentInfo(BaseModel):
    """One thing a client employee is assigned to (a whole project or a task)."""
    grant_id: int
    scope: str  # "project" | "task"
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    task_id: Optional[int] = None
    task_name: Optional[str] = None
    capabilities: List[str] = Field(default_factory=list)


class ClientEmployeeSummary(BaseModel):
    user_id: int
    full_name: str
    email: str
    label: Optional[str] = None
    email_verified: bool = False
    assignment_count: int = 0  # how many tasks/projects they're assigned to
    assignments: List[ClientEmployeeAssignmentInfo] = Field(default_factory=list)


class ClientEmployeeInvite(BaseModel):
    """A CLIENT_MANAGER invites one of their own client employees. Allowed only
    when at least one of their managed clients has self-manage enabled."""
    full_name: str = Field(..., min_length=1)
    email: EmailStr
    label: Optional[str] = None


class ClientEmployeeAssign(BaseModel):
    """A CLIENT_MANAGER assigns an employee to a task (or whole project) they
    themselves hold. capabilities are clamped to read/update server-side."""
    employee_user_id: int
    project_id: Optional[int] = None
    task_id: Optional[int] = None
    capabilities: List[str] = Field(default_factory=lambda: ["read"])

    @field_validator("capabilities")
    @classmethod
    def _valid_emp_caps(cls, v: List[str]) -> List[str]:
        bad = [c for c in v if c not in CLIENT_EMPLOYEE_CAPABILITIES]
        if bad:
            raise ValueError(f"Employees can only be granted read/update. Invalid: {bad}")
        caps = sorted(set(v))
        if "read" not in caps:
            caps.append("read")
        return sorted(set(caps))


class ClientReviewItem(BaseModel):
    """One item in a CLIENT_MANAGER's review feed: an employee's update to a
    task awaiting (or already given) the manager's sign-off."""
    review_id: int
    task_id: int
    task_name: str
    project_name: Optional[str] = None
    employee_user_id: int
    employee_name: str
    status: str  # pending | approved | rejected
    note: Optional[str] = None
    task_status: Optional[str] = None
    submitted_at: Optional[datetime] = None
    reviewed_at: Optional[datetime] = None


class ClientReviewAction(BaseModel):
    note: Optional[str] = None
