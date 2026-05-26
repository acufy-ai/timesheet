import { apiClient } from './client';

export type HistoryGroupEntry = {
  id: number;
  entry_date: string;
  hours: number;
  description: string | null;
  status: string;
  rejection_reason: string | null;
  project_name: string | null;
  task_name: string | null;
  /** Optional explicit time block (HH:MM:SS). Null for hours-only entries. */
  start_time: string | null;
  end_time: string | null;
};

export type HistoryGroup = {
  employee_id: number;
  employee_name: string;
  week_start: string;
  week_end: string;
  total_hours: number;
  entry_count: number;
  approved_count: number;
  rejected_count: number;
  status: 'approved' | 'rejected' | 'mixed';
  entries: HistoryGroupEntry[];
};

import {
  ChangePasswordRequest,
  UserCreateResponse,
  DashboardAnalytics,
  Department,
  Holiday,
  HolidaySuggestionsResponse,
  HolidayType,
  LeaveType,
  DashboardRecentActivityItem,
  DashboardSummary,
  FetchJobResponse,
  FetchJobStatus,
  IngestionApprovalResult,
  IngestionDataUpdate,
  IngestionLineItem,
  IngestionLineItemPayload,
  IngestionTimesheetDetail,
  IngestionTimesheetSummary,
  LoginRequest,
  MappingReapplyResult,
  Mailbox,
  MailboxPayload,
  MessageResponse,
  NotificationActionResponse,
  NotificationSummary,
  ReprocessSkippedResult,
  ReprocessStoredEmailResult,
  ServiceToken,
  ServiceTokenCreate,
  ServiceTokenCreated,
  ManagerProjectHealthResponse,
  ManagerTeamOverviewResponse,
  StoredEmailDetail,
  SystemHealthCheckResponse,
  Task,
  TeamDailyOverview,
  Tenant,
  TenantStatus,
  TimeEntry,
  TimeOffRequest,
  TokenResponse,
  User,
  UserProfile,
  UserRole,
  SkippedEmailOverview,
  WeeklySubmissionStatus,
  UserClientAssignment,
  PlatformAuditCategory,
  PlatformAuditEventDetail,
  PlatformAuditListParams,
  PlatformAuditListResponse,
  PlatformCalendarEventsResponse,
  PlatformDashboardHealth,
  PlatformDashboardSummary,
  PlatformTenantsUsersCountResponse,
  PlatformTenantStatsResponse,
} from '@/types';

// Auth endpoints
export const authAPI = {
  login: (data: LoginRequest) =>
    apiClient.post<TokenResponse>('/auth/login', data),
  
  me: () =>
    apiClient.get<User>('/auth/me'),

  changePassword: (data: ChangePasswordRequest) =>
    apiClient.post<MessageResponse>('/auth/change-password', data),

  refresh: (refreshToken: string) =>
    apiClient.post<TokenResponse>('/auth/refresh', { refresh_token: refreshToken }),

  logout: (refreshToken: string) =>
    apiClient.post('/auth/logout', { refresh_token: refreshToken }),

  verifyEmail: (token: string) =>
    apiClient.post<MessageResponse & { email: string }>('/auth/verify-email', { token }),

  resendVerification: (email: string) =>
    apiClient.post<MessageResponse>('/auth/resend-verification', { email }),

  // Multi-role: flip the active role to one already in user.roles.
  // Mints a fresh access + refresh pair; frontend swaps them in.
  switchRole: (role: UserRole) =>
    apiClient.post<TokenResponse>('/auth/switch-role', { role }),

  // Mint a short-lived token; new tab redeems it for an independent session.
  roleHandoffIssue: (role: UserRole) =>
    apiClient.post<{ handoff_token: string; target_role: UserRole }>('/auth/role-handoff', { role }),

  roleHandoffExchange: (handoff_token: string) =>
    apiClient.post<TokenResponse>('/auth/role-handoff/exchange', { handoff_token }),

  // Validate an invitation/reset token without consuming it (page load).
  verifyInvitation: (token: string) =>
    apiClient.get<{ valid: boolean; email?: string; purpose?: 'invite' | 'reset'; reason?: string }>(
      '/auth/invitation/verify',
      { params: { token } },
    ),

  // Consume an invitation/reset token by submitting the new password.
  setPasswordViaInvitation: (token: string, new_password: string) =>
    apiClient.post<{ success: boolean; email: string; purpose: 'invite' | 'reset' }>(
      '/auth/invitation/set-password',
      { token, new_password },
    ),

  // Anti-enumeration: always returns success regardless of email existence.
  forgotPassword: (email: string) =>
    apiClient.post<MessageResponse>('/auth/forgot-password', { email }),
};

