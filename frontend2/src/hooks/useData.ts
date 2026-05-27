import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { HistoryGroup, SettingValue } from '@/api/endpoints';
import {
  timeentriesAPI,
  approvalsAPI,
  clientsAPI,
  projectsAPI,
  dashboardAPI,
  notificationsAPI,
  timeOffAPI,
  timeOffApprovalsAPI,
  usersAPI,
  tasksAPI,
  tenantsAPI,
  mailboxesAPI,
  ingestionAPI,
  tenantSettingsAPI,
  departmentsAPI,
  holidaysAPI,
  leaveTypesAPI,
  adminAPI,
  attentionSignalsAPI,
  platformDashboardAPI,
} from '@/api/endpoints';
import type { PlatformAuditListParams } from '@/types';

type TimeEntriesListParams = Parameters<typeof timeentriesAPI.list>[0];
type ApprovalsPendingParams = Parameters<typeof approvalsAPI.pending>[0];
type ApprovalsHistoryParams = Parameters<typeof approvalsAPI.history>[0];
type ProjectsListParams = Parameters<typeof projectsAPI.list>[0];
type TasksListParams = Parameters<typeof tasksAPI.list>[0];
type TimeOffListParams = Parameters<typeof timeOffAPI.list>[0];
type TimeOffApprovalsPendingParams = Parameters<typeof timeOffApprovalsAPI.pending>[0];
type TimeOffApprovalsHistoryParams = Parameters<typeof timeOffApprovalsAPI.history>[0];
type GenericQueryParams = Record<string, unknown>;

// TimeEntries queries
export const useTimeEntries = (params?: GenericQueryParams, enabled: boolean = true) => {
  return useQuery({
    queryKey: ['timeentries', params],
    queryFn: () => timeentriesAPI.list(params as TimeEntriesListParams).then(res => res.data),
    placeholderData: keepPreviousData,
    enabled,
  });
};

export const useTimeEntry = (id: number) => {
  return useQuery({
    queryKey: ['timeentry', id],
    queryFn: () => timeentriesAPI.get(id).then(res => res.data),
  });
};

export const useParseNaturalTimeEntry = () => {
  return useMutation({
    mutationFn: (text: string) => timeentriesAPI.parseNatural(text).then(res => res.data),
  });
};

export const useCreateTimeEntry = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof timeentriesAPI.create>[0]) => timeentriesAPI.create(data).then(res => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeentries'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useUpdateTimeEntry = (id: number) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof timeentriesAPI.update>[1]) => timeentriesAPI.update(id, data).then(res => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeentries'] });
      queryClient.invalidateQueries({ queryKey: ['timeentry', id] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useDeleteTimeEntry = (id: number) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => timeentriesAPI.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeentries'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useSubmitTimeEntries = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entry_ids: number[]) => timeentriesAPI.submit(entry_ids).then(res => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeentries'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

/**
 * Recall a set of SUBMITTED entries back to DRAFT. Invalidates the
 * timeentries list (so the editor re-renders with DRAFT statuses)
 * and the weekly-submit-status query (so the banner clears). 409s
 * from the backend bubble up so the caller can surface a "manager
 * already acted" toast.
 */
export const useRecallTimeEntries = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entry_ids: number[]) => timeentriesAPI.recall(entry_ids).then(res => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeentries'] });
      queryClient.invalidateQueries({ queryKey: ['timeentries', 'weekly-submit-status'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useWeeklySubmitStatus = () => {
  return useQuery({
    queryKey: ['timeentries', 'weekly-submit-status'],
    queryFn: () => timeentriesAPI.weeklySubmitStatus().then(res => res.data),
    refetchInterval: 60000,
    staleTime: 30000,
  });
};

// Approvals queries
export const usePendingApprovals = (params?: GenericQueryParams, enabled: boolean = true) => {
  return useQuery({
    queryKey: ['approvals', 'pending', params],
    queryFn: () => approvalsAPI.pending(params as ApprovalsPendingParams).then(res => res.data),
    placeholderData: keepPreviousData,
    enabled,
  });
};

export const useApprovalHistory = (params?: GenericQueryParams) => {
  return useQuery({
    queryKey: ['approvals', 'history', params],
    queryFn: () => approvalsAPI.history(params as ApprovalsHistoryParams).then(res => res.data),
    placeholderData: keepPreviousData,
  });
};

export const useApprovalHistoryGrouped = (params?: { days_back?: number; status_filter?: string }) => {
  return useQuery<HistoryGroup[]>({
    queryKey: ['approvals', 'history-grouped', params],
    queryFn: () => approvalsAPI.historyGrouped(params).then(res => res.data),
    placeholderData: keepPreviousData,
  });
};

// Approving/rejecting a timesheet changes both the pending-approval
// queue and every aggregate view that summarises approved work. The
// approved-timesheets manager view + the admin-portal timesheets tab
// each cache their own queries, so we invalidate them explicitly to
// stop the page rendering stale totals after the mutation lands.
const invalidateApprovalSurfaces = (queryClient: ReturnType<typeof useQueryClient>) => {
  queryClient.invalidateQueries({ queryKey: ['approvals'] });
  queryClient.invalidateQueries({ queryKey: ['timeentries'] });
  queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  queryClient.invalidateQueries({ queryKey: ['notifications'] });
  queryClient.invalidateQueries({ queryKey: ['approved-timesheets'] });
  queryClient.invalidateQueries({ queryKey: ['team-timesheets'] });
  queryClient.invalidateQueries({ queryKey: ['team-timesheets-ingestion-all'] });
};

export const useApproveTimeEntry = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => approvalsAPI.approve(id).then(res => res.data),
    onSuccess: () => invalidateApprovalSurfaces(queryClient),
  });
};

export const useRejectTimeEntry = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      approvalsAPI.reject(id, reason).then(res => res.data),
    onSuccess: () => invalidateApprovalSurfaces(queryClient),
  });
};

