import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { customDashboardsApi } from '@/api/client';
import type { CustomDashboardBody } from '@/types/customDashboard';

// Configurable Insights dashboards: list (own + shared), create, update
// (layout/name/share), delete. Mutations invalidate the list.

export function useCustomDashboards(enabled = true) {
  return useQuery({
    queryKey: ['custom-dashboards'],
    queryFn: () => customDashboardsApi.list().then((r) => r.data),
    enabled, staleTime: 15_000,
  });
}

export function useCreateCustomDashboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CustomDashboardBody) => customDashboardsApi.create(data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-dashboards'] }),
  });
}

export function useUpdateCustomDashboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: CustomDashboardBody }) =>
      customDashboardsApi.update(id, data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-dashboards'] }),
  });
}

export function useDeleteCustomDashboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customDashboardsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-dashboards'] }),
  });
}

// ── Public sharing ───────────────────────────────────────────────────────────
export function useShareDashboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, mode }: { id: number; mode: 'live' | 'snapshot' }) =>
      customDashboardsApi.share(id, mode).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-dashboards'] }),
  });
}

export function useRefreshDashboardSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customDashboardsApi.refreshSnapshot(id).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-dashboards'] }),
  });
}

export function useRevokeDashboardShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customDashboardsApi.revokeShare(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-dashboards'] }),
  });
}
