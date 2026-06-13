import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  adminApi,
  auditApi,
  brandingApi,
  clientsApi,
  departmentsApi,
  holidaysApi,
  ingestionApi,
  leaveTypesApi,
  mailboxesApi,
  meApi,
  projectsApi,
  tasksApi,
  teamTimesheetsApi,
  tenantSettingsApi,
  timeOffApi,
  usersApi,
} from '@/api/client';
import type { CreateUserBody, SettingValue, UpdateUserBody } from '@/types/admin';

// Data hooks for the management + admin pages. Read-mostly; the time-off
// page has create/submit/delete mutations.

export function useUsers(enabled = true) {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list().then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

// Candidate managers for the user-edit manager picker (role-scoped server-side).
export function useAssignableUsers(enabled = true) {
  return useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => usersApi.assignable().then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

// Active projects for the project-access picker in the user-edit modal.
export function useAdminProjects(enabled = true) {
  return useQuery({
    queryKey: ['projects', 'active'],
    queryFn: () => projectsApi.list({ active_only: true }).then((r) => r.data),
    enabled,
    staleTime: 5 * 60_000,
  });
}

function invalidateUsers(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['users'] });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateUserBody) => usersApi.create(data).then((r) => r.data),
    onSuccess: () => invalidateUsers(qc),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateUserBody }) =>
      usersApi.update(id, data).then((r) => r.data),
    onSuccess: () => invalidateUsers(qc),
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => usersApi.remove(id),
    onSuccess: () => invalidateUsers(qc),
  });
}

export function useBulkDeleteUsers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => usersApi.bulkDelete(ids),
    onSuccess: () => invalidateUsers(qc),
  });
}

export function useResetUserPassword() {
  return useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      usersApi.resetPassword(id, password),
  });
}

export function useSendInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => usersApi.sendInvite(id),
    onSuccess: () => invalidateUsers(qc),
  });
}
// Clear a user's locked timesheet (admin) so they can edit/submit again.
export function useUnlockTimesheet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => usersApi.unlockTimesheet(id).then((r) => r.data),
    onSuccess: () => invalidateUsers(qc),
  });
}

// ── Email aliases (admin-managed extra addresses) ───────────────────
export function useUserAliases(userId: number | null) {
  return useQuery({
    queryKey: ['users', 'aliases', userId],
    queryFn: () => usersApi.aliases(userId as number).then((r) => r.data),
    enabled: userId != null,
    staleTime: 30_000,
  });
}
export function useAddAlias() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, email }: { userId: number; email: string }) => usersApi.addAlias(userId, email).then((r) => r.data),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['users', 'aliases', v.userId] }),
  });
}
export function useRemoveAlias() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, aliasId }: { userId: number; aliasId: number }) => usersApi.removeAlias(userId, aliasId),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['users', 'aliases', v.userId] }),
  });
}

// ── Per-user client assignments ─────────────────────────────────────
export function useUserClients(userId: number | null) {
  return useQuery({
    queryKey: ['users', 'clients', userId],
    queryFn: () => usersApi.clients(userId as number).then((r) => r.data),
    enabled: userId != null,
    staleTime: 30_000,
  });
}
export function useAddUserClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, clientId }: { userId: number; clientId: number }) => usersApi.addClient(userId, clientId),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['users', 'clients', v.userId] }),
  });
}
export function useRemoveUserClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, clientId }: { userId: number; clientId: number }) => usersApi.removeClient(userId, clientId),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['users', 'clients', v.userId] }),
  });
}

