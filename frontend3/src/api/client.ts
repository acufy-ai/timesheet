import axios, { type InternalAxiosRequestConfig } from 'axios';

import type {
  DashboardAnalytics,
  DashboardSummary,
  ManagerProjectHealth,
  ManagerFinancials,
  MyWork,
  ManagerTeamOverview,
  TeamBillableStats,
  TeamDailyOverview,
  TeamOnTimeStats,
  TeamProjectMatrix,
  TeamResourcing,
  Portfolio,
  EvmData,
  RevRec,
  HealthConfigBody,
  HealthConfigResponse,
  ManagerClients,
  ProjectTaskBreakdown,
  TeamRejectionStats,
} from '@/types/dashboard';
import type {
  CreateTenantBody,
  PlatformAuditEventDetail,
  PlatformAuditList,
  PlatformAuditParams,
  PlatformCalendarResponse,
  PlatformHealth,
  PlatformSummary,
  ServiceToken,
  SmtpConfig,
  SmtpConfigUpdate,
  Tenant,
  TenantFeatures,
  TenantStatsEntry,
} from '@/types/platform';
import type {
  CreateTimeEntry,
  HistoryGroup,
  ListEntriesParams,
  ParseNaturalResult,
  Project,
  Task,
  TimeEntry,
  UpdateTimeEntry,
  WeeklySubmissionStatus,
} from '@/types/time';
import type {
  AuditEvent,
  Client,
  ClientBody,
  ClientImportPreview,
  ClientImportResult,
  ClientTeamMember,
  ClientTeamBody,
  Contract,
  ContractBody,
  ClientContact,
  ClientContactBody,
  ClientRoleRate,
  ClientRoleRateBody,
  ClientNote,
  ClientNoteBody,
  CreateUserBody,
  Department,
  Title,
  CreateUserResult,
  DismissedSignal,
  EmailAlias,
  ImportPreview,
  ImportValidateResult,
  ImportCommitBody,
  ImportCommitResult,
  NotificationSummary,
  UserClientAssignment,
  FullProject,
  FullTask,
  Holiday,
  IngestionApprovalResult,
  IngestionDetail,
  IngestionLineItem,
  IngestionSummary,
  FetchJobStatus,
  SkippedEmailOverview,
  StoredEmailDetail,
  IngestionTimesheetSummary,
  LeaveType,
  Mailbox,
  MailboxCreateBody,
  ManagedUser,
  UserListParams,
  UserPage,
  ClientCapability,
  ClientGrant,
  ClientPortalUser,
  ClientInviteBody,
  PortalProject,
  ClientManagerContext,
  ClientEmployeeSummary,
  ClientReviewItem,
  PortalContext,
  UserProfile,
  ProjectBody,
  SettingDefinition,
  SettingValue,
  SystemHealthCheck,
  TaskBody,
  TimeOffRequest,
  TimeOffRequestWithUser,
  TimeOffUsageRow,
  UpdateUserBody,
} from '@/types/admin';

// Single Axios instance used by every request. The dev proxy in
// vite.config.ts forwards /api -> http://localhost:8000 so the same code
// works locally and (eventually) in production behind nginx.
//
// Storage:
//   - access token in sessionStorage at TOKEN_KEY (short-lived; the SPA must
//     read it to set the Authorization header)
//   - refresh token: NOT stored in JS. It lives in an HttpOnly cookie the
//     backend sets on login/refresh, so XSS can't exfiltrate it. The browser
//     sends it automatically on /auth/refresh and /auth/logout (withCredentials).
//
// Auth flow:
//   1. POST /auth/login -> access token + user in body; refresh token in cookie
//   2. Interceptor adds Authorization: Bearer on every subsequent request
//   3. On 401 we POST /auth/refresh (cookie carries the refresh token) to mint
//      a new access token; on failure the caller routes to /login

export const TOKEN_KEY = 'accessToken';
// Kept only to purge any refresh token left in storage by a previous build.
export const REFRESH_KEY = 'refreshToken';

// Per-tab id, sent as X-Tab-Id so the backend scopes the HttpOnly refresh
// cookie PER TAB (refresh_token__<id>). This is what lets two different
// accounts in two tabs of the same browser keep independent sessions instead
// of fighting over one shared cookie. sessionStorage is per-tab and survives
// reloads within the tab, so the id (and thus the session) is stable for the
// life of the tab and gone when it closes.
const TAB_ID_KEY = 'tabId';
export function getTabId(): string {
  let id = window.sessionStorage.getItem(TAB_ID_KEY);
  if (!id) {
    id = (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
    window.sessionStorage.setItem(TAB_ID_KEY, id);
  }
  return id;
}

// Decode a JWT's `sub` (the user id) WITHOUT verification — used only to detect
// a cross-tab identity swap, never for trust decisions. The HttpOnly refresh
// cookie is shared across all tabs of an origin; if you log into a SECOND
// account in another tab, that login overwrites the cookie, and an older tab's
// refresh would silently adopt the new account. We compare the sub before/after
// a refresh and refuse a token that belongs to a different user.
export function tokenSub(token: string | null | undefined): string | null {
  if (!token) return null;
  try {
    const payload = JSON.parse(
      atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')),
    );
    return payload?.sub != null ? String(payload.sub) : null;
  } catch {
    return null;
  }
}

// API base. Dev + same-origin-proxy deploys use the relative '/api' (the Vite
// proxy / nginx rewrites it to the backend root). Prod fronts the API at an
// absolute origin (e.g. https://acufy.ai/api) because the SPA itself is served
// under a sub-path; VITE_API_BASE_URL supplies that, baked at build time.
export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) || '/api';

export const api = axios.create({
  baseURL: API_BASE,
  timeout: 20_000,
  // Send the HttpOnly refresh cookie on auth requests. Same-origin in dev (via
  // the Vite proxy) and prod (nginx), so this is safe; CORS allow-credentials
  // is set on the backend for the cross-origin case.
  withCredentials: true,
});

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = window.sessionStorage.getItem(TOKEN_KEY);
  if (config.headers) {
    if (token) config.headers.set('Authorization', `Bearer ${token}`);
    // Per-tab refresh-cookie scoping. Harmless on non-auth calls; the backend
    // only reads it on /auth/login, /auth/refresh, /auth/logout.
    config.headers.set('X-Tab-Id', getTabId());
  }
  return config;
});

