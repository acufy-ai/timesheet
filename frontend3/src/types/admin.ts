// Shapes for the management + admin pages (users, clients, audit, time-off,
// ingestion). Trimmed to the fields the UI renders; the wire payloads have
// more. Verified against the live API on 2026-06-05.

export interface ManagedUser {
  id: number;
  email: string;
  username?: string;
  full_name: string;
  role: string;
  roles?: string[];
  department?: string | null;
  title?: string | null;
  cost_rate?: number | string | null;
  cost_currency?: string | null;
  timezone?: string | null;
  manager_id?: number | null;
  manager_ids?: number[];
  primary_manager_id?: number | null;
  project_ids?: number[];
  task_ids?: number[];
  default_client_id?: number | null;
  phones?: string[];
  is_active: boolean;
  can_review?: boolean;
  is_external?: boolean;
  email_verified?: boolean;
  has_changed_password?: boolean;
  timesheet_locked?: boolean;
  timesheet_locked_reason?: string | null;
  created_at?: string | null;
}

// POST /users body. full_name + is_external required; password is always
// auto-generated server-side (the route forces it to null). Mirrors the
// backend UserCreate schema.
export interface CreateUserBody {
  full_name: string;
  is_external: boolean;
  email?: string | null;
  username?: string | null;
  title?: string | null;
  title_id?: number | null;
  department?: string | null;
  cost_rate?: number | string | null;
  cost_currency?: string | null;
  timezone?: string | null;
  role?: string;
  is_active?: boolean;
  manager_id?: number | null;
  manager_ids?: number[];
  primary_manager_id?: number | null;
  project_ids?: number[];
  task_ids?: number[];
  default_client_id?: number | null;
  can_review?: boolean;
  phones?: string[];
}

// PUT /users/{id} body. All optional (partial update). Mirrors UserUpdate.
export interface UpdateUserBody {
  email?: string | null;
  username?: string | null;
  full_name?: string;
  title?: string | null;
  title_id?: number | null;
  department?: string | null;
  cost_rate?: number | string | null;
  cost_currency?: string | null;
  timezone?: string | null;
  role?: string;
  roles?: string[];
  is_active?: boolean;
  can_review?: boolean;
  is_external?: boolean;
  manager_id?: number | null;
  manager_ids?: number[];
  primary_manager_id?: number | null;
  project_ids?: number[];
  task_ids?: number[];
  default_client_id?: number | null;
  phones?: string[];
}

// Query params for the paged/searchable user list (GET /users).
export interface UserListParams {
  skip?: number;
  limit?: number;
  q?: string;
  role?: string;
  status?: 'active' | 'inactive';
  audience?: 'internal' | 'external' | 'client';
  no_manager?: boolean;
  unverified?: boolean;
}

// A page of users plus the server's total match count (from X-Total-Count).
export interface UserPage {
  items: ManagedUser[];
  total: number;
}

// ── Client Portal Access ──
export type ClientCapability = 'create' | 'read' | 'update' | 'delete';

export interface ClientGrant {
  id: number;
  user_id: number;
  project_id?: number | null;
  task_id?: number | null;
  capabilities: ClientCapability[];
  created_by?: number | null;
  created_at?: string | null;
}

export interface PortalTask {
  id: number;
  project_id: number;
  name: string;
  description?: string | null;
  status?: string | null;
  capabilities: ClientCapability[];
  due_date?: string | null;
  blocked_reason?: string | null;
  allowed_transitions?: string[];
  blocking_team?: boolean;
  blocked_by_client_task?: { id: number; name: string } | null;
}

export interface PortalProgress {
  done: number;
  total: number;
  pct: number;
}

export type ClientHealth = 'on_track' | 'at_risk' | 'off_track';

export interface PortalProject {
  id: number;
  name: string;
  code?: string | null;
  client_id: number;
  client_name?: string | null;
  status?: string | null;
  description?: string | null;
  capabilities: ClientCapability[];
  tasks: PortalTask[];
  // Client Portal Redesign (Phase 1)
  start_date?: string | null;
  target_date?: string | null;
  client_health?: ClientHealth | null;
  client_health_note?: string | null;
  progress: PortalProgress;
  attention_count: number;
  overdue_count: number;
  contact_name?: string | null;
}

