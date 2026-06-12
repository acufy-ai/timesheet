import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  CornerUpLeft,
  Flag,
  Layers,
  Loader2,
  Search,
  X,
} from 'lucide-react';

import {
  Button,
  Card,
  Empty,
  Input,
  Modal,
  StatTile,
  StatusBadge,
  TonePill,
  WorkspaceHeader,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { useQueryClient } from '@tanstack/react-query';

import {
  useApprovalHistoryGrouped,
  useBatchApprove,
  useBatchReject,
  usePendingApprovals,
} from '@/hooks/useApprovals';
import { approvalsApi } from '@/api/client';
import {
  groupPending,
  initials,
  type EmployeeGroup,
  type WeekGroup,
} from '@/lib/approvalsGrouping';
import { fromISODate, formatDayLong, formatTime12h, formatWeekRange } from '@/lib/date';
import { TimeOffApprovals } from '@/components/time-off/TimeOffApprovals';
import { ApprovedTimesheetsTab } from '@/components/users/ApprovedTimesheetsTab';
import { TeamDraftsTab } from '@/components/approvals/TeamDraftsTab';
import { usePendingTimeOff } from '@/hooks/useAdmin';
import type { HistoryGroup } from '@/types/time';

type Tab = 'timesheets' | 'timeoff' | 'team' | 'approved';

const fmtH = (h: number) => h.toFixed(1);
const fmt12 = (v: string | null | undefined) => formatTime12h(v) ?? '—';

export function ApprovalsPage() {
  const [tab, setTab] = useState<Tab>('timesheets');
  const qc = useQueryClient();
  const pending = usePendingApprovals();
  const approve = useBatchApprove();
  const reject = useBatchReject();
  // Pending time-off count for the Time Off tab badge.
  const pendingTimeOff = usePendingTimeOff();
  const pendingTimeOffCount = pendingTimeOff.data?.length ?? 0;

  const [search, setSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [selectedWeekStart, setSelectedWeekStart] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  // Per-day collapse in the detail pane: a Set of `day.date` keys that are
  // EXPANDED. Default empty = every day collapsed (header-only).
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  // The reject modal doubles as "send back for rework" (same reject-with-reason
  // endpoint, softer framing). 'reject' = hard reject, 'send_back' = rework.
  const [rejectMode, setRejectMode] = useState<'reject' | 'send_back'>('reject');
  // Multi-week bulk selection: "<userId>|<weekStart>" keys.
  const [bulkKeys, setBulkKeys] = useState<Set<string>>(new Set());
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [bulkReason, setBulkReason] = useState('');

  const employees = useMemo(() => groupPending(pending.data ?? []), [pending.data]);

  const filtered = useMemo(
    () => employees.filter((e) => e.name.toLowerCase().includes(search.trim().toLowerCase())),
    [employees, search],
  );

  useEffect(() => {
    if (employees.length === 0) { setSelectedUserId(null); return; }
    const stillExists = employees.some((e) => e.userId === selectedUserId);
    if (!stillExists) {
      setSelectedUserId(employees[0].userId);
      setSelectedWeekStart(employees[0].weeks[0]?.weekStart ?? null);
    }
  }, [employees, selectedUserId]);

  // Drop stale bulk keys when the data shrinks (after approve/reject).
  useEffect(() => {
    const valid = new Set(employees.flatMap((e) => e.weeks.map((w) => `${e.userId}|${w.weekStart}`)));
    setBulkKeys((prev) => {
      const next = new Set([...prev].filter((k) => valid.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [employees]);

  const selectedEmployee = employees.find((e) => e.userId === selectedUserId);
  const selectedWeek =
    selectedEmployee?.weeks.find((w) => w.weekStart === selectedWeekStart) ??
    selectedEmployee?.weeks[0];

  // Collapse all days when the viewed employee/week changes so a new week
  // always opens header-only.
  useEffect(() => {
    setExpandedDays(new Set());
  }, [selectedUserId, selectedWeek?.weekStart]);

  function toggleDay(date: string) {
    setExpandedDays((s) => { const n = new Set(s); n.has(date) ? n.delete(date) : n.add(date); return n; });
  }

  const totalEntries = employees.reduce((s, e) => s + e.entryCount, 0);
  const totalWeeks = employees.reduce((s, e) => s + e.weekCount, 0);

  // Resolve bulk-selected week groups → flat entry IDs.
  const weekByKey = useMemo(() => {
    const m = new Map<string, { emp: EmployeeGroup; week: WeekGroup }>();
    employees.forEach((emp) => emp.weeks.forEach((week) => m.set(`${emp.userId}|${week.weekStart}`, { emp, week })));
    return m;
  }, [employees]);
  const bulkEntryIds = useMemo(
    () => [...bulkKeys].flatMap((k) => weekByKey.get(k)?.week.entryIds ?? []),
    [bulkKeys, weekByKey],
  );

  function selectEmployee(e: EmployeeGroup) {
    setSelectedUserId(e.userId);
    setSelectedWeekStart(e.weeks[0]?.weekStart ?? null);
  }
  function toggleBulk(key: string) {
    setBulkKeys((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  // All employee-week keys currently shown (respects the search filter).
  const allKeys = useMemo(
    () => filtered.flatMap((e) => e.weeks.map((w) => `${e.userId}|${w.weekStart}`)),
    [filtered],
  );
  const allSelected = allKeys.length > 0 && allKeys.every((k) => bulkKeys.has(k));
  function toggleSelectAll() {
    setBulkKeys(allSelected ? new Set() : new Set(allKeys));
  }
  // Select / clear every week for one employee (scenario 1 in one click).
  function toggleEmployeeWeeks(e: EmployeeGroup) {
    const keys = e.weeks.map((w) => `${e.userId}|${w.weekStart}`);
    const allOn = keys.every((k) => bulkKeys.has(k));
    setBulkKeys((s) => {
      const n = new Set(s);
      keys.forEach((k) => (allOn ? n.delete(k) : n.add(k)));
      return n;
    });
  }


  // ── Bulk action plumbing ───────────────────────────────────────────
  // The backend approves/rejects ONE employee-week at a time, all of that
  // week's submitted entries together (approvals.py _validate_weekly_batch:
  // one employee + one work week + requested_ids == submitted_ids). So a
  // selection spanning multiple employees/weeks is fanned out into one
  // batch call PER (employee, week) group. To the manager it's one click;
  // under the hood it's N atomic calls with a per-group result summary.
  const [bulkResult, setBulkResult] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  function selectedWeekGroups() {
    return [...bulkKeys]
      .map((k) => weekByKey.get(k))
      .filter((g): g is { emp: EmployeeGroup; week: WeekGroup } => Boolean(g));
  }

  // Run one API call per selected (employee, week) group, then invalidate ONCE.
  // We call approvalsApi directly (not the mutation hook) so each group is its
  // own independent request — the hook's per-call onSuccess invalidation would
  // otherwise refetch /pending mid-loop and clobber the group set we captured.
  async function fanOut(run: (ids: number[]) => Promise<unknown>) {
    // Snapshot the groups BEFORE any mutation so refetches can't shrink them.
    const groups = selectedWeekGroups();
    const results = await Promise.allSettled(groups.map((g) => run(g.week.entryIds)));
    let ok = 0;
    const failed: string[] = [];
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') { ok += 1; return; }
      const err = res.reason;
      const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      const g = groups[i];
      failed.push(`${g.emp.name} (${formatWeekRange(fromISODate(g.week.weekStart))})${typeof d === 'string' ? ` — ${d}` : ''}`);
    });
    // Refresh the queue + dashboards once, after all calls settle.
    qc.invalidateQueries({ queryKey: ['approvals'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    return { ok, failed, total: groups.length };
  }

  function summarize(verb: string, r: { ok: number; failed: string[]; total: number }) {
    if (r.failed.length === 0) {
      setBulkResult({ tone: 'ok', text: `${verb} ${r.ok} ${r.ok === 1 ? 'week' : 'weeks'}.` });
    } else {
      setBulkResult({ tone: 'err', text: `${verb} ${r.ok} of ${r.total}. Failed: ${r.failed.join('; ')}` });
    }
    window.setTimeout(() => setBulkResult(null), 8000);
  }

  // Single-week "Approve week" in the detail pane (already one valid group).
  async function handleApprove() {
    if (!selectedWeek) return;
    setBulkResult(null);
    try {
      await approve.mutateAsync(selectedWeek.entryIds);
    } catch (err) {
      const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setBulkResult({ tone: 'err', text: typeof d === 'string' ? d : 'Could not approve.' });
      window.setTimeout(() => setBulkResult(null), 8000);
    }
  }
  function openReject(mode: 'reject' | 'send_back') {
    setRejectMode(mode);
    setRejectReason('');
    setRejectOpen(true);
  }
  // Week-level reject/send-back for the active week (the backend requires the
  // whole week together, so there is no per-entry reject).
  async function handleReject() {
    const ids = selectedWeek?.entryIds;
    if (!ids || ids.length === 0 || !rejectReason.trim()) return;
    try {
      await reject.mutateAsync({ entryIds: ids, reason: rejectReason.trim() });
    } catch (err) {
      const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setBulkResult({ tone: 'err', text: typeof d === 'string' ? d : 'Could not reject.' });
      window.setTimeout(() => setBulkResult(null), 8000);
    }
    setRejectOpen(false);
    setRejectReason('');
  }
  const [bulkBusy, setBulkBusy] = useState(false);
  async function handleBulkApprove() {
    if (bulkKeys.size === 0) return;
    setBulkBusy(true);
    const r = await fanOut((ids) => approvalsApi.batchApprove(ids));
    summarize('Approved', r);
    setBulkKeys(new Set());
    setBulkBusy(false);
  }
  async function handleBulkReject() {
    if (bulkKeys.size === 0 || !bulkReason.trim()) return;
    const reason = bulkReason.trim();
    setBulkBusy(true);
    const r = await fanOut((ids) => approvalsApi.batchReject(ids, reason));
    summarize('Rejected', r);
    setBulkRejectOpen(false);
    setBulkReason('');
    setBulkKeys(new Set());
    setBulkBusy(false);
  }

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        title="Approvals"
        description="Review timesheets from your direct reports."
      />

      {/* Tabs */}
      <div className="flex items-center gap-1.5 border-b border-border pb-3">
        <TabPill active={tab === 'timesheets'} onClick={() => setTab('timesheets')}>
          Timesheets
          <Count active={tab === 'timesheets'}>{totalEntries}</Count>
        </TabPill>
        <TabPill active={tab === 'timeoff'} onClick={() => setTab('timeoff')}>
          Time Off
          {pendingTimeOffCount > 0 ? <Count active={tab === 'timeoff'}>{pendingTimeOffCount}</Count> : null}
        </TabPill>
        <TabPill active={tab === 'team'} onClick={() => setTab('team')}>
          Team Drafts
        </TabPill>
        <TabPill active={tab === 'approved'} onClick={() => setTab('approved')}>
          History
        </TabPill>
      </div>

      {tab === 'timeoff' ? (
        <TimeOffApprovals enabled={tab === 'timeoff'} />
      ) : tab === 'team' ? (
        // Same detail-pane layout as pending approvals (employee -> week ->
        // per-day entries), but READ-ONLY and status-badged (defaults to Draft).
        // Lets a manager see in-progress timesheets before submission.
        <TeamDraftsTab />
      ) : tab === 'approved' ? (
        <div className="space-y-6">
          {/* Full approved-timesheets table (grouped drill-in + inbox-merge +
              source-file viewer + export), matching frontend2's manager view. */}
          <ApprovedTimesheetsTab />
          {/* Approval-event history below the table. */}
          <ApprovalHistory />
        </div>
      ) : pending.isLoading ? (
        <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
        </div>
      ) : pending.isError ? (
        <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">
          Couldn't load pending approvals. Try refreshing.
        </Card>
      ) : employees.length === 0 ? (
        <Empty Icon={CheckCircle2} title="All caught up" description="No timesheets are waiting for your approval." />
      ) : (
        <>
          {/* Stat tiles */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile Icon={Flag} tone="rose" value={employees.length} label="Employees awaiting review" />
            <StatTile Icon={Clock} tone="amber" value={totalWeeks} label="Weeks pending" hint="across all employees" />
            <StatTile Icon={Layers} tone="violet" value={totalEntries} label="Entries" hint="across all weeks" />
          </div>

          {/* Bulk action result summary (success or per-week failure list). */}
          {bulkResult ? (
            <div role="alert" className={'rounded-xl border px-3 py-2 text-sm ' + (bulkResult.tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300')}>
              {bulkResult.text}
            </div>
          ) : null}

          {/* Picker + detail */}
          <div className="grid gap-4 lg:grid-cols-3">
            {/* Employee + week picker (with bulk checkboxes) */}
            <div className="space-y-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-9" placeholder="Search employees..." value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              {/* Select-all across every employee + week (scenarios 1-3). */}
              {filtered.length > 0 ? (
                <label className="flex cursor-pointer items-center gap-2 px-1 py-1 text-xs font-medium text-muted-foreground">
                  <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} className="h-3.5 w-3.5 rounded border-border accent-[hsl(var(--primary))]" />
                  Select all {totalWeeks} {totalWeeks === 1 ? 'week' : 'weeks'}
                  {bulkKeys.size > 0 ? <span className="ml-auto text-primary">{bulkKeys.size} selected</span> : null}
                </label>
              ) : null}
              {filtered.map((e) => {
                const active = e.userId === selectedUserId;
                return (
                  <div
                    key={e.userId}
                    className={cn(
                      'rounded-2xl border transition-colors',
                      active ? 'border-primary/30 bg-primary/5' : 'border-border bg-card hover:border-primary/30 hover:bg-primary/5',
                    )}
                  >
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
                        <StatusBadge status="submitted" variant="timesheet" label="Awaiting" showIcon={false} />
                      </div>
                    </button>
                    {/* Per-week bulk-select checkboxes (+ a clear "select all
                        weeks" button for this employee when they have >1). */}
                    <div className="space-y-1.5 border-t border-border px-3 py-2">
                      {e.weeks.length > 1 ? (() => {
                        const allOn = e.weeks.every((w) => bulkKeys.has(`${e.userId}|${w.weekStart}`));
                        return (
                          <button
                            type="button"
                            onClick={() => toggleEmployeeWeeks(e)}
                            className={cn(
                              'flex w-full items-center justify-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium transition-colors',
                              allOn
                                ? 'border-primary bg-primary/15 text-primary'
                                : 'border-border text-muted-foreground hover:border-primary/40 hover:text-primary',
                            )}
                          >
                            {allOn ? (
                              <><X className="h-3.5 w-3.5" /> Clear all {e.weekCount} weeks</>
                            ) : (
                              <><CheckCircle2 className="h-3.5 w-3.5" /> Select all {e.weekCount} weeks</>
                            )}
                          </button>
                        );
                      })() : null}
                      <div className="flex flex-wrap gap-1.5">
                      {e.weeks.map((w) => {
                        const key = `${e.userId}|${w.weekStart}`;
                        const checked = bulkKeys.has(key);
                        return (
                          <label
                            key={key}
                            className={cn(
                              'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]',
                              checked ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground',
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleBulk(key)}
                              className="h-3 w-3 rounded border-border accent-[hsl(var(--primary))]"
                            />
                            {w.label.replace(/, \d{4}$/, '')}
                          </label>
                        );
                      })}
                      </div>
                    </div>
                  </div>
                );
              })}
              {filtered.length === 0 ? (
                <p className="px-1 py-4 text-center text-sm text-muted-foreground">No employees match "{search}".</p>
              ) : null}
            </div>

            {/* Week detail */}
            <div className="lg:col-span-2">
              {selectedEmployee && selectedWeek ? (
                <Card className="space-y-3 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={selectedEmployee.name} active />
                      <div>
                        <p className="text-sm font-semibold text-foreground">{selectedEmployee.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {selectedWeek.label}
                          {(() => {
                            const subs = selectedWeek.days.flatMap((d) => d.entries).map((e) => e.submitted_at).filter(Boolean) as string[];
                            if (subs.length === 0) return null;
                            const oldest = subs.sort()[0];
                            const d = new Date(oldest);
                            return Number.isNaN(d.getTime()) ? null : <> · submitted {d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</>;
                          })()}
                        </p>
                      </div>
                    </div>
                    <StatusBadge status="submitted" variant="timesheet" label="Awaiting review" />
                  </div>

                  {selectedEmployee.weeks.length > 1 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {selectedEmployee.weeks.map((w) => (
                        <button
                          key={w.weekStart}
                          type="button"
                          onClick={() => setSelectedWeekStart(w.weekStart)}
                          className={cn('pill text-xs', w.weekStart === selectedWeek.weekStart ? 'pill-active' : 'pill-idle bg-muted')}
                        >
                          {w.label.replace(/, \d{4}$/, '')}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <p className="text-xs text-muted-foreground">
                    {selectedWeek.entryCount} {selectedWeek.entryCount === 1 ? 'entry' : 'entries'} across{' '}
                    {selectedWeek.days.length} {selectedWeek.days.length === 1 ? 'day' : 'days'} ·{' '}
                    <strong className="text-foreground">Total {fmtH(selectedWeek.hours)} hours</strong>
                  </p>

                  {/* Day entries — collapsed by default. Click a day header to
                      expand its full per-entry detail (start/end/hours/task). */}
                  <div className="space-y-2">
                    {selectedWeek.days.map((day) => {
                      const dayOpen = expandedDays.has(day.date);
                      return (
                      <div key={day.date} className="rounded-xl border border-border">
                        <button
                          type="button"
                          onClick={() => toggleDay(day.date)}
                          aria-expanded={dayOpen}
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-primary/5"
                        >
                          {dayOpen ? (
                            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="flex-1 text-sm font-medium text-foreground">{formatDayLong(fromISODate(day.date))}</span>
                          <span className="text-xs text-muted-foreground">
                            {day.entries.length} {day.entries.length === 1 ? 'entry' : 'entries'}
                          </span>
                          <span className="tabular-nums text-sm font-medium text-foreground">{fmtH(day.hours)}h</span>
                        </button>
                        {dayOpen ? (
                        <div className="space-y-1.5 px-3 pb-3">
                          {day.entries.map((entry) => (
                            <div key={entry.id} className="flex items-start gap-3 rounded-lg bg-muted/30 px-2.5 py-1.5">
                              <div className="w-24 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                                {entry.start_time || entry.end_time ? (
                                  <>{fmt12(entry.start_time)}<br />{fmt12(entry.end_time)}</>
                                ) : (
                                  <span className="opacity-60">no time</span>
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs font-medium text-foreground">
                                  {entry.project?.name ?? `Project #${entry.project_id}`}
                                  {entry.task_id ? <span className="text-muted-foreground"> · task</span> : null}
                                  {!entry.is_billable ? <span className="text-muted-foreground"> · Non-billable</span> : null}
                                </p>
                                {entry.description ? (
                                  <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{entry.description}</p>
                                ) : null}
                              </div>
                              <p className="shrink-0 text-xs font-semibold tabular-nums text-foreground">
                                {fmtH(typeof entry.hours === 'string' ? parseFloat(entry.hours) : entry.hours)}h
                              </p>
                              {/* No per-entry approve/reject: the backend approves a week as a
                                  unit (all submitted entries together), so actions are week-level. */}
                            </div>
                          ))}
                        </div>
                        ) : null}
                      </div>
                      );
                    })}
                  </div>

                  {/* Actions: approve the whole week, send back for rework
                      (reject-with-reason, softer framing), or hard reject. */}
                  <div className="flex gap-2 pt-1">
                    <Button className="flex-1" onClick={() => void handleApprove()} disabled={approve.isPending}>
                      {approve.isPending ? (<><Loader2 className="h-4 w-4 animate-spin" /> Approving…</>) : 'Approve week'}
                    </Button>
                    <Button
                      variant="secondary"
                      className="border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-500/30 dark:text-amber-300 dark:hover:bg-amber-500/10"
                      onClick={() => openReject('send_back')}
                      disabled={reject.isPending}
                    >
                      <CornerUpLeft className="h-4 w-4" /> Send back
                    </Button>
                    <Button
                      variant="secondary"
                      className="border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:border-rose-500/30 dark:hover:bg-rose-500/10"
                      onClick={() => openReject('reject')}
                      disabled={reject.isPending}
                    >
                      Reject
                    </Button>
                  </div>
                </Card>
              ) : (
                <Card className="grid place-items-center py-16 text-sm text-muted-foreground">
                  Select an employee to review their week.
                </Card>
              )}
            </div>
          </div>
        </>
      )}

      {/* Sticky multi-week bulk action bar */}
      {tab === 'timesheets' && bulkKeys.size > 0 ? (
        <div className="sticky bottom-4 z-20 flex items-center justify-between gap-3 rounded-2xl border border-primary/30 bg-card/95 px-4 py-3 shadow-xl backdrop-blur">
          <div className="flex items-center gap-3 text-sm">
            <button type="button" onClick={() => setBulkKeys(new Set())} aria-label="Clear selection" className="grid h-6 w-6 place-items-center rounded-full hover:bg-foreground/10">
              <X className="h-4 w-4" />
            </button>
            <span className="font-medium text-foreground">
              {bulkKeys.size} week{bulkKeys.size === 1 ? '' : 's'} · {bulkEntryIds.length} entries selected
            </span>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void handleBulkApprove()} disabled={bulkBusy}>
              {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Approve selected
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-500/30 dark:hover:bg-rose-500/10"
              onClick={() => setBulkRejectOpen(true)}
              disabled={bulkBusy}
            >
              Reject selected
            </Button>
          </div>
        </div>
      ) : null}

      {/* Single-week reject reason modal */}
      <Modal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title={`${rejectMode === 'send_back' ? 'Send back' : 'Reject'} ${selectedEmployee?.name ?? ''}'s week`}
      >
        <RejectBody
          name={selectedEmployee?.name}
          reason={rejectReason}
          setReason={setRejectReason}
          pending={reject.isPending}
          mode={rejectMode}
          onCancel={() => setRejectOpen(false)}
          onConfirm={() => void handleReject()}
        />
      </Modal>

      {/* Bulk reject reason modal */}
      <Modal open={bulkRejectOpen} onClose={() => setBulkRejectOpen(false)} title={`Reject ${bulkKeys.size} selected week${bulkKeys.size === 1 ? '' : 's'}`}>
        <RejectBody
          name={undefined}
          reason={bulkReason}
          setReason={setBulkReason}
          pending={bulkBusy}
          onCancel={() => setBulkRejectOpen(false)}
          onConfirm={() => void handleBulkReject()}
        />
      </Modal>
    </div>
  );
}

// ─── Approval history (the "History" tab) ───────────────────────────

function ApprovalHistory() {
  const [daysBack, setDaysBack] = useState(30);
  const [statusFilter, setStatusFilter] = useState<'all' | 'approved' | 'rejected' | 'mixed'>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const q = useApprovalHistoryGrouped({
    days_back: daysBack,
    status_filter: statusFilter === 'all' ? undefined : statusFilter,
  });
  const groups = q.data ?? [];

  function keyOf(g: HistoryGroup) {
    return `${g.employee_id}|${g.week_start}`;
  }
  function toggle(k: string) {
    setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }

  const DAY_OPTIONS = [
    { v: 7, label: 'Last 7 days' },
    { v: 30, label: 'Last 30 days' },
    { v: 90, label: 'Last 90 days' },
    { v: 365, label: 'Last year' },
  ];
  const STATUS_OPTIONS: Array<{ v: typeof statusFilter; label: string }> = [
    { v: 'all', label: 'All' },
    { v: 'approved', label: 'Approved' },
    { v: 'rejected', label: 'Rejected' },
    { v: 'mixed', label: 'Mixed' },
  ];

  return (
    <div className="space-y-4">
      {/* Filters */}
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {STATUS_OPTIONS.map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => setStatusFilter(o.v)}
              className={cn('pill text-xs', statusFilter === o.v ? 'pill-active' : 'pill-idle bg-muted')}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <select
          value={daysBack}
          onChange={(e) => setDaysBack(Number(e.target.value))}
          className="h-9 rounded-full border border-border bg-transparent px-4 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          {DAY_OPTIONS.map((o) => (
            <option key={o.v} value={o.v}>{o.label}</option>
          ))}
        </select>
      </Card>

      {q.isLoading ? (
        <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
        </div>
      ) : q.isError ? (
        <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">Couldn't load approval history. Try refreshing.</Card>
      ) : groups.length === 0 ? (
        <Empty Icon={CheckCircle2} title="No history yet" description="Decided timesheets for this period will appear here." />
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {groups.map((g) => {
            const k = keyOf(g);
            const open = expanded.has(k);
            return (
              <div key={k}>
                <button type="button" onClick={() => toggle(k)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-primary/5">
                  {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                  <Avatar name={g.employee_name} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{g.employee_name}</p>
                    <p className="text-xs text-muted-foreground">{formatWeekRange(fromISODate(g.week_start))}</p>
                  </div>
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    {g.entry_count} {g.entry_count === 1 ? 'entry' : 'entries'} · {fmtH(g.total_hours)}h
                  </span>
                  <HistoryStatusPill g={g} />
                </button>
                {open ? (
                  <div className="space-y-1.5 bg-muted/20 px-4 pb-3 pt-1">
                    {g.entries.map((e) => (
                      <div key={e.id} className="flex items-start gap-3 rounded-lg bg-card px-2.5 py-1.5">
                        <div className="w-20 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {formatDayLong(fromISODate(e.entry_date)).replace(/,.*$/, '')}
                        </div>
                        <div className="w-24 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {e.start_time || e.end_time ? (<>{fmt12(e.start_time)}<br />{fmt12(e.end_time)}</>) : <span className="opacity-60">no time</span>}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-foreground">
                            {e.project_name ?? 'Project'}{e.task_name ? ` · ${e.task_name}` : ''}
                          </p>
                          {e.description ? <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{e.description}</p> : null}
                          {e.status === 'REJECTED' && e.rejection_reason ? (
                            <p className="mt-0.5 text-[11px] text-rose-600 dark:text-rose-300">Rejected: {e.rejection_reason}</p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-0.5">
                          <span className="text-xs font-semibold tabular-nums text-foreground">{fmtH(e.hours)}h</span>
                          <StatusBadge status={e.status.toLowerCase()} variant="timesheet" showIcon={false} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

function HistoryStatusPill({ g }: { g: HistoryGroup }) {
  if (g.status === 'mixed') {
    return (
      <TonePill tone="warning">
        {g.approved_count}✓ {g.rejected_count}✗
      </TonePill>
    );
  }
  if (g.status === 'rejected') return <TonePill tone="danger">Rejected</TonePill>;
  return <TonePill tone="success">Approved</TonePill>;
}

// ─── Shared bits ────────────────────────────────────────────────────

function RejectBody({
  name,
  reason,
  setReason,
  pending,
  mode = 'reject',
  onCancel,
  onConfirm,
}: {
  name?: string;
  reason: string;
  setReason: (v: string) => void;
  pending: boolean;
  mode?: 'reject' | 'send_back';
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const sendBack = mode === 'send_back';
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {name
          ? `Tell ${name.split(/\s+/)[0]} what needs to change. They'll see this reason when reworking the timesheet.`
          : "Tell them what needs to change. They'll see this reason when reworking the timesheet."}
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        autoFocus
        placeholder="e.g. Wednesday's hours look high — please confirm."
        className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button
          variant={sendBack ? 'primary' : 'destructive'}
          onClick={onConfirm}
          disabled={!reason.trim() || pending}
        >
          {pending ? (<><Loader2 className="h-4 w-4 animate-spin" /> {sendBack ? 'Sending…' : 'Rejecting…'}</>) : (sendBack ? 'Send back' : 'Reject')}
        </Button>
      </div>
    </div>
  );
}

function TabPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn('pill text-sm', active ? 'pill-active' : 'pill-idle')}>
      {children}
    </button>
  );
}

function Count({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <span className={cn('ml-1 rounded-full px-1.5 text-[10px]', active ? 'bg-white/20' : 'bg-muted')}>{children}</span>
  );
}

function Avatar({ name, active }: { name: string; active?: boolean }) {
  return (
    <span
      className={cn(
        'grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold ring-2 ring-card',
        active ? 'bg-primary text-primary-foreground' : 'bg-violet-500/15 text-violet-600 dark:text-violet-300',
      )}
    >
      {initials(name)}
    </span>
  );
}
