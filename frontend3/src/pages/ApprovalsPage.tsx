import { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
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
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

import { Button, Card, Empty, Input, Modal, StatusBadge, TableSkeleton, Toast, WorkspaceHeader } from '@/components/ui';
import { cn } from '@/lib/cn';

import { useBatchApprove, useBatchReject, usePendingApprovals } from '@/hooks/useApprovals';
import { usePendingTimeOff, useTeamTimesheets, useWeekStartDay } from '@/hooks/useAdmin';
import { approvalsApi } from '@/api/client';
import { groupPending, initials, type EmployeeGroup, type WeekGroup } from '@/lib/approvalsGrouping';
import { fromISODate, formatTime12h, startOfWeek, toISODate } from '@/lib/date';
import { TimeOffApprovals } from '@/components/time-off/TimeOffApprovals';
import type { TimeEntry } from '@/types/time';

type Tab = 'pending' | 'thisweek' | 'timeoff' | 'history';

const fmtH = (h: number) => h.toFixed(1);
const fmt12 = (v: string | null | undefined) => formatTime12h(v) ?? '—';
const shortRange = (label: string) => label.replace(/, \d{4}$/, '');

// Per-tab context for the shared employee-table + detail shell. Each tab swaps
// the data source, the badge, whether the detail pane is actionable, and the
// bulk-bar action — but the layout is identical.
interface TabConfig {
  key: Tab;
  label: string;
  detailBadge: string;
  badgeStatus: string;
  showWeekActions: boolean; // Pending only: approve/send-back/reject in the pane
  // Whether this tab has a bulk action (and therefore shows selection UI:
  // row checkboxes, "Select all", and the top bulk bar). This Week is
  // review-only — no bulk action — so it has no selection UI.
  bulkAction: boolean;
  bulkApprove: string; // top-bar primary action label (when bulkAction)
  bulkReject: string | null; // top-bar secondary (null = none)
}

const TAB_CONFIG: Record<Exclude<Tab, 'timeoff'>, TabConfig> = {
  pending: {
    key: 'pending', label: 'Pending Approvals', detailBadge: 'Awaiting review', badgeStatus: 'submitted',
    showWeekActions: true, bulkAction: true, bulkApprove: 'Approve all', bulkReject: 'Reject all',
  },
  thisweek: {
    key: 'thisweek', label: 'This Week', detailBadge: 'Draft · not submitted', badgeStatus: 'draft',
    showWeekActions: false, bulkAction: false, bulkApprove: '', bulkReject: null,
  },
  history: {
    key: 'history', label: 'History', detailBadge: 'Approved', badgeStatus: 'approved',
    showWeekActions: false, bulkAction: true, bulkApprove: 'Export selected', bulkReject: null,
  },
};

const PERIOD_OPTIONS = [
  { v: '7', label: 'Last 7 days' },
  { v: '30', label: 'Last 30 days' },
  { v: '90', label: 'Last 90 days' },
  { v: 'month', label: 'This month' },
  { v: 'quarter', label: 'This quarter' },
  { v: 'year', label: 'This year' },
  { v: 'all', label: 'All time' },
];

// Resolve a period preset to a [from, to] ISO date window (to = today).
function periodRange(preset: string): [string | null, string] {
  const today = new Date();
  const to = toISODate(today);
  if (preset === 'all') return [null, to];
  if (preset === 'month') { const f = new Date(today.getFullYear(), today.getMonth(), 1); return [toISODate(f), to]; }
  if (preset === 'quarter') { const f = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1); return [toISODate(f), to]; }
  if (preset === 'year') { return [`${today.getFullYear()}-01-01`, to]; }
  const f = new Date(today); f.setDate(today.getDate() - Number(preset));
  return [toISODate(f), to];
}

const TAB_KEYS: Tab[] = ['pending', 'thisweek', 'timeoff', 'history'];

