import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { approvalsApi } from '@/api/client';

// Approvals data + mutations. Approve/reject invalidate the approvals queries
// and the dashboard (pending_approvals_count feeds the manager overview).

export function usePendingApprovals() {
  return useQuery({
    queryKey: ['approvals', 'pending'],
    queryFn: () => approvalsApi.pending().then((r) => r.data),
    staleTime: 5_000,
  });
}

export function useApprovalHistory(enabled = true) {
  return useQuery({
    queryKey: ['approvals', 'history'],
    queryFn: () => approvalsApi.history().then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

// Approval history grouped by employee-week (the "Approved" tab). Refetches
// when the days-back window or status filter changes.
export function useApprovalHistoryGrouped(
  params: { days_back: number; status_filter?: 'approved' | 'rejected' | 'mixed' },
  enabled = true,
) {
  return useQuery({
    queryKey: ['approvals', 'history-grouped', params.days_back, params.status_filter ?? 'all'],
    queryFn: () => approvalsApi.historyGrouped(params).then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

export function useBatchApprove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entryIds: number[]) => approvalsApi.batchApprove(entryIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useBatchReject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ entryIds, reason }: { entryIds: number[]; reason: string }) =>
      approvalsApi.batchReject(entryIds, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
