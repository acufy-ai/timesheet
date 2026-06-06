/**
 * D-061 grouping helpers for the manager-side master-detail Approvals
 * surface. Pure functions, no React deps — easy to unit-test and
 * reusable across the Pending tab body, the stat strip, and the
 * detail-pane summary.
 *
 * Two layers of grouping:
 *
 *   1. ``groupPendingByEmployee`` — collapse the flat
 *      ``/approvals/pending`` payload (one row per entry) into one
 *      bucket per employee, with a nested list of week buckets so
 *      the detail pane's week-switcher can drive directly off it.
 *
 *   2. ``groupWeekByDay`` — inside a selected week, split the
 *      employee's entries into per-day buckets sorted Sunday → Saturday
 *      (or Monday-start, depending on the workspace setting). The
 *      detail pane renders each as a collapsible card.
 */
import type { TimeEntry } from '@/types';

// ── Week bucket ──────────────────────────────────────────────────

export interface WeekBucket {
  /** ISO date of the week's first day (settings-driven). */
  weekStart: string;
  /** ISO date of the week's last day. */
  weekEnd: string;
  entries: TimeEntry[];
  totals: {
    hours: number;
    entries: number;
  };
}

// ── Employee bucket ──────────────────────────────────────────────

export interface EmployeeBucket {
  /** ``user_id`` of the employee. Always present — pending entries
   *  carry a non-null user. */
  employeeId: number;
  employeeName: string;
  /** Convenience: most recent submission timestamp across all weeks. */
  oldestSubmittedAt: string | null;
  weeks: WeekBucket[];
  totals: {
    /** Total hours pending across all weeks for this employee. */
    hours: number;
    /** Total entry count across all weeks. */
    entries: number;
    /** Distinct week count, used for the "+N more weeks" badge. */
    weeks: number;
  };
}

// ── Week-start helper ────────────────────────────────────────────

/**
 * Compute the start of the week containing ``isoDate`` given the
 * workspace's ``week_start_day`` setting (0 = Sunday, 1 = Monday).
 *
 * We deliberately do this in vanilla Date math (no date-fns) so the
 * util has zero runtime deps and trivial test setup.
 */
export function weekStartIso(isoDate: string, weekStartsOn: 0 | 1 = 0): string {
  const d = new Date(`${isoDate}T00:00:00`);
  const day = d.getDay(); // 0..6 (Sun..Sat)
  const offset = weekStartsOn === 0 ? day : (day + 6) % 7;
  d.setDate(d.getDate() - offset);
  return toIso(d);
}

