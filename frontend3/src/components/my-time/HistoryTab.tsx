import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Loader2, Search } from 'lucide-react';

import { Button, Card, Empty, Input, StatusBadge } from '@/components/ui';
import { useMyEntriesFiltered } from '@/hooks/useTime';
import { formatDateShort, formatDayLong, fromISODate } from '@/lib/date';
import { groupHistoryByMonth, type HistoryMonth, type HistoryWeek } from '@/lib/historyGrouping';
import { timesheetStatusKey, type TimeEntry, type TimeEntryStatus } from '@/types/time';
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

// Status-appropriate context line for a week row — tells the employee the one
// thing that matters for that status, instead of a blank approver slot.
function weekContext(w: HistoryWeek): string {
  const proj = w.projects.length === 1 ? w.projects[0] : `${w.projects.length} projects`;
  const days = `${w.daysWorked} ${w.daysWorked === 1 ? 'day' : 'days'}`;
  const lead = `${days} · ${proj}`;
  switch (w.status) {
    case 'APPROVED': {
      const sub = w.submittedAt ? `Submitted ${formatDateShort(w.submittedAt)} → ` : '';
      const appr = w.approvedAt ? `Approved ${formatDateShort(w.approvedAt)}` : 'Approved';
      const by = w.approverName ? ` by ${w.approverName}` : '';
      return `${lead} · ${sub}${appr}${by}`;
    }
    case 'SUBMITTED':
      return `${lead} · ${w.submittedAt ? `Submitted ${formatDateShort(w.submittedAt)}` : 'Submitted'} · awaiting review`;
    case 'REJECTED':
      return `${lead} · Sent back${w.approverName ? ` by ${w.approverName}` : ''} · see Rework`;
    case 'DRAFT':
    default:
      return `${lead} · Not submitted`;
  }
}

const statusLabel: Record<TimeEntryStatus, string> = {
  DRAFT: 'Draft', SUBMITTED: 'Submitted', APPROVED: 'Approved', REJECTED: 'Rejected',
};

