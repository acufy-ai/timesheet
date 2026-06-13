import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Download, Loader2, Search } from 'lucide-react';

import { Button, Card, Empty, Input } from '@/components/ui';
import { useMyEntriesFiltered } from '@/hooks/useTime';
import { formatDateShort, fromISODate } from '@/lib/date';
import { groupHistoryByMonth, type HistoryMonth } from '@/lib/historyGrouping';
import type { TimeEntry, TimeEntryStatus } from '@/types/time';
import { cn } from '@/lib/cn';

const num = (v: string | number) => (typeof v === 'string' ? parseFloat(v) : v) || 0;
const fmtH = (h: number) => h.toFixed(1);

function exportHistoryCsv(rows: TimeEntry[]) {
  const header = ['Date', 'Project', 'Hours', 'Billable', 'Status', 'Description'];
  const esc = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map((e) => [
    e.entry_date, e.project?.name ?? `#${e.project_id}`, String(num(e.hours)),
    e.is_billable ? 'yes' : 'no', e.status, e.description ?? '',
  ].map(esc).join(','));
  const blob = new Blob([[header.map(esc).join(','), ...lines].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'my-timesheet-history.csv'; a.click();
  URL.revokeObjectURL(url);
}

// Per-day rollup the calendar consumes: total hours, dominant status, the day's
// entries, and (when approved) the approver name. Built from the grouped month.
interface DayCell {
  date: string;
  hours: number;
  status: TimeEntryStatus;
  entries: TimeEntry[];
  approverName: string | null;
}

// Rank: surface the least-settled status when a day mixes statuses.
const STATUS_RANK: Record<TimeEntryStatus, number> = {
  REJECTED: 0, DRAFT: 1, SUBMITTED: 2, APPROVED: 3,
};
const STATUS_LABEL: Record<TimeEntryStatus, string> = {
  DRAFT: 'Draft', SUBMITTED: 'Submitted', APPROVED: 'Approved', REJECTED: 'Sent back',
};
// Hour-pill tint per status (matches the legend).
const PILL_CLASS: Record<TimeEntryStatus, string> = {
  APPROVED: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  SUBMITTED: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  DRAFT: 'bg-slate-500/15 text-slate-600 dark:text-slate-300',
  REJECTED: 'bg-rose-500/15 text-rose-600 dark:text-rose-300',
};

function dayCellsFor(month: HistoryMonth): Map<string, DayCell> {
  const cells = new Map<string, DayCell>();
  for (const week of month.weeks) {
    for (const day of week.days) {
      let status: TimeEntryStatus = 'APPROVED';
      for (const e of day.entries) if (STATUS_RANK[e.status] < STATUS_RANK[status]) status = e.status;
      const approverName = day.entries.find((e) => e.approved_by_name)?.approved_by_name ?? null;
      cells.set(day.date, { date: day.date, hours: day.hours, status, entries: day.entries, approverName });
    }
  }
  return cells;
}

// History tab — a 3-column overview: Periods (months) | Calendar | Day detail.
// Pick a month on the left to drive the calendar; the calendar paints a tinted
// hour pill per worked day (colored by status) with the approver shown
// prominently under the name; click a day to see its entries on the right.
export function HistoryTab() {
  const [status, setStatus] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const q = useMyEntriesFiltered({
    status: status === 'all' ? undefined : status,
    search: search.trim() || undefined,
    sort_by: 'entry_date',
    sort_order: sortOrder,
    limit: 1000,
  });

  const rows = useMemo(() => (q.data ?? []) as TimeEntry[], [q.data]);
  const months = useMemo(() => groupHistoryByMonth(rows), [rows]);

  const totals = useMemo(() => {
    const approved = rows.filter((e) => e.status === 'APPROVED').reduce((s, e) => s + num(e.hours), 0);
    const draft = rows.filter((e) => e.status === 'DRAFT').reduce((s, e) => s + num(e.hours), 0);
    return { approved, draft, monthCount: months.length };
  }, [rows, months]);

  // Active month (most recent by default) + selected day in the calendar.
  const [curMonthKey, setCurMonthKey] = useState<string | null>(null);
  const [selDay, setSelDay] = useState<string | null>(null);

  // Keep the active month valid as the filtered data changes (default = newest).
  useEffect(() => {
    if (months.length === 0) { setCurMonthKey(null); return; }
    if (!curMonthKey || !months.some((m) => m.key === curMonthKey)) {
      setCurMonthKey(months[0].key);
      setSelDay(null);
    }
  }, [months, curMonthKey]);

  const curMonth = months.find((m) => m.key === curMonthKey) ?? months[0] ?? null;
  const cells = useMemo(() => (curMonth ? dayCellsFor(curMonth) : new Map<string, DayCell>()), [curMonth]);
  const maxMonthHours = Math.max(1, ...months.map((m) => m.hours));

  const navMonth = (dir: -1 | 1) => {
    if (!curMonth) return;
    const i = months.findIndex((m) => m.key === curMonth.key);
    const next = months[i + dir];
    if (next) { setCurMonthKey(next.key); setSelDay(null); }
  };
  const selectMonth = (k: string) => { setCurMonthKey(k); setSelDay(null); };

  const inputClass = 'h-9 rounded-full border border-border bg-transparent px-4 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

  return (
    <div className="space-y-4">
      {/* Filter bar (kept) */}
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search description or project..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="SUBMITTED">Submitted</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
        </select>
        <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value as 'asc' | 'desc')} className={inputClass}>
          <option value="desc">Newest first</option>
          <option value="asc">Oldest first</option>
        </select>
        <Button variant="secondary" onClick={() => exportHistoryCsv(rows)} disabled={rows.length === 0}>
          <Download className="h-4 w-4" /> Export
        </Button>
      </Card>

      {/* Summary tiles (kept) */}
      {rows.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card className="px-4 py-3"><p className="text-xl font-semibold tabular-nums text-foreground">{fmtH(totals.approved)}h</p><p className="text-xs text-muted-foreground">Approved {status === 'all' ? '' : '(filtered)'}</p></Card>
          <Card className="px-4 py-3"><p className="text-xl font-semibold tabular-nums text-foreground">{fmtH(totals.draft)}h</p><p className="text-xs text-muted-foreground">Draft / not submitted</p></Card>
          <Card className="px-4 py-3"><p className="text-xl font-semibold tabular-nums text-foreground">{totals.monthCount}</p><p className="text-xs text-muted-foreground">Months with activity</p></Card>
        </div>
      ) : null}

      {q.isLoading ? (
        <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>
      ) : q.isError ? (
        <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">Couldn't load your history. Try refreshing.</Card>
      ) : rows.length === 0 || !curMonth ? (
        <Empty Icon={Search} title="No entries match" description="Try a different status, date range, or search." />
      ) : (
        <div className="grid gap-3.5 lg:grid-cols-[1fr_2.6fr_1.2fr]">
          {/* COL 1 — Periods */}
          <Card className="overflow-hidden">
            <p className="px-3.5 pb-2 pt-3 text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">Periods</p>
            <div>
              {months.map((m) => {
                const active = m.key === curMonth.key;
                return (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => selectMonth(m.key)}
                    className={cn(
                      'flex w-full items-center gap-2.5 border-t border-border/50 px-3.5 py-3 text-left transition-colors hover:bg-primary/5',
                      active && 'bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-foreground">{m.label}</span>
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">{m.daysWorked} {m.daysWorked === 1 ? 'day' : 'days'} · {fmtH(m.hours)}h</span>
                      <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-muted">
                        <span className="block h-full rounded-full bg-primary/70" style={{ width: `${Math.round((m.hours / maxMonthHours) * 100)}%` }} />
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-bold tabular-nums text-foreground">{Math.round(m.hours)}h</span>
                  </button>
                );
              })}
            </div>
          </Card>

          {/* COL 2 — Calendar */}
          <CalendarCard
            month={curMonth}
            cells={cells}
            selDay={selDay}
            onSelectDay={setSelDay}
            onNav={navMonth}
            canPrev={months.findIndex((m) => m.key === curMonth.key) < months.length - 1}
            canNext={months.findIndex((m) => m.key === curMonth.key) > 0}
          />

          {/* COL 3 — Day detail */}
          <Card className="overflow-hidden">
            <p className="px-3.5 pb-2 pt-3 text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">Day detail</p>
            <DayDetail cell={selDay ? cells.get(selDay) ?? null : null} />
          </Card>
        </div>
      )}
    </div>
  );
}