export const useApproveTimeEntryBatch = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entryIds: number[]) => approvalsAPI.batchApprove(entryIds).then(res => res.data),
    onSuccess: () => invalidateApprovalSurfaces(queryClient),
  });
};

export const useRejectTimeEntryBatch = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ entryIds, reason }: { entryIds: number[]; reason: string }) =>
      approvalsAPI.batchReject(entryIds, reason).then(res => res.data),
    onSuccess: () => invalidateApprovalSurfaces(queryClient),
  });
};

// Clients queries
export const useClients = () => {
  return useQuery({
    queryKey: ['clients'],
    queryFn: () => clientsAPI.list().then(res => res.data),
  });
};

export const useUpdateClient = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<{ name: string; quickbooks_customer_id: string }> }) =>
      clientsAPI.update(id, data).then(res => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });
};

export const useDeleteClient = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => clientsAPI.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
};

export const useBulkDeleteClients = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (clientIds: number[]) => clientsAPI.bulkDelete(clientIds).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
};

export const useDeleteProject = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => projectsAPI.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
};

export const useCreateClient = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; quickbooks_customer_id?: string }) =>
      clientsAPI.create(data).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
};

// POST /clients/from-domain: creates the client and cascades to matching pending timesheets.
export const useCreateClientFromDomain = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; domain: string }) =>
      clientsAPI.createFromDomain(data).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'skipped-emails'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
};

// Projects queries
export const useProjects = (params?: GenericQueryParams) => {
  return useQuery({
    queryKey: ['projects', params],
    queryFn: () => projectsAPI.list(params as ProjectsListParams).then(res => res.data),
    placeholderData: keepPreviousData,
  });
};

export const useTasks = (params?: TasksListParams) => {
  return useQuery({
    queryKey: ['tasks', params],
    queryFn: () => tasksAPI.list(params).then(res => res.data),
    placeholderData: keepPreviousData,
  });
};

export const useCreateTask = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof tasksAPI.create>[0]) => tasksAPI.create(data).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['timeentries'] });
    },
  });
};

export const useUpdateTask = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof tasksAPI.update>[1] }) => tasksAPI.update(id, data).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['timeentries'] });
    },
  });
};

export const useDeleteTask = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => tasksAPI.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['timeentries'] });
    },
  });
};

export const useCreateProject = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof projectsAPI.create>[0]) => projectsAPI.create(data).then(res => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useUpdateProject = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof projectsAPI.update>[1] }) => projectsAPI.update(id, data).then(res => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useDashboardSummary = () => {
  return useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: () => dashboardAPI.summary().then((res) => res.data),
  });
};

// Decode "realm" claim from the JWT in sessionStorage. PA tokens carry
// realm="platform"; tenant tokens carry realm="tenant" (default). This
// helper avoids a circular import dep on AuthContext from the data hooks.
const _isPlatformRealmFromToken = (): boolean => {
  if (typeof window === 'undefined') return false;
  const token = sessionStorage.getItem('accessToken');
  if (!token) return false;
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const decoded = JSON.parse(json) as { realm?: string };
    return decoded.realm === 'platform';
  } catch {
    return false;
  }
};

export const useNotifications = () => {
  // /notifications/summary is tenant-scoped and 400s for platform-admin
  // tokens (no X-Tenant-Slug). The TopNavBar mounts this hook on every
  // page load including PA pages, so without this gate the console
  // fills with 400s on every navigation. PAs have no notification
  // surface today; turn the poll off for them entirely.
  const isPlatform = _isPlatformRealmFromToken();
  return useQuery({
    queryKey: ['notifications', 'summary'],
    queryFn: () => notificationsAPI.summary().then((res) => res.data),
    placeholderData: keepPreviousData,
    refetchInterval: 60000,
    staleTime: 30000,  // Serve cached data for 30s before background refetch
    enabled: !isPlatform,
  });
};

export const useMarkNotificationRead = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notificationId: string) => notificationsAPI.markRead(notificationId).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useMarkAllNotificationsRead = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => notificationsAPI.markAllRead().then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useDeleteNotification = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notificationId: string) => notificationsAPI.deleteOne(notificationId).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useDeleteAllNotifications = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => notificationsAPI.deleteAll().then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useTeamEmployees = () => {
  return useQuery({
    queryKey: ['dashboard', 'team'],
    queryFn: () => dashboardAPI.team().then(res => res.data),
    placeholderData: keepPreviousData,
  });
};

export const useTeamDailyOverview = () => {
  return useQuery({
    queryKey: ['dashboard', 'team-daily-overview'],
    queryFn: () => dashboardAPI.teamDailyOverview().then((res) => res.data),
    placeholderData: keepPreviousData,
    refetchInterval: 60000,
    staleTime: 30000,
  });
};

export const useDashboardAnalytics = (params: {
  start_date: string;
  end_date: string;
  project_id?: number;
  user_id?: number;
}) => {
  return useQuery({
    queryKey: ['dashboard', 'analytics', params],
    queryFn: () => dashboardAPI.analytics(params).then(res => res.data),
    enabled: !!params.start_date && !!params.end_date,
    placeholderData: keepPreviousData,
  });
};

