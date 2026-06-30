import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { dashboardApi, dashboardSummaryApi, tasksApi } from '@/api/client';
// useTeamRejectionStats is exported below alongside the other manager hooks.
// (useDashboardSummary retained for any future use; the dashboard now uses the
// analytics-driven widget grid for the personal view.)

// Manager dashboard data hooks. Team overview has a short stale window so the
// dashboard reflects recent submissions; project health is cheaper to leave
// cached longer.

export function useManagerTeamOverview(enabled = true, weekOffset = 0) {
  return useQuery({
    queryKey: ['dashboard', 'manager-team-overview', weekOffset],
    queryFn: () => dashboardApi.managerTeamOverview(weekOffset).then((r) => r.data),
    enabled,
    // Past weeks are immutable history, so they cache far longer; the current
    // week stays fresh so recent submissions show up.
    staleTime: weekOffset < 0 ? 5 * 60_000 : 5_000,
  });
}

export function useManagerProjectHealth(enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'manager-project-health'],
    queryFn: () => dashboardApi.managerProjectHealth().then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

export function useManagerFinancials(enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'manager-financials'],
    queryFn: () => dashboardApi.managerFinancials().then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

export function useMyWork(enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'my-work'],
    queryFn: () => dashboardApi.myWork().then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

// Assignee-scoped task progress edit (status / description) from My Work.
// Invalidates My Work so the row reflects the new state.
export function useUpdateTaskProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, ...body }: { taskId: number; status?: string; description?: string }) =>
      tasksApi.updateProgress(taskId, body).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dashboard', 'my-work'] });
    },
  });
}

// Daily standup view of yesterday's submissions. Short stale window like the
// team overview so it reflects late submissions made this morning.
export function useTeamDailyOverview(enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'team-daily-overview'],
    queryFn: () => dashboardApi.teamDailyOverview().then((r) => r.data),
    enabled,
    staleTime: 5_000,
  });
}

// Rejection rate + top reasons over a lookback window (default 90 days).
// Historical/aggregate view, so a longer stale window is fine.
export function useTeamRejectionStats(daysBack = 90, enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'team-rejection-stats', daysBack],
    queryFn: () => dashboardApi.teamRejectionStats(daysBack).then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

// Billable share of approved hours per employee over a window (default 90 days).
export function useTeamBillableStats(daysBack = 90, enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'team-billable-stats', daysBack],
    queryFn: () => dashboardApi.teamBillableStats(daysBack).then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

// On-time submission trend (weekly grain) over a window (default 90 days).
export function useTeamOnTimeStats(daysBack = 90, enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'team-on-time-stats', daysBack],
    queryFn: () => dashboardApi.teamOnTimeStats(daysBack).then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

// Per-employee per-project approved hours matrix (default 30-day window).
export function useTeamProjectMatrix(daysBack = 30, enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'team-project-matrix', daysBack],
    queryFn: () => dashboardApi.teamProjectMatrix(daysBack).then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

export function useTeamResourcing(weeksAhead = 4, enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'team-resourcing', weeksAhead],
    queryFn: () => dashboardApi.teamResourcing(weeksAhead).then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

// Per-employee detail for the resourcing slide-over (fetched only when opened).
export function useResourceDetail(userId: number | null, daysBack = 90) {
  return useQuery({
    queryKey: ['dashboard', 'resource', userId, daysBack],
    queryFn: () => dashboardApi.resourceDetail(userId as number, daysBack).then((r) => r.data),
    enabled: userId != null,
    staleTime: 30_000,
  });
}

export function usePortfolio(enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'portfolio'],
    queryFn: () => dashboardApi.portfolio().then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

export function useEvm(enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'evm'],
    queryFn: () => dashboardApi.evm().then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

export function useRevenueRecognition(enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'revenue-recognition'],
    queryFn: () => dashboardApi.revenueRecognition().then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

// Task-level "why" breakdown for a single project (project report).
export function useProjectTaskBreakdown(projectId: number, enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'project-task-breakdown', projectId],
    queryFn: () => dashboardApi.projectTaskBreakdown(projectId).then((r) => r.data),
    enabled: enabled && Number.isFinite(projectId),
    staleTime: 60_000,
  });
}

// The manager's clients + the projects they run (dashboard widget).
export function useManagerClients(enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'manager-clients'],
    queryFn: () => dashboardApi.managerClients().then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

// Configurable project-health thresholds (workspace default + this manager's
// override). The mutation invalidates portfolio + project-health so the pills
// reclassify immediately after a rule change.
export function useHealthConfig(enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'health-config'],
    queryFn: () => dashboardApi.healthConfig().then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

export function useSaveHealthConfig() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['dashboard', 'health-config'] });
    qc.invalidateQueries({ queryKey: ['dashboard', 'portfolio'] });
    qc.invalidateQueries({ queryKey: ['dashboard', 'manager-project-health'] });
  };
  return useMutation({
    mutationFn: ({ scope, body }: { scope: 'workspace' | 'override'; body: import('@/types/dashboard').HealthConfigBody }) =>
      dashboardApi.setHealthConfig(scope, body).then((r) => r.data),
    onSuccess: invalidate,
  });
}

export function useClearHealthOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => dashboardApi.clearHealthOverride().then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dashboard', 'health-config'] });
      qc.invalidateQueries({ queryKey: ['dashboard', 'portfolio'] });
      qc.invalidateQueries({ queryKey: ['dashboard', 'manager-project-health'] });
    },
  });
}

// Set or clear ONE project's manual health override (health: null clears it).
export function useSetProjectHealthOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, health }: { projectId: number; health: string | null }) =>
      dashboardApi.setProjectHealthOverride(projectId, health).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dashboard', 'portfolio'] });
      qc.invalidateQueries({ queryKey: ['dashboard', 'manager-project-health'] });
    },
  });
}

// Personal summary (own hours logged/approved/pending). Powers the employee
// dashboard variant for non-managers.
export function useDashboardSummary(enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: () => dashboardSummaryApi.summary().then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

// Per-range analytics for the employee widget grid.
export function useDashboardAnalytics(
  params: { start_date: string; end_date: string; user_id?: number },
  enabled = true,
) {
  return useQuery({
    queryKey: ['dashboard', 'analytics', params.start_date, params.end_date, params.user_id ?? 'me'],
    queryFn: () => dashboardSummaryApi.analytics(params).then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}
