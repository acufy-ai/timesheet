import { byStartTime, type DayGroup } from './approvalsGrouping';
import { formatWeekRange, fromISODate, startOfWeek, toISODate } from './date';
import type { TimeEntry, TimeEntryStatus } from '@/types/time';

// Group one user's own entries (from /timesheets/my) into month -> week -> day
// so the History tab can present a drill-down: month overview (default) ->
// click to open weeks -> expand a week to per-day detail. Pure functions, no
// React. Weeks are Monday-based (matches My Time + approvalsGrouping).

const num = (v: string | number) => (typeof v === 'string' ? parseFloat(v) : v) || 0;

// Rank used when a week mixes statuses: surface the "least settled" status so
// the badge reflects what still needs the employee's attention.
const STATUS_RANK: Record<TimeEntryStatus, number> = {
  REJECTED: 0,
  DRAFT: 1,
  SUBMITTED: 2,
  APPROVED: 3,
};

export interface HistoryWeek {
  weekStart: string; // YYYY-MM-DD (Monday)
  label: string; // "May 25 – May 31, 2026"
  days: DayGroup[];
  hours: number;
  entryCount: number;
  // Derived facts for the lean collapsed week row.
  status: TimeEntryStatus; // dominant (least-settled) status for the week
  mixed: boolean; // true when the week holds more than one status
  daysWorked: number; // distinct dates with entries
  projects: string[]; // distinct project names, in first-seen order
  submittedAt: string | null; // earliest submitted_at across the week
  approvedAt: string | null; // latest approved_at across the week
  approverName: string | null; // approved_by_name (first seen)
  rejectionReason: string | null; // first rejection reason (REJECTED weeks)
}

export interface HistoryMonth {
  key: string; // YYYY-MM
  label: string; // "May 2026"
  weeks: HistoryWeek[];
  hours: number;
  entryCount: number;
  daysWorked: number;
  // When every entry in the month is approved, expose the approver for the
  // month header ("· approved by John Doe").
  allApproved: boolean;
  approverName: string | null;
}

function monthKey(dateIso: string): string {
  return dateIso.slice(0, 7); // YYYY-MM
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function buildWeek(weekStart: string, weekEntries: TimeEntry[]): HistoryWeek {
  const byDay = new Map<string, TimeEntry[]>();
  for (const e of weekEntries) {
    const list = byDay.get(e.entry_date) ?? [];
    list.push(e);
    byDay.set(e.entry_date, list);
  }
  const days: DayGroup[] = [...byDay.entries()]
    .map(([date, dayEntries]) => ({
      date,
      entries: [...dayEntries].sort(byStartTime),
      hours: dayEntries.reduce((s, e) => s + num(e.hours), 0),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const statuses = new Set(weekEntries.map((e) => e.status));
  // Dominant = the least-settled status present (lowest rank).
  let status: TimeEntryStatus = 'APPROVED';
  for (const s of statuses) if (STATUS_RANK[s] < STATUS_RANK[status]) status = s;

  const projects: string[] = [];
  for (const e of weekEntries) {
    const name = e.project?.name ?? `Project #${e.project_id}`;
    if (!projects.includes(name)) projects.push(name);
  }

  // Earliest submission, latest approval — the bracketing dates for the row.
  const submittedAt = weekEntries.reduce<string | null>((acc, e) => {
    if (!e.submitted_at) return acc;
    return acc === null || e.submitted_at < acc ? e.submitted_at : acc;
  }, null);
  const approvedAt = weekEntries.reduce<string | null>((acc, e) => {
    if (!e.approved_at) return acc;
    return acc === null || e.approved_at > acc ? e.approved_at : acc;
  }, null);
  const approverName = weekEntries.find((e) => e.approved_by_name)?.approved_by_name ?? null;
  const rejectionReason = weekEntries.find((e) => e.status === 'REJECTED' && e.rejection_reason)?.rejection_reason ?? null;

  return {
    weekStart,
    label: formatWeekRange(fromISODate(weekStart)),
    days,
    hours: weekEntries.reduce((s, e) => s + num(e.hours), 0),
    entryCount: weekEntries.length,
    status,
    mixed: statuses.size > 1,
    daysWorked: byDay.size,
    projects,
    submittedAt,
    approvedAt,
    approverName,
    rejectionReason,
  };
}

/**
 * Group a flat list of the user's own entries into months (newest first), each
 * holding its weeks (newest first), each holding its days (oldest first).
 */
export function groupHistoryByMonth(entries: TimeEntry[]): HistoryMonth[] {
  const byMonth = new Map<string, TimeEntry[]>();
  for (const e of entries) {
    const k = monthKey(e.entry_date);
    const list = byMonth.get(k) ?? [];
    list.push(e);
    byMonth.set(k, list);
  }

  const months: HistoryMonth[] = [];
  for (const [key, monthEntries] of byMonth) {
    const byWeek = new Map<string, TimeEntry[]>();
    for (const e of monthEntries) {
      const ws = toISODate(startOfWeek(fromISODate(e.entry_date)));
      const list = byWeek.get(ws) ?? [];
      list.push(e);
      byWeek.set(ws, list);
    }
    const weeks = [...byWeek.entries()]
      .map(([weekStart, weekEntries]) => buildWeek(weekStart, weekEntries))
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart));

    const distinctDays = new Set(monthEntries.map((e) => e.entry_date));
    const allApproved = monthEntries.length > 0 && monthEntries.every((e) => e.status === 'APPROVED');

    months.push({
      key,
      label: monthLabel(key),
      weeks,
      hours: monthEntries.reduce((s, e) => s + num(e.hours), 0),
      entryCount: monthEntries.length,
      daysWorked: distinctDays.size,
      allApproved,
      approverName: allApproved ? monthEntries.find((e) => e.approved_by_name)?.approved_by_name ?? null : null,
    });
  }

  // Newest month first.
  months.sort((a, b) => b.key.localeCompare(a.key));
  return months;
}
