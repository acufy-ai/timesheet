import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { attentionSignalsApi, notificationsApi } from '@/api/client';

// In-app notifications (the bell). Polls every 60s while mounted. Gated off for
// PLATFORM_ADMIN — /notifications/summary is tenant-scoped and 400s without a
// tenant context, and PAs have no notification surface.
export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: ['notifications', 'summary'],
    queryFn: () => notificationsApi.summary().then((r) => r.data),
    enabled,
    refetchInterval: enabled ? 60_000 : false,
    staleTime: 30_000,
    retry: false,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}
export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}
export function useDeleteNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => notificationsApi.deleteOne(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}
export function useDeleteAllNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => notificationsApi.deleteAll(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

// Server-persisted dismissal/snooze of dashboard attention-queue cards.
export function useDismissedSignals(enabled = true) {
  return useQuery({
    queryKey: ['attention-signals', 'dismissed'],
    queryFn: () => attentionSignalsApi.dismissed().then((r) => r.data),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}
export function useDismissSignal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, snoozedUntil }: { key: string; snoozedUntil?: string }) =>
      attentionSignalsApi.dismiss(key, snoozedUntil),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attention-signals'] }),
  });
}
export function useUndismissSignal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => attentionSignalsApi.undismiss(key),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attention-signals'] }),
  });
}