export function ApprovalsPage() {
  // Tab is driven by the URL (?tab=history|thisweek|timeoff) so it survives a
  // page refresh and is deep-linkable. Default (no/unknown param) = pending.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get('tab') as Tab | null;
  const tab: Tab = urlTab && TAB_KEYS.includes(urlTab) ? urlTab : 'pending';
  const setTab = (t: Tab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (t === 'pending') next.delete('tab'); else next.set('tab', t);
      return next;
    }, { replace: true });
  };
  const pendingTimeOff = usePendingTimeOff();
  const pendingTimeOffCount = pendingTimeOff.data?.length ?? 0;

  // Whether any direct report has a DRAFT for the CURRENT week — drives the
  // "This Week" tab's enabled state (nothing to chase once everyone submitted).
  const weekStartDay = useWeekStartDay();
  const draftsProbe = useTeamTimesheets({ status: 'DRAFT' });
  const thisWeekStart = toISODate(startOfWeek(new Date(), weekStartDay));
  const draftsExist = useMemo(() => {
    const rows = (draftsProbe.data ?? []) as TimeEntry[];
    return rows.some((e) => toISODate(startOfWeek(fromISODate(e.entry_date), weekStartDay)) === thisWeekStart);
  }, [draftsProbe.data, weekStartDay, thisWeekStart]);

  // If "This Week" disables while it's active, fall back to Pending Approvals.
  useEffect(() => {
    if (tab === 'thisweek' && !draftsExist && !draftsProbe.isLoading) setTab('pending');
  }, [tab, draftsExist, draftsProbe.isLoading]);

  const pending = usePendingApprovals();
  // Badge counts employees awaiting review (one per employee), matching the
  // Pending list (which renders one row per employee) and the "Employees
  // awaiting review" stat tile — not the raw time-entry rows underneath.
  const pendingEmployeeCount = useMemo(
    () => groupPending((pending.data ?? []) as TimeEntry[], weekStartDay).length,
    [pending.data, weekStartDay],
  );

  return (
    <div className="space-y-5">
      <WorkspaceHeader title="Approvals" description="Review timesheets from your direct reports." />

      {/* Tabs: Pending Approvals · This Week · Time Off · History */}
      <div className="flex items-center gap-1.5 border-b border-border pb-3">
        <TabPill active={tab === 'pending'} onClick={() => setTab('pending')}>
          Pending Approvals<Count active={tab === 'pending'}>{pendingEmployeeCount}</Count>
        </TabPill>
        <TabPill active={tab === 'thisweek'} onClick={() => setTab('thisweek')} disabled={!draftsExist} title={draftsExist ? undefined : 'No drafts this week — everyone has submitted'}>
          This Week
        </TabPill>
        <TabPill active={tab === 'timeoff'} onClick={() => setTab('timeoff')}>
          Time Off{pendingTimeOffCount > 0 ? <Count active={tab === 'timeoff'}>{pendingTimeOffCount}</Count> : null}
        </TabPill>
        <TabPill active={tab === 'history'} onClick={() => setTab('history')}>
          History
        </TabPill>
      </div>

      {tab === 'timeoff' ? (
        <TimeOffApprovals enabled />
      ) : (
        <ApprovalsShell tab={tab} weekStartDay={weekStartDay} />
      )}
    </div>
  );
}

// ─── Shared shell: employee table + detail pane, per-tab data/actions ─────────