export const useManagerTeamOverview = (enabled: boolean = true) => {
  return useQuery({
    queryKey: ['dashboard', 'manager-team-overview'],
    queryFn: () => dashboardAPI.managerTeamOverview().then((res) => res.data),
    enabled,
    // Short stale window so the manager dashboard reflects recent
    // org-chart edits (add/remove direct reports) without waiting for
    // the previous 30s cache. Mutations also explicitly invalidate
    // ['dashboard', ...], so this is a safety net for navigation flows
    // that bypass the mutation hooks (e.g. coming back from /platform).
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
};

export const useManagerProjectHealth = (enabled: boolean = true) => {
  return useQuery({
    queryKey: ['dashboard', 'manager-project-health'],
    queryFn: () => dashboardAPI.managerProjectHealth().then((res) => res.data),
    enabled,
    staleTime: 60_000,
  });
};

export const useAdminSystemHealth = (enabled: boolean = true) => {
  return useQuery({
    queryKey: ['admin', 'system-health'],
    queryFn: () => adminAPI.systemHealth().then((res) => res.data),
    enabled,
    // Health checks are cheap server-side and the user expects current
    // values. 30s refresh keeps the panel honest without hammering.
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
};

export const useUserEmailAliases = (userId: number | null, enabled: boolean = true) => {
  return useQuery({
    queryKey: ['users', userId, 'email-aliases'],
    queryFn: () => usersAPI.listEmailAliases(userId as number).then((res) => res.data),
    enabled: enabled && userId != null,
    staleTime: 30_000,
  });
};

export const useAddUserEmailAlias = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, email }: { userId: number; email: string }) =>
      usersAPI.addEmailAlias(userId, email).then((res) => res.data),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['users', vars.userId, 'email-aliases'] });
    },
  });
};

export const useDeleteUserEmailAlias = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, aliasId }: { userId: number; aliasId: number }) =>
      usersAPI.deleteEmailAlias(userId, aliasId),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['users', vars.userId, 'email-aliases'] });
    },
  });
};

export const useUserClientAssignments = (userId: number | null, enabled: boolean = true) => {
  return useQuery({
    queryKey: ['users', userId, 'clients'],
    queryFn: () => clientsAPI.listUserAssignments(userId as number).then((res) => res.data),
    enabled: enabled && userId != null,
    staleTime: 30_000,
  });
};

export const useAddUserClientAssignment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, clientId }: { userId: number; clientId: number }) =>
      clientsAPI.addUserAssignment(userId, clientId).then((res) => res.data),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['users', vars.userId, 'clients'] });
    },
  });
};

export const useRemoveUserClientAssignment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, clientId }: { userId: number; clientId: number }) =>
      clientsAPI.removeUserAssignment(userId, clientId).then((res) => res.data),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['users', vars.userId, 'clients'] });
    },
  });
};

export const useDismissedAttentionSignals = (enabled: boolean = true) => {
  return useQuery({
    queryKey: ['attention-signals', 'dismissed'],
    queryFn: () => attentionSignalsAPI.listDismissed().then((res) => res.data),
    enabled,
    staleTime: 30_000,
  });
};

export const useDismissAttentionSignal = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ signal_key, snoozed_until }: { signal_key: string; snoozed_until: string | null }) =>
      attentionSignalsAPI.dismiss(signal_key, snoozed_until),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attention-signals', 'dismissed'] });
    },
  });
};

export const useDashboardRecentActivity = (params?: { limit?: number }, enabled: boolean = true) => {
  return useQuery({
    queryKey: ['dashboard', 'recent-activity', params],
    queryFn: () => dashboardAPI.recentActivity(params).then((res) => res.data),
    enabled,
    placeholderData: keepPreviousData,
  });
};
export const useAuditTrail = (params?: { limit?: number; offset?: number; activity_type?: string; search?: string }) => {
  return useQuery({
    queryKey: ['dashboard', 'audit-trail', params],
    queryFn: () => dashboardAPI.auditTrail(params).then((res) => res.data),
    placeholderData: keepPreviousData,
  });
};

export const useTimeOffRequests = (params?: TimeOffListParams) => {
  return useQuery({
    queryKey: ['timeoff', params],
    queryFn: () => timeOffAPI.list(params).then((res) => res.data),
    placeholderData: keepPreviousData,
  });
};

/** Per-leave-type approved-days totals for the caller in the given year
 *  (default: current). Backs the "Time Off Taken" dashboard widget. */
export const useTimeOffUsageSummary = (year?: number) => {
  return useQuery({
    queryKey: ['timeoff', 'usage-summary', year ?? 'current'],
    queryFn: () => timeOffAPI.usageSummary(year).then((res) => res.data),
    staleTime: 60_000,
  });
};

export const useTimeOffRequest = (id: number) => {
  return useQuery({
    queryKey: ['timeoff', id],
    queryFn: () => timeOffAPI.get(id).then((res) => res.data),
  });
};