export interface PortalTaskNote {
  id: number;
  author?: string | null;
  author_user_id?: number | null;
  body: string;
  note_date?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ClientPortalUser {
  user_id: number;
  full_name: string;
  email: string;
  label?: string | null;
  // False until the client accepts the invite + sets a password.
  email_verified?: boolean;
  grants: ClientGrant[];
}

// ── Two-tier client portal (CLIENT_MANAGER manages CLIENT_EMPLOYEEs) ──
export interface ClientManagerContext {
  client_ids: number[];
  client_names: string[];
  can_invite_employees: boolean;
  employee_count: number;
}

export interface ClientEmployeeAssignmentInfo {
  grant_id: number;
  scope: 'project' | 'task';
  project_id?: number | null;
  project_name?: string | null;
  task_id?: number | null;
  task_name?: string | null;
  capabilities: string[];
}

export interface ClientEmployeeSummary {
  user_id: number;
  full_name: string;
  email: string;
  label?: string | null;
  email_verified?: boolean;
  assignment_count: number;
  assignments?: ClientEmployeeAssignmentInfo[];
}

export interface PortalContactInfo {
  name: string;
  title?: string | null;
  email?: string | null;
}

export interface PortalContext {
  role: string;
  role_label: string;
  client_names: string[];
  manager?: PortalContactInfo | null;
  account_team: PortalContactInfo[];
}

export interface ClientReviewItem {
  review_id: number;
  task_id: number;
  task_name: string;
  project_name?: string | null;
  employee_user_id: number;
  employee_name: string;
  status: 'pending' | 'approved' | 'rejected';
  note?: string | null;
  task_status?: string | null;
  submitted_at?: string | null;
  reviewed_at?: string | null;
}

// One scoped grant in an invite: a whole project XOR a specific task, each with
// its own capabilities. Mirrors the invite modal's per-project mode.
export interface ClientGrantSpec {
  scope: 'project' | 'task';
  project_id?: number | null;
  task_id?: number | null;
  capabilities: ClientCapability[];
}

export interface ClientInviteBody {
  full_name: string;
  email: string;
  label?: string | null;
  // "manager" => CLIENT_MANAGER (delegates to own employees); "employee" =>
  // CLIENT_EMPLOYEE (auto-linked to the client's manager; read/update only).
  portal_role?: 'manager' | 'employee';
  manager_user_id?: number | null; // only needed when a client has >1 manager
  grants?: ClientGrantSpec[];
  // Legacy flat form (every project gets the same caps); used only when
  // `grants` is omitted.
  project_ids?: number[];
  capabilities?: ClientCapability[];
}

// An extra email address on a user (GET /users/{id}/email-aliases).
export interface EmailAlias {
  id: number;
  email: string;
  created_at?: string;
}

// A client a user is assigned to (GET /users/{id}/clients).
export interface UserClientAssignment {
  id: number;
  client_id: number;
  client_name: string;
  client_type: string;
}

// ── Bulk CSV user import (POST /users/import/{preview,validate,commit}) ──
export interface ImportPreview {
  headers: string[];
  preview_rows: Record<string, string>[];
  total_rows: number;
  all_rows: string[][];
}
export interface ImportValidatedRow {
  row_index: number;
  status: 'new' | 'exact_match' | 'conflict' | 'error' | 'duplicate_in_file';
  full_name?: string;
  email?: string;
  message?: string;
  [k: string]: unknown;
}
export interface ImportValidateResult {
  rows: ImportValidatedRow[];
  counts: Record<string, number>;
}
export interface ImportCommitBody {
  mapping: Record<string, string>;
  rows: string[][];
  headers: string[];
  user_type?: 'external' | 'internal';
  default_client_id?: number | null;
  default_project_id?: number | null;
  default_manager_id?: number | null;
  conflict_resolutions?: Record<string, 'overwrite' | 'skip'>;
}
export interface ImportCommitResult {
  created: number;
  updated?: number;
  skipped?: number;
  errors?: Array<{ row_index?: number; message: string }>;
  [k: string]: unknown;
}

// Returned by POST /users (UserCreateResponse).
export interface CreateUserResult {
  user: ManagedUser;
  temporary_password?: string | null;
  verification_email_sent?: boolean;
}

// Client lifecycle status (migration 071). Wire values are snake_case.
export type ClientStatus = 'active' | 'prospect' | 'on_hold' | 'churned';

export interface Client {
  id: number;
  name: string;
  client_type: string; // "internal" | "external"
  status?: ClientStatus;
  company?: string | null;
  since?: string | null; // ISO date
  quickbooks_customer_id?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  // Two-tier portal: when true, this client's CLIENT_MANAGER may invite their
  // own employees.
  client_self_manage_enabled?: boolean;
}

// POST/PUT /clients body (ClientCreate / ClientUpdate share these fields).
export interface ClientBody {
  name: string;
  client_type: string;
  status?: ClientStatus;
  company?: string | null;
  since?: string | null;
  quickbooks_customer_id?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  client_self_manage_enabled?: boolean;
  // Initial team, sent on CREATE so the client + roster are written in one
  // request (avoids a follow-up PUT /team that would re-check access).
  pm_ids?: number[];
  member_ids?: number[];
}

// A member of a client's team (GET /clients/{id}/team). assignment_role marks
// PMs vs. plain members on this client; role is the user's org role.
export interface ClientTeamMember {
  user_id: number;
  full_name: string;
  role: string;
  assignment_role: 'pm' | 'member';
}

// GET /clients/{id}/resources — everyone actually working on ANY of the client's
// projects (roster + task assignees), de-duplicated, distinct from the formal
// client-team assignment above.
export interface ClientResourceProject {
  project_id: number;
  project_name: string;
  on_roster: boolean;
  task_count: number;
  role?: string | null; // per-project billing role (Developer, Tester, ...)
}
export interface ClientResource {
  user_id: number;
  full_name: string;
  role: string;
  title?: string | null;
  is_pm: boolean;
  is_client: boolean; // client-side portal user vs internal delivery team
  project_count: number;
  projects: ClientResourceProject[];
}

// PUT /clients/{id}/team body.
export interface ClientTeamBody {
  pm_ids: number[];
  member_ids: number[];
}

// Contract lifecycle status (migration 075). Wire values are snake_case.
export type ContractStatus = 'draft' | 'active' | 'on_hold' | 'completed' | 'churned';

// A client agreement (GET /clients/{id}/contracts). The document is stored via
// the storage service; has_document signals an attachment exists.
export interface Contract {
  id: number;
  client_id: number;
  title: string;
  kind?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  value?: string | number | null;
  status: ContractStatus;
  document_name?: string | null;
  document_size?: number | null;
  has_document: boolean;
}

// POST/PUT /clients/{id}/contracts body.
export interface ContractBody {
  title?: string;
  kind?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  value?: number | null;
  status?: ContractStatus;
}

// ── Phase C: client contacts / role rates / notes ───────────────────────────
export interface ContactChannel { label?: string | null; address?: string; number?: string }

export interface ClientContact {
  id: number;
  client_id: number;
  name: string;
  role?: string | null;
  emails: ContactChannel[];
  phones: ContactChannel[];
}
export interface ClientContactBody {
  name?: string;
  role?: string | null;
  emails?: ContactChannel[];
  phones?: ContactChannel[];
}

export interface ClientRoleRate {
  id: number;
  client_id: number;
  role: string;
  rate: string | number;
  currency: string;
  effective_date?: string | null;
}
export interface ClientRoleRateBody {
  role?: string;
  rate?: number;
  currency?: string;
  effective_date?: string | null;
}

export interface ClientNote {
  id: number;
  client_id: number;
  author?: string | null;       // server-stamped display name
  author_user_id?: number | null; // provable author link
  body: string;
  note_date?: string | null;
  // Optional target project/task. project_name/code/task_name are denormalized
  // server-side for display + search.
  project_id?: number | null;
  task_id?: number | null;
  project_name?: string | null;
  project_code?: string | null;
  task_name?: string | null;
  created_at: string;
  updated_at: string;
}
// `author` is server-stamped from the logged-in user — not sendable.
export interface ClientNoteBody {
  body?: string;
  note_date?: string | null;
  project_id?: number | null;
  task_id?: number | null;
  // Sets the linked task's status. Only when 'blocked' does the note body
  // become the task's blocked_reason. Transient (not stored on the note).
  task_status?: TaskStatus | null;
}

// Project lifecycle status (migration 071). Wire values are snake_case.
export type ProjectStatus = 'planning' | 'in_progress' | 'on_hold' | 'completed';

// Full project shape from /projects (ProjectResponse). billable_rate is a
// Decimal serialised as a string on the wire.
export interface FullProject {
  id: number;
  name: string;
  client_id: number;
  billable_rate: string | number;
  quickbooks_project_id?: string | null;
  code?: string | null;
  description?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  estimated_hours?: string | number | null;
  budget_amount?: string | number | null;
  currency?: string | null;
  is_active: boolean;
  status?: ProjectStatus;
  manager_id?: number | null; // first PM, back-compat
  manager_ids?: number[]; // project managers (user ids)
  resource_ids?: number[]; // project roster (user ids), from user_project_access
  contract_id?: number | null; // the contract (MSA/SOW) this project is under
  client_health?: ClientHealth | null; // client-facing health (null = hidden)
  client_health_note?: string | null;
}

// POST/PUT /projects body. billable_rate required on create.
export interface ProjectBody {
  name?: string;
  client_id?: number;
  billable_rate?: number;
  quickbooks_project_id?: string | null;
  code?: string | null;
  description?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  estimated_hours?: number | null;
  budget_amount?: number | null;
  currency?: string | null;
  revenue_recognition?: string;
  is_active?: boolean;
  status?: ProjectStatus;
  manager_id?: number | null;
  manager_ids?: number[]; // when set, replaces the project's managers
  resource_ids?: number[]; // when set, replaces the project roster
  contract_id?: number | null;
  client_health?: ClientHealth | '' | null; // '' clears it back to hidden
  client_health_note?: string | null;
}

export type TaskPriority = 'low' | 'medium' | 'high';
export type TaskStatus = 'to_do' | 'in_progress' | 'blocked' | 'done';

// Task shape from /tasks (TaskResponse / TaskWithProject).
export interface FullTask {
  id: number;
  project_id: number;
  name: string;
  code?: string | null;
  description?: string | null;
  is_active: boolean;
  priority?: TaskPriority;
  status?: TaskStatus;
  // Phase 2 causal fields. null = not captured (unknown).
  estimated_hours?: string | number | null;
  start_date?: string | null;
  due_date?: string | null;
  blocked_reason?: string | null;
  assignee_ids?: number[]; // task_assignees (user ids)
  client_assignees?: { user_id: number; full_name: string }[]; // client employees on this task
}

// A dependency edge: `task_id` depends on (is blocked by) `depends_on_task_id`.
export interface TaskDependency {
  id: number;
  task_id: number;
  depends_on_task_id: number;
  reason?: string | null;
  task_name?: string | null;
  depends_on_task_name?: string | null;
}

// POST/PUT /tasks body.
export interface TaskBody {
  project_id?: number;
  name?: string;
  code?: string | null;
  description?: string | null;
  is_active?: boolean;
  priority?: TaskPriority;
  status?: TaskStatus;
  // Phase 2 causal fields. Send null to clear, omit to leave untouched.
  estimated_hours?: string | number | null;
  start_date?: string | null;
  due_date?: string | null;
  blocked_reason?: string | null;
  assignee_ids?: number[]; // when set, replaces the task's assignees
}

export interface AuditEvent {
  id: number;
  activity_type: string;
  entity_type: string;
  actor_name: string | null;
  summary: string;
  route?: string | null;
  severity: 'info' | 'success' | 'warning' | 'error' | string;
  created_at: string;
}

export type TimeOffStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

export interface TimeOffRequest {
  id: number;
  user_id: number;
  request_date: string;
  hours: string | number;
  leave_type: string;
  reason: string;
  status: TimeOffStatus;
  rejection_reason: string | null;
  submitted_at?: string | null;
  approved_at?: string | null;
  approved_by?: number | null;
  created_at: string;
}

// A pending/decided request as the manager sees it: carries the requesting
// user (TimeOffRequestWithUser). approved_by is a user id; we resolve names
// from the roster where shown.
export interface TimeOffRequestWithUser extends TimeOffRequest {
  user: { id: number; full_name: string; email?: string };
}

// A workforce department (GET /departments).
export interface Department {
  id: number;
  name: string;
}

// A managed job title (GET /titles).
export interface Title {
  id: number;
  name: string;
}

// Per-service infra health (GET /admin/system-health).
export interface SystemHealthCheck {
  key: string;
  label: string;
  status: 'healthy' | 'attention' | 'loading';
  subtitle: string;
}

// In-app notification (GET /notifications/summary).
export interface NotificationItem {
  id: string;
  title: string;
  message: string;
  route: string;
  severity: string; // info | warning | error | success
  count: number;
  created_at?: string | null;
  is_read: boolean;
}
export interface NotificationRouteCounts {
  my_time: number;
  time_off: number;
  approvals: number;
  admin: number;
  dashboard: number;
}
export interface NotificationSummary {
  total_count: number;
  route_counts: NotificationRouteCounts;
  items: NotificationItem[];
}

// A dismissed/snoozed attention-queue signal (GET /attention-signals/dismissed).
export interface DismissedSignal {
  signal_key: string;
  snoozed_until: string | null;
}

// A connected mailbox for email ingestion (GET /mailboxes, MailboxRead).
export interface Mailbox {
  id: number;
  label: string;
  protocol: string; // imap | gmail_api | graph_api ...
  auth_type: string; // basic | oauth
  host: string | null;
  port: number | null;
  use_ssl: boolean;
  username: string | null;
  has_password: boolean;
  oauth_provider: string | null;
  oauth_email: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_username: string | null;
  linked_client_id: number | null;
  is_active: boolean;
  last_fetched_at: string | null;
  last_fetch_error: string | null;
  auto_disabled_reason: string | null;
}

// POST /mailboxes body (basic IMAP). OAuth mailboxes come via the OAuth flow.
export interface MailboxCreateBody {
  label: string;
  protocol: string;
  auth_type: string;
  host?: string | null;
  port?: number | null;
  use_ssl?: boolean;
  username?: string | null;
  password?: string | null;
  smtp_host?: string | null;
  smtp_port?: number | null;
  smtp_username?: string | null;
  smtp_password?: string | null;
  linked_client_id?: number | null;
}

// Tenant-defined leave type (GET /leave-types). Drives the request form's
// type dropdown instead of a hardcoded list.
export interface LeaveType {
  id: number;
  code: string;
  label: string;
  color: string;
  is_active: boolean;
}

// Self profile with org context (GET /users/me/profile).
export interface OrgPerson {
  id: number;
  full_name: string;
  email?: string;
  role: string;
  title?: string | null;
}
export interface UserProfile {
  id: number;
  email: string;
  username: string;
  full_name: string;
  title?: string | null;
  title_id?: number | null;
  department?: string | null;
  cost_rate?: number | string | null;
  cost_currency?: string | null;
  timezone?: string | null;
  role: string;
  // Back-compat single-manager fields (primary). Prefer `managers`.
  manager_id?: number | null;
  manager_name?: string | null;
  // All immediate managers (primary first). Multi-manager.
  managers?: OrgPerson[];
  direct_reports: OrgPerson[];
  supervisor_chain: OrgPerson[];
}

// A holiday on the workspace calendar (GET /holidays).
export interface Holiday {
  id: number;
  date: string;
  name: string;
  holiday_type: 'PUBLIC' | 'COMPANY';
  country?: string | null;
}

// One row of the tenant-settings catalog (GET /users/tenant-settings/catalog).
// Approved inbox-ingested (PDF) timesheet summary, for the Approved Timesheets
// tab's inbox-merge + source-file viewer. Shape mirrors the backend
// _timesheet_to_summary serializer.
export interface IngestionTimesheetSummary {
  id: number;
  tenant_id: number;
  email_id: number;
  attachment_id: number | null;
  subject: string | null;
  sender_email: string | null;
  sender_name: string | null;
  employee_id: number | null;
  employee_name: string | null;
  extracted_employee_name: string | null;
  extracted_supervisor_name: string | null;
  client_id: number | null;
  client_name: string | null;
  extracted_client_name: string | null;
  period_start: string | null;
  period_end: string | null;
  total_hours: string | number | null;
  status: string;
  push_status: string | null;
  time_entries_created: boolean;
  reviewed_at?: string | null;
  [k: string]: unknown;
}

// A tenant-setting value. The catalog stores scalars, an optional string list
// (e.g. recipient ids), or a json object. Matches what the settings form reads
// and writes through the catalog hooks.
export type SettingValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | Record<string, unknown>;

// data_type drives which control the settings form renders; validation carries
// enum / min / max / length where present.
export interface SettingDefinition {
  key: string;
  category: string;
  data_type: 'string' | 'int' | 'bool' | 'time' | 'json' | 'float';
  default_value: SettingValue;
  validation: {
    enum?: string[];
    min?: number;
    max?: number;
    min_length?: number;
    max_length?: number;
  } & Record<string, unknown>;
  label: string;
  description?: string | null;
  is_public: boolean;
  sort_order: number;
}

export interface TimeOffUsageRow {
  leave_type: string;
  label: string;
  color: string;
  hours_taken: number;
  days_taken: number;
}

// One LLM-flagged anomaly on an ingested timesheet (reviewer "issues to review").
export interface IngestionAnomaly {
  type: string;
  severity?: string | null;
  description: string;
}

export interface IngestionSummary {
  id: number;
  subject: string | null;
  sender_email: string | null;
  sender_name: string | null;
  employee_id?: number | null;
  employee_name: string | null;
  extracted_employee_name: string | null;
  extracted_supervisor_name?: string | null;
  client_id?: number | null;
  client_name: string | null;
  period_start: string | null;
  period_end: string | null;
  total_hours: string | number | null;
  status: string;
  created_at?: string;
  // Present on the /ingestion/timesheets wire payload (verified 2026-06-11);
  // the inbox grouping + rows read these. email_id is the grouping key.
  email_id?: number | null;
  received_at?: string | null;
  attachment_id?: number | null;
  llm_anomalies?: IngestionAnomaly[] | null;
  llm_match_suggestions?: Array<Record<string, unknown>> | null;
  push_status?: string | null;
  reviewer_name?: string | null;
  reviewer_id?: number | null;
  time_entries_created?: boolean;
  // NOTE: is_likely_resubmission and mailbox_label are NOT sent by the backend
  // for timesheet rows (verified: undefined on the wire) — so f2's resubmission
  // badge + mailbox label are intentionally omitted (would need backend work).
}

// One extracted line item on an ingested timesheet (LineItemRead).
export interface IngestionLineItem {
  id: number;
  work_date: string;
  hours: string | number;
  description: string | null;
  project_code: string | null;
  project_id: number | null;
  is_corrected: boolean;
  is_rejected: boolean;
  rejection_reason: string | null;
}

// Full review-panel detail (IngestionTimesheetDetail), trimmed to what the UI
// renders.
export interface IngestionDetail {
  id: number;
  status: string;
  employee_id: number | null;
  employee_name: string | null;
  client_id: number | null;
  client_name: string | null;
  period_start: string | null;
  period_end: string | null;
  total_hours: string | number | null;
  llm_summary: string | null;
  rejection_reason: string | null;
  internal_notes: string | null;
  time_entries_created: boolean;
  extracted_employee_name?: string | null;
  extracted_supervisor_name?: string | null;
  line_items: IngestionLineItem[];
  created_at?: string | null;
  // Raw LLM extraction blob — the extracted-client hint reads
  // extracted_data.client_name (verified on the wire 2026-06-11). Loose-typed
  // because the shape varies by parser; read defensively.
  extracted_data?: Record<string, unknown> | null;
  corrected_data?: Record<string, unknown> | null;
  // Reviewer action history (IngestionAuditLog rows).
  audit_log?: Array<{
    id?: number;
    action?: string;
    actor_type?: string | null;
    user_id?: number | null;
    comment?: string | null;
    previous_value?: string | null;
    new_value?: string | null;
    created_at?: string | null;
    [k: string]: unknown;
  }> | null;
  // Source-email context (id powers reprocess; sender domain powers
  // create-client-from-domain). forwarded_from_* surface the friendly sender
  // name on forwarded chains.
  email?: {
    id: number;
    sender_email: string;
    sender_name?: string | null;
    subject?: string | null;
    forwarded_from_email?: string | null;
    forwarded_from_name?: string | null;
  } | null;
}

// Status of a mailbox fetch job (GET /ingestion/fetch-emails/status/{id}).
export interface FetchJobStatus {
  status: string; // queued | running | completed | failed | cancelled ...
  job_id: string;
  progress?: number | null;
  message?: string | null;
  mode?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  started_at?: string | null;
  updated_at?: string | null;
  counters?: Record<string, number> | null;
}

// A skipped (classified not-a-timesheet) email (GET /ingestion/skipped-emails).
export interface SkippedEmail {
  id: number;
  subject: string | null;
  sender_email: string;
  sender_name?: string | null;
  received_at: string | null;
  mailbox_label?: string | null;
  has_attachments: boolean;
  timesheet_attachment_count: number;
  classification_intent?: string | null;
  classification_confidence?: number | null;
  skip_reason?: string | null;
  skip_detail?: string | null;
  reprocessable_attachments: Array<Record<string, unknown>>;
}
export interface SkippedEmailOverview {
  count: number;
  emails: SkippedEmail[];
}

// Full stored-email detail (GET /ingestion/emails/{id}).
export interface StoredEmailDetail {
  id: number;
  subject: string | null;
  sender_email: string;
  sender_name?: string | null;
  forwarded_from_email?: string | null;
  forwarded_from_name?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  received_at: string | null;
  mailbox_label?: string | null;
  classification_intent?: string | null;
  skip_reason?: string | null;
  skip_detail?: string | null;
  attachments: Array<Record<string, unknown>>;
}

// Result of approving an ingested timesheet (ApprovalResult).
export interface IngestionApprovalResult {
  ingestion_timesheet_id: number;
  time_entries_created: number;
  employee_id: number;
  project_ids: number[];
  status: string;
  overlapping_entries_count: number;
  overlapping_dates: string[];
}

// ── Client bulk import (clients + projects + tasks + assignments) ──
export interface ClientImportRowIssue {
  row: number;            // 0-based data-row index (matches the preview table)
  level: 'error' | 'skip' | 'note';
  message: string;
}
export interface ClientImportPreview {
  counts: { clients: number; projects: number; tasks: number; assignments: number };
  errors: string[];
  warnings: string[];
  // Per-row issues keyed by sheet, so the preview can mark each affected row.
  row_issues: Record<string, ClientImportRowIssue[]>;
  // Parsed sheet data, echoed back so commit doesn't re-upload the file.
  data: Record<string, Array<Record<string, string>>>;
}
export interface ClientImportResult {
  created: { clients: number; projects: number; tasks: number; assignments: number };
  errors: string[];
}