export function useClients(enabled = true) {
  return useQuery({
    queryKey: ['clients'],
    queryFn: () => clientsApi.list().then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

// All projects (full shape) for the client-management drill-in. Unfiltered so
// inactive projects are visible/editable too.
export function useAllProjects(enabled = true) {
  return useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => projectsApi.list({ limit: 1000 }).then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

// All tasks for the project drill-in.
export function useAllTasks(enabled = true) {
  return useQuery({
    queryKey: ['tasks', 'all'],
    queryFn: () => tasksApi.list({ limit: 1000 }).then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

function invalidateClients(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['clients'] });
}
function invalidateProjects(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['projects'] });
}
function invalidateTasks(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['tasks'] });
}

export function useCreateClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: import('@/types/admin').ClientBody) => clientsApi.create(data).then((r) => r.data),
    onSuccess: () => invalidateClients(qc),
  });
}
export function useUpdateClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<import('@/types/admin').ClientBody> }) =>
      clientsApi.update(id, data).then((r) => r.data),
    onSuccess: () => invalidateClients(qc),
  });
}
export function useDeleteClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => clientsApi.remove(id),
    onSuccess: () => { invalidateClients(qc); invalidateProjects(qc); },
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: import('@/types/admin').ProjectBody) => projectsApi.create(data).then((r) => r.data),
    onSuccess: () => invalidateProjects(qc),
  });
}
export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: import('@/types/admin').ProjectBody }) =>
      projectsApi.update(id, data).then((r) => r.data),
    onSuccess: () => invalidateProjects(qc),
  });
}
export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => projectsApi.remove(id),
    onSuccess: () => { invalidateProjects(qc); invalidateTasks(qc); },
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: import('@/types/admin').TaskBody) => tasksApi.create(data).then((r) => r.data),
    onSuccess: () => invalidateTasks(qc),
  });
}
export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: import('@/types/admin').TaskBody }) =>
      tasksApi.update(id, data).then((r) => r.data),
    onSuccess: () => invalidateTasks(qc),
  });
}
export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => tasksApi.remove(id),
    onSuccess: () => invalidateTasks(qc),
  });
}

// Infra health for the admin dashboard. Polls every 30s while visible.
export function useSystemHealth(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'system-health'],
    queryFn: () => adminApi.systemHealth().then((r) => r.data),
    enabled,
    staleTime: 15_000,
    refetchInterval: enabled ? 30_000 : false,
  });
}

// Recent workspace activity feed for the admin dashboard.
export function useRecentActivity(limit = 12, enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'recent-activity', limit],
    queryFn: () => adminApi.recentActivity(limit).then((r) => r.data),
    enabled,
    staleTime: 15_000,
  });
}

export function useAuditTrail(
  params?: { limit?: number; offset?: number; activity_type?: string; search?: string },
  enabled = true,
) {
  return useQuery({
    queryKey: ['audit-trail', params?.limit ?? 50, params?.offset ?? 0, params?.activity_type ?? '', params?.search ?? ''],
    queryFn: () => auditApi.list(params).then((r) => r.data),
    enabled,
    staleTime: 15_000,
  });
}

export function useMyTimeOff() {
  return useQuery({
    queryKey: ['time-off', 'my'],
    queryFn: () => timeOffApi.mine().then((r) => r.data),
    staleTime: 10_000,
  });
}

export function useTimeOffUsage() {
  return useQuery({
    queryKey: ['time-off', 'usage'],
    queryFn: () => timeOffApi.usageSummary().then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useCreateTimeOff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      request_date: string;
      hours: number;
      leave_type: string;
      reason: string;
    }) => timeOffApi.create(data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['time-off'] }),
  });
}

export function useSubmitTimeOff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => timeOffApi.submit(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['time-off'] }),
  });
}

export function useUpdateTimeOff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: {
      id: number;
      data: Partial<{ request_date: string; hours: number; leave_type: string; reason: string }>;
    }) => timeOffApi.update(id, data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['time-off'] }),
  });
}

export function useDeleteTimeOff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => timeOffApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['time-off'] }),
  });
}

// ── Self profile + password ────────────────────────────────────────
export function useMyProfile() {
  return useQuery({
    queryKey: ['me', 'profile'],
    queryFn: () => meApi.profile().then((r) => r.data),
    staleTime: 60_000,
  });
}
export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<{ full_name: string; title: string; timezone: string; username: string }>) =>
      meApi.updateProfile(data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['auth'] });
    },
  });
}
export function useChangePassword() {
  return useMutation({
    mutationFn: ({ current, next }: { current: string; next: string }) =>
      meApi.changePassword(current, next),
  });
}

// ── Holidays ────────────────────────────────────────────────────────
export function useHolidays(params?: { start_date?: string; end_date?: string; country?: string }, enabled = true) {
  return useQuery({
    queryKey: ['holidays', params?.start_date ?? '', params?.end_date ?? '', params?.country ?? ''],
    queryFn: () => holidaysApi.list(params).then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}
export function useCreateHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { date: string; name: string; holiday_type: 'PUBLIC' | 'COMPANY'; country?: string | null }) =>
      holidaysApi.create(data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['holidays'] }),
  });
}
export function useDeleteHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => holidaysApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['holidays'] }),
  });
}
// Public-holiday suggestions for a country/year (lazy; preview before import).
export function useHolidaySuggestions(country: string | null, year: number | null) {
  return useQuery({
    queryKey: ['holidays', 'suggestions', country, year],
    queryFn: () => holidaysApi.suggestions(country as string, year as number).then((r) => r.data),
    enabled: Boolean(country) && Boolean(year),
    staleTime: 5 * 60_000,
  });
}
export function useBulkCreateHolidays() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (holidays: { date: string; name: string; holiday_type: 'PUBLIC' | 'COMPANY'; country?: string | null }[]) =>
      holidaysApi.bulkCreate(holidays).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['holidays'] }),
  });
}