export const useCreateTimeOffRequest = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof timeOffAPI.create>[0]) => timeOffAPI.create(data).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeoff'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useUpdateTimeOffRequest = (id: number) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof timeOffAPI.update>[1]) => timeOffAPI.update(id, data).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeoff'] });
      queryClient.invalidateQueries({ queryKey: ['timeoff', id] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useDeleteTimeOffRequest = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => timeOffAPI.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeoff'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useSubmitTimeOffRequests = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request_ids: number[]) => timeOffAPI.submit(request_ids).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeoff'] });
      queryClient.invalidateQueries({ queryKey: ['timeoff-approvals'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const usePendingTimeOffApprovals = (params?: TimeOffApprovalsPendingParams, enabled: boolean = true) => {
  return useQuery({
    queryKey: ['timeoff-approvals', 'pending', params],
    queryFn: () => timeOffApprovalsAPI.pending(params).then((res) => res.data),
    placeholderData: keepPreviousData,
    enabled,
  });
};

export const useTimeOffApprovalHistory = (params?: TimeOffApprovalsHistoryParams) => {
  return useQuery({
    queryKey: ['timeoff-approvals', 'history', params],
    queryFn: () => timeOffApprovalsAPI.history(params).then((res) => res.data),
    placeholderData: keepPreviousData,
  });
};

export const useApproveTimeOffRequest = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => timeOffApprovalsAPI.approve(id).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeoff-approvals'] });
      queryClient.invalidateQueries({ queryKey: ['timeoff'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useRejectTimeOffRequest = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      timeOffApprovalsAPI.reject(id, reason).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeoff-approvals'] });
      queryClient.invalidateQueries({ queryKey: ['timeoff'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

// Users queries (Admin only)
export const useUsers = (enabled: boolean = true, tenantSlug?: string) => {
  return useQuery({
    // Include slug in the key so PA users viewing different tenants
    // get distinct cache buckets instead of stepping on each other.
    queryKey: ['users', tenantSlug ?? null],
    queryFn: () => usersAPI.list(tenantSlug).then((res) => res.data),
    enabled,
  });
};

export const useAssignableUsers = (enabled: boolean = true) => {
  return useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => usersAPI.listAssignable().then((res) => res.data),
    enabled,
  });
};

export const useMyProfile = () => {
  return useQuery({
    queryKey: ['users', 'me', 'profile'],
    queryFn: () => usersAPI.meProfile().then((res) => res.data),
  });
};

export const useMyPermissions = () => {
  return useQuery({
    queryKey: ['my-permissions'],
    queryFn: () =>
      apiClient
        .get<{ permissions: string[] }>('/users/me/permissions')
        .then((res) => res.data.permissions),
    staleTime: 30_000,
  });
};

// Per-user UI preferences. We keep a single query key so any component
// can read or invalidate it.
export const useMyPreferences = () => {
  return useQuery({
    queryKey: ['users', 'me', 'preferences'],
    queryFn: () => usersAPI.getMyPreferences().then((res) => res.data),
    staleTime: 60_000,
  });
};

export const useUpdateMyPreferences = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      usersAPI.updateMyPreferences(data).then((res) => res.data),
    onMutate: async (patch) => {
      // Optimistic update: write the new keys into cache immediately so
      // controlled components (e.g. HolidayCountryFilter's <select>) flip
      // to the new value without waiting on the network. The server
      // response in onSuccess will replace this with the canonical
      // merged dict.
      await queryClient.cancelQueries({ queryKey: ['users', 'me', 'preferences'] });
      const previous = queryClient.getQueryData<Record<string, unknown>>([
        'users', 'me', 'preferences',
      ]);
      const next = { ...(previous || {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined) delete next[k];
        else next[k] = v;
      }
      queryClient.setQueryData(['users', 'me', 'preferences'], next);
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(['users', 'me', 'preferences'], ctx.previous);
      }
    },
    onSuccess: (preferences) => {
      // Authoritative merge from server overwrites the optimistic write.
      queryClient.setQueryData(['users', 'me', 'preferences'], preferences);
      // Any query whose params depend on a preference (e.g. holidays
      // filtered by holiday_calendar_country) needs a re-fetch with the
      // new param. Cheaper than threading invalidations through every
      // consumer.
      queryClient.invalidateQueries({ queryKey: ['holidays'] });
    },
  });
};

export const useUpdateMyProfile = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      full_name?: string;
      title?: string;
      department?: string;
      timezone?: string;
      username?: string;
      email?: string;
    }) => usersAPI.updateMyProfile(data).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users', 'me', 'profile'] });
      queryClient.invalidateQueries({ queryKey: ['users', 'me'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};

export const useChangePassword = () => {
  return useMutation({
    mutationFn: (data: { current_password: string; new_password: string }) =>
      usersAPI.changePassword(data).then((res) => res.data),
  });
};

// Accept an optional tenantSlug so platform-admin callers can target a
// specific tenant's DB (the backend reads X-Tenant-Slug for PA tokens).
type CreateUserArgs = {
  data: Parameters<typeof usersAPI.create>[0];
  tenantSlug?: string;
};
export const useCreateUser = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: CreateUserArgs | Parameters<typeof usersAPI.create>[0]) => {
      // Backward-compatible: most callers still pass just the user payload.
      const isWrapped = args && typeof args === 'object' && 'data' in args && Object.keys(args).every((k) => k === 'data' || k === 'tenantSlug');
      if (isWrapped) {
        const { data, tenantSlug } = args as CreateUserArgs;
        return usersAPI.create(data, tenantSlug).then((res) => res.data);
      }
      return usersAPI.create(args as Parameters<typeof usersAPI.create>[0]).then((res) => res.data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useUpdateUser = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof usersAPI.update>[1] }) => usersAPI.update(id, data).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useDeleteUser = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => usersAPI.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useResetUserPassword = () => {
  return useMutation({
    mutationFn: ({ id, newPassword }: { id: number; newPassword: string }) =>
      usersAPI.resetPassword(id, newPassword).then(res => res.data),
  });
};

export const useResendVerification = () => {
  return useMutation({
    mutationFn: (id: number) => usersAPI.resendVerification(id).then(res => res.data),
  });
};

export const useResendInvite = () => {
  return useMutation({
    mutationFn: (id: number) => usersAPI.resendInvite(id).then(res => res.data),
  });
};

// Unified Send invite. Dispatches Auth0 vs legacy verification per user
// on the server. New UI should prefer this over the two legacy hooks
// above.
export const useSendInvite = () => {
  return useMutation({
    mutationFn: (id: number) => usersAPI.sendInvite(id).then(res => res.data),
  });
};

export const useBulkDeleteUsers = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userIds: number[]) => usersAPI.bulkDelete(userIds).then(res => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
};

export const useTenants = (enabled: boolean = true) => {
  return useQuery({
    queryKey: ['tenants'],
    queryFn: () => tenantsAPI.list().then((res) => res.data),
    enabled,
  });
};

export const useTenant = (tenantId?: number | null, enabled: boolean = true) => {
  return useQuery({
    queryKey: ['tenants', tenantId],
    queryFn: () => tenantsAPI.get(tenantId as number).then((res) => res.data),
    enabled: enabled && Boolean(tenantId),
  });
};

/**
 * Resolves a tenant by slug. Used by the Path-B tenant detail route
 * (/platform/tenants/:slug). Pulls the full tenants list (cheap;
 * platform admins typically have a handful of tenants) and locates
 * by slug client-side, so we don't need a new backend lookup.
 */
export const useTenantBySlug = (slug?: string | null, enabled: boolean = true) => {
  const { data: tenants = [], isLoading, error } = useTenants(enabled && Boolean(slug));
  const tenant = slug ? tenants.find((t) => t.slug === slug) ?? null : null;
  return { data: tenant, isLoading, error, tenants };
};

/**
 * Trigger an Advanced-tab lifecycle action (mark_inactive / suspend /
 * resume / delete) with the typed-name confirmation. Invalidates the
 * tenants list on success so the detail page reflects the new status
 * and any archived tenant disappears from the list view.
 */
export const useTenantLifecycle = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      tenantId,
      action,
      confirmationToken,
    }: {
      tenantId: number;
      action: 'mark_inactive' | 'suspend' | 'resume' | 'delete';
      confirmationToken?: string;
    }) =>
      tenantsAPI
        .lifecycle(tenantId, action, confirmationToken)
        .then((res) => res.data),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['tenants'] });
      queryClient.invalidateQueries({ queryKey: ['tenants', vars.tenantId] });
      queryClient.invalidateQueries({ queryKey: ['platform', 'audit'] });
      queryClient.invalidateQueries({ queryKey: ['platform', 'dashboard'] });
    },
  });
};