// Users endpoints
export const usersAPI = {
  // ``tenantSlug`` is only relevant for platform-admin callers; the
  // backend's ``get_tenant_db`` dep requires X-Tenant-Slug on PA tokens
  // to route the session to the right tenant DB AND to scope the
  // returned rows. Tenant-admin callers leave it undefined; their
  // tenant comes from the JWT claim.
  list: (tenantSlug?: string) =>
    apiClient.get<User[]>('/users', {
      params: { limit: 1000 },
      headers: tenantSlug ? { 'X-Tenant-Slug': tenantSlug } : undefined,
    }),
  listAssignable: () =>
    apiClient.get<User[]>('/users/assignable'),
  
  get: (id: number) =>
    apiClient.get<User>(`/users/${id}`),
  
  create: (data: Partial<User> & { password?: string }, tenantSlug?: string) =>
    apiClient.post<UserCreateResponse>(
      '/users',
      data,
      // Platform-admin tokens carry tenant_id=null in the JWT, so the
      // backend can't route the create to the right tenant DB. Pass the
      // tenant slug as a header so backend's get_tenant_db dep picks it up.
      tenantSlug ? { headers: { 'X-Tenant-Slug': tenantSlug } } : undefined,
    ),
  
  update: (id: number, data: Partial<User>) =>
    apiClient.put<User>(`/users/${id}`, data),

  meProfile: () =>
    apiClient.get<UserProfile>('/users/me/profile'),

  // Per-user UI preferences (view modes, table densities). Keys are
  // free-form; backend validates known ones (e.g., inbox_view_mode).
  getMyPreferences: () =>
    apiClient.get<Record<string, unknown>>('/users/me/preferences'),

  updateMyPreferences: (data: Record<string, unknown>) =>
    apiClient.patch<Record<string, unknown>>('/users/me/preferences', data),

  updateMyProfile: (data: {
    full_name?: string;
    title?: string;
    department?: string;
    timezone?: string;
    username?: string;
    email?: string;
  }) => apiClient.patch<User>('/users/me/profile', data),

  changePassword: (data: ChangePasswordRequest) =>
    apiClient.post<MessageResponse>('/auth/change-password', data),

  changePasswordAfterVerification: async (tempPassword: string, newPassword: string, email: string) => {
    // Trim temp password — users frequently copy-paste with trailing whitespace
    // or a newline, which bcrypt compare rejects.
    const temp = tempPassword.trim();
    // Log in with the temp password to get a short-lived token, then change password
    const loginRes = await apiClient.post<TokenResponse>('/auth/login', { email, password: temp });
    const token = loginRes.data.access_token;
    return apiClient.post<MessageResponse>(
      '/users/me/password',
      { current_password: temp, new_password: newPassword },
      { headers: { Authorization: `Bearer ${token}` } },
    );
  },

  delete: (id: number) =>
    apiClient.delete(`/users/${id}`),
  bulkDelete: (userIds: number[]) =>
    apiClient.post<{ deleted: number }>('/users/bulk-delete', { user_ids: userIds }),
  resetPassword: (id: number, newPassword: string) =>
    apiClient.post<{ message: string }>(`/users/${id}/reset-password`, { new_password: newPassword }),
  resendVerification: (id: number) =>
    apiClient.post<{ message: string }>(`/users/${id}/resend-verification`, {}),
  resendInvite: (id: number) =>
    apiClient.post<{ message: string }>(`/users/${id}/resend-invite`, {}),
  // Unified Send invite: backend dispatches Auth0 vs legacy verification
  // path based on whether the user has an auth0_sub. Prefer this over
  // resendVerification / resendInvite in new UI.
  sendInvite: (id: number) =>
    apiClient.post<{ message: string }>(`/users/${id}/send-invite`, {}),

  listEmailAliases: (id: number) =>
    apiClient.get<EmailAlias[]>(`/users/${id}/email-aliases`),
  addEmailAlias: (id: number, email: string) =>
    apiClient.post<EmailAlias>(`/users/${id}/email-aliases`, { email }),
  deleteEmailAlias: (id: number, alias_id: number) =>
    apiClient.delete<void>(`/users/${id}/email-aliases/${alias_id}`),

  importPreview: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return apiClient.post<ImportPreviewResponse>('/users/import/preview', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  importValidate: (data: { headers: string[]; rows: string[][]; mapping: Record<string, string> }) =>
    apiClient.post<{ rows: ImportPreviewRow[]; counts: Record<string, number> }>('/users/import/validate', data),
  importCommit: (data: ImportCommitRequest) =>
    apiClient.post<ImportCommitResponse>('/users/import/commit', data),

  exportUsers: (params: ExportUsersParams) =>
    apiClient.get<Blob>('/users/export/users', { params, responseType: 'blob' }),
  exportClients: (params: ExportClientsParams) =>
    apiClient.get<Blob>('/users/export/clients', { params, responseType: 'blob' }),
  exportTimesheets: (params: ExportTimesheetsParams) =>
    apiClient.get<Blob>('/users/export/timesheets', { params, responseType: 'blob' }),
};

export interface ExportUsersParams {
  fmt: 'csv' | 'xlsx';
  user_type?: 'all' | 'internal' | 'external';
  role?: string;
  status_filter?: 'all' | 'active' | 'inactive';
  client_id?: number;
  department?: string;
}

export interface ExportClientsParams {
  fmt: 'csv' | 'xlsx';
}

export interface ExportTimesheetsParams {
  fmt: 'csv' | 'xlsx';
  period_start: string; // YYYY-MM-DD
  period_end: string;   // YYYY-MM-DD
  user_type?: 'all' | 'internal' | 'external';
  user_id?: number;
  client_id?: number;
  project_id?: number;
}

export interface EmailAlias {
  id: number;
  email: string;
  created_at: string;
}

export interface ImportPreviewResponse {
  headers: string[];
  preview_rows: Record<string, string>[];
  total_rows: number;
  all_rows: string[][];
}

export interface ImportPreviewRow {
  row: number;
  status: 'new' | 'exact_match' | 'conflict' | 'duplicate_in_file' | 'error';
  full_name: string;
  email: string;
  existing_name: string | null;
  extra_emails: string[];
  phones: string[];
  role: string;
  title: string;
  department: string;
  client: string;
  project: string;
  manager: string;
  is_active: boolean;
  warnings: string[];
  errors: string[];
}

export interface ImportCommitRequest {
  headers: string[];
  rows: string[][];
  mapping: Record<string, string>;
  user_type?: 'internal' | 'external';
  default_client_id?: number;
  default_project_id?: number;
  default_manager_id?: number;
  conflict_resolutions?: Record<string, 'overwrite' | 'skip'>;
}

export interface ImportCommitResponse {
  created: number;
  updated: number;
  skipped: number;
  details: {
    created: Array<{ row: number; user_id: number; full_name: string; warnings: string[] }>;
    updated: Array<{ row: number; user_id: number; full_name: string; warnings: string[] }>;
    skipped: Array<{ row: number; reason: string }>;
  };
  // Names of clients that didn't exist before this import and were
  // auto-created during the run. Surfaced in the result panel so the
  // admin sees that the client directory grew as a side effect.
  new_clients?: string[];
}

// Clients endpoints
export const clientsAPI = {
  list: () =>
    apiClient.get('/clients'),
  
  get: (id: number) =>
    apiClient.get(`/clients/${id}`),
  
  create: (data: { name: string; client_type?: string; quickbooks_customer_id?: string; contact_name?: string; contact_email?: string; contact_phone?: string }) =>
    apiClient.post('/clients', data),

  update: (id: number, data: Partial<{ name: string; client_type: string; quickbooks_customer_id: string; contact_name: string; contact_email: string; contact_phone: string }>) =>
    apiClient.put(`/clients/${id}`, data),

  delete: (id: number) =>
    apiClient.delete(`/clients/${id}`),

  bulkDelete: (clientIds: number[]) =>
    apiClient.post<{ deleted: number }>('/clients/bulk-delete', { client_ids: clientIds }),

  createFromDomain: (data: { name: string; domain: string }) =>
    apiClient.post<{
      client: { id: number; name: string };
      domain: string;
      cascaded_count: number;
    }>('/clients/from-domain', data),

  listUserAssignments: (userId: number) =>
    apiClient.get<UserClientAssignment[]>(`/users/${userId}/clients`),

  addUserAssignment: (userId: number, clientId: number) =>
    apiClient.post<{ assignments: UserClientAssignment[] }>(`/users/${userId}/clients/${clientId}`),

  removeUserAssignment: (userId: number, clientId: number) =>
    apiClient.delete<{ assignments: UserClientAssignment[] }>(`/users/${userId}/clients/${clientId}`),
};

export const departmentsAPI = {
  list: () => apiClient.get<Department[]>('/departments'),
  create: (name: string) => apiClient.post<Department>('/departments', { name }),
  delete: (id: number) => apiClient.delete(`/departments/${id}`),
};

export const leaveTypesAPI = {
  list: (includeInactive = false) => apiClient.get<LeaveType[]>(`/leave-types${includeInactive ? '?include_inactive=true' : ''}`),
  create: (data: { label: string; code?: string; color?: string }) =>
    apiClient.post<LeaveType>('/leave-types', data),
  update: (id: number, data: Partial<Pick<LeaveType, 'label' | 'color' | 'is_active'>>) =>
    apiClient.patch<LeaveType>(`/leave-types/${id}`, data),
  delete: (id: number) => apiClient.delete(`/leave-types/${id}`),
};

export const holidaysAPI = {
  list: (params?: { start_date?: string; end_date?: string; country?: string }) =>
    apiClient.get<Holiday[]>('/holidays', { params }),
  countries: () => apiClient.get<string[]>('/holidays/countries'),
  create: (data: { date: string; name: string; holiday_type: HolidayType; country?: string }) =>
    apiClient.post<Holiday>('/holidays', data),
  bulkCreate: (holidays: Array<{ date: string; name: string; holiday_type: HolidayType; country?: string }>) =>
    apiClient.post<Holiday[]>('/holidays/bulk', { holidays }),
  update: (id: number, data: { name?: string; holiday_type?: HolidayType }) =>
    apiClient.patch<Holiday>(`/holidays/${id}`, data),
  delete: (id: number) => apiClient.delete(`/holidays/${id}`),
  suggestions: (country: string, year: number) =>
    apiClient.get<HolidaySuggestionsResponse>('/holidays/suggestions', {
      params: { country, year },
    }),
};

// Projects endpoints
export const projectsAPI = {
  list: (params?: { client_id?: number; active_only?: boolean; skip?: number; limit?: number }) =>
    apiClient.get('/projects', { params }),
  
  get: (id: number) =>
    apiClient.get(`/projects/${id}`),
  
  create: (data: {
    name: string;
    client_id: number;
    billable_rate: number;
    quickbooks_project_id?: string;
    code?: string;
    description?: string;
    start_date?: string;
    end_date?: string;
    estimated_hours?: number;
    budget_amount?: number;
    currency?: string;
    is_active?: boolean;
  }) =>
    apiClient.post('/projects', data),
  
  update: (id: number, data: Partial<Record<string, unknown>>) =>
    apiClient.put(`/projects/${id}`, data),
  
  delete: (id: number) =>
    apiClient.delete(`/projects/${id}`),
};

export const tasksAPI = {
  list: (params?: { project_id?: number; active_only?: boolean; skip?: number; limit?: number }) =>
    apiClient.get<Task[]>('/tasks', { params }),

  get: (id: number) =>
    apiClient.get<Task>(`/tasks/${id}`),

  create: (data: {
    project_id: number;
    name: string;
    code?: string;
    description?: string;
    is_active?: boolean;
  }) =>
    apiClient.post<Task>('/tasks', data),

  update: (id: number, data: Partial<{ project_id: number; name: string; code: string; description: string; is_active: boolean }>) =>
    apiClient.put<Task>(`/tasks/${id}`, data),

  delete: (id: number) =>
    apiClient.delete(`/tasks/${id}`),
};

// TimeEntries endpoints
export const timeentriesAPI = {
  list: (params?: {
    start_date?: string;
    end_date?: string;
    status?: string;
    search?: string;
    sort_by?: 'entry_date' | 'created_at' | 'hours' | 'status';
    sort_order?: 'asc' | 'desc';
    skip?: number;
    limit?: number;
  }) =>
    apiClient.get('/timesheets/my', { params }),
  
  get: (id: number) =>
    apiClient.get(`/timesheets/${id}`),
  
  create: (data: {
    project_id: number;
    task_id?: number | null;
    entry_date: string;
    // Wire-format HH:MM or HH:MM:SS; both nullable so the caller can
    // log hours-only entries when no time block is known.
    start_time?: string | null;
    end_time?: string | null;
    hours: number;
    description: string;
    notes?: string | null;
    is_billable?: boolean;
  }) =>
    apiClient.post('/timesheets', data),
  
  update: (id: number, data: Partial<Record<string, unknown>>) =>
    apiClient.put(`/timesheets/${id}`, data),
  
  delete: (id: number) =>
    apiClient.delete(`/timesheets/${id}`),
  
  submit: (entry_ids: number[]) =>
    apiClient.post('/timesheets/submit', { entry_ids }),

  /**
   * Recall (un-submit) a set of SUBMITTED entries back to DRAFT so
   * the user can edit them. Backend returns 409 if any entry was
   * already actioned by a manager (approved or rejected).
   * Reuses the same body shape as /submit.
   */
  recall: (entry_ids: number[]) =>
    apiClient.post('/timesheets/recall', { entry_ids }),

  weeklySubmitStatus: () =>
    apiClient.get<WeeklySubmissionStatus>('/timesheets/weekly-submit-status'),

  parseNatural: (text: string) =>
    apiClient.post<{
      entries: Array<{
        project_id: number | null;
        project_name: string;
        task_id: number | null;
        task_name: string;
        client_name: string;
        client_id: number | null;
        entry_date: string;
        hours: number | null;
        description: string;
        is_billable: boolean;
        error: string | null;
        alternatives: Array<{
          project_id: number;
          project_name: string;
          task_id: number;
          task_name: string;
        }>;
      }>;
      raw_input?: string;
      error?: string;
    }>('/timesheets/parse-natural', { text }),

  listAll: (params?: {
    user_id?: number;
    start_date?: string;
    end_date?: string;
    status?: string;
    sort_by?: 'entry_date' | 'created_at' | 'hours' | 'status';
    sort_order?: 'asc' | 'desc';
    skip?: number;
    limit?: number;
  }) =>
    apiClient.get<TimeEntry[]>('/timesheets/all', { params }),
};

// Approvals endpoints
export const approvalsAPI = {
  pending: (params?: {
    search?: string;
    sort_by?: string;
    sort_order?: 'asc' | 'desc';
    skip?: number;
    limit?: number;
  }) =>
    apiClient.get('/approvals/pending', { params }),

  history: (params?: {
    search?: string;
    sort_by?: string;
    sort_order?: 'asc' | 'desc';
    include_older?: boolean;
    skip?: number;
    limit?: number;
  }) =>
    apiClient.get('/approvals/history', { params }),
  
  approve: (id: number) =>
    apiClient.post(`/approvals/${id}/approve`, {}),

  batchApprove: (entry_ids: number[]) =>
    apiClient.post('/approvals/batch-approve', { entry_ids }),
  
  reject: (id: number, rejection_reason: string) =>
    apiClient.post(`/approvals/${id}/reject`, { rejection_reason }),

  batchReject: (entry_ids: number[], rejection_reason: string) =>
    apiClient.post('/approvals/batch-reject', { entry_ids, rejection_reason }),

  revertRejection: (id: number) =>
    apiClient.post<{ status: string }>(`/approvals/${id}/revert-rejection`, {}),

  historyGrouped: (params?: { days_back?: number; status_filter?: string }) =>
    apiClient.get<HistoryGroup[]>('/approvals/history-grouped', { params }),
};

export const timeOffAPI = {
  list: (params?: {
    start_date?: string;
    end_date?: string;
    status?: string;
    leave_type?: string;
    search?: string;
    sort_by?: 'request_date' | 'created_at' | 'hours' | 'status';
    sort_order?: 'asc' | 'desc';
    skip?: number;
    limit?: number;
  }) => apiClient.get<TimeOffRequest[]>('/time-off/my', { params }),

  get: (id: number) => apiClient.get<TimeOffRequest>(`/time-off/${id}`),

  create: (data: {
    request_date: string;
    hours: number;
    leave_type: string;
    reason: string;
  }) => apiClient.post<TimeOffRequest>('/time-off', data),

  update: (id: number, data: Partial<{ request_date: string; hours: number; leave_type: string; reason: string }>) =>
    apiClient.put<TimeOffRequest>(`/time-off/${id}`, data),

  delete: (id: number) => apiClient.delete(`/time-off/${id}`),

  submit: (request_ids: number[]) => apiClient.post<TimeOffRequest[]>('/time-off/submit', { request_ids }),

  usageSummary: (year?: number) =>
    apiClient.get<TimeOffUsageSummaryRow[]>('/time-off/usage-summary', {
      params: year ? { year } : undefined,
    }),
};

export interface TimeOffUsageSummaryRow {
  leave_type: string;
  label: string;
  color: string;
  hours_taken: number;
  days_taken: number;
}

export const timeOffApprovalsAPI = {
  pending: (params?: {
    search?: string;
    sort_by?: 'request_date' | 'submitted_at' | 'hours' | 'employee';
    sort_order?: 'asc' | 'desc';
    skip?: number;
    limit?: number;
  }) => apiClient.get<TimeOffRequest[]>('/time-off-approvals/pending', { params }),

  history: (params?: {
    search?: string;
    sort_by?: 'approved_at' | 'request_date' | 'hours' | 'employee' | 'status';
    sort_order?: 'asc' | 'desc';
    include_older?: boolean;
    skip?: number;
    limit?: number;
  }) => apiClient.get<TimeOffRequest[]>('/time-off-approvals/history', { params }),

  approve: (id: number) => apiClient.post<TimeOffRequest>(`/time-off-approvals/${id}/approve`, {}),

  reject: (id: number, rejection_reason: string) =>
    apiClient.post<TimeOffRequest>(`/time-off-approvals/${id}/reject`, { rejection_reason }),
};

export const dashboardAPI = {
  summary: () => apiClient.get<DashboardSummary>('/dashboard/summary'),
  team: () => apiClient.get<User[]>('/dashboard/team'),
  teamDailyOverview: () => apiClient.get<TeamDailyOverview>('/dashboard/team-daily-overview'),
  analytics: (params: {
    start_date: string;
    end_date: string;
    project_id?: number;
    user_id?: number;
  }) => apiClient.get<DashboardAnalytics>('/dashboard/analytics', { params }),
  recentActivity: (params?: { limit?: number }) =>
    apiClient.get<DashboardRecentActivityItem[]>('/dashboard/recent-activity', { params }),
  managerTeamOverview: () =>
    apiClient.get<ManagerTeamOverviewResponse>('/dashboard/manager-team-overview'),
  managerProjectHealth: () =>
    apiClient.get<ManagerProjectHealthResponse>('/dashboard/manager-project-health'),
  auditTrail: (params?: { limit?: number; offset?: number; activity_type?: string; search?: string }) =>
    apiClient.get<DashboardRecentActivityItem[]>('/dashboard/audit-trail', { params }),
};

export const adminAPI = {
  /** Per-service operational state for the admin dashboard. ADMIN /
   *  PLATFORM_ADMIN only; other roles get 403. Each entry is independent
   *  — one degraded service does not mask the others. */
  systemHealth: () => apiClient.get<SystemHealthCheckResponse[]>('/admin/system-health'),

  /** Replace the current tenant's branding logo. Admin only. Server
   *  derives the storage path from the authenticated tenant's slug, so
   *  this cannot redirect to another tenant's prefix. */
  uploadTenantLogo: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return apiClient.post<{ has_logo: boolean; mime_type: string | null }>(
      '/admin/tenant/logo',
      form,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    );
  },

  /** Fetch the current tenant's logo bytes as a Blob. Auth header
   *  attached automatically; the response is scoped to the caller's
   *  tenant via Depends(get_tenant_db). 404 when no logo is set. */
  getTenantLogoBlob: () =>
    apiClient.get<Blob>('/admin/tenant/logo', { responseType: 'blob' }),

  /** Remove the current tenant's logo. Admin only. */
  deleteTenantLogo: () =>
    apiClient.delete<{ has_logo: boolean }>('/admin/tenant/logo'),

  /** Admin-readable list of approved ingestion timesheets, scoped to
   *  the caller's tenant. Used by the Team Timesheets tab to merge
   *  summary-only ingestion timesheets (those with no line items) into
   *  the table. Reviewer-queue access stays gated separately under
   *  /ingestion/timesheets. */
  /**
   * Approved inbox-PDF timesheets for the Approved Timesheets surface.
   * ``scope`` defaults to ``workspace`` (admin behaviour); managers
   * who only review their direct reports pass ``mine`` so the backend
   * filters to (their reports' PDFs) OR (PDFs they personally
   * reviewed). Admins / viewers always see the workspace view.
   */
  listApprovedIngestionTimesheets: (
    params?: { employee_id?: number; scope?: 'mine' | 'workspace' },
  ) =>
    apiClient.get<IngestionTimesheetSummary[]>('/admin/approved-ingestion-timesheets', {
      params: params && (params.employee_id !== undefined || params.scope) ? params : undefined,
    }),

  /** Stream the source file (PDF / Excel / image) for an approved
   *  ingestion timesheet attachment. Admin-permissive counterpart to
   *  /ingestion/attachments/{id}/file (which stays reviewer-only).
   *  Backend rejects with 403 unless the attachment belongs to a
   *  timesheet in the approved state. Returns both the object URL (for
   *  iframe rendering) and the mime type (so the caller can decide
   *  between inline rendering and a download UI). */
  getApprovedIngestionAttachmentFile: async (attachmentId: number) => {
    const response = await apiClient.get<Blob>(
      `/admin/approved-ingestion-attachments/${attachmentId}/file`,
      { responseType: 'blob', headers: { Accept: '*/*' } },
    );
    return {
      url: URL.createObjectURL(response.data),
      mime: response.data.type,
      blob: response.data,
    };
  },

  /** Render a spreadsheet attachment (xlsx / xls / csv) as HTML for
   *  inline preview in the Team Timesheets modal. Admin-permissive,
   *  scoped to approved-ingestion rows only. */
  getApprovedIngestionAttachmentHtml: (attachmentId: number) =>
    apiClient.get<{ html: string; mime_type: string; filename: string }>(
      `/admin/approved-ingestion-attachments/${attachmentId}/full-html`,
    ),
};

