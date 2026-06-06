import { describe, it, expect } from 'vitest';

import {
  groupPendingByEmployee,
  groupWeekByDay,
  computeStatTiles,
  weekStartIso,
  weekEndIso,
} from './approvalsGrouping';
import type { TimeEntry } from '@/types';

// ─── Synthetic fixtures ─────────────────────────────────────────────

function entry(over: Partial<TimeEntry>): TimeEntry {
  return {
    id: Math.floor(Math.random() * 1_000_000),
    user_id: 1,
    project_id: 1,
    entry_date: '2026-05-18',
    hours: 1,
    description: '',
    is_billable: true,
    status: 'SUBMITTED',
    submitted_at: '2026-05-19T10:00:00Z',
    approved_by: null,
    approved_at: null,
    rejection_reason: null,
    quickbooks_time_activity_id: null,
    created_at: '2026-05-18T00:00:00Z',
    updated_at: '2026-05-18T00:00:00Z',
    user: { id: 1, full_name: 'Alice', email: 'alice@x.test' },
    ...over,
  } as unknown as TimeEntry;
}

// ─── Week boundaries ────────────────────────────────────────────────

describe('weekStartIso / weekEndIso', () => {
  it('Sun=0: Mon 2026-05-18 → week starts on Sun 2026-05-17', () => {
    expect(weekStartIso('2026-05-18', 0)).toBe('2026-05-17');
    expect(weekEndIso('2026-05-17')).toBe('2026-05-23');
  });
  it('Mon=1: Mon 2026-05-18 → week starts on Mon 2026-05-18', () => {
    expect(weekStartIso('2026-05-18', 1)).toBe('2026-05-18');
  });
  it('Mon=1: Sun 2026-05-17 → week starts on Mon 2026-05-11', () => {
    expect(weekStartIso('2026-05-17', 1)).toBe('2026-05-11');
  });
});

// ─── groupPendingByEmployee ─────────────────────────────────────────

describe('groupPendingByEmployee', () => {
  it('returns an empty array for an empty input', () => {
    expect(groupPendingByEmployee([])).toEqual([]);
  });

  it('collapses entries by employee + week', () => {
    const entries = [
      // Alice, week of May 17, two days, two entries
      entry({ user_id: 1, entry_date: '2026-05-18', hours: 2 }),
      entry({ user_id: 1, entry_date: '2026-05-19', hours: 4 }),
      // Alice, prior week
      entry({ user_id: 1, entry_date: '2026-05-11', hours: 8 }),
      // Bob
      entry({ user_id: 2, entry_date: '2026-05-18', hours: 5, user: { id: 2, full_name: 'Bob' } as any }),
    ];
    const groups = groupPendingByEmployee(entries, 0);
    expect(groups).toHaveLength(2);
    const alice = groups.find((g) => g.employeeId === 1)!;
    expect(alice.weeks).toHaveLength(2);
    expect(alice.totals).toEqual({ hours: 14, entries: 3, weeks: 2 });
    // Newest week first
    expect(alice.weeks[0].weekStart).toBe('2026-05-17');
    expect(alice.weeks[0].totals).toEqual({ hours: 6, entries: 2 });
    expect(alice.weeks[1].weekStart).toBe('2026-05-10');
  });

  it('sorts employees by oldest pending submission ascending (overdue first)', () => {
    const e1 = entry({ user_id: 1, submitted_at: '2026-05-19T10:00:00Z' });
    const e2 = entry({ user_id: 2, submitted_at: '2026-05-15T10:00:00Z', user: { id: 2, full_name: 'Bob' } as any });
    const groups = groupPendingByEmployee([e1, e2]);
    // Bob's older submission should top the list.
    expect(groups[0].employeeId).toBe(2);
    expect(groups[1].employeeId).toBe(1);
  });

  it('handles null submitted_at gracefully (lands at the bottom)', () => {
    const e1 = entry({ user_id: 1, submitted_at: null });
    const e2 = entry({ user_id: 2, submitted_at: '2026-05-15T10:00:00Z', user: { id: 2, full_name: 'Bob' } as any });
    const groups = groupPendingByEmployee([e1, e2]);
    expect(groups[0].employeeId).toBe(2);
    expect(groups[1].employeeId).toBe(1);
    expect(groups[1].oldestSubmittedAt).toBeNull();
  });

  it('tracks the OLDEST submitted_at when an employee has many entries', () => {
    const entries = [
      entry({ user_id: 1, submitted_at: '2026-05-19T10:00:00Z' }),
      entry({ user_id: 1, submitted_at: '2026-05-12T10:00:00Z' }),
      entry({ user_id: 1, submitted_at: '2026-05-21T10:00:00Z' }),
    ];
    const groups = groupPendingByEmployee(entries);
    expect(groups[0].oldestSubmittedAt).toBe('2026-05-12T10:00:00Z');
  });
});