// Broadcast that the session is unrecoverable. AuthContext listens for this and
// clears `user`, which makes the router bounce to /login. Without this, clearing
// sessionStorage alone leaves the already-mounted page sitting on a dead session
// (every call 4xx-ing) because AuthContext's `user` state is still populated.
export const SESSION_EXPIRED_EVENT = 'acufy:session-expired';
function forceLogout() {
  window.sessionStorage.removeItem(TOKEN_KEY);
  window.sessionStorage.removeItem(REFRESH_KEY);
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

// ── Token refresh + dead-session handling ───────────────────────────
// On a 401 we try ONCE to mint a fresh access token from the stored refresh
// token (single-use rotation: the backend returns a new refresh token too),
// then retry the original request. Concurrent 401s share one in-flight refresh
// so we don't stampede the endpoint. The refresh call uses a bare axios
// instance so it doesn't loop back through this interceptor.
//
// 403 is ambiguous: it can be a legitimate permission denial (a valid user
// hitting an endpoint their role can't use) OR a dead/stale token (one minted
// against a now-gone DB whose user_id no longer resolves). We must NOT log out
// on a permission-403. We distinguish by probing /auth/me: if the token can't
// even fetch the current user, the session is genuinely dead.
let refreshInFlight: Promise<string | null> | null = null;
let deadSessionChecked = false;

async function tokenIsDead(): Promise<boolean> {
  const token = window.sessionStorage.getItem(TOKEN_KEY);
  if (!token) return true;
  try {
    await axios.get(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Tab-Id': getTabId() },
      withCredentials: true,
    });
    return false; // /auth/me works -> token is valid, the 403 was a permission denial
  } catch (e) {
    const s = (e as { response?: { status?: number } })?.response?.status;
    return s === 401 || s === 403; // /auth/me itself rejects -> token is dead
  }
}

async function runRefresh(): Promise<string | null> {
  // The refresh token rides in the HttpOnly cookie; withCredentials sends it.
  // No token is read from JS storage anymore.
  //
  // CROSS-TAB IDENTITY GUARD: the cookie is per-origin, shared by every tab. If
  // another tab logged into a DIFFERENT account, this refresh would mint a token
  // for THAT account and this tab would silently become someone else. So we pin
  // to the user this tab already holds: capture our current sub, and if the
  // refreshed token's sub differs, refuse it. The caller treats null as a dead
  // session and bounces this tab to /login (correct — its own session is gone).
  const priorSub = tokenSub(window.sessionStorage.getItem(TOKEN_KEY));
  try {
    const res = await axios.post(`${API_BASE}/auth/refresh`, {}, {
      headers: { 'X-Tab-Id': getTabId() },
      withCredentials: true,
    });
    const data = res.data as { access_token?: string };
    if (!data?.access_token) return null;
    const newSub = tokenSub(data.access_token);
    if (priorSub != null && newSub != null && newSub !== priorSub) {
      // The shared cookie now belongs to another account. Do NOT adopt it.
      return null;
    }
    window.sessionStorage.setItem(TOKEN_KEY, data.access_token);
    return data.access_token;
  } catch {
    return null;
  }
}

api.interceptors.response.use(
  (response) => { deadSessionChecked = false; return response; },
  async (error) => {
    const original = error?.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
    const status = error?.response?.status;
    const url: string = original?.url ?? '';
    // Don't recurse on the auth calls themselves (refresh/login/logout/me).
    const isAuthCall = /\/auth\/(refresh|login|logout|me)/.test(url);
    const hasToken = Boolean(window.sessionStorage.getItem(TOKEN_KEY));

    // 401: access token expired/invalid. Try one refresh + retry; the refresh
    // token is in the HttpOnly cookie (not visible to JS), so we always attempt
    // the refresh and let the backend decide — if it fails, the session is dead.
    if (status === 401 && original && !original._retried && !isAuthCall) {
      original._retried = true;
      if (!refreshInFlight) {
        refreshInFlight = runRefresh().finally(() => { refreshInFlight = null; });
      }
      const newToken = await refreshInFlight;
      if (newToken) {
        original.headers = original.headers ?? {};
        (original.headers as Record<string, string>).Authorization = `Bearer ${newToken}`;
        return api(original);
      }
      forceLogout();
      return Promise.reject(error);
    }

    // 403: ambiguous — permission denial vs dead token. Only when we hold a
    // token, on a non-auth call, probe /auth/me ONCE to tell them apart and
    // log out only if the token is genuinely dead. (deadSessionChecked guards
    // against probing repeatedly when many calls 403 at once.)
    if (status === 403 && hasToken && !isAuthCall && !deadSessionChecked) {
      deadSessionChecked = true;
      if (await tokenIsDead()) {
        forceLogout();
      }
    }

    return Promise.reject(error);
  },
);

// Helpers for the auth flow, kept close to the client so call sites don't
// have to remember endpoint paths.
export const authApi = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  me: () => api.get('/auth/me'),
  // Logout: the refresh token is in the HttpOnly cookie (sent via
  // withCredentials), so no body is needed. The backend clears the cookie.
  logout: () => api.post('/auth/logout', {}),
  // Single-use refresh. The refresh token rides in the cookie; no body needed.
  refresh: () =>
    api.post<{ access_token: string }>('/auth/refresh', {}),
  // Re-send the email-verification link for an unverified account.
  resendVerification: (email: string) =>
    api.post<{ message: string }>('/auth/resend-verification', { email }),
  // ── Public auth-flow endpoints (no token) ──────────────────────────
  // Anti-enumeration: always 200 regardless of whether the email exists.
  forgotPassword: (email: string) =>
    api.post('/auth/forgot-password', { email }),
  // Validate an invite/reset token on page load (does not consume it).
  verifyInvitation: (token: string) =>
    api.get<{ valid: boolean; email?: string; purpose?: 'invite' | 'reset'; reason?: string }>(
      '/auth/invitation/verify', { params: { token } },
    ),
  // Consume an invite/reset token by setting the new password.
  setPasswordViaInvitation: (token: string, new_password: string) =>
    api.post<{ success: boolean; email: string; purpose: 'invite' | 'reset' }>(
      '/auth/invitation/set-password', { token, new_password },
    ),
  // Confirm an email-verification token.
  verifyEmail: (token: string) =>
    api.post<{ message: string; email: string }>('/auth/verify-email', { token }),
  // After email verification a new user sets their password: log in with the
  // temporary password from the email to get a token, then change the password.
  // (Composite client-side flow; no dedicated backend route.)
  changePasswordAfterVerification: async (tempPassword: string, newPassword: string, email: string) => {
    const temp = tempPassword.trim();
    const loginRes = await api.post<{ access_token: string }>('/auth/login', { email, password: temp });
    const token = loginRes.data.access_token;
    return api.post(
      '/users/me/password',
      { current_password: temp, new_password: newPassword },
      { headers: { Authorization: `Bearer ${token}` } },
    );
  },
  // Multi-role: flip the active role to one already in user.roles. Mints a
  // fresh access + refresh pair the caller swaps in.
  switchRole: (role: string) =>
    api.post<{ access_token: string; user: unknown }>('/auth/switch-role', { role }),
};