export interface DismissedSignal {
  signal_key: string;
  snoozed_until: string | null;
}

export const attentionSignalsAPI = {
  listDismissed: () =>
    apiClient.get<DismissedSignal[]>('/attention-signals/dismissed'),
  dismiss: (signal_key: string, snoozed_until: string | null) =>
    apiClient.post<void>('/attention-signals', { signal_key, snoozed_until }),
  undismiss: (signal_key: string) =>
    apiClient.delete<void>(`/attention-signals/${encodeURIComponent(signal_key)}`),
};

export const notificationsAPI = {
  summary: () => apiClient.get<NotificationSummary>('/notifications/summary'),
  markRead: (notification_id: string) =>
    apiClient.post<NotificationActionResponse>('/notifications/read', { notification_id }),
  markAllRead: () =>
    apiClient.post<NotificationActionResponse>('/notifications/read-all', {}),
  deleteOne: (notification_id: string) =>
    apiClient.post<NotificationActionResponse>('/notifications/delete', { notification_id }),
  deleteAll: () =>
    apiClient.post<NotificationActionResponse>('/notifications/delete-all', {}),
};

// Server-side enum (matches app.schemas.TenantLifecycleAction).
export type TenantLifecycleAction = 'mark_inactive' | 'suspend' | 'resume' | 'delete';