// ── Catalog-driven tenant settings ─────────────────────────────────
export function useTenantSettingsCatalog(enabled = true) {
  return useQuery({
    queryKey: ['tenant-settings', 'catalog'],
    queryFn: () => tenantSettingsApi.catalog().then((r) => r.data),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useTenantSettings(enabled = true) {
  return useQuery({
    queryKey: ['tenant-settings', 'values'],
    queryFn: () => tenantSettingsApi.values().then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

// Public (is_public=true) tenant settings, readable by every authenticated
// user. The shell uses this to read the navigation policy (default_nav_layout
// / nav_switch_enabled / nav_switch_user_ids) for all roles, since the full
// /tenant-settings endpoint is admin-only.
export function usePublicTenantSettings(enabled = true) {
  return useQuery({
    queryKey: ['tenant-settings', 'public'],
    queryFn: () => tenantSettingsApi.publicValues().then((r) => r.data),
    enabled,
    staleTime: 5 * 60_000,
  });
}

// The tenant's week-start day (0=Sunday, 1=Monday) for week grouping. Read from
// the PUBLIC settings (week_start_day is is_public=true) so MANAGERS — not just
// admins — get it; the admin-only /tenant-settings would 403 for a manager.
// Defaults to 0 (Sunday) to MATCH THE BACKEND DEFAULT — getting this wrong makes
// weekly approval fail with "must target one work week at a time". Returns 1
// only when the setting is explicitly 1.
export function useWeekStartDay(): 0 | 1 {
  const q = usePublicTenantSettings();
  const v = (q.data as Record<string, unknown> | undefined)?.week_start_day;
  return v === 1 || v === '1' ? 1 : 0;
}

export function useUpdateTenantSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, SettingValue>) => tenantSettingsApi.update(patch).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant-settings'] }),
  });
}

// Per-tenant entitlement flags (gates SMTP/custom-email + email templates).
export function useTenantFeatures(enabled = true) {
  return useQuery({
    queryKey: ['tenant-features'],
    queryFn: () => brandingApi.features().then((r) => r.data),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

// Tenant-defined leave types for the request form's type dropdown.
export function useLeaveTypes(includeInactive = false) {
  return useQuery({
    queryKey: ['leave-types', includeInactive],
    queryFn: () => leaveTypesApi.list(includeInactive).then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}
export function useCreateLeaveType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { label: string; code?: string; color?: string }) => leaveTypesApi.create(data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leave-types'] }),
  });
}
// Approved inbox-ingested (PDF) timesheets for the Approved Timesheets tab.
export function useApprovedIngestionTimesheets(enabled = true, params?: { employee_id?: number; scope?: 'mine' | 'workspace' }) {
  return useQuery({
    queryKey: ['approved-ingestion-timesheets', params?.scope ?? 'workspace', params?.employee_id ?? null],
    queryFn: () => adminApi.approvedIngestionTimesheets(params).then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

export function useUpdateLeaveType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<{ label: string; color: string; is_active: boolean }> }) =>
      leaveTypesApi.update(id, data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leave-types'] }),
  });
}
export function useDeleteLeaveType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => leaveTypesApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leave-types'] }),
  });
}

// ── Departments (Workforce Setup) ───────────────────────────────────
export function useDepartments(enabled = true) {
  return useQuery({
    queryKey: ['departments'],
    queryFn: () => departmentsApi.list().then((r) => r.data),
    enabled,
    staleTime: 5 * 60_000,
  });
}
export function useCreateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => departmentsApi.create(name).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['departments'] }),
  });
}
export function useDeleteDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => departmentsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['departments'] }),
  });
}