// ─── groupWeekByDay ─────────────────────────────────────────────────

describe('groupWeekByDay', () => {
  it('groups one week of entries by date, sorted earliest first', () => {
    const week = [
      entry({ entry_date: '2026-05-21', hours: 8 }),
      entry({ entry_date: '2026-05-18', hours: 2 }),
      entry({ entry_date: '2026-05-18', hours: 4 }),
      entry({ entry_date: '2026-05-19', hours: 6 }),
    ];
    const days = groupWeekByDay(week);
    expect(days.map((d) => d.date)).toEqual(['2026-05-18', '2026-05-19', '2026-05-21']);
    expect(days[0].totals).toEqual({ hours: 6, entries: 2 });
  });

  it('returns an empty array for an empty input (does not emit empty days)', () => {
    expect(groupWeekByDay([])).toEqual([]);
  });

  it('orders entries WITHIN a day chronologically by start_time', () => {
    // Regression: prod showed a day's entries in insertion/id order
    // (e.g. 5pm, 8pm, 7:30pm, 1pm, 3pm). They must read in clock order.
    const day = [
      entry({ id: 1, entry_date: '2026-05-26', start_time: '17:00' }),
      entry({ id: 2, entry_date: '2026-05-26', start_time: '20:00' }),
      entry({ id: 3, entry_date: '2026-05-26', start_time: '19:30' }),
      entry({ id: 4, entry_date: '2026-05-26', start_time: '13:00' }),
      entry({ id: 5, entry_date: '2026-05-26', start_time: '15:00' }),
    ];
    const [bucket] = groupWeekByDay(day);
    expect(bucket.entries.map((e) => e.start_time)).toEqual([
      '13:00', '15:00', '17:00', '19:30', '20:00',
    ]);
  });

  it('sorts entries without a start_time to the end, id as tiebreaker', () => {
    const day = [
      entry({ id: 10, entry_date: '2026-05-26', start_time: null }),
      entry({ id: 11, entry_date: '2026-05-26', start_time: '09:00' }),
      entry({ id: 9, entry_date: '2026-05-26', start_time: null }),
    ];
    const [bucket] = groupWeekByDay(day);
    expect(bucket.entries.map((e) => e.id)).toEqual([11, 9, 10]);
  });
});

// ─── computeStatTiles ───────────────────────────────────────────────

describe('computeStatTiles', () => {
  it('sums weeks + entries across all buckets', () => {
    const buckets = groupPendingByEmployee([
      entry({ user_id: 1, entry_date: '2026-05-18' }),
      entry({ user_id: 1, entry_date: '2026-05-11' }),
      entry({ user_id: 2, entry_date: '2026-05-18', user: { id: 2, full_name: 'B' } as any }),
    ]);
    expect(computeStatTiles(buckets)).toEqual({
      employees: 2,
      weeks: 3, // Alice has 2, Bob has 1
      entries: 3,
    });
  });

  it('returns zeros for empty input', () => {
    expect(computeStatTiles([])).toEqual({ employees: 0, weeks: 0, entries: 0 });
  });
});