export const tenantsAPI = {
  mine: () => apiClient.get<Tenant>('/tenants/mine'),
  list: (params?: { include_archived?: boolean }) =>
    apiClient.get<Tenant[]>('/tenants', { params }),
  get: (id: number) => apiClient.get<Tenant>(`/tenants/${id}`),
  create: (data: { name: string; slug: string; is_isolated?: boolean }) =>
    apiClient.post<Tenant>('/tenants', data),
  update: (id: number, data: { name?: string; slug?: string; status?: TenantStatus; ingestion_enabled?: boolean }) =>
    apiClient.patch<Tenant>(`/tenants/${id}`, data),
  /**
   * Apply a destructive lifecycle action (mark_inactive / suspend / resume /
   * delete) with a typed-name confirmation. The backend re-validates the
   * confirmation_token against the live tenant.name before performing the
   * action and writes a PlatformAuditEvent with before/after state.
   *
   * confirmation_token is required for mark_inactive/suspend/delete and
   * ignored for resume.
   */
  lifecycle: (
    id: number,
    action: TenantLifecycleAction,
    confirmation_token?: string,
  ) =>
    apiClient.post<Tenant>(`/tenants/${id}/lifecycle`, {
      action,
      confirmation_token,
    }),
  provisionSystemUser: (id: number) =>
    apiClient.post<{ provisioned: boolean; user_id: number; email: string }>(`/tenants/${id}/provision-system-user`),
  getServiceTokens: (tenantId: number) =>
    apiClient.get<ServiceToken[]>(`/tenants/${tenantId}/service-tokens`),
  createServiceToken: (tenantId: number, data: ServiceTokenCreate) =>
    apiClient.post<ServiceTokenCreated>(`/tenants/${tenantId}/service-tokens`, data),
  revokeServiceToken: (tenantId: number, tokenId: number) =>
    apiClient.delete(`/tenants/${tenantId}/service-tokens/${tokenId}`),

  // Feature flags (Acufy-controlled per-tenant entitlements).
  getMyFeatures: () =>
    apiClient.get<TenantFeatures>('/tenants/mine/features'),
  getTenantFeatures: (tenantId: number) =>
    apiClient.get<TenantFeatures>(`/tenants/${tenantId}/features`),
  updateTenantFeatures: (tenantId: number, updates: Partial<Omit<TenantFeatures, 'tenant_id'>>) =>
    apiClient.patch<TenantFeatures>(`/tenants/${tenantId}/features`, updates),
};