function CalendarCard({
  month, cells, selDay, onSelectDay, onNav, canPrev, canNext,
}: {
  month: HistoryMonth;
  cells: Map<string, DayCell>;
  selDay: string | null;
  onSelectDay: (iso: string) => void;
  onNav: (dir: -1 | 1) => void;
  canPrev: boolean;
  canNext: boolean;
}) {
  const dayVals = [...cells.values()];
  const approvedCount = dayVals.filter((d) => d.status === 'APPROVED').length;
  const total = dayVals.length;
  const approverName = dayVals.find((d) => d.approverName)?.approverName ?? null;

  const [y, mo] = month.key.split('-').map(Number);
  const first = new Date(y, mo - 1, 1);
  const startDow = first.getDay();
  const dim = new Date(y, mo, 0).getDate();
  const todayIso = new Date().toISOString().slice(0, 10);

  const cellNodes: React.ReactNode[] = [];
  for (let i = 0; i < startDow; i++) cellNodes.push(<div key={`out-${i}`} className="min-h-[62px] rounded-[10px] border border-border/40 opacity-35" />);
  for (let d = 1; d <= dim; d++) {
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cell = cells.get(iso);
    const isToday = iso === todayIso;
    const isSel = iso === selDay;
    cellNodes.push(
      <button
        key={iso}
        type="button"
        disabled={!cell}
        onClick={() => cell && onSelectDay(iso)}
        className={cn(
          'flex min-h-[62px] flex-col rounded-[10px] border p-1.5 text-left transition-colors',
          cell ? 'cursor-pointer border-border/60 bg-card hover:border-primary/50' : 'border-border/40 bg-card cursor-default',
          isSel && 'border-primary ring-1 ring-primary',
        )}
      >
        <span className={cn('text-[11px] text-muted-foreground', isToday && 'font-bold text-primary')}>{d}</span>
        {cell ? (
          <span className={cn('mt-auto self-start rounded-full px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums', PILL_CLASS[cell.status])}>
            {fmtH(cell.hours)}h
          </span>
        ) : null}
      </button>,
    );
  }

  return (
    <Card className="overflow-hidden">
      {/* Header: name + approver line, period total */}
      <div className="border-b border-border px-4 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {approvedCount === 0 ? (
              <p className="text-[12.5px] text-muted-foreground">No approved days yet</p>
            ) : approvedCount === total ? (
              <p className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-600 dark:text-emerald-300">
                <Check className="h-3.5 w-3.5" /> Approved{approverName ? <> by <strong>{approverName}</strong></> : null}
              </p>
            ) : (
              <p className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-600 dark:text-emerald-300">
                <Check className="h-3.5 w-3.5" /> Approved{approverName ? <> by <strong>{approverName}</strong></> : null} · {approvedCount} of {total} days
              </p>
            )}
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xl font-semibold tabular-nums text-foreground">{fmtH(month.hours)}h</p>
            <p className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">{month.label} total</p>
          </div>
        </div>
        {/* Month nav + legend */}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => onNav(-1)} disabled={!canPrev} className="grid h-6 w-6 place-items-center rounded-full border border-border text-foreground transition hover:bg-primary/10 disabled:opacity-30" aria-label="Previous month"><ChevronLeft className="h-3.5 w-3.5" /></button>
          <span className="text-sm font-semibold text-foreground">{month.label}</span>
          <button type="button" onClick={() => onNav(1)} disabled={!canNext} className="grid h-6 w-6 place-items-center rounded-full border border-border text-foreground transition hover:bg-primary/10 disabled:opacity-30" aria-label="Next month"><ChevronRight className="h-3.5 w-3.5" /></button>
          <div className="ml-auto flex flex-wrap gap-3 text-[10px] text-muted-foreground">
            <LegendDot cls="bg-emerald-500" label="Approved" />
            <LegendDot cls="bg-amber-500" label="Submitted" />
            <LegendDot cls="bg-slate-500" label="Draft" />
            <LegendDot cls="bg-rose-500" label="Sent back" />
          </div>
        </div>
      </div>
      {/* Grid */}
      <div className="p-3">
        <div className="mb-1.5 grid grid-cols-7 gap-1.5">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d} className="text-center text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1.5">{cellNodes}</div>
      </div>
    </Card>
  );
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center">
      <i className={cn('mr-1 inline-block h-2 w-2 rounded-[3px] align-middle', cls)} />{label}
    </span>
  );
}

