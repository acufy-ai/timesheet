// Per-user timesheet page. Admins (and managers, for their direct
// reports) can drill into a single user's logged time, grouped by
// calendar month with each month expandable into ISO weeks. Reuses the
// existing GET /timesheets/all?user_id=X and the inbox-approved
// summaries endpoint so external contractors with summary-only rows
// also show up.
//
// Route: /user-management/:userId/timesheets
import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, ChevronRight, Clock, Mail } from 'lucide-react';

import { adminAPI, timeentriesAPI } from '@/api/endpoints';
import { useUsers } from '@/hooks';
import type { IngestionTimesheetSummary, TimeEntry, User } from '@/types';

// ── Helpers ───────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// YYYY-MM key derived from an ISO date string (entry_date or period_start).
// Returns null for missing/invalid dates so we can group those in an "Undated" bucket.
const monthKey = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  if (iso.length < 7) return null;
  return iso.slice(0, 7);
};

const monthLabel = (key: string): string => {
  const [yearStr, monthStr] = key.split('-');
  const y = Number(yearStr);
  const m = Number(monthStr);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return key;
  return `${MONTH_NAMES[m - 1]} ${y}`;
};

// ISO week key (year + week number, Mon-based). Returns "YYYY-Www".
// Mirrors how the rest of the app buckets entries.
const isoWeekKey = (dateStr: string): string => {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return 'unknown';
  // ISO week algorithm.
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

// Friendly label for a week-key, e.g. "May 5 – May 11".
const weekRange = (entries: TimeEntry[]): string => {
  if (entries.length === 0) return '';
  const dates = entries.map((e) => e.entry_date).sort();
  const start = new Date(dates[0] + 'T00:00:00Z');
  const end = new Date(dates[dates.length - 1] + 'T00:00:00Z');
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`;
};

const sumHours = (entries: TimeEntry[]): number =>
  entries.reduce((acc, e) => acc + Number(e.hours || 0), 0);

const sumIngestion = (rows: IngestionTimesheetSummary[]): number =>
  rows.reduce((acc, r) => acc + Number(r.total_hours || 0), 0);

// ── Page ──────────────────────────────────────────────────────────────

export const UserTimesheetsPage: React.FC = () => {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const numericUserId = Number(userId);

  const { data: users = [] } = useUsers();
  const user = React.useMemo<User | undefined>(
    () => users.find((u) => u.id === numericUserId),
    [users, numericUserId],
  );

  const entriesQuery = useQuery({
    queryKey: ['user-timesheets', numericUserId],
    queryFn: () =>
      timeentriesAPI
        .listAll({ user_id: numericUserId, limit: 1000, sort_order: 'desc' })
        .then((r) => r.data),
    enabled: Number.isFinite(numericUserId),
  });

  // Summary-only inbox-approved rows for THIS user. The endpoint takes
  // ``employee_id`` directly so the backend filter is exact.
  const ingestionQuery = useQuery({
    queryKey: ['user-ingestion-timesheets', numericUserId],
    queryFn: () =>
      adminAPI
        .listApprovedIngestionTimesheets({ employee_id: numericUserId })
        .then((r) =>
          (r.data as IngestionTimesheetSummary[]).filter(
            (ts) => !ts.time_entries_created && ts.total_hours,
          ),
        ),
    enabled: Number.isFinite(numericUserId),
  });

  const entries = React.useMemo(() => entriesQuery.data ?? [], [entriesQuery.data]);
  const ingestion = React.useMemo(() => ingestionQuery.data ?? [], [ingestionQuery.data]);
  const isLoading = entriesQuery.isLoading || ingestionQuery.isLoading;

  // Group both data sources by month-key, then within each month group
  // the per-day entries by ISO week. Ingestion summary rows are listed
  // separately at the bottom of their month since they don't carry
  // per-day rows.
  type MonthGroup = {
    key: string;
    label: string;
    totalHours: number;
    entries: TimeEntry[];
    ingestion: IngestionTimesheetSummary[];
    weeks: { key: string; entries: TimeEntry[] }[];
  };

  const monthGroups: MonthGroup[] = React.useMemo(() => {
    const byMonth = new Map<string, MonthGroup>();
    const getMonth = (k: string): MonthGroup => {
      let g = byMonth.get(k);
      if (!g) {
        g = { key: k, label: monthLabel(k), totalHours: 0, entries: [], ingestion: [], weeks: [] };
        byMonth.set(k, g);
      }
      return g;
    };

    for (const e of entries) {
      const k = monthKey(e.entry_date);
      if (!k) continue;
      const g = getMonth(k);
      g.entries.push(e);
    }
    for (const ts of ingestion) {
      const k = monthKey(ts.period_start ?? ts.reviewed_at?.slice(0, 10) ?? null);
      if (!k) continue;
      const g = getMonth(k);
      g.ingestion.push(ts);
    }

    // Build week buckets per month + total hours = day-entry sum + ingestion sum.
    for (const g of byMonth.values()) {
      const byWeek = new Map<string, TimeEntry[]>();
      for (const e of g.entries) {
        const wk = isoWeekKey(e.entry_date);
        const list = byWeek.get(wk) ?? [];
        list.push(e);
        byWeek.set(wk, list);
      }
      g.weeks = Array.from(byWeek.entries())
        .map(([key, weekEntries]) => ({
          key,
          entries: weekEntries.sort((a, b) => a.entry_date.localeCompare(b.entry_date)),
        }))
        .sort((a, b) => a.key.localeCompare(b.key));
      g.totalHours = sumHours(g.entries) + sumIngestion(g.ingestion);
    }

    // Sort months newest-first.
    return Array.from(byMonth.values()).sort((a, b) => b.key.localeCompare(a.key));
  }, [entries, ingestion]);

  // Default-expand the most recent month. Others stay collapsed.
  const [expandedMonths, setExpandedMonths] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    if (monthGroups.length > 0 && expandedMonths.size === 0) {
      setExpandedMonths(new Set([monthGroups[0].key]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthGroups.length === 0 ? '' : monthGroups[0]?.key]);

  const [expandedWeeks, setExpandedWeeks] = React.useState<Set<string>>(new Set());

  const toggleMonth = (key: string) => {
    setExpandedMonths((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleWeek = (key: string) => {
    setExpandedWeeks((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (!Number.isFinite(numericUserId)) {
    return (
      <div className="max-w-5xl mx-auto p-6">
        <p className="text-sm text-destructive">Invalid user id.</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-5">
      {/* Header */}
      <div>
        <button
          type="button"
          onClick={() => navigate('/user-management')}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition mb-3"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to users
        </button>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {user?.full_name ?? 'User timesheets'}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {user?.email ?? ''}
              {user?.is_external && (
                <span className="ml-2 inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                  External
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total logged</p>
              <p className="text-sm font-semibold text-foreground">
                {monthGroups.reduce((acc, g) => acc + g.totalHours, 0).toFixed(1)} h
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      {isLoading ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Loading timesheets…
        </div>
      ) : monthGroups.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No timesheet entries found for this user.
        </div>
      ) : (
        <div className="space-y-3">
          {monthGroups.map((group) => {
            const isOpen = expandedMonths.has(group.key);
            const dayEntryHours = sumHours(group.entries);
            const ingestionHours = sumIngestion(group.ingestion);
            return (
              <div key={group.key} className="rounded-xl border border-border bg-card overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleMonth(group.key)}
                  className="w-full flex items-center justify-between gap-3 px-5 py-4 hover:bg-muted/30 transition-colors text-left"
                >
                  <div className="flex items-center gap-3">
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                    <h2 className="text-base font-semibold text-foreground">{group.label}</h2>
                    <span className="text-xs text-muted-foreground">
                      {group.weeks.length} {group.weeks.length === 1 ? 'week' : 'weeks'}
                      {group.ingestion.length > 0 && (
                        <span className="ml-1">· {group.ingestion.length} inbox-approved</span>
                      )}
                    </span>
                  </div>
                  <p className="text-base font-semibold text-foreground">{group.totalHours.toFixed(1)} h</p>
                </button>

                {isOpen && (
                  <div className="border-t border-border">
                    {/* Per-week rows */}
                    {group.weeks.map((week) => {
                      const wkOpen = expandedWeeks.has(`${group.key}::${week.key}`);
                      const wkHours = sumHours(week.entries);
                      return (
                        <div key={week.key} className="border-b border-border last:border-b-0">
                          <button
                            type="button"
                            onClick={() => toggleWeek(`${group.key}::${week.key}`)}
                            className="w-full flex items-center justify-between gap-3 px-7 py-2.5 hover:bg-muted/20 transition-colors text-left"
                          >
                            <div className="flex items-center gap-2">
                              {wkOpen ? (
                                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                              <span className="text-sm text-foreground">{weekRange(week.entries)}</span>
                              <span className="text-xs text-muted-foreground">
                                · {week.entries.length} {week.entries.length === 1 ? 'entry' : 'entries'}
                              </span>
                            </div>
                            <p className="text-sm font-medium text-foreground">{wkHours.toFixed(1)} h</p>
                          </button>

                          {wkOpen && (
                            <div className="bg-muted/10 px-5 pb-3 pt-1">
                              <table className="w-full text-xs">
                                <thead className="text-muted-foreground">
                                  <tr className="text-left">
                                    <th className="py-2 font-medium">Date</th>
                                    <th className="py-2 font-medium">Project</th>
                                    <th className="py-2 font-medium">Task</th>
                                    <th className="py-2 font-medium">Description</th>
                                    <th className="py-2 font-medium">Status</th>
                                    <th className="py-2 font-medium text-right">Hours</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {week.entries.map((e) => (
                                    <tr key={e.id} className="border-t border-border/50">
                                      <td className="py-2 text-foreground">
                                        {new Date(e.entry_date + 'T00:00:00').toLocaleDateString(undefined, {
                                          weekday: 'short', month: 'short', day: 'numeric',
                                        })}
                                      </td>
                                      <td className="py-2 text-foreground">{e.project?.name ?? 'N/A'}</td>
                                      <td className="py-2 text-muted-foreground">{e.task?.name ?? 'N/A'}</td>
                                      <td className="py-2 text-muted-foreground max-w-md truncate" title={e.description}>
                                        {e.description || 'N/A'}
                                      </td>
                                      <td className="py-2">
                                        <span
                                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                            e.status === 'APPROVED'
                                              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                              : e.status === 'REJECTED'
                                              ? 'bg-destructive/15 text-destructive'
                                              : e.status === 'SUBMITTED'
                                              ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
                                              : 'bg-muted text-muted-foreground'
                                          }`}
                                        >
                                          {e.status}
                                        </span>
                                      </td>
                                      <td className="py-2 text-right font-medium text-foreground">
                                        {Number(e.hours).toFixed(2)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Inbox-approved summary rows for this month */}
                    {group.ingestion.length > 0 && (
                      <div className="bg-amber-500/[0.04] px-7 py-3 border-t border-border">
                        <div className="flex items-center gap-2 mb-2">
                          <Mail className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                          <p className="text-xs font-medium text-foreground">
                            Inbox-approved timesheets
                            <span className="ml-1 text-muted-foreground">({ingestionHours.toFixed(1)} h)</span>
                          </p>
                        </div>
                        <ul className="space-y-1.5">
                          {group.ingestion.map((ts) => (
                            <li
                              key={ts.id}
                              className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
                            >
                              <span className="truncate">
                                {ts.client_name ?? 'Unspecified client'}
                                {ts.period_start && (
                                  <span className="ml-2">
                                    · {ts.period_start}
                                    {ts.period_end && ts.period_end !== ts.period_start && ` – ${ts.period_end}`}
                                  </span>
                                )}
                              </span>
                              <span className="font-medium text-foreground">
                                {Number(ts.total_hours ?? 0).toFixed(1)} h
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {group.entries.length === 0 && group.ingestion.length === 0 && (
                      <p className="px-5 py-4 text-xs text-muted-foreground">No entries this month.</p>
                    )}
                  </div>
                )}

                {!isOpen && group.entries.length === 0 && group.ingestion.length === 0 && (
                  <div className="hidden" />
                )}

                {/* When the month is collapsed, show a hint of what's inside via the chevron + total hours */}
                {isOpen && dayEntryHours === 0 && ingestionHours === 0 && (
                  <p className="px-5 py-4 text-xs text-muted-foreground">No hours logged in this month.</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