export type TenantFeatures = {
  tenant_id: number;
  custom_outbound_email: boolean;
  custom_email_template: boolean;
};

export type SettingValue = string | number | boolean | null;

export type SettingDefinition = {
  key: string;
  category: string;
  data_type: 'int' | 'float' | 'bool' | 'string' | 'time' | 'json';
  default_value: SettingValue;
  validation: {
    min?: number;
    max?: number;
    min_length?: number;
    max_length?: number;
    enum?: Array<string | number>;
    pattern?: string;
  };
  label: string;
  description: string;
  is_public: boolean;
  sort_order: number;
};

export const tenantSettingsAPI = {
  // Post-migration 028 the GET endpoints return typed values (numbers,
  // booleans) rather than all strings. Legacy callers normalise via
  // ``toStringish`` in AdminSettingsPage; new callers work with the typed
  // values directly.
  get: () => apiClient.get<Record<string, SettingValue>>('/users/tenant-settings'),
  getPublic: () => apiClient.get<Record<string, SettingValue>>('/users/tenant-settings/public'),
  getCatalog: () => apiClient.get<SettingDefinition[]>('/users/tenant-settings/catalog'),
  update: (data: Record<string, SettingValue>) =>
    apiClient.patch<Record<string, SettingValue>>('/users/tenant-settings', data),
  unlockUser: (userId: number) =>
    apiClient.post<{ success: boolean; user_id: number }>(`/users/users/${userId}/unlock-timesheet`, {}),
  testSmtp: () =>
    apiClient.post<{ ok: boolean; detail?: string }>('/users/smtp-test', {}),
  previewEmailTemplate: (data: { purpose: 'invite' | 'reset'; subject: string; greeting: string; body: string; button_label: string; signoff: string }) =>
    apiClient.post<{ subject: string; html: string; text: string }>('/users/email-template-preview', data),
};