/**
 * PATCH a tenant's plain fields (name, status, ingestion_enabled, etc.).
 * Distinct from the lifecycle endpoint — that one is for the
 * mark_inactive / suspend / resume / delete actions that gate on a
 * typed confirmation. This is for routine edits the platform admin
 * makes from the Overview tab.
 */
export const useUpdateTenant = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      tenantId,
      data,
    }: {
      tenantId: number;
      data: Parameters<typeof tenantsAPI.update>[1];
    }) => tenantsAPI.update(tenantId, data).then((res) => res.data),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['tenants'] });
      queryClient.invalidateQueries({ queryKey: ['tenants', vars.tenantId] });
      queryClient.invalidateQueries({ queryKey: ['platform', 'audit'] });
    },
  });
};

export const useMailboxes = (enabled: boolean = true) => {
  return useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => mailboxesAPI.list().then((res) => res.data),
    enabled,
  });
};

export const useCreateMailbox = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof mailboxesAPI.create>[0]) => mailboxesAPI.create(data).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
    },
  });
};

export const useUpdateMailbox = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof mailboxesAPI.update>[1] }) =>
      mailboxesAPI.update(id, data).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
    },
  });
};

export const useDeleteMailbox = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => mailboxesAPI.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
    },
  });
};

export const useTestMailbox = () => {
  return useMutation({
    mutationFn: (id: number) => mailboxesAPI.test(id).then((res) => res.data),
  });
};

export const useResetMailboxCursor = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => mailboxesAPI.resetCursor(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
    },
  });
};

export const useTriggerFetchEmails = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => ingestionAPI.triggerFetch().then((res) => res.data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'fetch-status', data.job_id] });
    },
  });
};

export const useReprocessSkippedEmails = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => ingestionAPI.reprocessSkipped().then((res) => res.data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'fetch-status', data.job_id] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'skipped-emails'] });
    },
  });
};

export const useReprocessIngestionEmail = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ emailId, attachmentIds }: { emailId: number; attachmentIds?: number[] }) =>
      ingestionAPI.reprocessEmail(emailId, attachmentIds).then((res) => res.data),
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'skipped-emails'] });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'fetch-status', data.job_id] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'skipped-emails'] });
    },
  });
};

export const useDeleteIngestedEmail = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ emailId, refetch = false }: { emailId: number; refetch?: boolean }) =>
      ingestionAPI.deleteEmail(emailId, refetch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'skipped-emails'] });
    },
  });
};

export const useBulkReprocessEmails = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (emailIds: number[]) => ingestionAPI.bulkReprocess(emailIds).then(res => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'skipped-emails'] });
    },
  });
};

