import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  EyeOff,
  Gauge,
  Loader2,
  PieChart,
  RotateCcw,
  Target,
  TimerReset,
  TreePalm,
  TrendingUp,
} from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable';

import { Card } from '@/components/ui';
import { useDashboardAnalytics } from '@/hooks/useDashboard';
import { useTimeOffUsage } from '@/hooks/useAdmin';
import { useDashboardPrefs, type WidgetKey } from '@/hooks/useDashboardPrefs';
import { WidgetWrapper } from '@/components/dashboard/WidgetWrapper';
import { addDays, formatWeekRange, fromISODate, startOfWeek, toISODate } from '@/lib/date';
import { cn } from '@/lib/cn';

const n = (v: string | number | null | undefined) =>
  v == null ? 0 : typeof v === 'string' ? parseFloat(v) || 0 : v;
const fmtHM = (h: number) => {
  const hrs = Math.floor(h); const mins = Math.round((h - hrs) * 60);
  return `${hrs}h ${String(mins).padStart(2, '0')}m`;
};
// Segmented-clock format ("00:00") used by the big time widgets — matches f2.
const fmtClock = (h: number) => {
  const safe = Number.isFinite(h) ? h : 0;
  const hrs = Math.floor(safe); const mins = Math.round((safe - hrs) * 60);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};