export const mailboxesAPI = {
  list: () => apiClient.get<Mailbox[]>('/mailboxes'),
  get: (id: number) => apiClient.get<Mailbox>(`/mailboxes/${id}`),
  create: (data: MailboxPayload) => apiClient.post<Mailbox>('/mailboxes', data),
  update: (id: number, data: Partial<MailboxPayload>) => apiClient.patch<Mailbox>(`/mailboxes/${id}`, data),
  delete: (id: number) => apiClient.delete(`/mailboxes/${id}`),
  test: (id: number) => apiClient.post<{ success: boolean; error: string | null; latency_ms: number; message_count: number }>(`/mailboxes/${id}/test`, {}),
  resetCursor: (id: number) => apiClient.post(`/mailboxes/${id}/reset-cursor`, {}),
  oauthConnect: (provider: 'google' | 'microsoft') => apiClient.get<{ auth_url: string }>(`/mailboxes/oauth/connect/${provider}`),
};

export const ingestionAPI = {
  triggerFetch: () => apiClient.post<FetchJobResponse>('/ingestion/fetch-emails', {}),
  getFetchStatus: (jobId: string) => apiClient.get<FetchJobStatus>(`/ingestion/fetch-emails/status/${jobId}`),
  getSkippedEmails: (params?: { limit?: number; include_classifier_skips?: boolean }) => apiClient.get<SkippedEmailOverview>('/ingestion/skipped-emails', { params }),
  promoteSkippedEmail: (emailId: number) =>
    apiClient.post<{ timesheet_id: number; already_promoted: boolean }>(`/ingestion/skipped-emails/${emailId}/promote`, {}),
  confirmSkippedEmail: (emailId: number) =>
    apiClient.post<{ ok: boolean }>(`/ingestion/skipped-emails/${emailId}/confirm-skip`, {}),
  reprocessSkipped: () => apiClient.post<ReprocessSkippedResult>('/ingestion/fetch-emails/reprocess-skipped', {}),
  reprocessEmail: (emailId: number, attachmentIds?: number[]) =>
    apiClient.post<ReprocessStoredEmailResult>('/ingestion/fetch-emails/reprocess', { email_id: emailId, attachment_ids: attachmentIds }),
  getEmail: (emailId: number) => apiClient.get<StoredEmailDetail>(`/ingestion/emails/${emailId}`),
  deleteEmail: (emailId: number, refetch: boolean = false) =>
    apiClient.delete(`/ingestion/emails/${emailId}`, { params: refetch ? { refetch: true } : undefined }),
  bulkDeleteEmails: (emailIds: number[]) =>
    apiClient.post<{ deleted: number }>('/ingestion/emails/bulk-delete', { email_ids: emailIds }),
  bulkReprocess: (emailIds: number[]) =>
    apiClient.post<{ queued: number; message: string }>('/ingestion/fetch-emails/bulk-reprocess', { email_ids: emailIds }),
  reapplyMappings: () => apiClient.post<MappingReapplyResult>('/ingestion/timesheets/reapply-mappings', {}),
  getAttachmentFile: async (attachmentId: number) => {
    const response = await apiClient.get<Blob>(`/ingestion/attachments/${attachmentId}/file`, {
      responseType: 'blob',
      headers: { Accept: '*/*' },
    });
    return URL.createObjectURL(response.data);
  },
  getAttachmentFullHtml: (attachmentId: number) =>
    apiClient.get<{ html: string }>(`/ingestion/attachments/${attachmentId}/full-html`),
  listTimesheets: (params?: { status_filter?: string; client_id?: number; employee_id?: number; email_id?: number; search?: string; limit?: number; offset?: number }) =>
    apiClient.get<IngestionTimesheetSummary[]>('/ingestion/timesheets', { params }),
  getTimesheet: (id: number) => apiClient.get<IngestionTimesheetDetail>(`/ingestion/timesheets/${id}`),
  updateTimesheetData: (id: number, data: IngestionDataUpdate) => apiClient.patch<{ status: string }>(`/ingestion/timesheets/${id}/data`, data),
  addLineItem: (id: number, data: Required<Pick<IngestionLineItemPayload, 'work_date' | 'hours'>> & IngestionLineItemPayload) =>
    apiClient.post<IngestionLineItem>(`/ingestion/timesheets/${id}/line-items`, data),
  updateLineItem: (timesheetId: number, itemId: number, data: IngestionLineItemPayload) =>
    apiClient.patch<IngestionLineItem>(`/ingestion/timesheets/${timesheetId}/line-items/${itemId}`, data),
  deleteLineItem: (timesheetId: number, itemId: number) =>
    apiClient.delete(`/ingestion/timesheets/${timesheetId}/line-items/${itemId}`),
  approveTimesheet: (id: number, comment?: string) =>
    apiClient.post<IngestionApprovalResult>(`/ingestion/timesheets/${id}/approve`, { comment }),
  rejectTimesheet: (id: number, reason: string, comment?: string) =>
    apiClient.post<{ status: string; reason: string }>(`/ingestion/timesheets/${id}/reject`, { reason, comment }),
  holdTimesheet: (id: number, comment?: string) =>
    apiClient.post<{ status: string }>(`/ingestion/timesheets/${id}/hold`, { comment }),
  rejectLineItem: (timesheetId: number, itemId: number, reason: string) =>
    apiClient.post<{ status: string; line_item_id: number }>(`/ingestion/timesheets/${timesheetId}/line-items/${itemId}/reject`, { reason }),
  unrejectLineItem: (timesheetId: number, itemId: number) =>
    apiClient.post<{ status: string; line_item_id: number }>(`/ingestion/timesheets/${timesheetId}/line-items/${itemId}/unreject`, {}),
  revertTimesheetRejection: (id: number) =>
    apiClient.post<{ status: string }>(`/ingestion/timesheets/${id}/revert-rejection`, {}),
  draftComment: (id: number, seed_text: string) =>
    apiClient.post<{ draft: string }>(`/ingestion/timesheets/${id}/draft-comment`, { seed_text }),
  assignChainCandidate: (id: number, data: { name?: string | null; email?: string | null }) =>
    apiClient.post<{ timesheet_id: number; employee_id: number; created_new_user: boolean }>(
      `/ingestion/timesheets/${id}/assign-chain-candidate`,
      data,
    ),
};

