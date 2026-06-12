import { useMemo } from 'react';
import { Loader2, Pencil, Wrench } from 'lucide-react';

import { Button, Card, Empty } from '@/components/ui';
import { useMyEntriesFiltered } from '@/hooks/useTime';
import { formatDayLong, formatWeekRange, fromISODate, startOfWeek, toISODate } from '@/lib/date';
import type { TimeEntry } from '@/types/time';

const num = (v: string | number) => (typeof v === 'string' ? parseFloat(v) : v) || 0;

// Rework tab: REJECTED entries grouped by week, showing the rejection reason so
// the user knows what to fix. "Fix in editor" jumps to the Enter tab on that
// week AND selects the specific rejected day (not the week's first day).
// Mirrors frontend2's Rework tab. onFix(weekStartIso, dayIso): dayIso is the
// exact day to open in the editor.
export function ReworkTab({ onFix }: { onFix: (weekStartIso: string, dayIso: string) => void }) {
  const q = useMyEntriesFiltered({ status: 'REJECTED', sort_by: 'entry_date', sort_order: 'desc', limit: 500 });
  const rows = q.data ?? [];

  const groups = useMemo(() => {
    const m = new Map<string, { weekStart: string; entries: TimeEntry[]; hours: number; reason: string | null; firstDay: string }>();
    rows.forEach((e) => {
      const ws = toISODate(startOfWeek(fromISODate(e.entry_date)));
      const g = m.get(ws) ?? { weekStart: ws, entries: [], hours: 0, reason: null, firstDay: e.entry_date };
      g.entries.push(e);
      g.hours += num(e.hours);
      if (!g.reason && e.rejection_reason) g.reason = e.rejection_reason;
      // Track the earliest rejected day so "Fix in editor" lands on a day that
      // actually needs rework, not the week's Monday.
      if (e.entry_date < g.firstDay) g.firstDay = e.entry_date;
      m.set(ws, g);
    });
    // Sort each group's entries by date so per-entry Fix targets the right day.
    const out = Array.from(m.values());
    out.forEach((g) => g.entries.sort((a, b) => a.entry_date.localeCompare(b.entry_date)));
    return out.sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  }, [rows]);

  if (q.isLoading) {
    return <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>;
  }
  if (q.isError) {
    return <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">Couldn't load rejected entries. Try refreshing.</Card>;
  }
  if (groups.length === 0) {
    return <Empty Icon={Wrench} title="Nothing to rework" description="When a manager sends a timesheet back, it shows up here with their notes." />;
  }

  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <Card key={g.weekStart} className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-rose-500/5 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-foreground">{formatWeekRange(fromISODate(g.weekStart))}</p>
              <p className="text-xs text-muted-foreground">{g.entries.length} {g.entries.length === 1 ? 'entry' : 'entries'} · {g.hours.toFixed(2)}h</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => onFix(g.weekStart, g.firstDay)}>
              <Pencil className="h-3.5 w-3.5" /> Fix in editor
            </Button>
          </div>
          {g.reason ? (
            <div className="border-b border-border px-4 py-2 text-sm text-rose-700 dark:text-rose-300">
              <span className="font-medium">Manager's note:</span> {g.reason}
            </div>
          ) : null}
          <div className="divide-y divide-border">
            {g.entries.map((e) => (
              <div key={e.id} className="group flex items-start gap-3 px-4 py-2.5">
                <div className="w-28 shrink-0 text-xs tabular-nums text-muted-foreground">{formatDayLong(fromISODate(e.entry_date))}</div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{e.project?.name ?? `Project #${e.project_id}`}</p>
                  {e.description ? <p className="truncate text-xs text-muted-foreground">{e.description}</p> : null}
                  {e.rejection_reason && e.rejection_reason !== g.reason ? <p className="text-[11px] text-rose-600 dark:text-rose-300">{e.rejection_reason}</p> : null}
                </div>
                <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{num(e.hours).toFixed(2)}h</p>
                <button
                  type="button"
                  onClick={() => onFix(g.weekStart, e.entry_date)}
                  title="Fix this day in the editor"
                  className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary opacity-0 transition-opacity hover:bg-primary/10 group-hover:opacity-100 focus:opacity-100"
                >
                  Fix
                </button>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