// History tab: the user's entries as a month -> week -> day drill-down.
// Default view is the month overview (total + bar); click a month to open its
// weeks; expand a week to see per-day entries. All statuses by default, with a
// status filter; each row carries its status badge and a status-appropriate
// context line, and the approver name shows on approved rows. Mirrors
// frontend2's History data with a richer, approval-aware layout.
export function HistoryTab() {
  const [status, setStatus] = useState<string>('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'entry_date' | 'created_at' | 'hours' | 'status'>('entry_date');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const q = useMyEntriesFiltered({
    status: status === 'all' ? undefined : status,
    start_date: startDate || undefined,
    end_date: endDate || undefined,
    search: search.trim() || undefined,
    sort_by: sortBy,
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

  // Most-recent month open by default; weeks + days start collapsed.
  const [openMonths, setOpenMonths] = useState<Set<string>>(() => new Set());
  const [openWeeks, setOpenWeeks] = useState<Set<string>>(() => new Set());
  const effectiveOpenMonths = openMonths.size === 0 && months[0] ? new Set([months[0].key]) : openMonths;
  const toggleMonth = (k: string) => setOpenMonths((s) => {
    // Seed from the effective set so the first toggle doesn't lose the auto-open.
    const base = s.size === 0 && months[0] ? new Set([months[0].key]) : s;
    const n = new Set(base); n.has(k) ? n.delete(k) : n.add(k); return n;
  });
  const toggleWeek = (k: string) => setOpenWeeks((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const inputClass = 'h-9 rounded-full border border-border bg-transparent px-4 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';
  const maxMonthHours = Math.max(1, ...months.map((m) => m.hours));

  return (
    <div className="space-y-4">
      {/* Filter bar */}
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
        <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-auto" aria-label="Start date" />
        <span className="text-xs text-muted-foreground">→</span>
        <Input type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} className="w-auto" aria-label="End date" />
        <select value={`${sortBy}:${sortOrder}`} onChange={(e) => { const [b, o] = e.target.value.split(':'); setSortBy(b as typeof sortBy); setSortOrder(o as typeof sortOrder); }} className={inputClass}>
          <option value="entry_date:desc">Newest first</option>
          <option value="entry_date:asc">Oldest first</option>
          <option value="created_at:desc">Recently created</option>
          <option value="hours:desc">Most hours</option>
          <option value="status:asc">By status</option>
        </select>
        <Button variant="secondary" onClick={() => exportHistoryCsv(rows)} disabled={rows.length === 0}>
          <Download className="h-4 w-4" /> Export
        </Button>
      </Card>

      {/* Summary tiles */}
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
      ) : rows.length === 0 ? (
        <Empty Icon={Search} title="No entries match" description="Try a different status, date range, or search." />
      ) : (
        <div className="space-y-3">
          {months.map((m) => (
            <MonthCard
              key={m.key}
              month={m}
              open={effectiveOpenMonths.has(m.key)}
              onToggle={() => toggleMonth(m.key)}
              openWeeks={openWeeks}
              onToggleWeek={toggleWeek}
              barPct={Math.round((m.hours / maxMonthHours) * 100)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MonthCard({
  month, open, onToggle, openWeeks, onToggleWeek, barPct,
}: {
  month: HistoryMonth;
  open: boolean;
  onToggle: () => void;
  openWeeks: Set<string>;
  onToggleWeek: (k: string) => void;
  barPct: number;
}) {
  return (
    <Card className="overflow-hidden">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-primary/5">
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <span className="text-sm font-semibold text-foreground">
          {month.label}
          {month.allApproved && month.approverName ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">· approved by {month.approverName}</span> : null}
        </span>
        <span className="hidden text-xs text-muted-foreground sm:inline">{month.daysWorked} {month.daysWorked === 1 ? 'day' : 'days'} · {month.entryCount} {month.entryCount === 1 ? 'entry' : 'entries'}</span>
        <span className="ml-auto hidden h-1.5 w-24 overflow-hidden rounded-full bg-muted md:block">
          <span className="block h-full rounded-full bg-primary/70" style={{ width: `${barPct}%` }} />
        </span>
        <span className="w-14 shrink-0 text-right text-sm font-bold tabular-nums text-foreground">{fmtH(month.hours)}h</span>
      </button>

      {open ? (
        <div className="space-y-1 border-t border-border px-3 py-2">
          {month.weeks.map((w) => (
            <WeekRow key={w.weekStart} week={w} open={openWeeks.has(`${month.key}:${w.weekStart}`)} onToggle={() => onToggleWeek(`${month.key}:${w.weekStart}`)} />
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function WeekRow({ week, open, onToggle }: { week: HistoryWeek; open: boolean; onToggle: () => void }) {
  return (
    <div className="rounded-xl">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-primary/5">
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <span className="w-[120px] shrink-0 text-xs font-medium text-muted-foreground">{week.label.replace(/, \d{4}$/, '').replace(' – ', ' – ')}</span>
        <StatusBadge status={timesheetStatusKey(week.status)} variant="timesheet" label={week.mixed ? `${statusLabel[week.status]} +` : statusLabel[week.status]} showIcon={false} />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{weekContext(week)}</span>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{fmtH(week.hours)}h</span>
      </button>

      {open ? (
        <div className="ml-5 border-l-2 border-border pl-3">
          {week.rejectionReason ? (
            <p className="py-1.5 text-[11px] text-rose-600 dark:text-rose-300">Sent back: {week.rejectionReason}</p>
          ) : null}
          {week.days.map((day) => (
            <div key={day.date} className="border-b border-border/40 py-1.5 last:border-b-0">
              {day.entries.map((entry, i) => (
                <div key={entry.id} className="flex items-center gap-3 py-0.5 text-xs">
                  <span className={cn('w-[108px] shrink-0 font-medium text-muted-foreground', i > 0 && 'opacity-0')}>
                    {formatDayLong(fromISODate(day.date))}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {entry.project?.name ?? `Project #${entry.project_id}`}
                    {!entry.is_billable ? <span className="text-muted-foreground"> · Non-billable</span> : null}
                    {entry.description ? <span className="text-muted-foreground"> · {entry.description}</span> : null}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-foreground">{num(entry.hours).toFixed(2)}h</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
