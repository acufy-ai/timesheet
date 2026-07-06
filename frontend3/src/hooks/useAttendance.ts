import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { attendanceApi } from '@/api/client';

// The caller's own clock-in/out status today. Drives the topbar clock button.
export function useMyAttendance(enabled = true) {
  return useQuery({
    queryKey: ['attendance', 'me'],
    queryFn: () => attendanceApi.me().then((r) => r.data),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

// Toggle clock-in / clock-out. Invalidates own status + the team tile + the
// notification bell (which counts today's team clock events).
export function useClockToggle() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['attendance'] });
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  const clockIn = useMutation({
    mutationFn: (note?: string) => attendanceApi.clockIn(note).then((r) => r.data),
    onSuccess: invalidate,
  });
  const clockOut = useMutation({
    mutationFn: (note?: string) => attendanceApi.clockOut(note).then((r) => r.data),
    onSuccess: invalidate,
  });
  return { clockIn, clockOut };
}

// A manager's team clock-in/out status today. Drives the "Who's in" tile.
export function useTeamAttendance(enabled = true) {
  return useQuery({
    queryKey: ['attendance', 'team'],
    queryFn: () => attendanceApi.team().then((r) => r.data),
    enabled,
    refetchInterval: enabled ? 60_000 : false,
    staleTime: 30_000,
    retry: false,
  });
}