export const useBulkDeleteIngestedEmails = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (emailIds: number[]) => ingestionAPI.bulkDeleteEmails(emailIds).then(res => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'skipped-emails'] });
    },
  });
};

export const useReapplyIngestionMappings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => ingestionAPI.reapplyMappings().then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
    },
  });
};

export const useSkippedEmails = (
  limit: number = 10,
  enabled: boolean = true,
  includeClassifierSkips: boolean = false,
) => {
  return useQuery({
    queryKey: ['ingestion', 'skipped-emails', limit, includeClassifierSkips],
    queryFn: () =>
      ingestionAPI
        .getSkippedEmails({ limit, include_classifier_skips: includeClassifierSkips })
        .then((res) => res.data),
    enabled,
  });
};

/**
 * Reviewer override: promote a classifier-skipped email into the
 * regular review queue. Creates an IngestionTimesheet in pending state
 * so the reviewer can fill in employee/client and approve normally.
 */
export const usePromoteSkippedEmail = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (emailId: number) =>
      ingestionAPI.promoteSkippedEmail(emailId).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ingestion', 'skipped-emails'] });
      qc.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
    },
  });
};

/**
 * Reviewer override: confirm that a skipped email really isn't a
 * timesheet. Sets a flag so the row stops appearing in the skipped
 * drawer, but the email row stays in the DB for audit.
 */
export const useConfirmSkippedEmail = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (emailId: number) =>
      ingestionAPI.confirmSkippedEmail(emailId).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ingestion', 'skipped-emails'] });
    },
  });
};

export const useFetchJobStatus = (jobId?: string | null, enabled: boolean = true) => {
  return useQuery({
    queryKey: ['ingestion', 'fetch-status', jobId],
    queryFn: () => ingestionAPI.getFetchStatus(jobId as string).then((res) => res.data),
    enabled: enabled && Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'in_progress' ? 4000 : false;
    },
  });
};

export const useIngestionTimesheets = (params?: Parameters<typeof ingestionAPI.listTimesheets>[0], enabled: boolean = true) => {
  return useQuery({
    queryKey: ['ingestion', 'timesheets', params],
    queryFn: () => ingestionAPI.listTimesheets(params).then((res) => res.data),
    enabled,
    placeholderData: keepPreviousData,
  });
};

export const useIngestionTimesheet = (id?: number | null, enabled: boolean = true) => {
  return useQuery({
    queryKey: ['ingestion', 'timesheet', id],
    queryFn: () => ingestionAPI.getTimesheet(id as number).then((res) => res.data),
    enabled: enabled && Boolean(id),
  });
};

export const useIngestionEmail = (emailId?: number | null, enabled: boolean = true) => {
  return useQuery({
    queryKey: ['ingestion', 'email', emailId],
    queryFn: () => ingestionAPI.getEmail(emailId as number).then((res) => res.data),
    enabled: enabled && Boolean(emailId),
  });
};

export const useUpdateIngestionTimesheetData = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof ingestionAPI.updateTimesheetData>[1] }) =>
      ingestionAPI.updateTimesheetData(id, data).then((res) => res.data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheet', id] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
    },
  });
};

export const useAssignChainCandidate = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: {
      id: number;
      data: { name?: string | null; email?: string | null };
    }) => ingestionAPI.assignChainCandidate(id, data).then((res) => res.data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheet', id] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
      // User list may have grown — refresh employee dropdowns.
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};

export const useAddIngestionLineItem = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ timesheetId, data }: { timesheetId: number; data: Parameters<typeof ingestionAPI.addLineItem>[1] }) =>
      ingestionAPI.addLineItem(timesheetId, data).then((res) => res.data),
    onSuccess: (_, { timesheetId }) => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheet', timesheetId] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
    },
  });
};

export const useUpdateIngestionLineItem = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      timesheetId,
      itemId,
      data,
    }: {
      timesheetId: number;
      itemId: number;
      data: Parameters<typeof ingestionAPI.updateLineItem>[2];
    }) => ingestionAPI.updateLineItem(timesheetId, itemId, data).then((res) => res.data),
    onSuccess: (_, { timesheetId }) => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheet', timesheetId] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
    },
  });
};

export const useDeleteIngestionLineItem = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ timesheetId, itemId }: { timesheetId: number; itemId: number }) =>
      ingestionAPI.deleteLineItem(timesheetId, itemId),
    onSuccess: (_, { timesheetId }) => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheet', timesheetId] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
    },
  });
};

export const useApproveIngestionTimesheet = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, comment }: { id: number; comment?: string }) =>
      ingestionAPI.approveTimesheet(id, comment).then((res) => res.data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheet', id] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
      invalidateApprovalSurfaces(queryClient);
    },
  });
};

export const useRejectIngestionTimesheet = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason, comment }: { id: number; reason: string; comment?: string }) =>
      ingestionAPI.rejectTimesheet(id, reason, comment).then((res) => res.data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheet', id] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
      invalidateApprovalSurfaces(queryClient);
    },
  });
};

export const useHoldIngestionTimesheet = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, comment }: { id: number; comment?: string }) =>
      ingestionAPI.holdTimesheet(id, comment).then((res) => res.data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheet', id] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
    },
  });
};

export const useDraftIngestionComment = () => {
  return useMutation({
    mutationFn: ({ id, seedText }: { id: number; seedText: string }) =>
      ingestionAPI.draftComment(id, seedText).then((res) => res.data),
  });
};