// Platform settings endpoints (PLATFORM_ADMIN only)
export type SmtpConfigResponse = {
  smtp_host: string;
  smtp_port: number;
  smtp_username: string;
  smtp_password_set: boolean;
  smtp_from_address: string;
  smtp_from_name: string;
  smtp_use_tls: boolean;
  source: 'database' | 'environment';
};

export type SmtpConfigUpdate = {
  smtp_host: string;
  smtp_port: number;
  smtp_username: string;
  smtp_password?: string | null;
  smtp_from_address: string;
  smtp_from_name: string;
  smtp_use_tls: boolean;
};

export const platformSettingsAPI = {
  getSmtp: () => apiClient.get<SmtpConfigResponse>('/platform/settings/smtp'),
  updateSmtp: (data: SmtpConfigUpdate) => apiClient.put<SmtpConfigResponse>('/platform/settings/smtp', data),
  clearSmtp: () => apiClient.delete('/platform/settings/smtp'),
};

// ── Platform-admin Dashboard / Calendar / Audit endpoints ──────────────────
//
// All these routes require PLATFORM_ADMIN. The backend rejects tenant-realm
// tokens at the router level, so a plain ADMIN won't reach any of them.
export const platformDashboardAPI = {
  summary: () =>
    apiClient.get<PlatformDashboardSummary>('/platform/dashboard/summary'),
  health: () =>
    apiClient.get<PlatformDashboardHealth>('/platform/dashboard/health'),
  // Tenant-lifecycle events bounded by a date range. Used by the Platform
  // Calendar to populate the month grid and the "next 30 days" sidebar.
  calendarEvents: (range_start: string, range_end: string) =>
    apiClient.get<PlatformCalendarEventsResponse>(
      '/platform/calendar/events',
      { params: { range_start, range_end } },
    ),
  // Paginated audit log read. Backend ANDs all set filters.
  auditList: (params: PlatformAuditListParams = {}) =>
    apiClient.get<PlatformAuditListResponse>('/platform/audit', { params }),
  // Single event for the drawer (includes before/after JSON payloads).
  auditEvent: (eventId: number) =>
    apiClient.get<PlatformAuditEventDetail>(`/platform/audit/${eventId}`),
  // Per-tenant user count fan-out for the Tenants tab Users column.
  tenantsUsersCount: () =>
    apiClient.get<PlatformTenantsUsersCountResponse>('/platform/tenants/users-count'),
  // Richer per-tenant snapshot for the compact list view: user count,
  // admin count, and last_activity_at. Single fan-out, single round-trip.
  tenantStats: () =>
    apiClient.get<PlatformTenantStatsResponse>('/platform/tenants/stats'),
};

// Re-export for callers that build URLs by category name.
export type { PlatformAuditCategory };