function DayDetail({ cell }: { cell: DayCell | null }) {
  if (!cell) {
    return <div className="px-3.5 py-10 text-center text-[13px] text-muted-foreground">Click a day in the calendar to see its entries.</div>;
  }
  const dt = fromISODate(cell.date);
  const title = dt.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const ctx =
    cell.status === 'APPROVED'
      ? <p className="mb-3 text-[11px] text-emerald-600 dark:text-emerald-300">Approved{cell.approverName ? ` by ${cell.approverName}` : ''} · {formatDateShort(cell.date)}</p>
      : cell.status === 'SUBMITTED'
      ? <p className="mb-3 text-[11px] text-amber-600 dark:text-amber-300">Submitted · awaiting review</p>
      : cell.status === 'REJECTED'
      ? <p className="mb-3 text-[11px] text-rose-600 dark:text-rose-300">Sent back for changes</p>
      : null;

  return (
    <div className="px-3.5 pb-3.5">
      <p className="font-semibold text-foreground">{title}</p>
      <p className="mb-3 text-[11px] text-muted-foreground">{fmtH(cell.hours)}h · {STATUS_LABEL[cell.status]}</p>
      {ctx}
      {cell.entries.map((e) => (
        <div key={e.id} className="mb-2 rounded-xl border border-border px-3 py-2.5">
          <p className="text-[13px] font-medium text-foreground">{e.project?.name ?? `Project #${e.project_id}`}</p>
          {e.description ? <p className="mt-0.5 text-xs text-muted-foreground">{e.description}</p> : null}
          {e.status === 'REJECTED' && e.rejection_reason ? <p className="mt-0.5 text-xs text-rose-600 dark:text-rose-300">Sent back: {e.rejection_reason}</p> : null}
          <div className="mt-1.5 flex items-center justify-between">
            <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.04em]', PILL_CLASS[e.status])}>{STATUS_LABEL[e.status]}</span>
            <span className="font-bold tabular-nums text-foreground">{num(e.hours).toFixed(2)}h</span>
          </div>
        </div>
      ))}
    </div>
  );
}