export const useRejectIngestionLineItem = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ timesheetId, itemId, reason }: { timesheetId: number; itemId: number; reason: string }) =>
      ingestionAPI.rejectLineItem(timesheetId, itemId, reason).then((res) => res.data),
    onSuccess: (_, { timesheetId }) => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheet', timesheetId] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
    },
  });
};

export const useUnrejectIngestionLineItem = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ timesheetId, itemId }: { timesheetId: number; itemId: number }) =>
      ingestionAPI.unrejectLineItem(timesheetId, itemId).then((res) => res.data),
    onSuccess: (_, { timesheetId }) => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheet', timesheetId] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
    },
  });
};

export const useRevertIngestionTimesheetRejection = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: number }) =>
      ingestionAPI.revertTimesheetRejection(id).then((res) => res.data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheet', id] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
    },
  });
};

export const useRevertTimeEntryRejection = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: number }) =>
      approvalsAPI.revertRejection(id).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['approvals', 'history'] });
      queryClient.invalidateQueries({ queryKey: ['approvals', 'pending'] });
    },
  });
};

// ── Tenant Settings ────────────────────────────────────────────────────────

export const useTenantSettings = (enabled: boolean = true) => {
  return useQuery({
    queryKey: ['tenant-settings'],
    queryFn: () => tenantSettingsAPI.get().then((res) => res.data),
    enabled,
  });
};

export const useTenantPublicSettings = () => {
  return useQuery({
    queryKey: ['tenant-settings', 'public'],
    queryFn: () => tenantSettingsAPI.getPublic().then((res) => res.data),
  });
};

/** Resolve tenant week start day as a date-fns compatible 0|1. Defaults to 0 (Sunday).
 *  Accepts both the legacy string payload (``"1"``) and the typed int (``1``)
 *  returned by the catalog-backed settings endpoint. */
export const useWeekStartsOn = (): 0 | 1 => {
  const { data } = useTenantPublicSettings();
  const raw = data?.week_start_day;
  return raw === 1 || raw === '1' ? 1 : 0;
};

export const useUpdateTenantSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, SettingValue>) =>
      tenantSettingsAPI.update(data).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenant-settings'] });
      queryClient.invalidateQueries({ queryKey: ['tenant-settings', 'public'] });
    },
  });
};

export const useTenantSettingsCatalog = () => {
  return useQuery({
    queryKey: ['tenant-settings', 'catalog'],
    queryFn: () => tenantSettingsAPI.getCatalog().then((res) => res.data),
    staleTime: 60_000,
  });
};

export const useUnlockUserTimesheet = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) => tenantSettingsAPI.unlockUser(userId).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};

// ── Departments ────────────────────────────────────────────────────────────

export const useDepartments = () => {
  return useQuery({
    queryKey: ['departments'],
    queryFn: () => departmentsAPI.list().then((res) => res.data),
  });
};

export const useCreateDepartment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => departmentsAPI.create(name).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['departments'] });
    },
  });
};

export const useDeleteDepartment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => departmentsAPI.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['departments'] });
    },
  });
};

// ── Leave types ────────────────────────────────────────────────────────────

export const useLeaveTypes = (includeInactive = false) => {
  return useQuery({
    queryKey: ['leave-types', includeInactive],
    queryFn: () => leaveTypesAPI.list(includeInactive).then((r) => r.data),
  });
};

export const useCreateLeaveType = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { label: string; code?: string; color?: string }) =>
      leaveTypesAPI.create(data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leave-types'] });
    },
  });
};

export const useUpdateLeaveType = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: { label?: string; color?: string; is_active?: boolean } }) =>
      leaveTypesAPI.update(id, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leave-types'] });
    },
  });
};

export const useDeleteLeaveType = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => leaveTypesAPI.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leave-types'] });
    },
  });
};

// ─── Holidays ──────────────────────────────────────────────────────────────
// Org-wide non-working days. Admins create/delete; everyone in the
// tenant reads. Calendar surfaces and dashboard late detection both
// consume the same list.

export const useHolidays = (params?: { start_date?: string; end_date?: string; country?: string }) => {
  return useQuery({
    queryKey: ['holidays', params?.start_date ?? null, params?.end_date ?? null, params?.country ?? null],
    queryFn: () => holidaysAPI.list(params).then((r) => r.data),
  });
};

/** Distinct country codes present in this tenant's holidays.
 *  Used to populate the calendar's location filter dropdown. */
export const useHolidayCountries = () => {
  return useQuery({
    queryKey: ['holiday-countries'],
    queryFn: () => holidaysAPI.countries().then((r) => r.data),
  });
};

export const useCreateHoliday = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { date: string; name: string; holiday_type: import('@/types').HolidayType; country?: string }) =>
      holidaysAPI.create(data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['holidays'] });
      queryClient.invalidateQueries({ queryKey: ['holiday-countries'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', 'manager-team-overview'] });
    },
  });
};

export const useBulkCreateHolidays = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (holidays: Array<{ date: string; name: string; holiday_type: import('@/types').HolidayType; country?: string }>) =>
      holidaysAPI.bulkCreate(holidays).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['holidays'] });
      queryClient.invalidateQueries({ queryKey: ['holiday-countries'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', 'manager-team-overview'] });
    },
  });
};

export const useUpdateHoliday = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: { name?: string; holiday_type?: import('@/types').HolidayType } }) =>
      holidaysAPI.update(id, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['holidays'] });
      queryClient.invalidateQueries({ queryKey: ['holiday-countries'] });
    },
  });
};