// ── Team timesheets (Approved Timesheets tab) ───────────────────────
export function useTeamTimesheets(
  params: { start_date?: string; end_date?: string; status?: string; user_id?: number },
  enabled = true,
) {
  return useQuery({
    queryKey: ['team-timesheets', params],
    queryFn: () => teamTimesheetsApi.list({ ...params, sort_by: 'entry_date', sort_order: 'desc', limit: 1000 }).then((r) => r.data),
    enabled,
    staleTime: 15_000,
  });
}

// ── Manager time-off approvals (/time-off-approvals) ────────────────
export function usePendingTimeOff(enabled = true) {
  return useQuery({
    queryKey: ['time-off-approvals', 'pending'],
    queryFn: () => timeOffApi.pending().then((r) => r.data),
    enabled,
    staleTime: 10_000,
  });
}

export function useTimeOffApprovalHistory(enabled = true) {
  return useQuery({
    queryKey: ['time-off-approvals', 'history'],
    queryFn: () => timeOffApi.approvalHistory().then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

function invalidateTimeOffApprovals(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['time-off-approvals'] });
  qc.invalidateQueries({ queryKey: ['time-off'] });
  qc.invalidateQueries({ queryKey: ['dashboard'] });
}

export function useApproveTimeOff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => timeOffApi.approve(id),
    onSuccess: () => invalidateTimeOffApprovals(qc),
  });
}

export function useRejectTimeOff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => timeOffApi.reject(id, reason),
    onSuccess: () => invalidateTimeOffApprovals(qc),
  });
}

// ── Mailboxes (ingestion config) ────────────────────────────────────
export function useMailboxes(enabled = true) {
  return useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => mailboxesApi.list().then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}
export function useCreateMailbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: import('@/types/admin').MailboxCreateBody) => mailboxesApi.create(data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mailboxes'] }),
  });
}
export function useDeleteMailbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => mailboxesApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mailboxes'] }),
  });
}
export function useTestMailbox() {
  return useMutation({ mutationFn: (id: number) => mailboxesApi.test(id).then((r) => r.data) });
}
export function useResetMailboxCursor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => mailboxesApi.resetCursor(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mailboxes'] }),
  });
}

export function useIngestionTimesheets(enabled = true) {
  return useQuery({
    queryKey: ['ingestion', 'timesheets'],
    queryFn: () => ingestionApi.list().then((r) => r.data),
    enabled,
    staleTime: 10_000,
  });
}

export function useIngestionDetail(id: number | null) {
  return useQuery({
    queryKey: ['ingestion', 'detail', id],
    queryFn: () => ingestionApi.detail(id as number).then((r) => r.data),
    enabled: id != null,
    staleTime: 5_000,
  });
}

function invalidateIngestion(qc: ReturnType<typeof useQueryClient>, id?: number | null) {
  qc.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
  if (id != null) qc.invalidateQueries({ queryKey: ['ingestion', 'detail', id] });
  qc.invalidateQueries({ queryKey: ['approvals'] });
}

export function useApproveIngestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, comment }: { id: number; comment?: string }) =>
      ingestionApi.approve(id, comment).then((r) => r.data),
    onSuccess: (_d, v) => invalidateIngestion(qc, v.id),
  });
}
export function useRejectIngestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason, comment }: { id: number; reason: string; comment?: string }) =>
      ingestionApi.reject(id, reason, comment),
    onSuccess: (_d, v) => invalidateIngestion(qc, v.id),
  });
}
export function useHoldIngestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, comment }: { id: number; comment?: string }) => ingestionApi.hold(id, comment),
    onSuccess: (_d, v) => invalidateIngestion(qc, v.id),
  });
}
export function useUpdateIngestionData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<{ employee_id: number | null; client_id: number | null; extracted_supervisor_name: string; period_start: string; period_end: string; internal_notes: string }> }) =>
      ingestionApi.updateData(id, data),
    onSuccess: (_d, v) => invalidateIngestion(qc, v.id),
  });
}
export function useReprocessIngestionEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (emailId: number) => ingestionApi.reprocessEmail(emailId),
    onSuccess: () => invalidateIngestion(qc),
  });
}
export function useFetchEmails() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => ingestionApi.fetchEmails().then((r) => r.data),
    onSuccess: () => invalidateIngestion(qc),
  });
}

