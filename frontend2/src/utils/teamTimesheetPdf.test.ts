import { describe, expect, it } from 'vitest';

import { buildMetadataRows, employeePdfFilename } from './teamTimesheetPdf';

describe('buildMetadataRows', () => {
  it('includes every field when all data is present', () => {
    const rows = buildMetadataRows(
      { full_name: 'Yamini Mallavarapu' },
      [{ hours: 8 }, { hours: 7.5 }],
      'Alexander Lee',
      { startDate: '2026-04-01', endDate: '2026-04-30', status: 'APPROVED' },
    );
    const labels = rows.map(([label]) => label);
    expect(labels).toEqual(['Employee', 'Manager', 'Period', 'Status', 'Total hours']);
    expect(rows.find(([l]) => l === 'Total hours')?.[1]).toBe('15.5 h');
  });

  it('omits Manager when no manager is provided', () => {
    const rows = buildMetadataRows(
      { full_name: 'Solo Contributor' },
      [{ hours: 4 }],
      null,
      { startDate: '2026-04-01', endDate: '2026-04-30' },
    );
    const labels = rows.map(([label]) => label);
    expect(labels).not.toContain('Manager');
    expect(labels).toContain('Employee');
    expect(labels).toContain('Total hours');
  });

  it('omits Status when filter is empty', () => {
    const rows = buildMetadataRows(
      { full_name: 'Whoever' },
      [{ hours: 1 }],
      null,
      { startDate: '2026-04-01', endDate: '2026-04-30', status: '' },
    );
    expect(rows.map(([l]) => l)).not.toContain('Status');
  });

  it('omits Period when both dates are missing', () => {
    const rows = buildMetadataRows(
      { full_name: 'Whoever' },
      [{ hours: 1 }],
      null,
      { startDate: null, endDate: null },
    );
    expect(rows.map(([l]) => l)).not.toContain('Period');
  });

  it('omits Total hours when entries sum to zero', () => {
    const rows = buildMetadataRows(
      { full_name: 'Whoever' },
      [],
      null,
      { startDate: '2026-04-01', endDate: '2026-04-30' },
    );
    expect(rows.map(([l]) => l)).not.toContain('Total hours');
  });

  it('includes ingestion-only hours in the Total hours line', () => {
    // No real TimeEntry rows, but an inbox-approved summary timesheet
    // contributes 40 hours. Total hours should still appear.
    const rows = buildMetadataRows(
      { full_name: 'Saatvik Manjunath' },
      [],
      null,
      { startDate: '2026-02-01', endDate: '2026-02-28' },
      [{ client_name: 'Webilent', period_start: '2026-02-01', period_end: '2026-02-28', total_hours: 40 }],
    );
    const total = rows.find(([l]) => l === 'Total hours')?.[1];
    expect(total).toBe('40.0 h');
  });

  it('includes Supervisor when supervisor names are provided', () => {
    const rows = buildMetadataRows(
      { full_name: 'Saatvik Manjunath' },
      [],
      'Alexander Lee',
      { startDate: '2026-02-01', endDate: '2026-02-28' },
      [{ client_name: 'Webilent', period_start: '2026-02-01', period_end: '2026-02-28', total_hours: 40 }],
      ['John Reilly'],
    );
    const supervisor = rows.find(([l]) => l === 'Supervisor')?.[1];
    expect(supervisor).toBe('John Reilly');
  });

  it('deduplicates and comma-joins multiple supervisor names', () => {
    const rows = buildMetadataRows(
      { full_name: 'X' },
      [],
      null,
      { startDate: '2026-02-01', endDate: '2026-02-28' },
      [
        { client_name: 'C1', period_start: '2026-02-01', period_end: '2026-02-07', total_hours: 10 },
        { client_name: 'C2', period_start: '2026-02-08', period_end: '2026-02-14', total_hours: 10 },
      ],
      ['Jane Doe', 'jane doe', 'John Roe', '', '   '],
    );
    const supervisor = rows.find(([l]) => l === 'Supervisor')?.[1];
    // Deduplication is case-sensitive after trim; the two "Jane Doe"/"jane doe"
    // names are intentionally treated as distinct so we don't lossy-merge two
    // different supervisors that happen to differ only in capitalisation.
    expect(supervisor).toContain('Jane Doe');
    expect(supervisor).toContain('John Roe');
  });

  it('omits Supervisor when all provided names are empty/whitespace', () => {
    const rows = buildMetadataRows(
      { full_name: 'X' },
      [{ hours: 5 }],
      null,
      { startDate: '2026-02-01', endDate: '2026-02-28' },
      [],
      ['', '   '],
    );
    expect(rows.map(([l]) => l)).not.toContain('Supervisor');
  });

  it('sums entries and ingestion hours when both are present', () => {
    const rows = buildMetadataRows(
      { full_name: 'Both Sources' },
      [{ hours: 10 }, { hours: 5 }],
      null,
      { startDate: '2026-02-01', endDate: '2026-02-28' },
      [{ client_name: 'X', period_start: '2026-02-01', period_end: '2026-02-07', total_hours: 25 }],
    );
    const total = rows.find(([l]) => l === 'Total hours')?.[1];
    expect(total).toBe('40.0 h');
  });

  it('omits Employee when full_name is empty', () => {
    const rows = buildMetadataRows(
      { full_name: '' },
      [{ hours: 8 }],
      'Manager',
      { startDate: '2026-04-01', endDate: '2026-04-30' },
    );
    expect(rows.map(([l]) => l)).not.toContain('Employee');
  });

  it('renders Period as a single date when start === end', () => {
    const rows = buildMetadataRows(
      { full_name: 'X' },
      [{ hours: 8 }],
      null,
      { startDate: '2026-04-15', endDate: '2026-04-15' },
    );
    const period = rows.find(([l]) => l === 'Period')?.[1];
    expect(period).toBe('Apr 15, 2026');
  });

  it('renders Period as range when start !== end', () => {
    const rows = buildMetadataRows(
      { full_name: 'X' },
      [{ hours: 8 }],
      null,
      { startDate: '2026-04-01', endDate: '2026-04-30' },
    );
    const period = rows.find(([l]) => l === 'Period')?.[1];
    expect(period).toBe('Apr 1, 2026 – Apr 30, 2026');
  });
});

describe('employeePdfFilename', () => {
  it('slugifies the name and includes the date stamp', () => {
    expect(
      employeePdfFilename('Yamini Mallavarapu', {
        startDate: '2026-04-01',
        endDate: '2026-04-30',
      }),
    ).toBe('yamini-mallavarapu-timesheet-2026-04-01-to-2026-04-30.pdf');
  });

  it('falls back to "employee" when the name is empty or punctuation-only', () => {
    expect(employeePdfFilename('', { startDate: null, endDate: null })).toBe(
      'employee-timesheet.pdf',
    );
    expect(employeePdfFilename('!!!', { startDate: null, endDate: null })).toBe(
      'employee-timesheet.pdf',
    );
  });

  it('drops the date stamp when either bound is missing', () => {
    expect(
      employeePdfFilename('Bob', { startDate: '2026-04-01', endDate: null }),
    ).toBe('bob-timesheet.pdf');
  });
});