export const dashboardApi = {
  managerTeamOverview: (weekOffset = 0) =>
    api.get<ManagerTeamOverview>('/dashboard/manager-team-overview', {
      params: weekOffset ? { week_offset: weekOffset } : undefined,
    }),
  managerProjectHealth: () =>
    api.get<ManagerProjectHealth>('/dashboard/manager-project-health'),
  managerFinancials: () =>
    api.get<ManagerFinancials>('/dashboard/manager-financials'),
  myWork: () => api.get<MyWork>('/dashboard/my-work'),
  teamDailyOverview: () =>
    api.get<TeamDailyOverview>('/dashboard/team-daily-overview'),
  teamRejectionStats: (days_back = 90) =>
    api.get<TeamRejectionStats>('/dashboard/team-rejection-stats', {
      params: { days_back },
    }),
  teamBillableStats: (days_back = 90) =>
    api.get<TeamBillableStats>('/dashboard/team-billable-stats', {
      params: { days_back },
    }),
  teamOnTimeStats: (days_back = 90) =>
    api.get<TeamOnTimeStats>('/dashboard/team-on-time-stats', {
      params: { days_back },
    }),
  teamProjectMatrix: (days_back = 30) =>
    api.get<TeamProjectMatrix>('/dashboard/team-project-matrix', {
      params: { days_back },
    }),
  teamResourcing: (weeks_ahead = 4) =>
    api.get<TeamResourcing>('/dashboard/team-resourcing', { params: { weeks_ahead } }),
  portfolio: () => api.get<Portfolio>('/dashboard/portfolio'),
  evm: () => api.get<EvmData>('/dashboard/evm'),
  revenueRecognition: () => api.get<RevRec>('/dashboard/revenue-recognition'),
  managerClients: () => api.get<ManagerClients>('/dashboard/manager-clients'),
  projectTaskBreakdown: (projectId: number) =>
    api.get<ProjectTaskBreakdown>(`/dashboard/project/${projectId}/task-breakdown`),
  healthConfig: () => api.get<HealthConfigResponse>('/dashboard/health-config'),
  setHealthConfig: (scope: 'workspace' | 'override', body: HealthConfigBody) =>
    api.put<HealthConfigResponse>('/dashboard/health-config', body, { params: { scope } }),
  clearHealthOverride: () => api.delete('/dashboard/health-config/override'),
  // Per-project manual health override. `health: null` clears it (back to auto).
  setProjectHealthOverride: (projectId: number, health: string | null) =>
    api.put<{ project_id: number; health_override: string | null }>(
      `/dashboard/project/${projectId}/health-override`, { health }),
};

export const timeApi = {
  // /timesheets/my returns a flat TimeEntry[]; date filters are inclusive.
  myEntries: (start_date?: string, end_date?: string) =>
    api.get<TimeEntry[]>('/timesheets/my', {
      params: { start_date, end_date },
    }),
  // Full param surface (sort, status, search) matching frontend2's list.
  list: (params?: ListEntriesParams) =>
    api.get<TimeEntry[]>('/timesheets/my', { params }),
  create: (data: CreateTimeEntry) => api.post<TimeEntry>('/timesheets', data),
  update: (id: number, data: UpdateTimeEntry) =>
    api.put<TimeEntry>(`/timesheets/${id}`, data),
  remove: (id: number) => api.delete(`/timesheets/${id}`),
  submit: (entry_ids: number[], approver_manager_id?: number | null) =>
    api.post('/timesheets/submit', { entry_ids, approver_manager_id }),
  // Un-submit SUBMITTED entries back to DRAFT. 409 if a manager already acted.
  recall: (entry_ids: number[]) =>
    api.post('/timesheets/recall', { entry_ids }),
  weeklyStatus: () =>
    api.get<WeeklySubmissionStatus>('/timesheets/weekly-submit-status'),
  // Parse a natural-language sentence into draft rows (does NOT save).
  parseNatural: (text: string) =>
    api.post<ParseNaturalResult>('/timesheets/parse-natural', { text }),
  // Server-side CSV export. Role-scoped (admin/manager -> tenant, employee ->
  // own). Filterable by date range + status. Returns a CSV blob.
  exportCsv: (params?: { start_date?: string; end_date?: string; status?: string }) =>
    api.get('/timesheets/export', { params, responseType: 'blob' }),
};

export const projectsApi = {
  list: (params?: { active_only?: boolean; client_id?: number; limit?: number; loggable_only?: boolean }) =>
    api.get<Project[]>('/projects', { params }),
  nextCode: () => api.get<{ code: string }>('/projects/next-code'),
  create: (data: ProjectBody) => api.post<FullProject>('/projects', data),
  update: (id: number, data: ProjectBody) => api.put<FullProject>(`/projects/${id}`, data),
  remove: (id: number) => api.delete(`/projects/${id}`),
  archive: (id: number) => api.post<FullProject>(`/projects/${id}/archive`),
  unarchive: (id: number) => api.post<FullProject>(`/projects/${id}/unarchive`),
};

export const tasksApi = {
  list: (params?: { project_id?: number; active_only?: boolean; limit?: number }) =>
    api.get<Task[]>('/tasks', { params }),
  create: (data: TaskBody) => api.post<FullTask>('/tasks', data),
  update: (id: number, data: TaskBody) => api.put<FullTask>(`/tasks/${id}`, data),
  remove: (id: number) => api.delete(`/tasks/${id}`),
  // Scoped edit for an assignee: status and/or description only (My Work).
  updateProgress: (id: number, body: { status?: string; description?: string }) =>
    api.patch<{ id: number; status: string | null; description: string | null }>(`/tasks/${id}/progress`, body),
};

