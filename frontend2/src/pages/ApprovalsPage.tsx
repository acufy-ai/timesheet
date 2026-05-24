/* eslint-disable @typescript-eslint/no-unused-vars */
//
// D-061 refactor: the legacy Pending tab body was replaced by
// <PendingMasterDetail />. Some state hooks, helpers, and view
// fragments that the old body relied on now linger unused; they're
// parked for the follow-up extraction PR rather than ripped out in
// the same diff so the History tab + Time Off tab keep their
// existing wiring untouched.
import React, { useCallback, useMemo, useState } from 'react';
import { format, parseISO, startOfWeek } from 'date-fns';
import { ArrowDown, ArrowUp, CheckCircle, ChevronDown, ChevronRight, Clock, XCircle } from 'lucide-react';

import { EmptyState, Error, ExpandableDescription, Loading, SearchInput } from '@/components';
import {
  useApprovalHistoryGrouped,
  useApproveTimeEntryBatch,
  usePendingApprovals,
  useRejectTimeEntry,
  useRejectTimeEntryBatch,
  useRevertTimeEntryRejection,
  usePendingTimeOffApprovals,
  useApproveTimeOffRequest,
  useRejectTimeOffRequest,
  useTimeOffApprovalHistory,
  useWeekStartsOn,
} from '@/hooks';
import type { HistoryGroup } from '@/api/endpoints';
import { TimeEntry, TimeOffRequest } from '@/types';
import { formatTimeBlock } from '@/utils/timeFormat';
import { PendingMasterDetail } from '@/components/approvals/PendingMasterDetail';
import { ApprovedTimesheetsManagerView } from '@/components/approvals/ApprovedTimesheetsManagerView';

type EmployeeOverview = {
  id: number;
  name: string;
  timesheetCount: number;
};

type WeeklyTimesheetGroup = {
  employeeId: number;
  employeeName: string;
  weekStart: string;
  weekEnd: string;
  items: TimeEntry[];
};

const parseEntryDate = (value: string) => parseISO(value);

const groupTimesheetsByEmployeeWeek = (items: TimeEntry[], weekStartsOn: 0 | 1): WeeklyTimesheetGroup[] => {
  const grouped = new Map<string, WeeklyTimesheetGroup>();

  items.forEach((item) => {
    const weekStartDate = startOfWeek(parseEntryDate(item.entry_date), { weekStartsOn });
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekEndDate.getDate() + 6);
    const weekStart = format(weekStartDate, 'yyyy-MM-dd');
    const weekEnd = format(weekEndDate, 'yyyy-MM-dd');
    const groupKey = `${item.user_id}-${weekStart}`;

    const existing = grouped.get(groupKey);
    if (existing) {
      existing.items.push(item);
      return;
    }

    grouped.set(groupKey, {
      employeeId: item.user_id,
      employeeName: item.user?.full_name || 'Unknown Employee',
      weekStart,
      weekEnd,
      items: [item],
    });
  });

  return Array.from(grouped.values())
    .map((group) => ({
      ...group,
      items: group.items.sort((a, b) => parseEntryDate(a.entry_date).getTime() - parseEntryDate(b.entry_date).getTime()),
    }))
    .sort((a, b) => {
      const nameCmp = a.employeeName.localeCompare(b.employeeName);
      if (nameCmp !== 0) return nameCmp;
      return b.weekStart.localeCompare(a.weekStart);
    });
};