// Poll a fetch job's status while active (2.5s); stop on a terminal state.
export function useFetchJobStatus(jobId: string | null) {
  return useQuery({
    queryKey: ['ingestion', 'fetch-status', jobId],
    queryFn: () => ingestionApi.fetchJobStatus(jobId as string).then((r) => r.data),
    enabled: jobId != null,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s && ['completed', 'failed', 'cancelled', 'error'].includes(s) ? false : 2500;
    },
  });
}
export function useCancelFetchJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => ingestionApi.cancelFetchJob(jobId).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ingestion', 'fetch-status'] }),
  });
}

// Skipped emails (not-a-timesheet) + promote / confirm-skip.
export function useSkippedEmails(enabled = true) {
  return useQuery({
    queryKey: ['ingestion', 'skipped'],
    queryFn: () => ingestionApi.listSkipped().then((r) => r.data),
    enabled,
    staleTime: 20_000,
  });
}
export function usePromoteSkipped() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (emailId: number) => ingestionApi.promoteSkipped(emailId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ingestion', 'skipped'] }); invalidateIngestion(qc); },
  });
}
export function useConfirmSkip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (emailId: number) => ingestionApi.confirmSkip(emailId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ingestion', 'skipped'] }),
  });
}

// Stored-email detail (lazy; for the review-panel email context).
export function useIngestionEmail(emailId: number | null) {
  return useQuery({
    queryKey: ['ingestion', 'email', emailId],
    queryFn: () => ingestionApi.getEmail(emailId as number).then((r) => r.data),
    enabled: emailId != null,
    staleTime: 30_000,
  });
}
export function useReprocessStoredEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ emailId, attachmentIds }: { emailId: number; attachmentIds?: number[] }) =>
      ingestionApi.reprocessStoredEmail(emailId, attachmentIds),
    onSuccess: () => invalidateIngestion(qc),
  });
}
export function useBulkReprocess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (emailIds: number[]) => ingestionApi.bulkReprocess(emailIds),
    onSuccess: () => invalidateIngestion(qc),
  });
}
export function useDeleteEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ emailId, refetch }: { emailId: number; refetch?: boolean }) => ingestionApi.deleteEmail(emailId, refetch),
    onSuccess: () => invalidateIngestion(qc),
  });
}
export function useBulkDeleteEmails() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ emailIds, refetch }: { emailIds: number[]; refetch?: boolean }) => ingestionApi.bulkDeleteEmails(emailIds, refetch),
    onSuccess: () => invalidateIngestion(qc),
  });
}

// Forwarded-chain employee assignment on a parsed timesheet.
export function useAssignChainCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, email }: { id: number; name?: string; email?: string }) =>
      ingestionApi.assignChainCandidate(id, { name, email }),
    onSuccess: (_d, v) => invalidateIngestion(qc, v.id),
  });
}

// Per-line-item + whole-timesheet rejection recovery.
export function useRejectLineItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tid, itemId, reason }: { tid: number; itemId: number; reason?: string }) =>
      ingestionApi.rejectLineItem(tid, itemId, reason),
    onSuccess: (_d, v) => invalidateIngestion(qc, v.tid),
  });
}
export function useUnrejectLineItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tid, itemId }: { tid: number; itemId: number }) => ingestionApi.unrejectLineItem(tid, itemId),
    onSuccess: (_d, v) => invalidateIngestion(qc, v.tid),
  });
}
export function useRevertIngestionRejection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => ingestionApi.revertRejection(id),
    onSuccess: (_d, id) => invalidateIngestion(qc, id),
  });
}
export function useDraftComment() {
  return useMutation({
    mutationFn: ({ id, seedText }: { id: number; seedText?: string }) =>
      ingestionApi.draftComment(id, seedText ?? '').then((r) => r.data),
  });
}
export function useUpdateLineItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tid, itemId, data }: {
      tid: number; itemId: number;
      data: Partial<{ work_date: string; hours: number; description: string; project_code: string; project_id: number }>;
    }) => ingestionApi.updateLineItem(tid, itemId, data).then((r) => r.data),
    onSuccess: (_d, v) => invalidateIngestion(qc, v.tid),
  });
}
export function useAddLineItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tid, data }: { tid: number; data: { work_date: string; hours: number; description?: string; project_code?: string; project_id?: number } }) =>
      ingestionApi.addLineItem(tid, data).then((r) => r.data),
    onSuccess: (_d, v) => invalidateIngestion(qc, v.tid),
  });
}
export function useDeleteLineItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tid, itemId }: { tid: number; itemId: number }) => ingestionApi.removeLineItem(tid, itemId),
    onSuccess: (_d, v) => invalidateIngestion(qc, v.tid),
  });
}
