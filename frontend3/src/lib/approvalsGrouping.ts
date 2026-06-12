import { formatWeekRange, fromISODate, startOfWeek, toISODate } from './date';
import type { TimeEntry } from '@/types/time';

// Group a flat pending-approvals feed into employee -> week -> day so the
// Approvals UI can present "review one person's week at a time". Weeks are
// Monday-based (matches My Time). Pure functions, no React.

const num = (v: string | number) => (typeof v === 'string' ? parseFloat(v) : v) || 0;

// Order entries within a day chronologically. start_time is wire "HH:MM[:SS]"
// (24h) which sorts lexicographically; entries without a start_time fall to
// the end, with id as a stable tiebreaker.
export function byStartTime(a: TimeEntry, b: TimeEntry): number {
  const sa = a.start_time ?? '';
  const sb = b.start_time ?? '';
  if (sa && sb && sa !== sb) return sa.localeCompare(sb);
  if (sa && !sb) return -1;
  if (!sa && sb) return 1;
  return (a.id ?? 0) - (b.id ?? 0);
}

export interface DayGroup {
  date: string; // YYYY-MM-DD
  entries: TimeEntry[];
  hours: number;
}

export interface WeekGroup {
  weekStart: string; // YYYY-MM-DD (Monday)
  label: string; // "May 17 – May 23, 2026"
  days: DayGroup[];
  entryIds: number[];
  hours: number;
  entryCount: number;
}

export interface EmployeeGroup {
  userId: number;
  name: string;
  email: string;
  weeks: WeekGroup[];
  entryCount: number;
  hours: number;
  weekCount: number;
}

// weekStartDay MUST match the tenant's backend setting (0=Sunday/1=Monday) or
// the grouped "weeks" straddle the backend's week boundary and weekly approval
// fails ("must target one work week at a time"). Default 1 (Monday) for callers
// that don't pass it, but the approvals page always supplies the tenant value.
export function groupPending(entries: TimeEntry[], weekStartDay: 0 | 1 = 1): EmployeeGroup[] {
  // employee -> week-start -> day -> entries
  const byEmp = new Map<number, TimeEntry[]>();
  for (const e of entries) {
    const list = byEmp.get(e.user_id) ?? [];
    list.push(e);
    byEmp.set(e.user_id, list);
  }

  const employees: EmployeeGroup[] = [];
  for (const [userId, empEntries] of byEmp) {
    const byWeek = new Map<string, TimeEntry[]>();
    for (const e of empEntries) {
      const ws = toISODate(startOfWeek(fromISODate(e.entry_date), weekStartDay));
      const list = byWeek.get(ws) ?? [];
      list.push(e);
      byWeek.set(ws, list);
    }

    const weeks: WeekGroup[] = [];
    for (const [weekStart, weekEntries] of byWeek) {
      const byDay = new Map<string, TimeEntry[]>();
      for (const e of weekEntries) {
        const list = byDay.get(e.entry_date) ?? [];
        list.push(e);
        byDay.set(e.entry_date, list);
      }
      const days: DayGroup[] = [...byDay.entries()]
        .map(([date, dayEntries]) => ({
          date,
          // Chronological by start time so the reviewer reads the day in
          // clock order; entries without a start_time fall to the end.
          entries: [...dayEntries].sort(byStartTime),
          hours: dayEntries.reduce((s, e) => s + num(e.hours), 0),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      weeks.push({
        weekStart,
        label: formatWeekRange(fromISODate(weekStart)),
        days,
        entryIds: weekEntries.map((e) => e.id),
        hours: weekEntries.reduce((s, e) => s + num(e.hours), 0),
        entryCount: weekEntries.length,
      });
    }
    // Newest week first.
    weeks.sort((a, b) => b.weekStart.localeCompare(a.weekStart));

    const first = empEntries[0];
    employees.push({
      userId,
      name: first.user?.full_name ?? `User #${userId}`,
      email: first.user?.email ?? '',
      weeks,
      entryCount: empEntries.length,
      hours: empEntries.reduce((s, e) => s + num(e.hours), 0),
      weekCount: weeks.length,
    });
  }

  // Most entries first (most attention needed).
  employees.sort((a, b) => b.entryCount - a.entryCount);
  return employees;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}