export const ApprovalsPage: React.FC = () => {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'entry_date' | 'submitted_at' | 'hours' | 'employee'>('submitted_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [rejectionReasons, setRejectionReasons] = useState<Record<string, string>>({});
  const [showRejectForm, setShowRejectForm] = useState<Record<string, boolean>>({});
  const [rejectingEntryId, setRejectingEntryId] = useState<number | null>(null);
  const [entryRejectReason, setEntryRejectReason] = useState('');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  const [historyDaysBack, setHistoryDaysBack] = useState(30);
  const [historyStatusFilter, setHistoryStatusFilter] = useState<'' | 'approved' | 'rejected' | 'mixed'>('');
  // Time off has its own history filter (status doesn't include 'mixed':
  // a single PTO request resolves to a single decision).
  const [timeOffHistoryStatusFilter, setTimeOffHistoryStatusFilter] = useState<'' | 'APPROVED' | 'REJECTED'>('');
  const [expandedHistoryKeys, setExpandedHistoryKeys] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<'timesheets' | 'time-off' | 'approved'>('timesheets');
  const [rejectingTimeOffId, setRejectingTimeOffId] = useState<number | null>(null);
  const [timeOffRejectReason, setTimeOffRejectReason] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [statusTone, setStatusTone] = useState<'success' | 'danger'>('success');

  const showStatus = useCallback((message: string, tone: 'success' | 'danger') => {
    setStatusMessage(message);
    setStatusTone(tone);
    setTimeout(() => setStatusMessage(''), 5000);
  }, []);

  const params = useMemo(
    () => ({ search: search.trim() || undefined, sort_by: sortBy, sort_order: sortOrder, limit: 500 }),
    [search, sortBy, sortOrder]
  );

  const { data: timeEntries, isLoading: timeLoading, error: timeError } = usePendingApprovals(params);
  const historyGroupedParams = useMemo(
    () => ({ days_back: historyDaysBack, status_filter: historyStatusFilter || undefined }),
    [historyDaysBack, historyStatusFilter]
  );
  const { data: historyGroups = [], isLoading: historyLoading, error: historyError } = useApprovalHistoryGrouped(historyGroupedParams);
  // Time off history. The backend endpoint returns APPROVED + REJECTED
  // in the manager's scope; we filter by status / age client-side so
  // the user can flip filters without re-fetching.
  const { data: timeOffHistoryRaw = [], isLoading: timeOffHistoryLoading } = useTimeOffApprovalHistory({
    sort_by: 'approved_at',
    sort_order: 'desc',
    limit: 200,
  });
  const timeOffHistory = useMemo(() => {
    const cutoff = Date.now() - historyDaysBack * 24 * 60 * 60 * 1000;
    return (timeOffHistoryRaw as TimeOffRequest[]).filter((r) => {
      if (timeOffHistoryStatusFilter && r.status !== timeOffHistoryStatusFilter) return false;
      const ts = r.approved_at ?? r.updated_at;
      if (!ts) return true;
      return new Date(ts).getTime() >= cutoff;
    });
  }, [timeOffHistoryRaw, timeOffHistoryStatusFilter, historyDaysBack]);

  const searchSuggestions = useMemo(() => {
    const set = new Set<string>();
    (timeEntries ?? []).forEach((e: TimeEntry) => {
      if (e.user?.full_name) set.add(e.user.full_name);
      if (e.project?.name) set.add(e.project.name);
      if (e.rejection_reason) set.add(e.rejection_reason);
    });
    historyGroups.forEach((g: HistoryGroup) => {
      set.add(g.employee_name);
      g.entries.forEach((e) => { if (e.project_name) set.add(e.project_name); });
    });
    return Array.from(set).filter(Boolean).sort();
  }, [timeEntries, historyGroups]);

  const approveBatchMutation = useApproveTimeEntryBatch();
  const rejectBatchMutation = useRejectTimeEntryBatch();
  const [selectedGroupKeys, setSelectedGroupKeys] = useState<Set<string>>(new Set());
  const [bulkRejectReason, setBulkRejectReason] = useState('');
  const [showBulkRejectForm, setShowBulkRejectForm] = useState(false);
  const rejectEntryMutation = useRejectTimeEntry();
  // Pre-existing — kept for upcoming revert flow; revisit when that lands.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const revertRejectionMutation = useRevertTimeEntryRejection();

  const { data: pendingTimeOff = [], isLoading: timeOffLoading } = usePendingTimeOffApprovals();
  const approveTimeOffMutation = useApproveTimeOffRequest();
  const rejectTimeOffMutation = useRejectTimeOffRequest();

  const weekStartsOn = useWeekStartsOn();

  // All grouping / memos must be BEFORE early returns (Rules of Hooks)
  const timesheetWeeklyGroups = useMemo(
    () => groupTimesheetsByEmployeeWeek((timeEntries ?? []) as TimeEntry[], weekStartsOn),
    [timeEntries, weekStartsOn]
  );
  const employeeOverview: EmployeeOverview[] = useMemo(() => {
    const map = new Map<number, EmployeeOverview>();
    timesheetWeeklyGroups.forEach((g) => {
      const existing = map.get(g.employeeId);
      if (existing) {
        existing.timesheetCount += 1;
      } else {
        map.set(g.employeeId, { id: g.employeeId, name: g.employeeName, timesheetCount: 1 });
      }
    });
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [timesheetWeeklyGroups]);

  const displayTimesheetWeeklyGroups = useMemo(
    () => selectedEmployeeId === null ? timesheetWeeklyGroups : timesheetWeeklyGroups.filter((g) => g.employeeId === selectedEmployeeId),
    [timesheetWeeklyGroups, selectedEmployeeId]
  );
  const historyDisplayGroups = useMemo(() => {
    let groups = historyGroups as HistoryGroup[];
    if (selectedEmployeeId !== null) groups = groups.filter((g) => g.employee_id === selectedEmployeeId);
    if (search.trim()) {
      const term = search.trim().toLowerCase();
      groups = groups.filter((g) =>
        g.employee_name.toLowerCase().includes(term) ||
        g.entries.some((e) => (e.project_name ?? '').toLowerCase().includes(term) || (e.description ?? '').toLowerCase().includes(term))
      );
    }
    return groups;
  }, [historyGroups, selectedEmployeeId, search]);

  const getGroupKey = (group: { employeeId: number; weekStart: string }) => `${group.employeeId}-${group.weekStart}`;

  const selectedEntryIds = useMemo(() => {
    const ids: number[] = [];
    for (const group of displayTimesheetWeeklyGroups) {
      if (selectedGroupKeys.has(getGroupKey(group))) {
        for (const entry of group.items) ids.push(entry.id);
      }
    }
    return ids;
  }, [displayTimesheetWeeklyGroups, selectedGroupKeys]);

  if (timeLoading && !timeEntries) {
    return <Loading />;
  }

  if (timeError || historyError) {
    return <Error message="Failed to load approvals" />;
  }

  const hasNoEntries = timesheetWeeklyGroups.length === 0;

  const handleApproveTimesheetWeek = async (entryIds: number[]) => {
    try {
      await approveBatchMutation.mutateAsync(entryIds);
      showStatus(`Approved ${entryIds.length} entries.`, 'success');
    } catch (error) {
      console.error('Error approving timesheet week:', error);
      showStatus('Some approvals failed. Please refresh and try again.', 'danger');
    }
  };

  const handleRejectTimesheetWeek = async (entryIds: number[], key: string) => {
    const reason = rejectionReasons[key] || '';
    if (!reason.trim()) {
      alert('Please provide a rejection reason');
      return;
    }

    try {
      await rejectBatchMutation.mutateAsync({ entryIds, reason });
      setShowRejectForm((current) => ({ ...current, [key]: false }));
      setRejectionReasons((current) => ({ ...current, [key]: '' }));
      showStatus(`Rejected ${entryIds.length} entries.`, 'success');
    } catch (error) {
      console.error('Error rejecting timesheet week:', error);
      showStatus('Some rejections failed. Please refresh and try again.', 'danger');
    }
  };

  // ── Bulk select + approve/reject across week groups ──
  const toggleGroupSelection = (key: string) => {
    setSelectedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllGroups = () => {
    setSelectedGroupKeys(new Set(displayTimesheetWeeklyGroups.map(getGroupKey)));
  };

  const clearGroupSelection = () => {
    setSelectedGroupKeys(new Set());
    setShowBulkRejectForm(false);
    setBulkRejectReason('');
  };

  const handleBulkApprove = async () => {
    if (selectedEntryIds.length === 0) return;
    if (!window.confirm(`Approve ${selectedEntryIds.length} time entries across ${selectedGroupKeys.size} employee-week groups?`)) return;
    try {
      await approveBatchMutation.mutateAsync(selectedEntryIds);
      showStatus(`Approved ${selectedEntryIds.length} entries.`, 'success');
      clearGroupSelection();
    } catch {
      showStatus('Some approvals failed. Please refresh and try again.', 'danger');
    }
  };

  const handleBulkReject = async () => {
    if (selectedEntryIds.length === 0 || !bulkRejectReason.trim()) return;
    try {
      await rejectBatchMutation.mutateAsync({ entryIds: selectedEntryIds, reason: bulkRejectReason.trim() });
      showStatus(`Rejected ${selectedEntryIds.length} entries.`, 'success');
      clearGroupSelection();
    } catch {
      showStatus('Some rejections failed. Please refresh and try again.', 'danger');
    }
  };

  return (
    <div>
      <div>
        <h1 className="text-3xl font-bold mb-6">Pending Approvals</h1>

        {statusMessage && (
          <div className={`mb-4 px-4 py-3 rounded text-sm font-medium ${
            statusTone === 'success'
              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}>
            {statusMessage}
          </div>
        )}

        {/* Tab switcher */}
        <div className="flex gap-1 mb-6 border-b">
          <button
            onClick={() => setActiveTab('timesheets')}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === 'timesheets'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            Timesheets
          </button>
          <button
            onClick={() => setActiveTab('time-off')}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === 'time-off'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            Time Off
            {(pendingTimeOff as TimeOffRequest[]).length > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-[11px] font-bold bg-red-500 text-white">
                {(pendingTimeOff as TimeOffRequest[]).length > 99 ? '99+' : (pendingTimeOff as TimeOffRequest[]).length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('approved')}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === 'approved'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            Approved
          </button>
        </div>

        {activeTab === 'timesheets' && <PendingMasterDetail />}
        {activeTab === 'approved' && <ApprovedTimesheetsManagerView />}


        {/* Approval History anchors the Timesheets sub-tab as the
            "what I just acted on" trail. It used to render under every
            sub-tab, but that duplicated the data on Approved (where the
            main table already lists the same rows) and was noise on
            Time Off. Single-tab placement keeps the audit affordance
            without three copies of the same widget. */}
        {activeTab === 'timesheets' && (
        <div className="mt-10">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-bold">Approval History</h2>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Status filter tabs */}
              {(['', 'approved', 'rejected', 'mixed'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setHistoryStatusFilter(f)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${
                    historyStatusFilter === f
                      ? f === '' ? 'bg-slate-700 text-white border-slate-700'
                        : f === 'approved' ? 'bg-emerald-600 text-white border-emerald-600'
                        : f === 'rejected' ? 'bg-red-600 text-white border-red-600'
                        : 'bg-amber-500 text-white border-amber-500'
                      : 'bg-card border-border hover:bg-muted'
                  }`}
                >
                  {f === '' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
              {/* Days back selector */}
              <select
                value={historyDaysBack}
                onChange={(e) => setHistoryDaysBack(Number(e.target.value))}
                className="h-8 rounded border border-border bg-card text-foreground px-2 text-xs"
              >
                <option value={7} className="bg-card text-foreground">Last 7 days</option>
                <option value={30} className="bg-card text-foreground">Last 30 days</option>
                <option value={90} className="bg-card text-foreground">Last 90 days</option>
                <option value={365} className="bg-card text-foreground">Last year</option>
              </select>
            </div>
          </div>

          {historyLoading ? (
            <Loading />
          ) : historyDisplayGroups.length === 0 ? (
            <EmptyState message="No approval history for the selected filters." />
          ) : (
            <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 border-b border-border text-left">
                  <tr>
                    <th className="px-4 py-3 font-semibold text-muted-foreground w-6"></th>
                    <th className="px-4 py-3 font-semibold text-muted-foreground">Employee</th>
                    <th className="px-4 py-3 font-semibold text-muted-foreground">Week</th>
                    <th className="px-4 py-3 font-semibold text-muted-foreground">Hours</th>
                    <th className="px-4 py-3 font-semibold text-muted-foreground">Entries</th>
                    <th className="px-4 py-3 font-semibold text-muted-foreground">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {historyDisplayGroups.map((group) => {
                    const key = `${group.employee_id}-${group.week_start}`;
                    const isExpanded = expandedHistoryKeys.has(key);
                    const toggleExpand = () => setExpandedHistoryKeys((prev) => {
                      const next = new Set(prev);
                      next.has(key) ? next.delete(key) : next.add(key);
                      return next;
                    });
                    // Theme-aware status pill — same palette used on the
                    // Approved tab so the two surfaces feel consistent.
                    const statusColors = group.status === 'approved'
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
                      : group.status === 'rejected'
                        ? 'bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/30'
                        : 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30';
                    return (
                      <React.Fragment key={key}>
                        <tr
                          className="border-t border-border hover:bg-muted/40 cursor-pointer"
                          onClick={toggleExpand}
                        >
                          <td className="px-4 py-3 text-muted-foreground text-xs select-none">
                            {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          </td>
                          <td className="px-4 py-3 font-medium text-foreground">{group.employee_name}</td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {format(parseISO(group.week_start), 'MMM d')} – {format(parseISO(group.week_end), 'MMM d, yyyy')}
                          </td>
                          <td className="px-4 py-3 font-medium text-foreground">{group.total_hours.toFixed(1)}h</td>
                          <td className="px-4 py-3 text-muted-foreground">{group.entry_count}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusColors}`}>
                              {group.status.charAt(0).toUpperCase() + group.status.slice(1)}
                              {group.status === 'mixed' && (
                                <span className="ml-1 text-[10px] opacity-75">
                                  ({group.approved_count}✓ {group.rejected_count}✗)
                                </span>
                              )}
                            </span>
                          </td>
                        </tr>
                        {isExpanded && group.entries.map((entry) => (
                          <tr key={entry.id} className="bg-muted/20 border-t border-border">
                            <td className="px-4 py-2"></td>
                            <td className="px-4 py-2 text-muted-foreground text-xs">↳</td>
                            <td className="px-4 py-2 text-xs text-muted-foreground">
                              <span className="font-medium text-foreground">{format(parseISO(entry.entry_date), 'EEE, MMM d')}</span>
                              {entry.project_name && <span className="ml-2">· {entry.project_name}</span>}
                              {entry.description && <p className="mt-0.5">{entry.description}</p>}
                              {entry.rejection_reason && (
                                <p className="text-rose-500 dark:text-rose-400 mt-0.5">Reason: {entry.rejection_reason}</p>
                              )}
                            </td>
                            <td className="px-4 py-2 text-xs font-medium text-foreground">
                              {entry.hours}h
                              {(() => {
                                const block = formatTimeBlock(entry.start_time, entry.end_time);
                                return block ? <span className="block text-[10px] text-muted-foreground font-normal mt-0.5">{block}</span> : null;
                              })()}
                            </td>
                            <td></td>
                            <td className="px-4 py-2">
                              <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                                entry.status === 'APPROVED'
                                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                                  : 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30'
                              }`}>
                                {entry.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        )}

        {activeTab === 'time-off' && (
          <div>
            {timeOffLoading ? (
              <Loading />
            ) : (pendingTimeOff as TimeOffRequest[]).length === 0 ? (
              <EmptyState message="No pending time off requests." />
            ) : (
              <div className="space-y-4">
                {(pendingTimeOff as TimeOffRequest[]).map((req) => (
                  <div key={req.id} className="border rounded-lg p-4 bg-white">
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <span className="font-medium">{req.user?.full_name ?? 'N/A'}</span>
                        <span className="ml-2 text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700">{req.leave_type}</span>
                      </div>
                      <span className="text-sm text-slate-500">{req.request_date}</span>
                    </div>
                    <p className="text-sm text-slate-600 mb-1">{req.reason || 'N/A'}</p>
                    <p className="text-sm font-medium mb-3">{Number(req.hours)}h</p>
                    {rejectingTimeOffId === req.id ? (
                      <div className="flex gap-2 items-center">
                        <input
                          className="flex-1 border rounded px-2 py-1 text-sm"
                          placeholder="Rejection reason..."
                          value={timeOffRejectReason}
                          onChange={(e) => setTimeOffRejectReason(e.target.value)}
                        />
                        <button
                          className="px-3 py-1 bg-red-600 text-white rounded text-sm"
                          onClick={() => {
                            rejectTimeOffMutation.mutate(
                              { id: req.id, reason: timeOffRejectReason },
                              {
                                onSuccess: () => { setRejectingTimeOffId(null); setTimeOffRejectReason(''); showStatus('Time entry rejected.', 'success'); },
                                onError: (err) => { console.error('Error rejecting time off:', err); showStatus('Rejection failed. Please try again.', 'danger'); },
                              }
                            );
                          }}
                        >Confirm</button>
                        <button className="px-3 py-1 border rounded text-sm" onClick={() => setRejectingTimeOffId(null)}>Cancel</button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <button
                          className="px-3 py-1.5 bg-emerald-600 text-white rounded text-sm hover:bg-emerald-700"
                          onClick={() => approveTimeOffMutation.mutate(req.id, {
                            onSuccess: () => showStatus('Time entry approved.', 'success'),
                            onError: (err) => { console.error('Error approving time off:', err); showStatus('Approval failed. Please try again.', 'danger'); },
                          })}
                        >Approve</button>
                        <button
                          className="px-3 py-1.5 border border-red-300 text-red-600 rounded text-sm hover:bg-red-50"
                          onClick={() => { setRejectingTimeOffId(req.id); setTimeOffRejectReason(''); }}
                        >Reject</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Time Off Approval History. Mirrors the Timesheets-tab
            history widget but scoped to time-off decisions only so
            the manager can audit a recent PTO approve/reject without
            jumping pages. */}
        {activeTab === 'time-off' && (
          <div className="mt-10">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-bold">Approval History</h2>
              <div className="flex items-center gap-2 flex-wrap">
                {(['', 'APPROVED', 'REJECTED'] as const).map((f) => (
                  <button
                    key={f || 'all'}
                    onClick={() => setTimeOffHistoryStatusFilter(f)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${
                      timeOffHistoryStatusFilter === f
                        ? f === '' ? 'bg-slate-700 text-white border-slate-700'
                          : f === 'APPROVED' ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-red-600 text-white border-red-600'
                        : 'bg-card border-border hover:bg-muted'
                    }`}
                  >
                    {f === '' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
                  </button>
                ))}
                <select
                  value={historyDaysBack}
                  onChange={(e) => setHistoryDaysBack(Number(e.target.value))}
                  className="h-8 rounded border border-border bg-card text-foreground px-2 text-xs"
                >
                  <option value={7} className="bg-card text-foreground">Last 7 days</option>
                  <option value={30} className="bg-card text-foreground">Last 30 days</option>
                  <option value={90} className="bg-card text-foreground">Last 90 days</option>
                  <option value={365} className="bg-card text-foreground">Last year</option>
                </select>
              </div>
            </div>

            {timeOffHistoryLoading ? (
              <Loading />
            ) : timeOffHistory.length === 0 ? (
              <EmptyState message="No time off history for the selected filters." />
            ) : (
              <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                    <tr>
                      <th className="px-4 py-3">Employee</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Date</th>
                      <th className="px-4 py-3 text-right">Hours</th>
                      <th className="px-4 py-3">Reason</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Acted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {timeOffHistory.map((r) => {
                      const acted = r.approved_at ?? r.updated_at;
                      const actedLabel = acted ? format(parseISO(acted), 'MMM d, yyyy') : 'N/A';
                      const isApproved = r.status === 'APPROVED';
                      return (
                        <tr key={r.id} className="border-t border-border hover:bg-muted/30">
                          <td className="px-4 py-3 font-medium">{r.user?.full_name ?? 'N/A'}</td>
                          <td className="px-4 py-3 text-muted-foreground">{r.leave_type}</td>
                          <td className="px-4 py-3 text-muted-foreground">{r.request_date}</td>
                          <td className="px-4 py-3 text-right tabular-nums">{Number(r.hours)}h</td>
                          <td className="px-4 py-3 text-muted-foreground max-w-md">
                            {isApproved
                              ? (r.reason || 'N/A')
                              : (r.rejection_reason || r.reason || 'N/A')}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                              isApproved
                                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                                : 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30'
                            }`}>
                              {r.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">{actedLabel}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
