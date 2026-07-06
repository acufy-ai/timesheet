import { LogIn, LogOut } from 'lucide-react';

import { useMyAttendance, useClockToggle } from '@/hooks/useAttendance';

// Top-bar clock in / out control. A "Clock in" button when out; while clocked
// in, shows the since-time and a "Clock out" button. Pure presence signal — it
// never touches time entries. On toggle, the user's manager(s) are notified.
function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function TopbarClock() {
  const statusQ = useMyAttendance();
  const { clockIn, clockOut } = useClockToggle();
  const busy = clockIn.isPending || clockOut.isPending;

  // Until we know the status, render a neutral, disabled placeholder so the
  // control doesn't flash between states.
  const clockedIn = statusQ.data?.clocked_in ?? false;
  const since = statusQ.data?.since ?? null;

  if (clockedIn) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1">
        <span className="hidden text-xs font-medium text-emerald-700 tabular-nums dark:text-emerald-300 sm:inline">
          In{since ? ` · ${fmtTime(since)}` : ''}
        </span>
        <button
          type="button"
          onClick={() => clockOut.mutate(undefined)}
          disabled={busy}
          title="Clock out"
          aria-label="Clock out"
          className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600 transition-opacity hover:opacity-80 disabled:opacity-50 dark:text-rose-400"
        >
          <LogOut className="h-3.5 w-3.5" /> Clock out
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => clockIn.mutate(undefined)}
      disabled={busy || statusQ.isLoading}
      title="Clock in"
      aria-label="Clock in"
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary disabled:opacity-50 sm:px-3"
    >
      <LogIn className="h-4 w-4 shrink-0" />
      <span className="hidden lg:inline">Clock in</span>
    </button>
  );
}
