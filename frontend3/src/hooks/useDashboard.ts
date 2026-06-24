import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { dashboardApi, dashboardSummaryApi, tasksApi } from '@/api/client';
// useTeamRejectionStats is exported below alongside the other manager hooks.
// (useDashboardSummary retained for any future use; the dashboard now uses the
// analytics-driven widget grid for the personal view.)

// Manager dashboard data hooks. Team overview has a short stale window so the
// dashboard reflects recent submissions; project health is cheaper to leave
// cached longer.

export function useManagerTeamOverview(enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'manager-team-overview'],
    queryFn: () => dashboardApi.managerTeamOverview().then((r) => r.data),
    enabled,
    staleTime: 5_000,
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