export const useDeleteHoliday = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => holidaysAPI.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['holidays'] });
      queryClient.invalidateQueries({ queryKey: ['holiday-countries'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', 'manager-team-overview'] });
    },
  });
};

export const useHolidaySuggestions = (country: string, year: number, enabled: boolean) => {
  return useQuery({
    queryKey: ['holiday-suggestions', country, year],
    queryFn: () => holidaysAPI.suggestions(country, year).then((r) => r.data),
    enabled: enabled && !!country && !!year,
  });
};

import type { ImportCommitRequest, ExportUsersParams, ExportClientsParams, ExportTimesheetsParams } from '@/api/endpoints';

export const useImportUsersPreview = () =>
  useMutation({
    mutationFn: (file: File) => usersAPI.importPreview(file).then((r) => r.data),
  });

export const useImportUsersValidate = () =>
  useMutation({
    mutationFn: (data: { headers: string[]; rows: string[][]; mapping: Record<string, string> }) =>
      usersAPI.importValidate(data).then((r) => r.data),
  });

export const useImportUsersCommit = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ImportCommitRequest) => usersAPI.importCommit(data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};

function _downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function _filenameFromHeaders(headers: Record<string, string> | undefined, fallback: string): string {
  const dispo = headers?.['content-disposition'] || headers?.['Content-Disposition'];
  if (dispo) {
    const match = /filename="?([^";]+)"?/.exec(dispo);
    if (match) return match[1];
  }
  return fallback;
}

export const useExportUsers = () =>
  useMutation({
    mutationFn: async (params: ExportUsersParams) => {
      const resp = await usersAPI.exportUsers(params);
      const filename = _filenameFromHeaders(
        resp.headers as Record<string, string>,
        `users.${params.fmt}`,
      );
      _downloadBlob(resp.data, filename);
    },
  });

export const useExportClients = () =>
  useMutation({
    mutationFn: async (params: ExportClientsParams) => {
      const resp = await usersAPI.exportClients(params);
      const filename = _filenameFromHeaders(
        resp.headers as Record<string, string>,
        `clients.${params.fmt}`,
      );
      _downloadBlob(resp.data, filename);
    },
  });

export const useExportTimesheets = () =>
  useMutation({
    mutationFn: async (params: ExportTimesheetsParams) => {
      const resp = await usersAPI.exportTimesheets(params);
      const filename = _filenameFromHeaders(
        resp.headers as Record<string, string>,
        `approved-timesheets.${params.fmt}`,
      );
      _downloadBlob(resp.data, filename);
    },
  });

// ── Platform-admin Dashboard / Calendar / Audit hooks ─────────────────────
//
// All require a PLATFORM_ADMIN token. The PA-specific pages call these.
// 30s staleTime on the dashboard widgets, 60s on the calendar/audit which
// change less frequently.
export const usePlatformDashboardSummary = (enabled: boolean = true) => {
  return useQuery({
    queryKey: ['platform', 'dashboard', 'summary'],
    queryFn: () => platformDashboardAPI.summary().then((res) => res.data),
    staleTime: 30_000,
    refetchInterval: 60_000,
    enabled,
  });
};

export const usePlatformDashboardHealth = (enabled: boolean = true) => {
  return useQuery({
    queryKey: ['platform', 'dashboard', 'health'],
    queryFn: () => platformDashboardAPI.health().then((res) => res.data),
    staleTime: 20_000,
    // Health refreshes faster than the summary because operators expect
    // it to feel live; matches the "Live · refreshes every 30s" hint in
    // the dashboard mockup.
    refetchInterval: 30_000,
    enabled,
  });
};

export const usePlatformCalendarEvents = (
  rangeStart: string,
  rangeEnd: string,
  enabled: boolean = true,
) => {
  return useQuery({
    queryKey: ['platform', 'calendar', rangeStart, rangeEnd],
    queryFn: () =>
      platformDashboardAPI
        .calendarEvents(rangeStart, rangeEnd)
        .then((res) => res.data),
    staleTime: 60_000,
    enabled: enabled && Boolean(rangeStart && rangeEnd),
  });
};

export const usePlatformAudit = (
  params: PlatformAuditListParams = {},
  enabled: boolean = true,
) => {
  return useQuery({
    // Stringify the params into the key so different filter combos cache
    // separately. The backend ANDs each set filter.
    queryKey: ['platform', 'audit', params],
    queryFn: () => platformDashboardAPI.auditList(params).then((res) => res.data),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    enabled,
  });
};

export const usePlatformAuditEvent = (
  eventId: number | null,
  enabled: boolean = true,
) => {
  return useQuery({
    queryKey: ['platform', 'audit', 'event', eventId],
    queryFn: () =>
      platformDashboardAPI.auditEvent(eventId as number).then((res) => res.data),
    enabled: enabled && eventId !== null && Number.isFinite(eventId),
  });
};

export const usePlatformTenantsUsersCount = (enabled: boolean = true) => {
  return useQuery({
    queryKey: ['platform', 'tenants', 'users-count'],
    queryFn: () =>
      platformDashboardAPI.tenantsUsersCount().then((res) => res.data),
    staleTime: 60_000,
    enabled,
  });
};

/**
 * Per-tenant compact-list stats: user count, admin count,
 * last_activity_at. Single fan-out across active tenant DBs.
 */
export const usePlatformTenantStats = (enabled: boolean = true) => {
  return useQuery({
    queryKey: ['platform', 'tenants', 'stats'],
    queryFn: () =>
      platformDashboardAPI.tenantStats().then((res) => res.data),
    staleTime: 60_000,
    enabled,
  });
};
