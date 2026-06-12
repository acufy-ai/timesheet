import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { projectsApi, tasksApi, timeApi } from '@/api/client';
import type { CreateTimeEntry, UpdateTimeEntry } from '@/types/time';

// My-Time data + mutations. Entries are keyed by the week range so navigating
// weeks caches each independently. Mutations invalidate both the week query
// and the dashboard (submitted hours feed the manager overview).

export function useMyEntries(startDate: string, endDate: string) {
  return useQuery({
    // Sort ascending by date so the week reads top-to-bottom in order.
    queryKey: ['timesheets', 'my', startDate, endDate],
    queryFn: () =>
      timeApi
        .list({
          start_date: startDate,
          end_date: endDate,
          sort_by: 'entry_date',
          sort_order: 'asc',
          limit: 1000,
        })
        .then((r) => r.data),
    staleTime: 5_000,
  });
}

export function useProjects() {
  return useQuery({
    queryKey: ['projects', 'active'],
    queryFn: () => projectsApi.list({ active_only: true }).then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

// All active tasks across projects; the editor filters by selected project.
export function useTasks() {
  return useQuery({
    queryKey: ['tasks', 'active'],
    queryFn: () => tasksApi.list({ active_only: true, limit: 1000 }).then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useWeeklySubmitStatus() {
  return useQuery({
    queryKey: ['timesheets', 'weekly-submit-status'],
    queryFn: () => timeApi.weeklyStatus().then((r) => r.data),
    staleTime: 30_000,
  });
}

// Filtered list for the History/Rework tabs (status, date range, search, sort).
export function useMyEntriesFiltered(params: import('@/types/time').ListEntriesParams) {
  return useQuery({
    queryKey: ['timesheets', 'my', 'filtered', params],
    queryFn: () => timeApi.list(params).then((r) => r.data),
    staleTime: 10_000,
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['timesheets'] });
  qc.invalidateQueries({ queryKey: ['dashboard'] });
}

export function useCreateEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTimeEntry) => timeApi.create(data).then((r) => r.data),
    onSuccess: () => invalidate(qc),
  });
}

export function useUpdateEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateTimeEntry }) =>
      timeApi.update(id, data).then((r) => r.data),
    onSuccess: () => invalidate(qc),
  });
}

export function useDeleteEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => timeApi.remove(id),
    onSuccess: () => invalidate(qc),
  });
}

export function useSubmitEntries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entryIds: number[]) => timeApi.submit(entryIds),
    onSuccess: () => invalidate(qc),
  });
}

export function useRecallEntries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entryIds: number[]) => timeApi.recall(entryIds),
    onSuccess: () => invalidate(qc),
  });
}
