/* eslint-disable react-hooks/exhaustive-deps */
import React, { useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import {
  Check,
  ChevronDown,
  ChevronRight,
  CornerUpLeft,
  Search,
  Users,
  X,
} from 'lucide-react';

import { ExpandableDescription } from '@/components';
import {
  useApproveTimeEntryBatch,
  usePendingApprovals,
  useRejectTimeEntryBatch,
  useWeekStartsOn,
} from '@/hooks';
import {
  computeStatTiles,
  groupPendingByEmployee,
  groupWeekByDay,
  type EmployeeBucket,
  type WeekBucket,
} from '@/utils/approvalsGrouping';
import { formatTimeBlock } from '@/utils/timeFormat';
import type { TimeEntry } from '@/types';

/**
 * D-061 master-detail body for the Pending Approvals tab.
 *
 * Layout: 3-tile stat strip + filter bar + two-column body
 * (employee list | detail pane) at ``lg+``, single-column with a
 * back-button below ``lg``. Selection is scoped to the active
 * employee so the backend's weekly-batch validation never sees a
 * cross-employee batch.
 */

type PendingAction = 'approve' | 'send_back' | 'reject';

export const PendingMasterDetail: React.FC = () => {
  const weekStartsOn = useWeekStartsOn();
  const { data: pendingEntries = [], isLoading } = usePendingApprovals({});
  const approveBatch = useApproveTimeEntryBatch();
  const rejectBatch = useRejectTimeEntryBatch();

  // ── Filter state ─────────────────────────────────────────────
  const [search, setSearch] = useState('');

  // ── Derived buckets ──────────────────────────────────────────
  const buckets = useMemo(
    () => groupPendingByEmployee(pendingEntries as TimeEntry[], weekStartsOn === 1 ? 1 : 0),
    [pendingEntries, weekStartsOn],
  );
  const stats = useMemo(() => computeStatTiles(buckets), [buckets]);
  const filteredBuckets = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return buckets;
    return buckets.filter((b) => b.employeeName.toLowerCase().includes(needle));
  }, [buckets, search]);

  // ── Selection state ──────────────────────────────────────────
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  const [selectedWeekStart, setSelectedWeekStart] = useState<string | null>(null);
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<number>>(new Set());
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [comment, setComment] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Pick the first bucket as the default selection so the page never
  // boots with a blank detail pane.
  React.useEffect(() => {
    if (selectedEmployeeId === null && filteredBuckets.length > 0) {
      setSelectedEmployeeId(filteredBuckets[0].employeeId);
    }
  }, [filteredBuckets.length]);

  const activeBucket: EmployeeBucket | null = useMemo(() => {
    if (selectedEmployeeId === null) return null;
    return filteredBuckets.find((b) => b.employeeId === selectedEmployeeId) ?? null;
  }, [filteredBuckets, selectedEmployeeId]);

  React.useEffect(() => {
    // Reset selected week when employee changes.
    if (activeBucket) {
      if (!selectedWeekStart || !activeBucket.weeks.find((w) => w.weekStart === selectedWeekStart)) {
        setSelectedWeekStart(activeBucket.weeks[0]?.weekStart ?? null);
      }
    } else {
      setSelectedWeekStart(null);
    }
    // Reset selection + comment when switching employee.
    setSelectedEntryIds(new Set());
    setPendingAction(null);
    setComment('');
    setErrorMessage(null);
  }, [selectedEmployeeId]);

  const activeWeek: WeekBucket | null = useMemo(() => {
    if (!activeBucket || !selectedWeekStart) return null;
    return activeBucket.weeks.find((w) => w.weekStart === selectedWeekStart) ?? null;
  }, [activeBucket, selectedWeekStart]);

  const dayBuckets = useMemo(
    () => (activeWeek ? groupWeekByDay(activeWeek.entries) : []),
    [activeWeek],
  );

  // Track which day groups are expanded (default: the first day).
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  React.useEffect(() => {
    setExpandedDays(new Set(dayBuckets[0] ? [dayBuckets[0].date] : []));
  }, [activeWeek?.weekStart]);

  const toggleDay = (date: string) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  const toggleEntry = (id: number) => {
    setSelectedEntryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllInWeek = () => {
    if (!activeWeek) return;
    const allIds = activeWeek.entries.map((e) => e.id);
    setSelectedEntryIds((prev) => {
      const allSelected = allIds.every((id) => prev.has(id));
      return allSelected ? new Set() : new Set(allIds);
    });
  };

  // ── Action handlers ──────────────────────────────────────────
  const submitAction = async () => {
    if (!pendingAction) return;
    setErrorMessage(null);
    const entryIds = Array.from(selectedEntryIds);
    if (entryIds.length === 0) {
      setErrorMessage('Pick at least one entry first.');
      return;
    }
    if ((pendingAction === 'send_back' || pendingAction === 'reject') && !comment.trim()) {
      setErrorMessage('Comment is required for Send back and Reject.');
      return;
    }

    try {
      if (pendingAction === 'approve') {
        await approveBatch.mutateAsync(entryIds);
      } else {
        await rejectBatch.mutateAsync({ entryIds, reason: comment.trim() });
      }
      // Reset everything after a successful action.
      setSelectedEntryIds(new Set());
      setPendingAction(null);
      setComment('');
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? 'Action failed. Try again.';
      setErrorMessage(detail);
    }
  };

  // ── Render ───────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        Loading pending approvals…
      </div>
    );
  }

  if (buckets.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-10 text-center">
        <Check className="w-8 h-8 mx-auto text-emerald-500 mb-3" />
        <p className="text-sm font-medium">All caught up.</p>
        <p className="text-xs text-muted-foreground mt-1">
          No timesheets are awaiting your review right now.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Stat strip — 3 tiles, no Hours */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatTile
          accent="rose"
          icon={<Users className="w-5 h-5" />}
          label="Employees awaiting review"
          value={stats.employees}
          sublabel={`of ${stats.employees} in your team`}
        />
        <StatTile
          accent="amber"
          icon={<span className="text-lg leading-none">📅</span>}
          label="Weeks pending"
          value={stats.weeks}
          sublabel="Across all employees"
        />
        <StatTile
          accent="blue"
          icon={<span className="text-lg leading-none">📋</span>}
          label="Entries"
          value={stats.entries}
          sublabel="Across all weeks"
        />
      </div>

      {/* Filter bar (minimal — just search for now; other dropdowns
          coming in a follow-up) */}
      <div className="rounded-xl border border-border bg-card p-3 flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employees..."
            className="w-full rounded-lg border border-border bg-background pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {/* Two-column body */}
      <div className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
        {/* Left: employee list */}
        <div className={`rounded-xl border border-border bg-card overflow-hidden ${activeBucket && 'hidden lg:block'} ${!activeBucket && 'block'}`.replace(/\s+/g, ' ').trim()}>
          <div className="px-4 py-3 border-b border-border text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Employees ({filteredBuckets.length})
          </div>
          <div className="max-h-[640px] overflow-y-auto">
            {filteredBuckets.map((b) => {
              const isActive = b.employeeId === selectedEmployeeId;
              return (
                <button
                  key={b.employeeId}
                  type="button"
                  onClick={() => setSelectedEmployeeId(b.employeeId)}
                  className={`w-full text-left grid grid-cols-[40px_1fr_auto] gap-3 items-center px-4 py-3 border-b border-border transition-colors ${
                    isActive
                      ? 'bg-rose-500/10 border-l-[3px] border-l-rose-500 pl-[13px]'
                      : 'hover:bg-muted/40'
                  }`}
                >
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-slate-600 to-slate-800 text-white inline-flex items-center justify-center text-sm font-bold">
                    {initials(b.employeeName)}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">{b.employeeName}</div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                      <span><strong className="text-foreground">{b.totals.entries}</strong> entries</span>
                      <span><strong className="text-foreground">{b.totals.hours.toFixed(2)}h</strong></span>
                      {b.totals.weeks > 1 && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-500 border border-violet-500/20 text-[10px] font-semibold">
                          +{b.totals.weeks - 1} {b.totals.weeks - 1 === 1 ? 'week' : 'weeks'}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 text-[10px] font-bold uppercase tracking-wide">
                    Awaiting
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right: detail pane */}
        <div className={`rounded-xl border border-border bg-card p-5 ${!activeBucket && 'hidden lg:block'}`}>
          {!activeBucket ? (
            <p className="text-sm text-muted-foreground text-center py-12">
              Pick an employee from the left to review their submitted timesheets.
            </p>
          ) : (
            <>
              {/* Mobile back-link */}
              <button
                type="button"
                onClick={() => setSelectedEmployeeId(null)}
                className="lg:hidden inline-flex items-center gap-1 text-xs text-primary mb-3"
              >
                ← Back to employees
              </button>

              {/* Header */}
              <div className="flex items-start justify-between gap-4 pb-4 border-b border-border mb-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-slate-600 to-slate-800 text-white inline-flex items-center justify-center text-base font-bold">
                    {initials(activeBucket.employeeName)}
                  </div>
                  <div>
                    <div className="text-lg font-semibold">{activeBucket.employeeName}</div>
                    {activeWeek && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {format(parseISO(activeWeek.weekStart), 'MMM d')} – {format(parseISO(activeWeek.weekEnd), 'MMM d, yyyy')}
                      </div>
                    )}
                    {activeBucket.oldestSubmittedAt && (
                      <div className="text-[11px] text-muted-foreground mt-1">
                        Oldest submission: {format(parseISO(activeBucket.oldestSubmittedAt), 'MMM d, yyyy h:mm a')}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-start gap-6 text-right">
                  <Stat label="Entries" value={String(activeWeek?.totals.entries ?? 0)} />
                  <Stat label="Hours" value={(activeWeek?.totals.hours ?? 0).toFixed(2)} />
                  <Stat
                    label="Status"
                    valueNode={
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 text-[10px] font-bold uppercase tracking-wide">
                        Awaiting review
                      </span>
                    }
                  />
                </div>
              </div>

              {/* Week switcher (multi-week) */}
              {activeBucket.weeks.length > 1 && (
                <div className="flex flex-wrap gap-2 mb-4">
                  {activeBucket.weeks.map((w) => {
                    const isActive = w.weekStart === selectedWeekStart;
                    return (
                      <button
                        key={w.weekStart}
                        type="button"
                        onClick={() => setSelectedWeekStart(w.weekStart)}
                        className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                          isActive
                            ? 'bg-primary/10 text-primary border-primary'
                            : 'bg-muted/40 text-muted-foreground border-border hover:border-foreground/30'
                        }`}
                      >
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 mr-2" />
                        {format(parseISO(w.weekStart), 'MMM d')} – {format(parseISO(w.weekEnd), 'MMM d, yyyy')}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Summary line */}
              {activeWeek && (
                <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 mb-3 text-sm">
                  <strong>{activeWeek.totals.entries} entries</strong> across{' '}
                  <strong>{dayBuckets.length} days</strong>. Total{' '}
                  <strong>{activeWeek.totals.hours.toFixed(2)} hours</strong> for this week.
                </div>
              )}

              {/* Select all — left-aligned at the same x as each day's
                  checkbox below (px-4 + 22px grid column ≈ matches the
                  outer day-card padding). */}
              {activeWeek && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground mb-2 px-4 cursor-pointer w-fit">
                  <input
                    type="checkbox"
                    className="w-4 h-4 rounded border-border accent-primary"
                    checked={
                      activeWeek.entries.length > 0 &&
                      activeWeek.entries.every((e) => selectedEntryIds.has(e.id))
                    }
                    onChange={toggleAllInWeek}
                  />
                  <span>Select all</span>
                </label>
              )}

              {/* Day groups */}
              <div className="space-y-2">
                {dayBuckets.map((day) => {
                  const isExpanded = expandedDays.has(day.date);
                  const checkedCount = day.entries.filter((e) => selectedEntryIds.has(e.id)).length;
                  const dayCheckState: 'none' | 'partial' | 'all' =
                    checkedCount === 0 ? 'none' : checkedCount === day.entries.length ? 'all' : 'partial';
                  return (
                    <div key={day.date} className="rounded-xl border border-border bg-muted/20 overflow-hidden">
                      <div className="grid grid-cols-[22px_1fr_auto_28px] gap-3 items-center px-4 py-3">
                        <input
                          type="checkbox"
                          className="w-4 h-4 rounded border-border accent-primary"
                          checked={dayCheckState === 'all'}
                          ref={(el) => {
                            if (el) el.indeterminate = dayCheckState === 'partial';
                          }}
                          onChange={() => {
                            const allIds = day.entries.map((e) => e.id);
                            setSelectedEntryIds((prev) => {
                              const next = new Set(prev);
                              if (dayCheckState === 'all') {
                                allIds.forEach((id) => next.delete(id));
                              } else {
                                allIds.forEach((id) => next.add(id));
                              }
                              return next;
                            });
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => toggleDay(day.date)}
                          className="text-left flex items-center gap-2 min-w-0"
                        >
                          <div>
                            <div className="text-sm font-semibold">
                              {format(parseISO(day.date), 'EEEE, MMM d, yyyy')}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {day.totals.entries} entries · {day.totals.hours.toFixed(2)} hours
                            </div>
                          </div>
                        </button>
                        <span className="text-sm font-semibold tabular-nums">{day.totals.hours.toFixed(2)}h</span>
                        <button
                          type="button"
                          onClick={() => toggleDay(day.date)}
                          className="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground"
                          aria-label={isExpanded ? 'Collapse' : 'Expand'}
                        >
                          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                      </div>
                      {isExpanded && (
                        <div className="px-4 pb-4">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                                <th className="py-2 w-6"></th>
                                <th className="py-2">Start</th>
                                <th className="py-2">End</th>
                                <th className="py-2">Project / Task</th>
                                <th className="py-2 text-right">Hours</th>
                                <th className="py-2">Description</th>
                              </tr>
                            </thead>
                            <tbody>
                              {day.entries.map((entry) => {
                                const block = formatTimeBlock(entry.start_time, entry.end_time);
                                const [start, end] = block ? block.split(' – ') : [null, null];
                                return (
                                  <tr key={entry.id} className="border-b border-border last:border-b-0 align-top">
                                    <td className="py-2 pr-2">
                                      <input
                                        type="checkbox"
                                        className="w-4 h-4 rounded border-border accent-primary"
                                        checked={selectedEntryIds.has(entry.id)}
                                        onChange={() => toggleEntry(entry.id)}
                                      />
                                    </td>
                                    <td className="py-2 text-xs text-muted-foreground">{start ?? 'N/A'}</td>
                                    <td className="py-2 text-xs text-muted-foreground">{end ?? 'N/A'}</td>
                                    <td className="py-2 text-xs">
                                      <div>{entry.project?.name ?? 'N/A'}</div>
                                      <div className="text-muted-foreground">{entry.task?.name ?? 'No task'}</div>
                                    </td>
                                    <td className="py-2 text-right tabular-nums font-medium">
                                      {Number(entry.hours).toFixed(2)}
                                    </td>
                                    <td className="py-2 text-xs">
                                      {entry.description && (
                                        <ExpandableDescription text={entry.description} />
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Bottom action bar */}
              {selectedEntryIds.size > 0 && activeWeek && (
                <div className="mt-4 rounded-xl border border-border bg-muted/20 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3 text-sm">
                      <strong>{selectedEntryIds.size} selected</strong>
                      <button
                        type="button"
                        className="text-primary text-xs hover:underline"
                        onClick={() => { setSelectedEntryIds(new Set()); setPendingAction(null); setComment(''); }}
                      >
                        Clear selection
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <ActionButton
                        label={pendingAction === 'approve' ? 'Confirm approve' : 'Approve selected'}
                        kind="approve"
                        active={pendingAction === 'approve'}
                        disabled={approveBatch.isPending || rejectBatch.isPending}
                        onClick={() => {
                          if (pendingAction === 'approve') void submitAction();
                          else { setPendingAction('approve'); setErrorMessage(null); }
                        }}
                      />
                      <ActionButton
                        label={pendingAction === 'send_back' ? 'Confirm send back' : 'Send back'}
                        kind="sendback"
                        active={pendingAction === 'send_back'}
                        disabled={approveBatch.isPending || rejectBatch.isPending}
                        onClick={() => {
                          if (pendingAction === 'send_back') void submitAction();
                          else { setPendingAction('send_back'); setErrorMessage(null); }
                        }}
                      />
                      <ActionButton
                        label={pendingAction === 'reject' ? 'Confirm reject' : 'Reject'}
                        kind="reject"
                        active={pendingAction === 'reject'}
                        disabled={approveBatch.isPending || rejectBatch.isPending}
                        onClick={() => {
                          if (pendingAction === 'reject') void submitAction();
                          else { setPendingAction('reject'); setErrorMessage(null); }
                        }}
                      />
                    </div>
                  </div>
                  {(pendingAction === 'send_back' || pendingAction === 'reject') && (
                    <div className="mt-4 pt-4 border-t border-border">
                      <label className="text-xs font-semibold">
                        Reviewer comments
                        <span className="text-rose-500 ml-1">required</span>
                      </label>
                      <textarea
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        rows={3}
                        placeholder="Explain what needs to change. Be specific. The employee sees this verbatim."
                        className="w-full mt-1.5 rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-y"
                      />
                      <p className="text-[11px] text-muted-foreground mt-1.5">
                        Comments are sent to the employee by email and shown in the Rework tab.
                        Switching between Send back and Reject keeps your comment.
                      </p>
                    </div>
                  )}
                  {errorMessage && (
                    <div className="mt-2 text-xs text-rose-600 dark:text-rose-400">{errorMessage}</div>
                  )}
                  <div className="text-[11px] text-muted-foreground mt-2">
                    Actions apply to selected entries from this employee only. Switching employees clears the selection.
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Sub-components ──────────────────────────────────────────────

const StatTile: React.FC<{
  accent: 'rose' | 'amber' | 'blue';
  icon: React.ReactNode;
  label: string;
  value: number;
  sublabel: string;
}> = ({ accent, icon, label, value, sublabel }) => {
  const wrap = {
    rose: 'bg-rose-500/10 border-rose-500/20 text-rose-500',
    amber: 'bg-amber-500/10 border-amber-500/20 text-amber-500',
    blue: 'bg-blue-500/10 border-blue-500/20 text-blue-500',
  }[accent];
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-4">
      <div className={`w-11 h-11 rounded-xl inline-flex items-center justify-center ${wrap}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold leading-tight">{value}</div>
        <div className="text-[11px] text-muted-foreground mt-0.5">{sublabel}</div>
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value?: string; valueNode?: React.ReactNode }> = ({ label, value, valueNode }) => (
  <div className="min-w-[70px]">
    <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</div>
    <div className="text-base font-semibold mt-0.5">{value ?? valueNode}</div>
  </div>
);

const ActionButton: React.FC<{
  label: string;
  kind: 'approve' | 'sendback' | 'reject';
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}> = ({ label, kind, active, disabled, onClick }) => {
  const classes = {
    approve: 'bg-emerald-500 hover:bg-emerald-600 text-white',
    sendback: 'bg-amber-500 hover:bg-amber-600 text-white',
    reject: 'bg-rose-500 hover:bg-rose-600 text-white',
  }[kind];
  const ring = {
    approve: 'ring-2 ring-offset-2 ring-emerald-400',
    sendback: 'ring-2 ring-offset-2 ring-amber-400',
    reject: 'ring-2 ring-offset-2 ring-rose-400',
  }[kind];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed ${classes} ${active ? ring : ''}`}
    >
      {kind === 'approve' && <Check className="w-4 h-4" />}
      {kind === 'sendback' && <CornerUpLeft className="w-4 h-4" />}
      {kind === 'reject' && <X className="w-4 h-4" />}
      {label}
    </button>
  );
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