// "Jun 9" for the daily-breakdown date line.
const formatDayMonth = (iso: string) =>
  fromISODate(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// Widget labels for the show/hide picker. Keys match useDashboardPrefs.WidgetKey.
const WIDGETS: { key: WidgetKey; label: string }[] = [
  { key: 'total', label: 'Total time' },
  { key: 'today', label: 'Today' },
  { key: 'utilization', label: 'Utilization' },
  { key: 'overtime', label: 'Overtime' },
  { key: 'topproject', label: 'Top project' },
  { key: 'daily', label: 'Daily breakdown' },
  { key: 'projects', label: 'Projects breakdown' },
  { key: 'productivity', label: 'Productivity' },
  { key: 'activities', label: 'Top activities' },
  { key: 'timeoff', label: 'Time off balance' },
];
const WIDGET_LABEL: Record<WidgetKey, string> = Object.fromEntries(WIDGETS.map((w) => [w.key, w.label])) as Record<WidgetKey, string>;
const HIDDEN_KEY = 'acufy:timesheet:dash:hidden-widgets';

function loadHidden(): Set<WidgetKey> {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')); } catch { return new Set(); }
}

// Employee dashboard: a grid of analytics widgets over the current week, with a
// show/hide picker. Same widgets + data as frontend2's EmployeeWidgetGrid
// (TotalTime/Today/Utilization/Overtime/TopProject/DailyBarChart/
// ProjectsBreakdown/TopActivities/TimeOffBalance); rendered in frontend3's idiom.
export function EmployeeWidgets({ targetHours = 40 }: { targetHours?: number }) {
  const today = useMemo(() => new Date(), []);
  // Week navigation: 0 = current week, negative = past weeks.
  const [weekOffset, setWeekOffset] = useState(0);
  const weekStart = useMemo(() => addDays(startOfWeek(today), weekOffset * 7), [today, weekOffset]);
  const rangeStart = toISODate(weekStart);
  const rangeEnd = toISODate(addDays(weekStart, 6));
  const todayIso = toISODate(today);
  const isCurrentWeek = weekOffset === 0;

  const analyticsQ = useDashboardAnalytics({ start_date: rangeStart, end_date: rangeEnd });
  const usageQ = useTimeOffUsage();

  // Layout (order + per-widget span) is persisted + drag/resize-driven.
  const { layout, setOrder, stepSize, canGrow, canShrink, resetLayout } = useDashboardPrefs();
  const sensors = useSensors(
    // Small activation distance so a click on the grip starts a drag but plain
    // clicks elsewhere (resize, picker) aren't swallowed.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const [hidden, setHidden] = useState<Set<WidgetKey>>(loadHidden);
  const [pickerOpen, setPickerOpen] = useState(false);
  function toggle(k: WidgetKey) {
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }
  const visible = (k: WidgetKey) => !hidden.has(k);

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = layout.order.indexOf(active.id as WidgetKey);
    const newIdx = layout.order.indexOf(over.id as WidgetKey);
    if (oldIdx === -1 || newIdx === -1) return;
    const next = [...layout.order];
    next.splice(oldIdx, 1);
    next.splice(newIdx, 0, active.id as WidgetKey);
    setOrder(next);
  }

  if (analyticsQ.isLoading) {
    return <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>;
  }
  if (analyticsQ.isError) {
    return <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">Couldn't load your dashboard widgets. Try refreshing.</Card>;
  }

  const a = analyticsQ.data;
  const total = n(a?.total_hours);
  const billable = n(a?.billable_hours);
  const todayHours = n(a?.daily_breakdown.find((d) => d.entry_date === todayIso)?.hours);
  const overtime = Math.max(0, total - targetHours);
  const utilPct = targetHours > 0 ? Math.min(100, Math.round((total / targetHours) * 100)) : 0;
  const billablePct = total > 0 ? Math.round((billable / total) * 100) : 0;
  const maxDay = Math.max(1, ...(a?.daily_breakdown ?? []).map((d) => n(d.hours)));
  const currentYear = today.getFullYear();
  const timeOffTotal = (usageQ.data ?? []).reduce((s, u) => s + (u.days_taken ?? 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        {/* Week picker: prev / range / next + "This week" reset. */}
        <div className="flex items-center gap-1.5">
          <button type="button" aria-label="Previous week" onClick={() => setWeekOffset((w) => w - 1)} className="grid h-8 w-8 place-items-center rounded-full border border-border bg-card hover:border-primary/40 hover:text-primary"><ChevronLeft className="h-4 w-4" /></button>
          <span className="min-w-[150px] text-center text-sm font-medium text-foreground">{isCurrentWeek ? 'This week' : formatWeekRange(weekStart)}</span>
          <button type="button" aria-label="Next week" onClick={() => setWeekOffset((w) => Math.min(0, w + 1))} disabled={isCurrentWeek} className="grid h-8 w-8 place-items-center rounded-full border border-border bg-card hover:border-primary/40 hover:text-primary disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
          {!isCurrentWeek ? <button type="button" onClick={() => setWeekOffset(0)} className="ml-1 text-xs font-medium text-primary hover:underline">Today</button> : null}
        </div>
        <div className="relative">
          <button type="button" onClick={() => setPickerOpen((v) => !v)} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-medium hover:border-primary/40 hover:text-primary">
            <Eye className="h-3.5 w-3.5" /> Widgets
          </button>
          {pickerOpen ? (
            <div className="absolute right-0 z-30 mt-1 w-56 rounded-xl border border-border bg-card p-1 shadow-xl" onMouseLeave={() => setPickerOpen(false)}>
              <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Show widgets</p>
              {WIDGETS.map((w) => (
                <button key={w.key} type="button" onClick={() => toggle(w.key)} className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm hover:bg-muted">
                  {w.label}
                  {visible(w.key) ? <Eye className="h-3.5 w-3.5 text-primary" /> : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
                </button>
              ))}
              <div className="my-1 border-t border-border" />
              <button type="button" onClick={() => { resetLayout(); setPickerOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
                <RotateCcw className="h-3.5 w-3.5" /> Reset layout
              </button>
              <p className="px-3 pb-1.5 pt-1 text-[10px] text-muted-foreground">Drag the grip to reorder · use −/+ to resize.</p>
            </div>
          ) : null}
        </div>
      </div>

      {/* 12-col grid; order + per-widget span come from useDashboardPrefs.
          Drag the grip (top-left) to reorder, −/+ (bottom-right) to resize. */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={layout.order} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
            {layout.order.filter(visible).map((key) => (
              <WidgetWrapper
                key={key}
                id={key}
                span={layout.sizes[key]}
                title={WIDGET_LABEL[key]}
                canGrow={canGrow(key)}
                canShrink={canShrink(key)}
                onGrow={() => stepSize(key, 1)}
                onShrink={() => stepSize(key, -1)}
              >
                {renderBody(key)}
              </WidgetWrapper>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );

  // Each widget's inner body. The card frame, drag grip, and resize controls
  // are supplied by WidgetWrapper; this returns only the <Widget>…</Widget>.
  function renderBody(key: WidgetKey): ReactNode {
    switch (key) {
      case 'total':
        return (
          <Widget Icon={Clock} tone="primary" title="Total time">
            <p className="font-mono text-4xl font-semibold tracking-tight tabular-nums text-foreground">{fmtClock(total)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{billablePct}% billable · this week</p>
          </Widget>
        );
      case 'today':
        return (
          <Widget Icon={TimerReset} tone="sky" title="Today">
            <p className="font-mono text-4xl font-semibold tracking-tight tabular-nums text-foreground">{fmtClock(todayHours)}</p>
            <p className="mt-1 text-xs text-muted-foreground">logged today</p>
          </Widget>
        );
      case 'utilization':
        return (
          <Widget Icon={Gauge} tone="violet" title="Utilization">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="font-mono text-3xl font-semibold tabular-nums text-foreground">{utilPct}%</p>
                <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">of {targetHours}h target</p>
              </div>
              <Donut pct={utilPct} />
            </div>
          </Widget>
        );
      case 'overtime':
        return (
          <Widget Icon={TrendingUp} tone="amber" title="Overtime">
            <p className="font-mono text-4xl font-semibold tracking-tight tabular-nums text-foreground">{fmtClock(overtime)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{overtime > 0 ? 'over target' : 'within target'}</p>
          </Widget>
        );
      case 'topproject':
        return (
          <Widget Icon={PieChart} tone="emerald" title="Top project">
            <p className="truncate text-lg font-semibold text-foreground">{a?.top_project_name ?? '—'}</p>
            <p className="mt-1 text-xs text-muted-foreground">{a?.top_client_name ?? 'No entries this week'}</p>
          </Widget>
        );
      case 'productivity':
        return (
          <Widget Icon={Target} tone="violet" title="Productivity">
            <div className="flex items-end gap-2">
              <p className="text-3xl font-semibold tabular-nums text-foreground">{billablePct}%</p>
              <p className="pb-1 text-xs text-muted-foreground">billable · {fmtHM(billable)} of {fmtHM(total)}</p>
            </div>
            <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-emerald-500" style={{ width: `${billablePct}%` }} title={`Billable ${fmtHM(billable)}`} />
              <div className="h-full bg-amber-400/70" style={{ width: `${100 - billablePct}%` }} title={`Non-billable ${fmtHM(Math.max(0, total - billable))}`} />
            </div>
            <div className="mt-1.5 flex gap-4 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Billable</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400/70" /> Non-billable</span>
            </div>
          </Widget>
        );
      case 'timeoff':
        return (
          <Widget Icon={TreePalm} tone="sky" title={`Time off taken (${currentYear})`}>
            {(usageQ.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No time off taken yet.</p>
            ) : (
              <>
                {/* All leave types (f2 shows the full list, not a top-3). */}
                <div className="space-y-1">
                  {(usageQ.data ?? []).map((u) => (
                    <div key={u.leave_type} className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: u.color }} />{u.label}</span>
                      <span className="tabular-nums text-foreground">{u.days_taken} {u.days_taken === 1 ? 'day' : 'days'}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-sm font-semibold">
                  <span className="text-foreground">Total approved</span>
                  <span className="tabular-nums text-foreground">{timeOffTotal} {timeOffTotal === 1 ? 'day' : 'days'}</span>
                </div>
              </>
            )}
          </Widget>
        );
      case 'daily':
        return (
          <Widget Icon={BarChart3} tone="primary" title="Daily breakdown">
            {/* f2 layout: 00:00 above each bar, full weekday + date below,
                today highlighted in primary, taller chart area. */}
            <div className="flex h-52 items-end gap-3">
              {(a?.daily_breakdown ?? []).map((d) => {
                const h = n(d.hours);
                const isToday = d.entry_date === todayIso;
                const weekday = (d.formatted_date ?? '').split(',')[0] || '';
                const pct = h <= 0 ? 1 : Math.max((h / maxDay) * 100, 4);
                return (
                  <div key={d.entry_date} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                    <span className="font-mono text-[11px] text-muted-foreground">{fmtClock(h)}</span>
                    <div className="flex w-full flex-1 items-end justify-center">
                      <div
                        className={cn('w-full max-w-[72px] rounded-t-md transition-colors', isToday ? 'bg-primary' : 'bg-muted-foreground/20')}
                        style={{ height: `${pct}%` }}
                        title={`${h.toFixed(2)}h`}
                      />
                    </div>
                    <span className={cn('text-xs font-medium', isToday ? 'text-primary' : 'text-foreground')}>{weekday}</span>
                    <span className="text-[10px] text-muted-foreground">{formatDayMonth(d.entry_date)}</span>
                  </div>
                );
              })}
            </div>
          </Widget>
        );
      case 'projects':
        return (
          <Widget Icon={PieChart} tone="violet" title="Projects breakdown">
            {(a?.project_breakdown ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No entries this week.</p>
            ) : (
              <div className="space-y-2">
                {(a?.project_breakdown ?? []).slice(0, 5).map((p) => (
                  <div key={p.project_id}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="truncate text-foreground">{p.project_name}</span>
                      <span className="tabular-nums text-muted-foreground">{n(p.hours).toFixed(1)}h · {Math.round(p.percentage)}%</span>
                    </div>
                    <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${p.percentage}%` }} /></div>
                  </div>
                ))}
              </div>
            )}
          </Widget>
        );
      case 'activities':
        return (
          <Widget Icon={Clock} tone="emerald" title="Top activities">
            {(a?.top_activities ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity logged this week.</p>
            ) : (
              <div className="divide-y divide-border">
                {(a?.top_activities ?? []).slice(0, 5).map((act, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5 text-sm">
                    <div className="min-w-0">
                      <p className="truncate text-foreground">{act.description || '(no description)'}</p>
                      <p className="text-xs text-muted-foreground">{act.project_name}</p>
                    </div>
                    <span className="shrink-0 tabular-nums text-foreground">{n(act.hours).toFixed(1)}h</span>
                  </div>
                ))}
              </div>
            )}
          </Widget>
        );
      default:
        return null;
    }
  }
}

const TONE: Record<string, string> = {
  primary: 'bg-primary/10 text-primary',
  sky: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
  violet: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
  amber: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
  emerald: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
};

// Utilization ring — matches f2's UtilizationWidget donut. The progress arc is
// drawn with strokeDasharray/offset and CSS-transitions when the value changes
// (f2 used GSAP; a transition keeps the same feel without the dependency).
function Donut({ pct, size = 56, strokeWidth = 5 }: { pct: number; size?: number; strokeWidth?: number }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (Math.min(100, Math.max(0, pct)) / 100) * circumference;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90 transform">
        <circle cx={size / 2} cy={size / 2} r={radius} className="fill-none stroke-muted" strokeWidth={strokeWidth} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          className="fill-none stroke-primary transition-[stroke-dashoffset] duration-700 ease-out"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

function Widget({ Icon, tone, title, children, className }: { Icon: typeof Clock; tone: string; title: string; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('flex h-full flex-col p-4', className)}>
      <div className="mb-2 flex items-center gap-2">
        <span className={cn('grid h-7 w-7 place-items-center rounded-lg', TONE[tone])}><Icon className="h-4 w-4" /></span>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      </div>
      {children}
    </Card>
  );
}
