import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

import { Card, Empty, WorkspaceHeader } from '@/components/ui';
import { usePlatformCalendar } from '@/hooks/usePlatform';
import { addDays, fromISODate, isSameDay, startOfWeek, toISODate } from '@/lib/date';
import { cn } from '@/lib/cn';
import type { PlatformCalendarEvent } from '@/types/platform';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Event-type config drives the chip tone, the filter row, and the swatch.
// Keys MUST match the backend CalendarEvent.type values.
type TypeConfig = { key: string; label: string; chip: string; swatch: string };

const EVENT_TYPES: TypeConfig[] = [
  { key: 'tenant_created', label: 'Tenants created', chip: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300', swatch: 'bg-emerald-500' },
  { key: 'provisioning', label: 'Provisioning', chip: 'bg-sky-500/15 text-sky-600 dark:text-sky-300', swatch: 'bg-sky-500' },
  { key: 'migration', label: 'Migrations', chip: 'bg-violet-500/15 text-violet-600 dark:text-violet-300', swatch: 'bg-violet-500' },
  { key: 'maintenance', label: 'Maintenance', chip: 'bg-amber-500/15 text-amber-600 dark:text-amber-300', swatch: 'bg-amber-500' },
  { key: 'contract', label: 'Contracts', chip: 'bg-primary/10 text-primary', swatch: 'bg-primary' },
];

const TYPE_CONFIG: Record<string, TypeConfig> = EVENT_TYPES.reduce(
  (acc, cfg) => ({ ...acc, [cfg.key]: cfg }),
  {} as Record<string, TypeConfig>,
);

// Everything except "contract" is on by default (matches the f2 mockup where
// contracts are off until a tenant has signed agreements modeled).
const DEFAULT_VISIBLE: string[] = ['tenant_created', 'provisioning', 'migration', 'maintenance'];

// Platform-admin calendar: tenant-lifecycle events (created/provisioning/
// migration/maintenance/contract) on a month grid, with type filters and an
// upcoming-30-days sidebar.
export function PlatformCalendarPage() {
  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(() => new Set(DEFAULT_VISIBLE));

  const gridStart = useMemo(() => startOfWeek(cursor), [cursor]);
  const gridDays = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)), [gridStart]);

  const q = usePlatformCalendar({ range_start: toISODate(gridDays[0]), range_end: toISODate(gridDays[41]) });
  const allEvents = useMemo(() => q.data?.events ?? [], [q.data]);

  // Per-day lookup, filtered to the visible types up front.
  const byDay = useMemo(() => {
    const m = new Map<string, PlatformCalendarEvent[]>();
    allEvents.forEach((e) => {
      if (!visibleTypes.has(e.type)) return;
      const l = m.get(e.date) ?? [];
      l.push(e);
      m.set(e.date, l);
    });
    return m;
  }, [allEvents, visibleTypes]);

  // Upcoming next 30 days: future-only, sorted, capped at 8 rows.
  const upcoming = useMemo(() => {
    const start = toISODate(today);
    const end = toISODate(addDays(today, 30));
    return allEvents
      .filter((e) => visibleTypes.has(e.type) && e.date >= start && e.date <= end)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 8);
  }, [allEvents, visibleTypes, today]);

  const toggleType = (key: string) =>
    setVisibleTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const monthIdx = cursor.getMonth();
  const visibleCount = allEvents.filter((e) => visibleTypes.has(e.type)).length;

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        title="Platform calendar"
        description="Tenant lifecycle events across the fleet."
        primary={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setCursor(new Date(today.getFullYear(), today.getMonth(), 1))}
              className="inline-flex h-9 items-center rounded-full border border-border bg-card px-3 text-sm font-medium text-foreground transition hover:border-primary/50 hover:text-primary"
            >
              Today
            </button>
            <div className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-card px-3 text-sm">
              <button type="button" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} aria-label="Previous month" className="text-muted-foreground hover:text-primary"><ChevronLeft className="h-4 w-4" /></button>
              <span className="min-w-[120px] text-center font-medium text-foreground">{monthLabel}</span>
              <button type="button" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} aria-label="Next month" className="text-muted-foreground hover:text-primary"><ChevronRight className="h-4 w-4" /></button>
            </div>
          </div>
        }
      />

      {/* Event-type filter chips. Client-side filtering of the grid + sidebar. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Show</span>
        {EVENT_TYPES.map((cfg) => {
          const active = visibleTypes.has(cfg.key);
          return (
            <button
              key={cfg.key}
              type="button"
              onClick={() => toggleType(cfg.key)}
              aria-pressed={active}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition',
                active
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground',
              )}
            >
              <span className={cn('h-2 w-2 rounded-full', cfg.swatch)} />
              {cfg.label}
            </button>
          );
        })}
      </div>

      {q.isLoading ? (
        <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>
      ) : q.isError ? (
        <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">Couldn't load the platform calendar.</Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
          {visibleCount === 0 ? (
            <Empty title="No events to show" description="No events match the selected types this month." />
          ) : (
            <Card className="p-3">
              <div className="grid grid-cols-7 gap-1.5 pb-2">
                {WEEKDAYS.map((d) => <div key={d} className="text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{d}</div>)}
              </div>
              <div className="grid grid-cols-7 gap-1.5">
                {gridDays.map((d) => {
                  const iso = toISODate(d);
                  const events = byDay.get(iso) ?? [];
                  const inMonth = d.getMonth() === monthIdx;
                  const isToday = isSameDay(d, today);
                  return (
                    <div key={iso} className={cn('flex min-h-[80px] flex-col rounded-xl border p-2', inMonth ? 'border-border bg-card' : 'border-transparent bg-muted/30', isToday ? 'ring-2 ring-primary/40' : '')}>
                      <span className={cn('text-xs', inMonth ? 'text-foreground' : 'text-muted-foreground/50', isToday ? 'font-semibold text-primary' : '')}>{d.getDate()}</span>
                      <div className="mt-1 flex flex-col gap-0.5">
                        {events.slice(0, 3).map((e) => {
                          const cfg = TYPE_CONFIG[e.type];
                          return (
                            <span key={e.id} className={cn('truncate rounded px-1 py-0.5 text-[9px] font-medium', cfg?.chip ?? 'bg-muted text-muted-foreground')} title={e.title + (e.detail ? `: ${e.detail}` : '')}>{e.title}</span>
                          );
                        })}
                        {events.length > 3 ? <span className="text-[9px] text-muted-foreground">+{events.length - 3} more</span> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Upcoming next 30 days */}
          <Card className="overflow-hidden p-0">
            <div className="border-b border-border bg-muted/30 px-4 py-3">
              <h2 className="text-xs font-semibold text-foreground">Upcoming · next 30 days</h2>
            </div>
            {upcoming.length > 0 ? (
              <ul className="divide-y divide-border">
                {upcoming.map((e) => {
                  const cfg = TYPE_CONFIG[e.type];
                  const date = fromISODate(e.date);
                  return (
                    <li key={e.id} className="flex gap-3 px-4 py-3">
                      <div className="flex shrink-0 flex-col items-center rounded-lg border border-border bg-muted/30 px-2 py-1">
                        <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{date.toLocaleDateString(undefined, { month: 'short' })}</span>
                        <span className="text-base font-bold leading-none text-foreground">{date.getDate()}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-foreground" title={e.title}>{e.title}</p>
                        <p className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span className={cn('h-1.5 w-1.5 rounded-full', cfg?.swatch ?? 'bg-muted-foreground')} />
                          {cfg?.label ?? e.type}
                          {e.detail ? ` · ${e.detail}` : ''}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                No upcoming events in the next 30 days.
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