export const approvalsApi = {
  // Both return a flat TimeEntry[] with eager-loaded user + project.
  // Request the full backlog (limit=1000) so the week grouping on the
  // Approvals page never silently drops the oldest pending weeks.
  pending: () => api.get<TimeEntry[]>('/approvals/pending', { params: { limit: 1000 } }),
  history: () =>
    api.get<TimeEntry[]>('/approvals/history', { params: { limit: 100 } }),
  // Approval history grouped by employee-week with per-entry detail and
  // approved/rejected/mixed status. Optional days-back window + status filter.
  historyGrouped: (params?: { days_back?: number; status_filter?: 'approved' | 'rejected' | 'mixed' }) =>
    api.get<HistoryGroup[]>('/approvals/history-grouped', { params }),
  batchApprove: (entry_ids: number[]) =>
    api.post('/approvals/batch-approve', { entry_ids }),
  batchReject: (entry_ids: number[], rejection_reason: string) =>
    api.post('/approvals/batch-reject', { entry_ids, rejection_reason }),
};

export const usersApi = {
  list: () => api.get<ManagedUser[]>('/users'),
  // Paged + searchable list. Reads the total match count from X-Total-Count
  // so the rail can render a numbered pager without loading the whole roster.
  listPaged: async (params: UserListParams = {}): Promise<UserPage> => {
    const res = await api.get<ManagedUser[]>('/users', { params });
    const total = Number(res.headers['x-total-count'] ?? res.data.length);
    return { items: res.data, total: Number.isFinite(total) ? total : res.data.length };
  },
  // Users an admin/manager may assign as a manager (role-scoped server-side).
  assignable: () => api.get<ManagedUser[]>('/users/assignable'),
  create: (data: CreateUserBody) => api.post<CreateUserResult>('/users', data),
  update: (id: number, data: UpdateUserBody) =>
    api.put<ManagedUser>(`/users/${id}`, data),
  remove: (id: number) => api.delete(`/users/${id}`),
  bulkDelete: (user_ids: number[]) =>
    api.post('/users/bulk-delete', { user_ids }),
  resetPassword: (id: number, new_password: string) =>
    api.post(`/users/${id}/reset-password`, { new_password }),
  sendInvite: (id: number) => api.post(`/users/${id}/send-invite`),
  // CSV/XLSX export of the workspace's users (blob), with optional filters.
  // Backend (users.py export_users) accepts fmt + user_type/role/status_filter/
  // client_id/department.
  exportUsers: (params?: { fmt?: 'csv' | 'xlsx'; user_type?: string; role?: string; status_filter?: string; client_id?: number; department?: string }) =>
    api.get('/users/export/users', { params, responseType: 'blob' }),
  // CSV/XLSX export of clients (blob).
  exportClients: (params?: { fmt?: 'csv' | 'xlsx' }) =>
    api.get('/users/export/clients', { params, responseType: 'blob' }),
  // CSV/XLSX export of timesheets, filterable (blob).
  exportTimesheets: (params?: { fmt?: 'csv' | 'xlsx'; period_start?: string; period_end?: string; user_type?: string; user_id?: number; client_id?: number; project_id?: number }) =>
    api.get('/users/export/timesheets', { params, responseType: 'blob' }),
  // ── Bulk CSV import: preview -> validate -> commit ──────────────────
  importPreview: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post<ImportPreview>('/users/import/preview', form, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  importValidate: (body: { mapping: Record<string, string>; rows: string[][]; headers: string[] }) =>
    api.post<ImportValidateResult>('/users/import/validate', body),
  importCommit: (body: ImportCommitBody) =>
    api.post<ImportCommitResult>('/users/import/commit', body),
  // Clear a locked timesheet for a user. NOTE the doubled /users prefix — the
  // backend route is declared "/users/{id}/unlock-timesheet" under a /users
  // router, so the reachable path really is /users/users/{id}/...
  unlockTimesheet: (id: number) =>
    api.post<{ success: boolean; user_id: number }>(`/users/users/${id}/unlock-timesheet`, {}),
  // Email aliases (admin-managed extra addresses on a user).
  aliases: (id: number) => api.get<EmailAlias[]>(`/users/${id}/email-aliases`),
  addAlias: (id: number, email: string) => api.post<EmailAlias>(`/users/${id}/email-aliases`, { email }),
  removeAlias: (id: number, aliasId: number) => api.delete(`/users/${id}/email-aliases/${aliasId}`),
  // Per-user client assignments (separate from default_client_id).
  clients: (id: number) => api.get<UserClientAssignment[]>(`/users/${id}/clients`),
  addClient: (id: number, clientId: number) => api.post(`/users/${id}/clients/${clientId}`, {}),
  removeClient: (id: number, clientId: number) => api.delete(`/users/${id}/clients/${clientId}`),
};

// Client Portal Access. The /client-portal/* calls are what a CLIENT user
// makes; the /client-grants/* calls are PM/admin grant management.
export const clientPortalApi = {
  // CLIENT side
  myProjects: () => api.get<PortalProject[]>('/client-portal/projects'),
  updateTask: (taskId: number, body: { status?: string; description?: string }) =>
    api.patch<{ id: number; status: string; description: string | null }>(`/client-portal/tasks/${taskId}`, body),
  createTask: (body: { project_id: number; name: string; description?: string }) =>
    api.post<{ id: number; project_id: number; name: string; status: string }>('/client-portal/tasks', body),
  deleteTask: (taskId: number) => api.delete(`/client-portal/tasks/${taskId}`),
  updateProject: (projectId: number, body: { description?: string }) =>
    api.patch<{ id: number; description: string | null }>(`/client-portal/projects/${projectId}`, body),
  // Orienting context for any client-side user (org, role, manager, account team).
  portalContext: () => api.get<PortalContext>('/client-portal/context'),
  // CLIENT_MANAGER side (two-tier portal): manage own employees + review.
  managerContext: () => api.get<ClientManagerContext>('/client-portal/manage/me'),
  managerEmployees: () => api.get<ClientEmployeeSummary[]>('/client-portal/manage/employees'),
  managerAssignable: () => api.get<PortalProject[]>('/client-portal/manage/assignable'),
  managerInvite: (body: { full_name: string; email: string; label?: string }) =>
    api.post<{ user_id: number; email: string; invited: boolean; message: string }>('/client-portal/manage/employees/invite', body),
  managerRemoveEmployee: (userId: number) => api.delete(`/client-portal/manage/employees/${userId}`),
  managerAssign: (body: { employee_user_id: number; project_id?: number | null; task_id?: number | null; capabilities: string[] }) =>
    api.post<{ id: number; updated: boolean }>('/client-portal/manage/assign', body),
  managerUnassign: (grantId: number) => api.delete(`/client-portal/manage/assign/${grantId}`),
  managerReviewFeed: (statusFilter?: string) =>
    api.get<ClientReviewItem[]>(`/client-portal/manage/review${statusFilter ? `?status_filter=${statusFilter}` : ''}`),
  managerApproveReview: (reviewId: number, note?: string) =>
    api.post<{ review_id: number; status: string }>(`/client-portal/manage/review/${reviewId}/approve`, { note }),
  managerRejectReview: (reviewId: number, note?: string) =>
    api.post<{ review_id: number; status: string }>(`/client-portal/manage/review/${reviewId}/reject`, { note }),
  // PM / admin side
  userGrants: (userId: number) => api.get<ClientGrant[]>(`/client-grants/user/${userId}`),
  clientUsers: (clientId: number) => api.get<ClientPortalUser[]>(`/client-grants/client/${clientId}`),
  createGrant: (body: { user_id: number; project_id?: number | null; task_id?: number | null; capabilities: ClientCapability[] }) =>
    api.post<ClientGrant>('/client-grants', body),
  updateGrant: (grantId: number, capabilities: ClientCapability[]) =>
    api.put<ClientGrant>(`/client-grants/${grantId}`, { capabilities }),
  revokeGrant: (grantId: number) => api.delete(`/client-grants/${grantId}`),
  // Delete a client account entirely (its grants + the user). Works at 0 scopes.
  deleteClientUser: (userId: number) => api.delete(`/client-grants/user/${userId}`),
  // Re-send the client-portal set-password invite to a client user who hasn't
  // accepted yet. Dedicated client endpoint (the internal one rejects externals
  // and sends the wrong email).
  resendInvite: (userId: number) =>
    api.post<{ message: string }>(`/client-grants/user/${userId}/resend-invite`),
  // Update a client user's profile (name, email, title) from client management.
  updateClientUser: (userId: number, body: { full_name?: string; email?: string; title?: string | null }) =>
    api.patch<{ id: number; full_name: string; email: string; title: string | null }>(`/client-grants/user/${userId}`, body),
  invite: (body: ClientInviteBody) =>
    api.post<{ user_id: number; email: string; invited: boolean; message: string }>('/client-grants/invite', body),
};

export const clientsApi = {
  list: () => api.get<Client[]>('/clients'),
  create: (data: ClientBody) => api.post<Client>('/clients', data),
  // Bulk import: clients + projects + tasks + assignments from an XLSX/CSV.
  importTemplate: () => api.get('/clients/import/template', { responseType: 'blob' }),
  importPreview: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post<ClientImportPreview>('/clients/import/preview', form,
      { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  importCommit: (data: ClientImportPreview['data']) =>
    api.post<ClientImportResult>('/clients/import/commit', { data }),
  update: (id: number, data: Partial<ClientBody>) => api.put<Client>(`/clients/${id}`, data),
  remove: (id: number) => api.delete(`/clients/${id}`),
  bulkDelete: (client_ids: number[]) => api.post('/clients/bulk-delete', { client_ids }),
  // Create a client from an email domain (used in ingestion review); cascades
  // the assignment to pending timesheets from that domain.
  createFromDomain: (name: string, domain: string) =>
    api.post<{ client: Client; domain: string; cascaded_count: number }>('/clients/from-domain', { name, domain }),
  // Client team roster (PMs + members with assignment_role).
  team: (id: number) => api.get<ClientTeamMember[]>(`/clients/${id}/team`),
  setTeam: (id: number, data: ClientTeamBody) =>
    api.put<ClientTeamMember[]>(`/clients/${id}/team`, data),
};

// Client contracts (Phase B). Nested under a client.
export const contractsApi = {
  list: (clientId: number) => api.get<Contract[]>(`/clients/${clientId}/contracts`),
  create: (clientId: number, data: ContractBody) =>
    api.post<Contract>(`/clients/${clientId}/contracts`, data),
  update: (clientId: number, id: number, data: ContractBody) =>
    api.put<Contract>(`/clients/${clientId}/contracts/${id}`, data),
  remove: (clientId: number, id: number) =>
    api.delete(`/clients/${clientId}/contracts/${id}`),
  uploadDocument: (clientId: number, id: number, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post<Contract>(`/clients/${clientId}/contracts/${id}/document`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  deleteDocument: (clientId: number, id: number) =>
    api.delete<Contract>(`/clients/${clientId}/contracts/${id}/document`),
  // Download URL for the attached document (opened/fetched with auth interceptor).
  documentUrl: (clientId: number, id: number) =>
    `/clients/${clientId}/contracts/${id}/document`,
  downloadDocument: (clientId: number, id: number) =>
    api.get<Blob>(`/clients/${clientId}/contracts/${id}/document`, { responseType: 'blob' }),
  // Inline disposition + real content type, so previewable files (PDF/image)
  // render in a new tab instead of downloading.
  viewDocument: (clientId: number, id: number) =>
    api.get<Blob>(`/clients/${clientId}/contracts/${id}/document?disposition=inline`, { responseType: 'blob' }),
};

// Phase C: client contacts, role rates, notes (all nested under a client).
export const clientContactsApi = {
  list: (cid: number) => api.get<ClientContact[]>(`/clients/${cid}/contacts2`),
  create: (cid: number, data: ClientContactBody) => api.post<ClientContact>(`/clients/${cid}/contacts2`, data),
  update: (cid: number, id: number, data: ClientContactBody) => api.put<ClientContact>(`/clients/${cid}/contacts2/${id}`, data),
  remove: (cid: number, id: number) => api.delete(`/clients/${cid}/contacts2/${id}`),
};
export const roleRatesApi = {
  list: (cid: number) => api.get<ClientRoleRate[]>(`/clients/${cid}/role-rates`),
  create: (cid: number, data: ClientRoleRateBody) => api.post<ClientRoleRate>(`/clients/${cid}/role-rates`, data),
  update: (cid: number, id: number, data: ClientRoleRateBody) => api.put<ClientRoleRate>(`/clients/${cid}/role-rates/${id}`, data),
  remove: (cid: number, id: number) => api.delete(`/clients/${cid}/role-rates/${id}`),
};
export const clientNotesApi = {
  list: (cid: number) => api.get<ClientNote[]>(`/clients/${cid}/notes`),
  create: (cid: number, data: ClientNoteBody) => api.post<ClientNote>(`/clients/${cid}/notes`, data),
  update: (cid: number, id: number, data: ClientNoteBody) => api.put<ClientNote>(`/clients/${cid}/notes/${id}`, data),
  remove: (cid: number, id: number) => api.delete(`/clients/${cid}/notes/${id}`),
};

export const auditApi = {
  list: (params?: { limit?: number; offset?: number; activity_type?: string; search?: string }) =>
    api.get<AuditEvent[]>('/dashboard/audit-trail', { params: { limit: 50, ...params } }),
};

// In-app notifications (the bell). summary returns total + route-scoped counts
// + items; read/delete take { notification_id }.
export const notificationsApi = {
  summary: () => api.get<NotificationSummary>('/notifications/summary'),
  markRead: (notification_id: string) => api.post('/notifications/read', { notification_id }),
  markAllRead: () => api.post('/notifications/read-all', {}),
  deleteOne: (notification_id: string) => api.post('/notifications/delete', { notification_id }),
  deleteAll: () => api.post('/notifications/delete-all', {}),
};

// Per-user dismissal/snooze of dashboard attention-queue cards.
export const attentionSignalsApi = {
  dismissed: () => api.get<DismissedSignal[]>('/attention-signals/dismissed'),
  dismiss: (signal_key: string, snoozed_until?: string) =>
    api.post('/attention-signals', snoozed_until ? { signal_key, snoozed_until } : { signal_key }),
  undismiss: (signal_key: string) => api.delete(`/attention-signals/${encodeURIComponent(signal_key)}`),
};

export const adminApi = {
  // Per-service infra health for the admin dashboard.
  systemHealth: () => api.get<SystemHealthCheck[]>('/admin/system-health'),
  // Workspace recent-activity feed (richer than the audit-trail; same source).
  recentActivity: (limit = 12) =>
    api.get<AuditEvent[]>('/dashboard/recent-activity', { params: { limit } }),
  // Approved inbox-ingested (PDF) timesheets for the Approved Timesheets tab.
  // Admin-permissive endpoint (the reviewer /ingestion/timesheets 403s for ADMIN).
  approvedIngestionTimesheets: (params?: { employee_id?: number; scope?: 'mine' | 'workspace' }) =>
    api.get<IngestionTimesheetSummary[]>('/admin/approved-ingestion-timesheets', { params }),
  // Source-file viewer for an approved-ingestion attachment. full-html returns a
  // sanitized HTML render (spreadsheets); file returns the raw bytes (pdf/image).
  approvedIngestionAttachmentHtml: (attachmentId: number) =>
    api.get<{ html: string; filename: string } & Record<string, unknown>>(`/admin/approved-ingestion-attachments/${attachmentId}/full-html`),
  approvedIngestionAttachmentFile: (attachmentId: number) =>
    api.get(`/admin/approved-ingestion-attachments/${attachmentId}/file`, { responseType: 'blob' }),
};

export const dashboardSummaryApi = {
  // Personal summary (hours logged/approved/pending) — powers the employee
  // dashboard. Available to any authenticated user for their own scope.
  summary: () => api.get<DashboardSummary>('/dashboard/summary'),
  // Per-range analytics — powers the employee widget grid.
  analytics: (params: { start_date: string; end_date: string; project_id?: number; user_id?: number }) =>
    api.get<DashboardAnalytics>('/dashboard/analytics', { params }),
};

export const timeOffApi = {
  mine: () => api.get<TimeOffRequest[]>('/time-off/my'),
  usageSummary: () => api.get<TimeOffUsageRow[]>('/time-off/usage-summary'),
  create: (data: {
    request_date: string;
    hours: number;
    leave_type: string;
    reason: string;
  }) => api.post<TimeOffRequest>('/time-off', data),
  update: (
    id: number,
    data: Partial<{ request_date: string; hours: number; leave_type: string; reason: string }>,
  ) => api.put<TimeOffRequest>(`/time-off/${id}`, data),
  submit: (request_ids: number[]) =>
    api.post('/time-off/submit', { request_ids }),
  remove: (id: number) => api.delete(`/time-off/${id}`),
  // Manager surface (/time-off-approvals).
  pending: () => api.get<TimeOffRequestWithUser[]>('/time-off-approvals/pending'),
  approvalHistory: () => api.get<TimeOffRequestWithUser[]>('/time-off-approvals/history'),
  approve: (id: number) => api.post(`/time-off-approvals/${id}/approve`, {}),
  reject: (id: number, rejection_reason: string) =>
    api.post(`/time-off-approvals/${id}/reject`, { rejection_reason }),
};

export const leaveTypesApi = {
  list: (includeInactive = false) =>
    api.get<LeaveType[]>('/leave-types', { params: includeInactive ? { include_inactive: true } : undefined }),
  create: (data: { label: string; code?: string; color?: string }) =>
    api.post<LeaveType>('/leave-types', data),
  // Rename / recolor / activate-deactivate (PATCH; partial).
  update: (id: number, data: Partial<{ label: string; color: string; is_active: boolean }>) =>
    api.patch<LeaveType>(`/leave-types/${id}`, data),
  remove: (id: number) => api.delete(`/leave-types/${id}`),
};

export const departmentsApi = {
  list: () => api.get<Department[]>('/departments'),
  create: (name: string) => api.post<Department>('/departments', { name }),
  remove: (id: number) => api.delete(`/departments/${id}`),
};

export const titlesApi = {
  list: () => api.get<Title[]>('/titles'),
  create: (name: string) => api.post<Title>('/titles', { name }),
  remove: (id: number) => api.delete(`/titles/${id}`),
};

// Team timesheets for the Approved-Timesheets tab (admin/manager scope).
export const teamTimesheetsApi = {
  list: (params?: {
    user_id?: number; start_date?: string; end_date?: string; status?: string;
    sort_by?: 'entry_date' | 'created_at' | 'hours' | 'status'; sort_order?: 'asc' | 'desc'; limit?: number;
  }) => api.get<TimeEntry[]>('/timesheets/all', { params }),
};

// Self-service profile + password. Profile fields are name/title/timezone/
// username (email only editable by platform admins, enforced server-side).
export const meApi = {
  profile: () => api.get<UserProfile>('/users/me/profile'),
  updateProfile: (data: Partial<{ full_name: string; title: string; timezone: string; username: string }>) =>
    api.patch<ManagedUser>('/users/me/profile', data),
  changePassword: (current_password: string, new_password: string) =>
    api.post('/users/me/password', { current_password, new_password }),
  // Per-user UI preferences (theme/palette/landing/page_size/inbox_view_mode/…).
  // GET merges in the tenant's customization defaults for a brand-new user, so
  // the returned object is the user's EFFECTIVE preferences. PATCH merges only
  // the sent keys; sending null deletes a key.
  preferences: () => api.get<Record<string, unknown>>('/users/me/preferences'),
  updatePreferences: (patch: Record<string, unknown>) =>
    api.patch<Record<string, unknown>>('/users/me/preferences', patch),
};

export const holidaysApi = {
  list: (params?: { start_date?: string; end_date?: string; country?: string }) =>
    api.get<Holiday[]>('/holidays', { params }),
  create: (data: { date: string; name: string; holiday_type: 'PUBLIC' | 'COMPANY'; country?: string | null }) =>
    api.post<Holiday>('/holidays', data),
  remove: (id: number) => api.delete(`/holidays/${id}`),
  countries: () => api.get<string[]>('/holidays/countries'),
  // Public-holiday import: preview suggestions for a country/year, then bulk-add.
  suggestions: (country: string, year: number) =>
    api.get<{ country: string; year: number; holidays: { date: string; name: string; country: string }[] }>('/holidays/suggestions', { params: { country, year } }),
  bulkCreate: (holidays: { date: string; name: string; holiday_type: 'PUBLIC' | 'COMPANY'; country?: string | null }[]) =>
    api.post<Holiday[]>('/holidays/bulk', { holidays }),
};

// Catalog-driven tenant settings. The catalog defines the fields; values are a
// flat { key: value } map. PATCH sends only the keys that changed. We render
// and write existing keys only; we never add or rename keys.
export const tenantSettingsApi = {
  catalog: () => api.get<SettingDefinition[]>('/users/tenant-settings/catalog'),
  values: () => api.get<Record<string, SettingValue>>('/users/tenant-settings'),
  // Public subset (is_public=true), readable by ANY authenticated user (not
  // just admins). Used by the shell to read the navigation policy
  // (default_nav_layout / nav_switch_enabled / nav_switch_user_ids) for everyone.
  publicValues: () => api.get<Record<string, SettingValue>>('/users/tenant-settings/public'),
  update: (patch: Record<string, SettingValue>) =>
    api.patch<Record<string, SettingValue>>('/users/tenant-settings', patch),
  // Specialised settings actions.
  smtpTest: () => api.post<{ ok: boolean; detail?: string }>('/users/smtp-test', {}),
  emailTemplatePreview: (data: { purpose: string; subject?: string; greeting?: string; body?: string; button_label?: string; signoff?: string }) =>
    api.post<{ subject?: string; html?: string; text?: string } & Record<string, unknown>>('/users/email-template-preview', data),
};

// Tenant branding (logo) + feature flags.
export const brandingApi = {
  // The caller's own tenant (workspace) — name, slug, status, branding flags.
  // Any authenticated tenant user may call this. Used for the top-nav workspace
  // label.
  mine: () => api.get<{ id: number; name: string; slug: string; status: string; has_logo: boolean }>('/tenants/mine'),
  features: () => api.get<{ tenant_id: number; custom_outbound_email: boolean; custom_email_template: boolean }>('/tenants/mine/features'),
  logoUrl: '/admin/tenant/logo', // GET (auth-attached) returns the bytes
  uploadLogo: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post('/admin/tenant/logo', form, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  deleteLogo: () => api.delete('/admin/tenant/logo'),
};

// Platform-admin (control-plane) console. PA tokens are accepted by these
// routes; the /tenants endpoints are the control plane, /platform/* are the
// fleet dashboard/audit/calendar/settings surfaces.
export const platformApi = {
  tenants: (include_archived = false) =>
    api.get<Tenant[]>('/tenants', { params: include_archived ? { include_archived: true } : undefined }),
  tenant: (id: number) => api.get<Tenant>(`/tenants/${id}`),
  createTenant: (data: CreateTenantBody) => api.post<Tenant>('/tenants', data),
  addTenantAdmin: (id: number, data: { full_name: string; email: string }) =>
    api.post<{ id: number; email: string; invited: boolean }>(`/tenants/${id}/admins`, data),
  updateTenant: (id: number, data: Partial<{ name: string; slug: string; status: string; ingestion_enabled: boolean; max_mailboxes: number; timezone: string }>) =>
    api.patch<Tenant>(`/tenants/${id}`, data),
  tenantLifecycle: (id: number, action: string, confirmation_token?: string) =>
    api.post<Tenant>(`/tenants/${id}/lifecycle`, { action, confirmation_token }),
  tenantUsersCount: () => api.get<{ counts: Record<number, number>; failed_tenant_ids: number[] }>('/platform/tenants/users-count'),
  summary: () => api.get<PlatformSummary>('/platform/dashboard/summary'),
  health: () => api.get<PlatformHealth>('/platform/dashboard/health'),
  // The backend (platform_dashboard.list_audit_events) AND-combines all of
  // these filters server-side: category, tenant_id, search (ILIKE on summary/
  // actor_email/tenant_name/request_ip), range_start/range_end (date), plus
  // limit/offset. We forward the whole surface so paging totals stay correct.
  audit: (params?: PlatformAuditParams) =>
    api.get<PlatformAuditList>('/platform/audit', { params }),
  // Single audit-event detail (for the drawer): includes user_agent + before/
  // after JSON state that the list omits.
  auditEvent: (eventId: number) =>
    api.get<PlatformAuditEventDetail>(`/platform/audit/${eventId}`),
  calendar: (params?: { range_start?: string; range_end?: string }) =>
    api.get<PlatformCalendarResponse>('/platform/calendar/events', { params }),
  getSmtp: () => api.get<SmtpConfig>('/platform/settings/smtp'),
  updateSmtp: (data: SmtpConfigUpdate) =>
    api.put<SmtpConfig>('/platform/settings/smtp', data),
  // Drop the DB-stored SMTP config so env vars take effect again.
  deleteSmtp: () => api.delete('/platform/settings/smtp'),
  // Per-tenant compact stats (user/admin counts, last activity), keyed by id.
  tenantStats: () => api.get<{ stats: Record<number, TenantStatsEntry> }>('/platform/tenants/stats'),
  // Per-tenant feature flags (read + partial update).
  tenantFeatures: (id: number) => api.get<TenantFeatures>(`/tenants/${id}/features`),
  updateTenantFeatures: (id: number, updates: Partial<Omit<TenantFeatures, 'tenant_id'>>) =>
    api.patch<TenantFeatures>(`/tenants/${id}/features`, updates),
  // Service tokens (inter-service auth) per tenant. create returns the
  // plaintext token ONCE.
  serviceTokens: (id: number) => api.get<ServiceToken[]>(`/tenants/${id}/service-tokens`),
  createServiceToken: (id: number, data: { name: string; issuer: string }) =>
    api.post<ServiceToken & { token: string }>(`/tenants/${id}/service-tokens`, data),
  revokeServiceToken: (id: number, tokenId: number) =>
    api.delete(`/tenants/${id}/service-tokens/${tokenId}`),
  // Provision the tenant's system (ingestion) user.
  provisionSystemUser: (id: number) =>
    api.post<Record<string, unknown>>(`/tenants/${id}/provision-system-user`, {}),
};

export const mailboxesApi = {
  list: () => api.get<Mailbox[]>('/mailboxes'),
  create: (data: MailboxCreateBody) => api.post<Mailbox>('/mailboxes', data),
  remove: (id: number) => api.delete(`/mailboxes/${id}`),
  test: (id: number) => api.post<{ success: boolean; error: string | null; latency_ms: number; message_count: number }>(`/mailboxes/${id}/test`, {}),
  resetCursor: (id: number) => api.post(`/mailboxes/${id}/reset-cursor`, {}),
  tryAgain: (id: number) => api.post<Mailbox>(`/mailboxes/${id}/try-again`, {}),
  // Returns an OAuth consent URL to redirect to for google/microsoft.
  oauthConnect: (provider: 'google' | 'microsoft') =>
    api.get<{ auth_url: string }>(`/mailboxes/oauth/connect/${provider}`),
};

export const ingestionApi = {
  list: () => api.get<IngestionSummary[]>('/ingestion/timesheets'),
  detail: (id: number) => api.get<IngestionDetail>(`/ingestion/timesheets/${id}`),
  approve: (id: number, comment?: string) =>
    api.post<IngestionApprovalResult>(`/ingestion/timesheets/${id}/approve`, comment ? { comment } : {}),
  reject: (id: number, reason: string, comment?: string) =>
    api.post(`/ingestion/timesheets/${id}/reject`, comment ? { reason, comment } : { reason }),
  hold: (id: number, comment?: string) =>
    api.post(`/ingestion/timesheets/${id}/hold`, comment ? { comment } : {}),
  // Assign / correct the employee, client, period etc. on a parsed timesheet.
  updateData: (id: number, data: Partial<{ employee_id: number | null; client_id: number | null; extracted_supervisor_name: string; period_start: string; period_end: string; internal_notes: string }>) =>
    api.patch(`/ingestion/timesheets/${id}/data`, data),
  // Re-run the LLM pipeline on the source email.
  reprocessEmail: (emailId: number) =>
    api.post(`/ingestion/emails/${emailId}/reprocess`, {}),
  // Trigger a mailbox fetch for the tenant; returns a job id.
  fetchEmails: () => api.post<{ job_id: string; status: string; message?: string }>('/ingestion/fetch-emails', {}),
  updateLineItem: (
    tid: number,
    itemId: number,
    data: Partial<{ work_date: string; hours: number; description: string; project_code: string; project_id: number }>,
  ) => api.patch<IngestionLineItem>(`/ingestion/timesheets/${tid}/line-items/${itemId}`, data),
  addLineItem: (tid: number, data: { work_date: string; hours: number; description?: string; project_code?: string; project_id?: number }) =>
    api.post<IngestionLineItem>(`/ingestion/timesheets/${tid}/line-items`, data),
  removeLineItem: (tid: number, itemId: number) =>
    api.delete(`/ingestion/timesheets/${tid}/line-items/${itemId}`),

  // ── Fetch-job lifecycle ───────────────────────────────────────────
  fetchJobStatus: (jobId: string) => api.get<FetchJobStatus>(`/ingestion/fetch-emails/status/${jobId}`),
  cancelFetchJob: (jobId: string) => api.post<FetchJobStatus>(`/ingestion/fetch-emails/cancel/${jobId}`, {}),

  // ── Skipped emails (classified not-a-timesheet) ───────────────────
  listSkipped: () => api.get<SkippedEmailOverview>('/ingestion/skipped-emails'),
  promoteSkipped: (emailId: number) => api.post(`/ingestion/skipped-emails/${emailId}/promote`, {}),
  confirmSkip: (emailId: number) => api.post(`/ingestion/skipped-emails/${emailId}/confirm-skip`, {}),

  // ── Stored-email detail + reprocess + delete ──────────────────────
  getEmail: (emailId: number) => api.get<StoredEmailDetail>(`/ingestion/emails/${emailId}`),
  // Reprocess a stored email (optionally a subset of its attachments).
  // Returns ReprocessStoredEmailResponse: { job_id, status, mode, email_id }.
  reprocessStoredEmail: (emailId: number, attachmentIds?: number[]) =>
    api.post<{ job_id: string; status: string; mode: string; email_id: number }>(
      '/ingestion/fetch-emails/reprocess',
      attachmentIds ? { email_id: emailId, attachment_ids: attachmentIds } : { email_id: emailId },
    ),
  bulkReprocess: (emailIds: number[]) => api.post('/ingestion/fetch-emails/bulk-reprocess', { email_ids: emailIds }),
  deleteEmail: (emailId: number, refetch = false) =>
    api.delete(`/ingestion/emails/${emailId}`, { params: { refetch } }),
  bulkDeleteEmails: (emailIds: number[], refetch = false) =>
    api.post('/ingestion/emails/bulk-delete', { email_ids: emailIds, refetch }),

  // ── Attachment preview (binary file + rendered full HTML) ─────────
  attachmentFileUrl: (attachmentId: number) => `/ingestion/attachments/${attachmentId}/file`,
  attachmentFullHtml: (attachmentId: number) =>
    api.get<{ html: string } & Record<string, unknown>>(`/ingestion/attachments/${attachmentId}/full-html`),

  // ── Forwarded-chain employee assignment ───────────────────────────
  assignChainCandidate: (id: number, data: { name?: string; email?: string }) =>
    api.post(`/ingestion/timesheets/${id}/assign-chain-candidate`, data),

  // ── Line-item + whole-timesheet rejection recovery ────────────────
  rejectLineItem: (tid: number, itemId: number, reason?: string) =>
    api.post(`/ingestion/timesheets/${tid}/line-items/${itemId}/reject`, reason ? { reason } : {}),
  unrejectLineItem: (tid: number, itemId: number) =>
    api.post(`/ingestion/timesheets/${tid}/line-items/${itemId}/unreject`, {}),
  revertRejection: (id: number) => api.post(`/ingestion/timesheets/${id}/revert-rejection`, {}),

  // ── LLM-drafted reviewer comment ──────────────────────────────────
  draftComment: (id: number, seed_text = '') => api.post<{ comment: string } & Record<string, unknown>>(`/ingestion/timesheets/${id}/draft-comment`, { seed_text }),
};
