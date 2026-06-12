import { useQuery } from '@tanstack/react-query';

import { dashboardApi, dashboardSummaryApi } from '@/api/client';
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
