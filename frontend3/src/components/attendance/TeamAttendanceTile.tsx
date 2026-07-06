import { CircleUser } from 'lucide-react';

import { Card } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useTeamAttendance } from '@/hooks/useAttendance';

// A small manager tile: who on the team is currently clocked in vs out today.
// Deliberately compact (a short status list), not a full project-management
// tile. Hidden entirely when the manager has no direct reports.
function fmtTime(iso?: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function TeamAttendanceTile() {
  const q = useTeamAttendance();
  const data = q.data;
  // No reports / nothing to show -> render nothing (tile collapses away).
  if (!data || data.total === 0) return null;

  return (
    <Card>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <CircleUser className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-semibold text-foreground">Who's in</p>
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">
          {data.in_count}/{data.total} clocked in
        </p>
      </div>
      <ul className="max-h-56 divide-y divide-border/60 overflow-y-auto">
        {data.rows.map((r) => (
          <li key={r.user_id} className="flex items-center justify-between px-4 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', r.clocked_in ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
              <span className="truncate text-foreground">{r.full_name}</span>
            </span>
            <span className={cn('shrink-0 tabular-nums text-xs', r.clocked_in ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>
              {r.clocked_in ? `In · ${fmtTime(r.since)}` : (r.last_event === 'clock_out' ? `Out · ${fmtTime(r.last_event_at)}` : 'Not in')}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
