import React, { useMemo, useState } from 'react';
import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';

import { Loading } from '@/components';
import { usePlatformCalendarEvents } from '@/hooks';
import type {
  PlatformCalendarEvent,
  PlatformCalendarEventType,
} from '@/types';

// ── Event type config drives swatches AND filter chips. The keys MUST
// match the backend's CalendarEvent.type values. ─────────────────────
type EventTypeConfig = {
  key: PlatformCalendarEventType;
  label: string;
  // Tailwind class on the event chip background + text.
  chipClass: string;
  // Tailwind class on the small color swatch in the filter row.
  swatchClass: string;
};

const EVENT_TYPES: EventTypeConfig[] = [
  {
    key: 'tenant_created',
    label: 'Tenants created',
    chipClass: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    swatchClass: 'bg-emerald-500',
  },
  {
    key: 'provisioning',
    label: 'Provisioning',
    chipClass: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300',
    swatchClass: 'bg-indigo-500',
  },
  {
    key: 'migration',
    label: 'Migrations',
    chipClass: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
    swatchClass: 'bg-sky-500',
  },
  {
    key: 'maintenance',
    label: 'Maintenance',
    chipClass: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    swatchClass: 'bg-amber-500',
  },
  {
    key: 'contract',
    label: 'Contracts',
    chipClass: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
    swatchClass: 'bg-rose-500',
  },
];

const TYPE_CONFIG: Record<PlatformCalendarEventType, EventTypeConfig> =
  EVENT_TYPES.reduce(
    (acc, cfg) => ({ ...acc, [cfg.key]: cfg }),
    {} as Record<PlatformCalendarEventType, EventTypeConfig>,
  );

// Default filter set: everything except "contract" (which isn't modeled
// today; matches the mockup where contracts are off by default).
const DEFAULT_VISIBLE_TYPES: PlatformCalendarEventType[] = [
  'tenant_created',
  'provisioning',
  'migration',
  'maintenance',
];

// Compute the 6-week grid that surrounds the current month. Sundays
// start each row so the dow header below matches.
const getMonthGrid = (cursor: Date): Date[] => {
  const monthStart = startOfMonth(cursor);
  const monthEnd = endOfMonth(cursor);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 0 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });
  const days: Date[] = [];
  let cursorDate = gridStart;
  while (cursorDate <= gridEnd) {
    days.push(cursorDate);
    cursorDate = addDays(cursorDate, 1);
  }
  return days;
};