function ApprovalsShell({ tab, weekStartDay }: { tab: Exclude<Tab, 'timeoff'>; weekStartDay: 0 | 1 }) {
  const qc = useQueryClient();
  const cfg = TAB_CONFIG[tab];
  const approve = useBatchApprove();
  const reject = useBatchReject();

  // Data source per tab. Pending = submitted approvals queue; This Week = team
  // drafts for the current week; History = approved team timesheets (period-
  // filtered below).
  const pending = usePendingApprovals();
  const drafts = useTeamTimesheets({ status: 'DRAFT' }, tab === 'thisweek');
  const approved = useTeamTimesheets({ status: 'APPROVED' }, tab === 'history');
  const active = tab === 'pending' ? pending : tab === 'thisweek' ? drafts : approved;

  // History period control.
  const [period, setPeriod] = useState('30');
  const [from, to] = useMemo(() => periodRange(period), [period]);

  const thisWeekStart = toISODate(startOfWeek(new Date(), weekStartDay));
  const rows = useMemo(() => {
    let r = (active.data ?? []) as TimeEntry[];
    if (tab === 'thisweek') {
      r = r.filter((e) => toISODate(startOfWeek(fromISODate(e.entry_date), weekStartDay)) === thisWeekStart);
    } else if (tab === 'history') {
      r = r.filter((e) => (!from || e.entry_date >= from) && e.entry_date <= to);
    }
    return r;
  }, [active.data, tab, weekStartDay, thisWeekStart, from, to]);

  const employees = useMemo(() => groupPending(rows, weekStartDay), [rows, weekStartDay]);

  // Stat-tile totals across the (filtered) data set for this tab.
  const stats = useMemo(() => ({
    employees: employees.length,
    weeks: employees.reduce((s, e) => s + e.weekCount, 0),
    entries: employees.reduce((s, e) => s + e.entryCount, 0),
  }), [employees]);
  const statLabels: { employees: string; weeks: string } =
    tab === 'thisweek' ? { employees: 'Employees with drafts', weeks: 'Draft weeks' }
    : tab === 'history' ? { employees: 'Employees', weeks: 'Approved weeks' }
    : { employees: 'Employees awaiting review', weeks: 'Weeks pending approval' };

  // ── Selection + navigation state ──
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [curUserId, setCurUserId] = useState<number | null>(null);
  const [viewWeekStart, setViewWeekStart] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [openDays, setOpenDays] = useState<Set<string>>(new Set());
  const [ddOpen, setDdOpen] = useState(false);
  const [bulkKeys, setBulkKeys] = useState<Set<string>>(new Set()); // `${userId}|${weekStart}`

  const PAGE_SIZE = 8;
  const filtered = useMemo(
    () => employees.filter((e) => e.name.toLowerCase().includes(search.trim().toLowerCase())),
    [employees, search],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageClamped = Math.min(page, pages - 1);
  const pageSlice = filtered.slice(pageClamped * PAGE_SIZE, (pageClamped + 1) * PAGE_SIZE);

  // Reset to a valid employee/week whenever the data changes.
  useEffect(() => {
    if (employees.length === 0) { setCurUserId(null); setViewWeekStart(null); return; }
    if (!employees.some((e) => e.userId === curUserId)) {
      setCurUserId(employees[0].userId);
      setViewWeekStart(employees[0].weeks[0]?.weekStart ?? null);
      setDetailsOpen(false);
      setOpenDays(new Set());
    }
  }, [employees, curUserId]);

  // Drop stale bulk keys after the data shrinks (post approve/reject).
  useEffect(() => {
    const valid = new Set(employees.flatMap((e) => e.weeks.map((w) => `${e.userId}|${w.weekStart}`)));
    setBulkKeys((prev) => {
      const next = new Set([...prev].filter((k) => valid.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [employees]);

  // Reset transient state on tab change.
  useEffect(() => {
    setBulkKeys(new Set());
    setDetailsOpen(false);
    setOpenDays(new Set());
    setBulkResult(null);
    setPage(0);
  }, [tab]);

  const curEmp = employees.find((e) => e.userId === curUserId);
  const curWeek = curEmp?.weeks.find((w) => w.weekStart === viewWeekStart) ?? curEmp?.weeks[0];

  // ── Approve / reject plumbing ──
  const weekByKey = useMemo(() => {
    const m = new Map<string, { emp: EmployeeGroup; week: WeekGroup }>();
    employees.forEach((emp) => emp.weeks.forEach((week) => m.set(`${emp.userId}|${week.weekStart}`, { emp, week })));
    return m;
  }, [employees]);
  const selectedEmpCount = useMemo(() => {
    const ids = new Set<number>();
    bulkKeys.forEach((k) => { const g = weekByKey.get(k); if (g) ids.add(g.emp.userId); });
    return ids.size;
  }, [bulkKeys, weekByKey]);

  const [bulkResult, setBulkResult] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectMode, setRejectMode] = useState<'reject' | 'send_back'>('reject');
  const [rejectReason, setRejectReason] = useState('');
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [bulkReason, setBulkReason] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  function flash(tone: 'ok' | 'err', text: string, ms = 6000) {
    setBulkResult({ tone, text });
    window.setTimeout(() => setBulkResult(null), ms);
  }

  // This employee's currently-checked weeks (drives the scope-based button).
  const selWeeks = useMemo(
    () => (curEmp ? curEmp.weeks.filter((w) => bulkKeys.has(`${curEmp.userId}|${w.weekStart}`)) : []),
    [curEmp, bulkKeys],
  );

  function toggleBulk(key: string) {
    setBulkKeys((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function toggleEmployeeWeeks(e: EmployeeGroup) {
    const keys = e.weeks.map((w) => `${e.userId}|${w.weekStart}`);
    const allOn = keys.every((k) => bulkKeys.has(k));
    setBulkKeys((s) => { const n = new Set(s); keys.forEach((k) => (allOn ? n.delete(k) : n.add(k))); return n; });
  }
  const allEmpIds = useMemo(() => employees.map((e) => e.userId), [employees]);
  const allEmpSelected = allEmpIds.length > 0 && allEmpIds.every((id) => {
    const e = employees.find((x) => x.userId === id)!;
    return e.weeks.every((w) => bulkKeys.has(`${id}|${w.weekStart}`));
  });
  function toggleSelectAllEmployees(on: boolean) {
    setBulkKeys(() => {
      const n = new Set<string>();
      if (on) employees.forEach((e) => e.weeks.forEach((w) => n.add(`${e.userId}|${w.weekStart}`)));
      return n;
    });
  }

  function selectEmployee(e: EmployeeGroup) {
    setCurUserId(e.userId);
    setViewWeekStart(e.weeks[0]?.weekStart ?? null);
    setDetailsOpen(false);
    setOpenDays(new Set());
  }
  // Clicking a week row in the dropdown: change the active review week, close
  // the dropdown, hide day details (so they never show under the wrong week).
  function viewWeek(weekStart: string) {
    setViewWeekStart(weekStart);
    setDetailsOpen(false);
    setOpenDays(new Set());
    setDdOpen(false);
  }
  function toggleDay(date: string) {
    setOpenDays((s) => { const n = new Set(s); n.has(date) ? n.delete(date) : n.add(date); return n; });
  }

  // Fan a multi-(employee,week) selection out into one batch call per group.
  function selectedGroups() {
    return [...bulkKeys].map((k) => weekByKey.get(k)).filter((g): g is { emp: EmployeeGroup; week: WeekGroup } => Boolean(g));
  }
  // Export the selected weeks' entries to CSV (History tab bulk action).
  function handleExport() {
    const groups = selectedGroups();
    if (groups.length === 0) return;
    const n = exportGroupsCsv(groups);
    flash('ok', `Exported ${n} ${n === 1 ? 'entry' : 'entries'} from ${selectedEmpCount} ${selectedEmpCount === 1 ? 'employee' : 'employees'}.`);
  }
  async function fanOut(run: (ids: number[]) => Promise<unknown>) {
    const groups = selectedGroups();
    const results = await Promise.allSettled(groups.map((g) => run(g.week.entryIds)));
    let ok = 0; const failed: string[] = [];
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') { ok += 1; return; }
      const d = (res.reason as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      const g = groups[i];
      failed.push(`${g.emp.name} (${shortRange(g.week.label)})${typeof d === 'string' ? ` — ${d}` : ''}`);
    });
    qc.invalidateQueries({ queryKey: ['approvals'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    return { ok, failed, total: groups.length };
  }

  // Approve the active week (0 selected) or every selected week of this employee.
  async function handleApprove() {
    if (!curEmp) return;
    const weeks: WeekGroup[] = selWeeks.length > 0 ? selWeeks : curWeek ? [curWeek] : [];
    if (weeks.length === 0) return;
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const results = await Promise.allSettled(weeks.map((w) => approve.mutateAsync(w.entryIds)));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length === 0) flash('ok', `Approved ${ok} ${ok === 1 ? 'week' : 'weeks'} for ${curEmp.name}.`);
      else flash('err', `Approved ${ok} of ${weeks.length}. Some weeks could not be approved.`, 8000);
      setBulkKeys((s) => { const n = new Set(s); weeks.forEach((w) => n.delete(`${curEmp.userId}|${w.weekStart}`)); return n; });
    } finally {
      setBulkBusy(false);
    }
  }
  function openReject(mode: 'reject' | 'send_back') { setRejectMode(mode); setRejectReason(''); setRejectOpen(true); }
  async function handleReject() {
    const ids = curWeek?.entryIds;
    if (!ids || ids.length === 0 || !rejectReason.trim() || !curEmp) return;
    const verb = rejectMode === 'send_back' ? 'Sent back' : 'Rejected';
    try {
      await reject.mutateAsync({ entryIds: ids, reason: rejectReason.trim() });
      flash('ok', `${verb} ${curEmp.name}'s week (${shortRange(curWeek!.label)}).`);
    } catch (err) {
      const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      flash('err', typeof d === 'string' ? d : `Could not ${rejectMode === 'send_back' ? 'send back' : 'reject'}.`, 8000);
    }
    setRejectOpen(false);
    setRejectReason('');
  }
  async function handleBulkApprove() {
    if (bulkKeys.size === 0) return;
    setBulkBusy(true);
    const r = await fanOut((ids) => approvalsApi.batchApprove(ids));
    if (r.failed.length === 0) flash('ok', `Approved ${r.ok} ${r.ok === 1 ? 'week' : 'weeks'}.`);
    else flash('err', `Approved ${r.ok} of ${r.total}. Failed: ${r.failed.join('; ')}`, 9000);
    setBulkKeys(new Set());
    setBulkBusy(false);
  }
  async function handleBulkReject() {
    if (bulkKeys.size === 0 || !bulkReason.trim()) return;
    const reason = bulkReason.trim();
    setBulkBusy(true);
    const r = await fanOut((ids) => approvalsApi.batchReject(ids, reason));
    if (r.failed.length === 0) flash('ok', `Rejected ${r.ok} ${r.ok === 1 ? 'week' : 'weeks'}.`);
    else flash('err', `Rejected ${r.ok} of ${r.total}. Failed: ${r.failed.join('; ')}`, 9000);
    setBulkRejectOpen(false);
    setBulkReason('');
    setBulkKeys(new Set());
    setBulkBusy(false);
  }

  // The top bulk bar appears only when 2+ EMPLOYEES are selected.
  // Top bulk bar only when this tab HAS a bulk action and 2+ employees selected.
  const showTopBar = cfg.bulkAction && selectedEmpCount >= 2;
  const nWeeks = bulkKeys.size;
  const multiEmp = selectedEmpCount > 1;

  if (active.isLoading) {
    return (
      <Card className="overflow-hidden p-0">
        <TableSkeleton rows={6} cols={5} />
      </Card>
    );
  }
  if (active.isError) {
    return <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">Couldn't load. Try refreshing.</Card>;
  }

  return (
    <div className="space-y-4">
      {/* History-only period control */}
      {tab === 'history' ? (
        <Card className="flex flex-wrap items-center gap-2.5 p-3">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Period</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value)} className="h-9 rounded-full border border-border bg-transparent px-4 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20">
            {PERIOD_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
          <span className="ml-auto text-xs text-muted-foreground">{PERIOD_OPTIONS.find((o) => o.v === period)?.label}</span>
        </Card>
      ) : null}

      {/* Stat tiles — compact single-line (icon · value · label) */}
      {employees.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <MiniStat Icon={Flag} tone="rose" value={stats.employees} label={statLabels.employees} />
          <MiniStat Icon={Clock} tone="amber" value={stats.weeks} label={statLabels.weeks} />
          <MiniStat Icon={Layers} tone="violet" value={stats.entries} label="Entries" />
        </div>
      ) : null}

      {/* Top bulk bar — buttons LEFT, summary RIGHT. Only at 2+ employees. */}
      {showTopBar ? (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-primary bg-gradient-to-r from-primary/[0.18] to-primary/[0.08] px-4 py-3 shadow-[0_6px_24px_hsl(var(--primary)/0.18)]">
          <div className="flex items-center gap-2.5">
            <button type="button" onClick={() => setBulkKeys(new Set())} aria-label="Clear selection" className="grid h-7 w-7 place-items-center rounded-full border border-border hover:bg-foreground/10"><X className="h-4 w-4" /></button>
            <Button size="sm" onClick={() => (tab === 'pending' ? void handleBulkApprove() : handleExport())} disabled={bulkBusy}>
              {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{cfg.bulkApprove}
            </Button>
            {cfg.bulkReject ? (
              <Button size="sm" variant="secondary" className="border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-500/30 dark:hover:bg-rose-500/10" onClick={() => setBulkRejectOpen(true)} disabled={bulkBusy}>{cfg.bulkReject}</Button>
            ) : null}
          </div>
          <span className="ml-auto text-right text-sm font-medium">
            {tab === 'pending'
              ? <><strong className="text-primary">{selectedEmpCount}</strong> {selectedEmpCount === 1 ? 'employee' : 'employees'} selected with <strong className="text-primary">{nWeeks}</strong> {nWeeks === 1 ? 'week' : 'weeks'} pending approvals</>
              : <><strong className="text-primary">{selectedEmpCount}</strong> {selectedEmpCount === 1 ? 'employee' : 'employees'} selected</>}
          </span>
        </div>
      ) : null}

      {/* Action result confirmation (success or per-week failure list). */}
      {bulkResult ? (
        <Toast tone={bulkResult.tone} message={bulkResult.text} onDismiss={() => setBulkResult(null)} />
      ) : null}

      {employees.length === 0 ? (
        <Empty Icon={CheckCircle2} title={tab === 'pending' ? 'All caught up' : 'Nothing here'} description={tab === 'pending' ? 'No timesheets are waiting for your approval.' : tab === 'thisweek' ? 'No drafts from your team this week.' : 'No approved timesheets in this period.'} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
          {/* LEFT: employee table (search + checkbox + name/hours/weeks + pager) */}
          <div className="space-y-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" placeholder="Search employees..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
            </div>
            {/* Select-all — only on tabs with a bulk action (Pending, History).
                This Week is review-only, so no selection UI. */}
            {cfg.bulkAction ? (
              <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2 text-[13px] font-semibold">
                <input type="checkbox" checked={allEmpSelected} onChange={(e) => toggleSelectAllEmployees(e.target.checked)} className="h-4 w-4 accent-[hsl(var(--primary))]" />
                <span>Select all</span>
                {selectedEmpCount > 0 ? <span className="ml-auto text-xs text-primary">{selectedEmpCount} of {allEmpIds.length} selected</span> : null}
              </label>
            ) : null}
            <div className="overflow-hidden rounded-2xl border border-border bg-card">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-muted/25 text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                    {cfg.bulkAction ? <th className="w-8 py-2.5 pl-3" /> : null}
                    <th className="py-2.5 pl-3 text-left font-semibold">Employee</th>
                    <th className="py-2.5 pr-3 text-right font-semibold">Hours</th>
                    <th className="py-2.5 pr-3 text-right font-semibold">Weeks</th>
                  </tr>
                </thead>
                <tbody>
                  {pageSlice.map((e) => {
                    const isActive = e.userId === curUserId;
                    const empOn = e.weeks.every((w) => bulkKeys.has(`${e.userId}|${w.weekStart}`));
                    return (
                      <tr key={e.userId} onClick={() => selectEmployee(e)} className={cn('cursor-pointer border-b border-border/50 last:border-0 hover:bg-primary/[0.06]', isActive && 'bg-primary/[0.1] shadow-[inset_3px_0_0_hsl(var(--primary))]')}>
                        {cfg.bulkAction ? (
                          <td className="py-2.5 pl-3" onClick={(ev) => ev.stopPropagation()}>
                            <input type="checkbox" checked={empOn} onChange={() => toggleEmployeeWeeks(e)} className="h-3.5 w-3.5 accent-[hsl(var(--primary))]" />
                          </td>
                        ) : null}
                        <td className="py-2.5 pl-3">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <Avatar name={e.name} active={isActive} small />
                            <span className="truncate font-medium text-foreground">{e.name}</span>
                          </div>
                        </td>
                        <td className="py-2.5 pr-3 text-right tabular-nums">{fmtH(e.hours)}h</td>
                        <td className="py-2.5 pr-3 text-right tabular-nums">{e.weekCount}</td>
                      </tr>
                    );
                  })}
                  {pageSlice.length === 0 ? (
                    <tr><td colSpan={cfg.bulkAction ? 4 : 3} className="px-3 py-6 text-center text-muted-foreground">No employees match "{search}".</td></tr>
                  ) : null}
                </tbody>
              </table>
              {filtered.length > 0 ? (
                <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
                  <span>{pageClamped * PAGE_SIZE + 1}–{Math.min(filtered.length, (pageClamped + 1) * PAGE_SIZE)} of {filtered.length}</span>
                  <div className="flex gap-1.5">
                    <PagerBtn disabled={pageClamped === 0} onClick={() => setPage(pageClamped - 1)}>‹</PagerBtn>
                    {Array.from({ length: pages }, (_, i) => (
                      <PagerBtn key={i} cur={i === pageClamped} onClick={() => setPage(i)}>{i + 1}</PagerBtn>
                    ))}
                    <PagerBtn disabled={pageClamped >= pages - 1} onClick={() => setPage(pageClamped + 1)}>›</PagerBtn>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* RIGHT: detail pane */}
          <div>
            {curEmp && curWeek ? (
              <Card className="space-y-3.5 p-4">
                {/* Employee header */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={curEmp.name} active />
                    <div>
                      <p className="text-sm font-semibold text-foreground">{curEmp.name}</p>
                      <p className="text-xs text-muted-foreground">{curWeek.label}</p>
                    </div>
                  </div>
                  <StatusBadge status={cfg.badgeStatus} variant="timesheet" label={cfg.detailBadge} showIcon={false} />
                </div>

                {/* Weeks dropdown */}
                {curEmp.weeks.length > 0 ? (
                  <div className="relative">
                    <button type="button" onClick={() => setDdOpen((v) => !v)} className="flex w-full items-center gap-2 rounded-xl border border-border bg-muted/40 px-3.5 py-2.5 text-[13px] text-foreground transition-colors hover:border-primary/40">
                      <span>{tab === 'pending' ? 'Select pending weeks' : 'Select weeks'}</span>
                      {cfg.bulkAction ? (
                        <span className="rounded-full bg-primary/[0.18] px-2.5 py-0.5 text-[11px] text-primary">{selWeeks.length ? `${selWeeks.length} selected` : 'none selected'}</span>
                      ) : null}
                      <ChevronDown className={cn('ml-auto h-4 w-4 text-muted-foreground transition-transform', ddOpen && 'rotate-180')} />
                    </button>
                    <p className="mt-1.5 pl-0.5 text-xs text-muted-foreground">{cfg.bulkAction ? (tab === 'pending' ? 'Select weeks for approval or choose one to review' : 'Select weeks to export, or choose one to review') : 'Choose a week to review'}</p>
                    {ddOpen ? (
                      <>
                        <div className="fixed inset-0 z-20" onClick={() => setDdOpen(false)} />
                        <div className="absolute left-0 right-0 z-30 mt-1.5 rounded-2xl border border-border bg-card p-1.5 shadow-2xl">
                          {cfg.bulkAction && curEmp.weeks.length > 1 ? (
                            <>
                              <label className="flex cursor-pointer items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-[13px] font-semibold hover:bg-primary/[0.08]" onClick={(e) => e.stopPropagation()}>
                                <input type="checkbox" checked={curEmp.weeks.every((w) => bulkKeys.has(`${curEmp.userId}|${w.weekStart}`))} onChange={() => toggleEmployeeWeeks(curEmp)} className="h-3.5 w-3.5 accent-[hsl(var(--primary))]" />
                                <span>Select all {curEmp.weeks.length} weeks</span>
                              </label>
                              <div className="mx-0.5 my-1 h-px bg-border" />
                            </>
                          ) : null}
                          {curEmp.weeks.map((w) => {
                            const isCur = w.weekStart === curWeek.weekStart;
                            const isChk = bulkKeys.has(`${curEmp.userId}|${w.weekStart}`);
                            return (
                              <div key={w.weekStart} onClick={() => viewWeek(w.weekStart)} className={cn('group flex cursor-pointer items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-[13px] hover:bg-primary/[0.08]', isCur && 'bg-primary/[0.12]')}>
                                {cfg.bulkAction ? (
                                  <input type="checkbox" checked={isChk} onClick={(e) => e.stopPropagation()} onChange={() => toggleBulk(`${curEmp.userId}|${w.weekStart}`)} className="h-3.5 w-3.5 accent-[hsl(var(--primary))]" />
                                ) : null}
                                <span className="flex-1">{w.label}</span>
                                <span className="tabular-nums text-xs text-muted-foreground">{fmtH(w.hours)}h</span>
                                {isCur ? (
                                  <span className="rounded-full bg-primary/[0.16] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.04em] text-primary">Currently reviewing</span>
                                ) : (
                                  <span className="rounded-full border border-primary/35 px-3 py-1 text-[11px] font-semibold text-primary opacity-70 transition group-hover:bg-primary/[0.12] group-hover:opacity-100">View</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : null}

                {/* Current review week card — the WHOLE card toggles day details. */}
                <button
                  type="button"
                  onClick={() => { setDetailsOpen((v) => !v); setOpenDays(new Set()); }}
                  aria-expanded={detailsOpen}
                  className="w-full rounded-[15px] border border-primary/[0.28] bg-primary/[0.05] px-4 py-3.5 text-left transition-colors hover:bg-primary/[0.09]"
                >
                  <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.07em] text-primary">Current review week</p>
                  <div className="flex items-center gap-3.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-[17px] font-bold leading-tight text-foreground">{curWeek.label}</p>
                      <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                        <strong className="text-foreground">{curWeek.entryCount} {curWeek.entryCount === 1 ? 'entry' : 'entries'}</strong> · {curWeek.days.length} {curWeek.days.length === 1 ? 'day' : 'days'} · <strong className="text-foreground">Total {fmtH(curWeek.hours)} hours</strong>
                      </p>
                    </div>
                    <ChevronDown className={cn('h-5 w-5 shrink-0 text-primary transition-transform', detailsOpen && 'rotate-180')} aria-hidden />
                  </div>
                </button>

                {/* Day details — hidden until "View day details" */}
                {detailsOpen ? (
                  <div className="rounded-[15px] border border-border bg-muted/[0.18] p-3.5">
                    <p className="mb-2.5 text-[13px] font-bold text-foreground">Day details</p>
                    <div className="space-y-2">
                      {curWeek.days.map((day) => {
                        const open = openDays.has(day.date);
                        return (
                          <div key={day.date} className="rounded-xl border border-border">
                            <button type="button" onClick={() => toggleDay(day.date)} aria-expanded={open} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-primary/5">
                              {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                              <span className="flex-1 text-sm font-medium text-foreground">{formatDayLabel(day.date)}</span>
                              <span className="text-xs text-muted-foreground">{day.entries.length} {day.entries.length === 1 ? 'entry' : 'entries'}</span>
                              <span className="text-sm font-medium tabular-nums text-foreground">{fmtH(day.hours)}h</span>
                            </button>
                            {open ? (
                              <div className="space-y-1.5 px-3 pb-3">
                                {day.entries.map((entry) => (
                                  <div key={entry.id} className="flex items-start gap-3 rounded-lg bg-muted/30 px-2.5 py-1.5">
                                    <div className="w-24 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                                      {entry.start_time || entry.end_time ? (<>{fmt12(entry.start_time)}<br />{fmt12(entry.end_time)}</>) : <span className="opacity-60">no time</span>}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <p className="truncate text-xs font-medium text-foreground">
                                        {entry.project?.name ?? `Project #${entry.project_id}`}
                                        {!entry.is_billable ? <span className="text-muted-foreground"> · Non-billable</span> : null}
                                      </p>
                                      {entry.description ? <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{entry.description}</p> : null}
                                    </div>
                                    <p className="shrink-0 text-xs font-semibold tabular-nums text-foreground">{fmtH(typeof entry.hours === 'string' ? parseFloat(entry.hours) : entry.hours)}h</p>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                {/* Actions */}
                {cfg.showWeekActions && !multiEmp ? (
                  <div className="flex gap-2 pt-1">
                    <Button className="flex-1" onClick={() => void handleApprove()} disabled={bulkBusy || approve.isPending}>
                      {approve.isPending || bulkBusy ? <><Loader2 className="h-4 w-4 animate-spin" /> Approving…</> : approveLabel(selWeeks, curWeek.label)}
                    </Button>
                    <Button variant="secondary" className="border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-500/30 dark:text-amber-300 dark:hover:bg-amber-500/10" onClick={() => openReject('send_back')} disabled={reject.isPending}>
                      <CornerUpLeft className="h-4 w-4" /> Send back
                    </Button>
                    <Button variant="secondary" className="border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:border-rose-500/30 dark:hover:bg-rose-500/10" onClick={() => openReject('reject')} disabled={reject.isPending}>
                      Reject
                    </Button>
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-border px-3.5 py-3 text-center text-[13px] text-muted-foreground">
                    {multiEmp
                      ? <>Multiple employees selected. Use <strong className="text-foreground">{cfg.bulkApprove}</strong> at the top. This pane is read-only while reviewing.</>
                      : tab === 'thisweek'
                      ? <>Draft timesheet — <strong className="text-foreground">not submitted</strong>, so there's nothing to approve.</>
                      : <>Approved timesheet — read-only.</>}
                  </div>
                )}
              </Card>
            ) : (
              <Card className="grid place-items-center py-16 text-sm text-muted-foreground">Select an employee to review their week.</Card>
            )}
          </div>
        </div>
      )}

      {/* Single-week reject / send-back modal */}
      <Modal open={rejectOpen} onClose={() => setRejectOpen(false)} title={`${rejectMode === 'send_back' ? 'Send back' : 'Reject'} ${curEmp?.name ?? ''}'s week`}>
        <RejectBody name={curEmp?.name} reason={rejectReason} setReason={setRejectReason} pending={reject.isPending} mode={rejectMode} onCancel={() => setRejectOpen(false)} onConfirm={() => void handleReject()} />
      </Modal>

      {/* Bulk reject modal */}
      <Modal open={bulkRejectOpen} onClose={() => setBulkRejectOpen(false)} title={`Reject ${nWeeks} selected week${nWeeks === 1 ? '' : 's'}`}>
        <RejectBody name={undefined} reason={bulkReason} setReason={setBulkReason} pending={bulkBusy} onCancel={() => setBulkRejectOpen(false)} onConfirm={() => void handleBulkReject()} />
      </Modal>
    </div>
  );
}

// Approve-button label per the selection scope:
//   0 selected → the active week, with its period: "Approve Week (Jun 7 – Jun 13)"
//   1 selected → that selected week's period (same shape)
//   2+ selected → plain "Approve"
function approveLabel(selectedWeeks: WeekGroup[], activeLabel: string): string {
  if (selectedWeeks.length >= 2) return 'Approve';
  const label = selectedWeeks.length === 1 ? selectedWeeks[0].label : activeLabel;
  return `Approve Week (${shortRange(label)})`;
}

const num = (v: string | number) => (typeof v === 'string' ? parseFloat(v) : v) || 0;
const csvEsc = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;

// Build + download a CSV of the given (employee, week) groups, ONE ROW PER
// ENTRY so a day split across multiple entries exports each line separately.
// Columns carry the approved-timesheet detail: employee, week, date, project,
// description, billable, start/end, hours, status, and approver/approved-on.
function exportGroupsCsv(groups: Array<{ emp: EmployeeGroup; week: WeekGroup }>) {
  const header = [
    'Employee', 'Week', 'Date', 'Project', 'Task',
    'Description', 'Billable', 'Start', 'End', 'Hours',
    'Status', 'Approved by', 'Approved on',
  ];
  const lines: string[] = [];
  for (const { emp, week } of groups) {
    for (const day of week.days) {
      for (const e of day.entries) {
        lines.push([
          emp.name,
          shortRange(week.label),
          e.entry_date,
          e.project?.name ?? `Project #${e.project_id}`,
          e.task_id ? `Task #${e.task_id}` : '',
          e.description ?? '',
          e.is_billable ? 'yes' : 'no',
          e.start_time ?? '',
          e.end_time ?? '',
          String(num(e.hours)),
          (e.status ?? '').toString(),
          e.approved_by_name ?? '',
          e.approved_at ? e.approved_at.slice(0, 10) : '',
        ].map((c) => csvEsc(String(c))).join(','));
      }
    }
  }
  const csv = [header.map(csvEsc).join(','), ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'approved-timesheets.csv'; a.click();
  URL.revokeObjectURL(url);
  return lines.length;
}

function formatDayLabel(date: string): string {
  return fromISODate(date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

function PagerBtn({ children, cur, disabled, onClick }: { children: React.ReactNode; cur?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={cn('grid h-7 w-7 place-items-center rounded-lg border border-border text-[13px] transition disabled:opacity-35', cur ? 'border-primary bg-primary font-semibold text-primary-foreground' : 'text-foreground hover:bg-primary/10')}>
      {children}
    </button>
  );
}

// Compact single-line stat: tinted icon · big value · label, all on one row.
const MINI_TONES: Record<'rose' | 'amber' | 'violet', string> = {
  rose: 'bg-rose-500/15 text-rose-600 dark:text-rose-300',
  amber: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  violet: 'bg-violet-500/15 text-violet-600 dark:text-violet-300',
};
function MiniStat({ Icon, tone, value, label }: { Icon: typeof Flag; tone: 'rose' | 'amber' | 'violet'; value: number; label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3">
      <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl', MINI_TONES[tone])}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="text-2xl font-semibold tabular-nums leading-none text-foreground">{value}</span>
      <span className="text-[13px] text-muted-foreground">{label}</span>
    </div>
  );
}

function RejectBody({
  name, reason, setReason, pending, mode = 'reject', onCancel, onConfirm,
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
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus placeholder="e.g. Wednesday's hours look high — please confirm." className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant={sendBack ? 'primary' : 'destructive'} onClick={onConfirm} disabled={!reason.trim() || pending}>
          {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> {sendBack ? 'Sending…' : 'Rejecting…'}</> : (sendBack ? 'Send back' : 'Reject')}
        </Button>
      </div>
    </div>
  );
}

function TabPill({ active, onClick, children, disabled, title }: { active: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={cn('pill text-sm', active ? 'pill-active' : 'pill-idle', disabled && 'cursor-not-allowed opacity-40')}>
      {children}
    </button>
  );
}

function Count({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <span className={cn('ml-1 rounded-full px-1.5 text-[10px]', active ? 'bg-white/20' : 'bg-muted')}>{children}</span>;
}

function Avatar({ name, active, small }: { name: string; active?: boolean; small?: boolean }) {
  return (
    <span className={cn('grid shrink-0 place-items-center rounded-full font-semibold', small ? 'h-7 w-7 text-[10px]' : 'h-8 w-8 text-xs ring-2 ring-card', active ? 'bg-primary text-primary-foreground' : 'bg-violet-500/15 text-violet-600 dark:text-violet-300')}>
      {initials(name)}
    </span>
  );
}