export function weekEndIso(weekStartIsoDate: string): string {
  const d = new Date(`${weekStartIsoDate}T00:00:00`);
  d.setDate(d.getDate() + 6);
  return toIso(d);
}

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function hoursOf(e: TimeEntry): number {
  const v = e.hours;
  if (typeof v === 'number') return v;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// ── Group by employee → weeks ─────────────────────────────────────

/**
 * Collapse a flat list of pending entries into one bucket per
 * employee, with a nested list of weeks sorted most-recent-first.
 * Within each week the entries stay in their original order — the
 * detail pane handles per-day grouping via ``groupWeekByDay``.
 *
 * Stable across React renders: passing the same ``entries`` produces
 * arrays whose contents and ordering are deterministic.
 */
export function groupPendingByEmployee(
  entries: TimeEntry[],
  weekStartsOn: 0 | 1 = 0,
): EmployeeBucket[] {
  const byEmp = new Map<number, EmployeeBucket>();

  for (const e of entries) {
    const userId = e.user_id;
    const name = e.user?.full_name ?? `User #${userId}`;

    let bucket = byEmp.get(userId);
    if (!bucket) {
      bucket = {
        employeeId: userId,
        employeeName: name,
        oldestSubmittedAt: e.submitted_at,
        weeks: [],
        totals: { hours: 0, entries: 0, weeks: 0 },
      };
      byEmp.set(userId, bucket);
    }

    // Track the oldest submitted_at so the list can sort by it.
    if (e.submitted_at) {
      if (!bucket.oldestSubmittedAt || e.submitted_at < bucket.oldestSubmittedAt) {
        bucket.oldestSubmittedAt = e.submitted_at;
      }
    }

    const wkStart = weekStartIso(e.entry_date, weekStartsOn);
    let week = bucket.weeks.find((w) => w.weekStart === wkStart);
    if (!week) {
      week = {
        weekStart: wkStart,
        weekEnd: weekEndIso(wkStart),
        entries: [],
        totals: { hours: 0, entries: 0 },
      };
      bucket.weeks.push(week);
    }
    week.entries.push(e);
    week.totals.entries += 1;
    week.totals.hours += hoursOf(e);
    bucket.totals.entries += 1;
    bucket.totals.hours += hoursOf(e);
  }

  // Finalize: sort each employee's weeks newest-first, set the
  // weeks count, then sort employees by oldest pending submission so
  // the manager handles aging items first.
  const buckets = Array.from(byEmp.values());
  for (const b of buckets) {
    b.weeks.sort((a, b2) => b2.weekStart.localeCompare(a.weekStart));
    b.totals.weeks = b.weeks.length;
  }
  buckets.sort((a, b) => {
    // Nulls last; otherwise ascending (oldest first) so the most
    // overdue employee tops the list.
    if (!a.oldestSubmittedAt && !b.oldestSubmittedAt) return a.employeeName.localeCompare(b.employeeName);
    if (!a.oldestSubmittedAt) return 1;
    if (!b.oldestSubmittedAt) return -1;
    return a.oldestSubmittedAt.localeCompare(b.oldestSubmittedAt);
  });
  return buckets;
}

// ── Group a week into per-day buckets ────────────────────────────

export interface DayBucket {
  /** ISO date for the day. */
  date: string;
  entries: TimeEntry[];
  totals: { hours: number; entries: number };
}

/**
 * Split a week's entries into per-day buckets sorted earliest-first.
 * Days with no entries are NOT included — the UI renders a placeholder
 * for those if it needs to (typically it doesn't, since weekends with
 * no work are usually invisible).
 */
export function groupWeekByDay(entries: TimeEntry[]): DayBucket[] {
  const byDate = new Map<string, DayBucket>();
  for (const e of entries) {
    let day = byDate.get(e.entry_date);
    if (!day) {
      day = { date: e.entry_date, entries: [], totals: { hours: 0, entries: 0 } };
      byDate.set(e.entry_date, day);
    }
    day.entries.push(e);
    day.totals.entries += 1;
    day.totals.hours += hoursOf(e);
  }
  const days = Array.from(byDate.values());
  days.sort((a, b) => a.date.localeCompare(b.date));
  // Within each day, order entries chronologically by start time so the
  // reviewer reads them top-to-bottom in clock order. start_time is wire
  // "HH:MM[:SS]" (24h), which sorts lexicographically; entries without a
  // start_time fall to the end, with id as a stable tiebreaker.
  for (const day of days) {
    day.entries.sort((a, b) => {
      const sa = a.start_time ?? '';
      const sb = b.start_time ?? '';
      if (sa && sb && sa !== sb) return sa.localeCompare(sb);
      if (sa && !sb) return -1;
      if (!sa && sb) return 1;
      return (a.id ?? 0) - (b.id ?? 0);
    });
  }
  return days;
}

// ── Stat tiles ───────────────────────────────────────────────────

export interface StatCounts {
  employees: number;
  weeks: number;
  entries: number;
}

/**
 * Derive the three top-of-page stat-tile values from the grouped
 * buckets so the tiles and the list never drift. ``hours`` was
 * dropped from the top strip per the D-061 critique; the detail
 * pane shows it per-employee.
 */
export function computeStatTiles(buckets: EmployeeBucket[]): StatCounts {
  let weeks = 0;
  let entries = 0;
  for (const b of buckets) {
    weeks += b.totals.weeks;
    entries += b.totals.entries;
  }
  return { employees: buckets.length, weeks, entries };
}
