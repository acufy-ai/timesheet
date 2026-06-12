import { useMemo, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Download, Loader2 } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';

import { Button, Card, Empty, Input, StatusBadge, WorkspaceHeader } from '@/components/ui';
import { useTeamTimesheets, useUsers } from '@/hooks/useAdmin';
import { formatWeekRange, fromISODate, startOfWeek, toISODate } from '@/lib/date';
import { timesheetStatusKey, type TimeEntry } from '@/types/time';

const num = (v: string | number) => (typeof v === 'string' ? parseFloat(v) : v) || 0;

interface WeekBucket { weekStart: string; entries: TimeEntry[]; hours: number }
interface MonthBucket { key: string; label: string; weeks: WeekBucket[]; hours: number; count: number }

// Admin drill-in: one user's full timesheet history, grouped by month -> week
// (collapsible) with per-group hour subtotals. Date + status filters + CSV
// export. Mirrors frontend2's UserTimesheetsPage nesting.
export function UserTimesheetsPage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const uid = Number(userId);

  const usersQ = useUsers();
  const user = (usersQ.data ?? []).find((u) => u.id === uid);

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const q = useTeamTimesheets(
    { user_id: uid, start_date: startDate || undefined, end_date: endDate || undefined, status: status === 'all' ? undefined : status },
    Number.isFinite(uid),
  );
  const rows = (q.data ?? []) as TimeEntry[];
  const totals = useMemo(() => ({ count: rows.length, hours: rows.reduce((s, e) => s + num(e.hours), 0) }), [rows]);

  // Group entries into months -> weeks, newest month first, weeks newest first,
  // entries within a week ascending by date.
  const months = useMemo<MonthBucket[]>(() => {
    const byMonth = new Map<string, Map<string, WeekBucket>>();
    [...rows].sort((a, b) => a.entry_date.localeCompare(b.entry_date)).forEach((e) => {
      const d = fromISODate(e.entry_date);
      const mKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const wKey = toISODate(startOfWeek(d));
      const weeks = byMonth.get(mKey) ?? new Map<string, WeekBucket>();
      const wk = weeks.get(wKey) ?? { weekStart: wKey, entries: [], hours: 0 };
      wk.entries.push(e); wk.hours += num(e.hours);
      weeks.set(wKey, wk); byMonth.set(mKey, weeks);
    });
    return [...byMonth.entries()]
      .map(([mKey, weeks]) => {
        const wkList = [...weeks.values()].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
        const d = fromISODate(`${mKey}-01`);
        return {
          key: mKey,
          label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
          weeks: wkList,
          hours: wkList.reduce((s, w) => s + w.hours, 0),
          count: wkList.reduce((s, w) => s + w.entries.length, 0),
        };
      })
      .sort((a, b) => b.key.localeCompare(a.key));
  }, [rows]);

  function toggle(k: string) {
    setCollapsed((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }
  function exportCsv() {
    const header = ['Date', 'Project', 'Hours', 'Billable', 'Status', 'Description'];
    const esc = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
    const lines = [...rows].sort((a, b) => a.entry_date.localeCompare(b.entry_date)).map((e) => [
      e.entry_date, e.project?.name ?? `#${e.project_id}`, String(num(e.hours)),
      e.is_billable ? 'yes' : 'no', e.status, e.description ?? '',
    ].map(esc).join(','));
    const blob = new Blob([[header.map(esc).join(','), ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${user?.full_name ?? 'user'}-timesheets.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const inputClass = 'h-9 rounded-full border border-border bg-transparent px-4 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

  return (
    <div className="space-y-5">
      <button type="button" onClick={() => navigate('/user-management')} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary">
        <ArrowLeft className="h-4 w-4" /> Back to users
      </button>
      <WorkspaceHeader
        title={user ? `${user.full_name}'s timesheets` : 'User timesheets'}
        description={user ? user.email : `User #${uid}`}
        primary={<Button variant="secondary" onClick={exportCsv} disabled={rows.length === 0}><Download className="h-4 w-4" /> Export</Button>}
      />

      <Card className="flex flex-wrap items-center gap-2 p-3">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          <option value="APPROVED">Approved</option>
          <option value="SUBMITTED">Submitted</option>
          <option value="REJECTED">Rejected</option>
          <option value="DRAFT">Draft</option>
        </select>
        <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-auto" aria-label="Start date" />
        <span className="text-xs text-muted-foreground">→</span>
        <Input type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} className="w-auto" aria-label="End date" />
      </Card>

      {q.isLoading ? (
        <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>
      ) : q.isError ? (
        <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">Couldn't load this user's timesheets.</Card>
      ) : rows.length === 0 ? (
        <Empty title="No timesheets" description="No entries match the current filters." />
      ) : (
        <>
          <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
            <span>{totals.count} {totals.count === 1 ? 'entry' : 'entries'} across {months.length} {months.length === 1 ? 'month' : 'months'}</span>
            <span className="tabular-nums">{totals.hours.toFixed(2)}h total</span>
          </div>
          {months.map((m) => {
            const mCollapsed = collapsed.has(m.key);
            return (
              <Card key={m.key} className="overflow-hidden">
                <button type="button" onClick={() => toggle(m.key)} className="flex w-full items-center justify-between border-b border-border px-4 py-3 text-left hover:bg-primary/5">
                  <div className="flex items-center gap-2">
                    {mCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                    <p className="text-sm font-semibold text-foreground">{m.label}</p>
                    <span className="text-xs text-muted-foreground">{m.count} {m.count === 1 ? 'entry' : 'entries'}</span>
                  </div>
                  <span className="text-sm font-semibold tabular-nums text-foreground">{m.hours.toFixed(2)}h</span>
                </button>
                {!mCollapsed ? (
                  <div className="divide-y divide-border">
                    {m.weeks.map((w) => (
                      <div key={w.weekStart}>
                        <div className="flex items-center justify-between bg-muted/30 px-4 py-1.5 text-xs">
                          <span className="font-medium text-muted-foreground">{formatWeekRange(fromISODate(w.weekStart))}</span>
                          <span className="tabular-nums text-muted-foreground">{w.hours.toFixed(2)}h</span>
                        </div>
                        {w.entries.map((e) => (
                          <div key={e.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                            <span className="w-24 shrink-0 tabular-nums text-muted-foreground">{e.entry_date}</span>
                            <span className="min-w-0 flex-1 truncate text-foreground" title={e.description ?? ''}>
                              {e.project?.name ?? `#${e.project_id}`}{e.description ? <span className="text-muted-foreground"> · {e.description}</span> : ''}
                            </span>
                            <StatusBadge status={timesheetStatusKey(e.status)} variant="timesheet" showIcon={false} />
                            <span className="w-14 shrink-0 text-right font-medium tabular-nums text-foreground">{num(e.hours).toFixed(2)}h</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </>
      )}
    </div>
  );
}
