import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Search } from 'lucide-react';

import { Card, Empty, Input, StatusBadge } from '@/components/ui';
import { useTeamTimesheets } from '@/hooks/useAdmin';
import { groupPending, type EmployeeGroup } from '@/lib/approvalsGrouping';
import { fromISODate, formatDayLong, formatTime12h } from '@/lib/date';
import { cn } from '@/lib/cn';
import { avatarTone, initials } from '@/lib/avatar';
import type { TimeEntry } from '@/types/time';

const fmtH = (h: number) => h.toFixed(1);
const fmt12 = (v: string | null | undefined) => formatTime12h(v) ?? '—';

function Avatar({ name, active }: { name: string; active?: boolean }) {
  return (
    <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-semibold', active ? 'bg-primary text-primary-foreground' : avatarTone(name))}>
      {initials(name)}
    </span>
  );
}

// Manager view of direct reports' DRAFT (and other in-progress) timesheets,
// BEFORE submission. Mirrors the pending-approval detail pane layout exactly
// (employee list -> week picker -> per-day entries) but is READ-ONLY: no
// approve/reject/bulk actions. Status is shown (Draft) so it's clear these
// aren't actionable yet. Backend /timesheets/all returns DRAFT for a manager's
// report tree.
export function TeamDraftsTab() {
  const [status, setStatus] = useState<'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'all'>('DRAFT');
  const q = useTeamTimesheets({ status: status === 'all' ? undefined : status });
  const entries = useMemo(() => (q.data ?? []) as TimeEntry[], [q.data]);

  const [search, setSearch] = useState('');
  const employees = useMemo(() => groupPending(entries), [entries]);
  const filtered = useMemo(
    () => employees.filter((e) => e.name.toLowerCase().includes(search.trim().toLowerCase())),
    [employees, search],
  );

  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [selectedWeekStart, setSelectedWeekStart] = useState<string | null>(null);
  useEffect(() => {
    if (employees.length === 0) { setSelectedUserId(null); return; }
    if (!employees.some((e) => e.userId === selectedUserId)) {
      setSelectedUserId(employees[0].userId);
      setSelectedWeekStart(employees[0].weeks[0]?.weekStart ?? null);
    }
  }, [employees, selectedUserId]);

  const selectedEmployee = filtered.find((e) => e.userId === selectedUserId) ?? filtered[0];
  const selectedWeek =
    selectedEmployee?.weeks.find((w) => w.weekStart === selectedWeekStart) ?? selectedEmployee?.weeks[0];

  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  function toggleDay(date: string) {
    setExpandedDays((s) => { const n = new Set(s); n.has(date) ? n.delete(date) : n.add(date); return n; });
  }
  function selectEmployee(e: EmployeeGroup) {
    setSelectedUserId(e.userId);
    setSelectedWeekStart(e.weeks[0]?.weekStart ?? null);
    setExpandedDays(new Set());
  }

  // Status label/badge for the current view.
  const statusBadge = (s: string) => {
    const k = s.toLowerCase();
    const label = s === 'DRAFT' ? 'Draft' : s === 'SUBMITTED' ? 'Submitted' : s === 'APPROVED' ? 'Approved' : s === 'REJECTED' ? 'Rejected' : s;
    return <StatusBadge status={k} variant="timesheet" label={label} showIcon={false} />;
  };

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-2 p-3">
        <p className="text-sm text-muted-foreground">Your team's timesheets, including drafts not yet submitted. Read-only.</p>
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="h-9 rounded-full border border-border bg-transparent px-4 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20">
          <option value="DRAFT">Draft</option>
          <option value="SUBMITTED">Submitted</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="all">All statuses</option>
        </select>
      </Card>

      {q.isLoading ? (
        <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>
      ) : q.isError ? (
        <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">Couldn't load team timesheets. Try refreshing.</Card>
      ) : employees.length === 0 ? (
        <Empty Icon={Search} title="Nothing here" description={`No ${status === 'all' ? '' : status.toLowerCase() + ' '}timesheets from your team.`} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Employee + week picker */}
          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" placeholder="Search employees..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {filtered.map((e) => {
              const active = e.userId === selectedEmployee?.userId;
              return (
                <div key={e.userId} className={cn('rounded-2xl border transition-colors', active ? 'border-primary/30 bg-primary/5' : 'border-border bg-card hover:border-primary/30 hover:bg-primary/5')}>
                  <button type="button" onClick={() => selectEmployee(e)} className="w-full p-3 text-left">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={e.name} active={active} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{e.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {e.entryCount} {e.entryCount === 1 ? 'entry' : 'entries'} · {fmtH(e.hours)}h
                          {e.weekCount > 1 ? <span className="ml-1 text-[10px]">· {e.weekCount} weeks</span> : null}
                        </p>
                      </div>
                      {statusBadge(status === 'all' ? 'DRAFT' : status)}
                    </div>
                  </button>
                  {/* Week picker (no bulk checkboxes — read-only). */}
                  {e.weeks.length > 1 ? (
                    <div className="flex flex-wrap gap-1.5 border-t border-border px-3 py-2">
                      {e.weeks.map((w) => (
                        <button
                          key={w.weekStart}
                          type="button"
                          onClick={() => { setSelectedUserId(e.userId); setSelectedWeekStart(w.weekStart); setExpandedDays(new Set()); }}
                          className={cn('rounded-full border px-2 py-0.5 text-[11px]', active && w.weekStart === selectedWeek?.weekStart ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/40')}
                        >
                          {w.label.replace(/, \d{4}$/, '')}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {filtered.length === 0 ? <p className="px-1 py-4 text-center text-sm text-muted-foreground">No employees match "{search}".</p> : null}
          </div>

          {/* Week detail — same layout as pending approvals, READ-ONLY. */}
          <div className="lg:col-span-2">
            {selectedEmployee && selectedWeek ? (
              <Card className="space-y-3 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={selectedEmployee.name} active />
                    <div>
                      <p className="text-sm font-semibold text-foreground">{selectedEmployee.name}</p>
                      <p className="text-xs text-muted-foreground">{selectedWeek.label}</p>
                    </div>
                  </div>
                  {statusBadge(status === 'all' ? 'DRAFT' : status)}
                </div>

                <p className="text-xs text-muted-foreground">
                  {selectedWeek.entryCount} {selectedWeek.entryCount === 1 ? 'entry' : 'entries'} across{' '}
                  {selectedWeek.days.length} {selectedWeek.days.length === 1 ? 'day' : 'days'} ·{' '}
                  <strong className="text-foreground">Total {fmtH(selectedWeek.hours)} hours</strong>
                </p>

                {/* Day entries — collapsed by default, click to expand. */}
                <div className="space-y-2">
                  {selectedWeek.days.map((day) => {
                    const open = expandedDays.has(day.date);
                    return (
                      <div key={day.date} className="rounded-xl border border-border">
                        <button type="button" onClick={() => toggleDay(day.date)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-primary/5">
                          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                          <p className="flex-1 text-sm font-medium text-foreground">{formatDayLong(fromISODate(day.date))}</p>
                          <span className="text-xs text-muted-foreground">{day.entries.length} {day.entries.length === 1 ? 'entry' : 'entries'}</span>
                          <p className="tabular-nums text-sm text-foreground">{fmtH(day.hours)}h</p>
                        </button>
                        {open ? (
                          <div className="space-y-1.5 px-3 pb-3">
                            {day.entries.map((entry) => (
                              <div key={entry.id} className="flex items-start gap-3 rounded-lg bg-muted/30 px-2.5 py-1.5">
                                <div className="w-24 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                                  {entry.start_time || entry.end_time ? (<>{fmt12(entry.start_time)}<br />{fmt12(entry.end_time)}</>) : (<span className="opacity-60">no time</span>)}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-xs font-medium text-foreground">
                                    {entry.project?.name ?? `Project #${entry.project_id}`}
                                    {entry.task_id ? <span className="text-muted-foreground"> · task</span> : null}
                                    {!entry.is_billable ? <span className="text-muted-foreground"> · Non-billable</span> : null}
                                  </p>
                                  {entry.description ? <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{entry.description}</p> : null}
                                </div>
                                <p className="shrink-0 text-xs font-semibold tabular-nums text-foreground">
                                  {fmtH(typeof entry.hours === 'string' ? parseFloat(entry.hours) : entry.hours)}h
                                </p>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                {/* No approve/reject — drafts are not submitted; this is read-only. */}
                <p className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
                  Read-only. {status === 'DRAFT' ? 'This timesheet has not been submitted yet, so there is nothing to approve.' : 'Submitted timesheets are approved from the Timesheets tab.'}
                </p>
              </Card>
            ) : (
              <Card className="grid place-items-center px-4 py-16 text-sm text-muted-foreground">Select an employee to view their timesheet.</Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
