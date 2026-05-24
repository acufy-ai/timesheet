import { describe, expect, it } from 'vitest';

import {
  buildRowGroups,
  countPendingGroups,
} from './inboxGrouping';
import type { IngestionTimesheetSummary } from '@/types';

const mk = (
  overrides: Partial<IngestionTimesheetSummary>,
): IngestionTimesheetSummary =>
  ({
    id: 1,
    email_id: 100,
    sender_email: 'sender@example.com',
    sender_name: 'Sender',
    subject: 'Timesheets',
    received_at: '2026-05-01T00:00:00Z',
    created_at: '2026-05-01T00:00:00Z',
    mailbox_label: 'm',
    client_name: null,
    employee_name: null,
    extracted_employee_name: null,
    employee_id: null,
    client_id: null,
    period_start: '2026-05-01',
    period_end: '2026-05-07',
    total_hours: 40,
    status: 'pending',
    attachment_id: 1,
    llm_anomalies: [],
    is_likely_resubmission: false,
    ...overrides,
  }) as unknown as IngestionTimesheetSummary;

describe('buildRowGroups', () => {
  it('groups rows by email_id', () => {
    // Three rows from one email = one group with periods=3.
    const groups = buildRowGroups([
      mk({ id: 1, email_id: 10, period_start: '2026-03-01', period_end: '2026-03-07' }),
      mk({ id: 2, email_id: 10, period_start: '2026-03-08', period_end: '2026-03-14' }),
      mk({ id: 3, email_id: 10, period_start: '2026-03-15', period_end: '2026-03-21' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].periods).toBe(3);
  });

  it('keeps separate emails as separate groups', () => {
    const groups = buildRowGroups([
      mk({ id: 1, email_id: 10 }),
      mk({ id: 2, email_id: 11 }),
      mk({ id: 3, email_id: 12 }),
    ]);
    expect(groups).toHaveLength(3);
  });

  it('dedupes intra-group rows with identical attachment + period + total', () => {
    const groups = buildRowGroups([
      mk({ id: 1, email_id: 10, attachment_id: 5, period_start: '2026-03-01', period_end: '2026-03-07', total_hours: 40 }),
      mk({ id: 2, email_id: 10, attachment_id: 5, period_start: '2026-03-01', period_end: '2026-03-07', total_hours: 40 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].periods).toBe(1);
  });

  it('excludes rejected rows by default', () => {
    const groups = buildRowGroups([
      mk({ id: 1, email_id: 10, status: 'rejected' }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('includes rejected rows when asked', () => {
    const groups = buildRowGroups(
      [mk({ id: 1, email_id: 10, status: 'rejected' })],
      { includeRejected: true },
    );
    expect(groups).toHaveLength(1);
  });
});

describe('countPendingGroups', () => {
  it('returns the inbox-visible pending count, not the raw row count', () => {
    // Matches the user-reported scenario: 38 pending rows collapse
    // into 10 grouped submissions because admins forward multi-week
    // emails. The dashboard tile must agree with what the user
    // actually sees when they open the inbox.
    const fourteenWeeksOneEmail = Array.from({ length: 14 }, (_, i) =>
      mk({
        id: 1000 + i,
        email_id: 200,
        period_start: `2026-01-${String(i + 1).padStart(2, '0')}`,
        period_end: `2026-01-${String(i + 1).padStart(2, '0')}`,
        total_hours: 40 + i, // distinct totals -> not deduped
      }),
    );
    const fiveWeeksOneEmail = Array.from({ length: 5 }, (_, i) =>
      mk({
        id: 2000 + i,
        email_id: 201,
        period_start: `2026-02-${String(i + 1).padStart(2, '0')}`,
        period_end: `2026-02-${String(i + 1).padStart(2, '0')}`,
        total_hours: 40 + i,
      }),
    );
    const singletons = [
      mk({ id: 3000, email_id: 300, total_hours: 100 }),
      mk({ id: 3001, email_id: 301, total_hours: 200 }),
    ];
    const all = [...fourteenWeeksOneEmail, ...fiveWeeksOneEmail, ...singletons];
    // Raw rows: 14 + 5 + 2 = 21
    expect(all).toHaveLength(21);
    // Grouped: 3 emails (200, 201, 300, 301) -> 4 groups
    expect(countPendingGroups(all)).toBe(4);
  });

  it('does not count rows that are already approved or rejected', () => {
    const rows = [
      mk({ id: 1, email_id: 10, status: 'pending' }),
      mk({ id: 2, email_id: 11, status: 'approved' }),
      mk({ id: 3, email_id: 12, status: 'rejected' }),
    ];
    expect(countPendingGroups(rows)).toBe(1);
  });

  it('returns 0 when nothing is pending', () => {
    expect(countPendingGroups([])).toBe(0);
    expect(
      countPendingGroups([mk({ id: 1, email_id: 10, status: 'approved' })]),
    ).toBe(0);
  });
});