export const PlatformCalendarPage: React.FC = () => {
  const [cursor, setCursor] = useState(() => new Date());
  const [visibleTypes, setVisibleTypes] = useState<Set<PlatformCalendarEventType>>(
    () => new Set(DEFAULT_VISIBLE_TYPES),
  );

  // Fetch the 6-week visible range so we cover edge days in adjacent months.
  const gridDays = useMemo(() => getMonthGrid(cursor), [cursor]);
  const rangeStart = format(gridDays[0], 'yyyy-MM-dd');
  const rangeEnd = format(gridDays[gridDays.length - 1], 'yyyy-MM-dd');

  const { data, isLoading } = usePlatformCalendarEvents(rangeStart, rangeEnd);
  const allEvents = data?.events ?? [];

  // Group events by their date string. Skip filtered-out types up front
  // so the per-day lookup stays minimal.
  const eventsByDate = useMemo(() => {
    const map: Record<string, PlatformCalendarEvent[]> = {};
    for (const ev of allEvents) {
      if (!visibleTypes.has(ev.type)) continue;
      const key = ev.date;
      if (!map[key]) map[key] = [];
      map[key].push(ev);
    }
    return map;
  }, [allEvents, visibleTypes]);

  // "Upcoming next 30 days" sidebar — filtered events strictly in the
  // future, capped at 8 rows so the panel stays scannable.
  const upcoming = useMemo(() => {
    const today = format(new Date(), 'yyyy-MM-dd');
    const horizon = format(addDays(new Date(), 30), 'yyyy-MM-dd');
    return allEvents
      .filter(
        (ev) =>
          visibleTypes.has(ev.type) && ev.date >= today && ev.date <= horizon,
      )
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 8);
  }, [allEvents, visibleTypes]);

  const toggleType = (key: PlatformCalendarEventType) => {
    setVisibleTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[20px] font-semibold text-foreground">Platform calendar</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Fleet-level events: tenant lifecycle, provisioning, migrations. Not user time entries.
        </p>
      </div>

      {/* ── Toolbar: month nav + filter chips ──────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setCursor(new Date())}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:opacity-90"
        >
          Today
        </button>
        <div className="inline-flex items-center overflow-hidden rounded-lg border border-border">
          <button
            type="button"
            onClick={() => setCursor((c) => subMonths(c, 1))}
            className="px-2 py-1.5 text-foreground transition hover:bg-muted"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="border-x border-border px-4 py-1.5 text-sm font-semibold text-foreground">
            {format(cursor, 'MMMM yyyy')}
          </span>
          <button
            type="button"
            onClick={() => setCursor((c) => addMonths(c, 1))}
            className="px-2 py-1.5 text-foreground transition hover:bg-muted"
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Show</span>
          {EVENT_TYPES.map((cfg) => {
            const active = visibleTypes.has(cfg.key);
            return (
              <button
                key={cfg.key}
                type="button"
                onClick={() => toggleType(cfg.key)}
                aria-pressed={active}
                className={[
                  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition',
                  active
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-card text-muted-foreground hover:border-border-strong/80 hover:text-foreground',
                ].join(' ')}
              >
                <span className={`h-2 w-2 rounded-full ${cfg.swatchClass}`} />
                {cfg.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Calendar grid + Upcoming sidebar ───────────────────────── */}
      {isLoading && !data ? (
        <Loading message="Loading calendar..." />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
          <section className="surface-card overflow-hidden">
            <div className="grid grid-cols-7 border-b border-border bg-background">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                <div
                  key={d}
                  className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.4px] text-muted-foreground"
                >
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {gridDays.map((day) => {
                const inMonth = isSameMonth(day, cursor);
                const isHighlightedToday = isToday(day);
                const key = format(day, 'yyyy-MM-dd');
                const dayEvents = eventsByDate[key] ?? [];
                return (
                  <div
                    key={key}
                    className={[
                      'min-h-[110px] border-b border-r border-border/70 p-2 last:border-r-0',
                      inMonth ? 'bg-card' : 'bg-background opacity-60',
                      isHighlightedToday ? 'bg-primary/5' : '',
                    ].join(' ')}
                  >
                    <p
                      className={[
                        'text-xs font-semibold',
                        isHighlightedToday
                          ? 'text-primary'
                          : inMonth
                            ? 'text-foreground'
                            : 'text-muted-foreground',
                      ].join(' ')}
                    >
                      {format(day, 'd')}
                    </p>
                    <div className="mt-1.5 space-y-1">
                      {dayEvents.slice(0, 3).map((ev) => {
                        const cfg = TYPE_CONFIG[ev.type];
                        return (
                          <div
                            key={ev.id}
                            title={ev.title + (ev.detail ? `: ${ev.detail}` : '')}
                            className={[
                              'flex items-center gap-1.5 truncate rounded px-1.5 py-0.5 text-[11px] leading-tight',
                              cfg.chipClass,
                            ].join(' ')}
                          >
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cfg.swatchClass}`} />
                            <span className="truncate">{ev.title}</span>
                          </div>
                        );
                      })}
                      {dayEvents.length > 3 && (
                        <p className="text-[10px] text-muted-foreground">
                          +{dayEvents.length - 3} more
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Upcoming next 30 days */}
          <aside className="surface-card overflow-hidden">
            <div className="border-b border-border/70 bg-background px-4 py-3">
              <h2 className="text-xs font-semibold text-foreground">
                Upcoming · next 30 days
              </h2>
            </div>
            {upcoming.length > 0 ? (
              <ul className="divide-y divide-border">
                {upcoming.map((ev) => {
                  const cfg = TYPE_CONFIG[ev.type];
                  const date = new Date(ev.date + 'T00:00:00');
                  return (
                    <li key={ev.id} className="flex gap-3 px-4 py-3 text-sm">
                      <div className="flex shrink-0 flex-col items-center rounded-md border border-border bg-background px-2 py-1">
                        <span className="text-[9px] font-semibold uppercase tracking-[0.4px] text-muted-foreground">
                          {format(date, 'MMM')}
                        </span>
                        <span className="text-base font-bold leading-none text-foreground">
                          {format(date, 'd')}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-foreground">{ev.title}</p>
                        <p className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span className={`h-1.5 w-1.5 rounded-full ${cfg.swatchClass}`} />
                          {cfg.label}
                          {ev.detail ? ` · ${ev.detail}` : ''}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center text-xs text-muted-foreground">
                <RefreshCw className="h-4 w-4 opacity-60" />
                <p>No upcoming events. Schedule a maintenance window or wait for the next provisioning run.</p>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
};

// Re-exported for testability of the grid math without rendering.
export { getMonthGrid, isSameDay };
