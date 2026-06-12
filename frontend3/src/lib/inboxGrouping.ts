// Inbox row-group helpers. The inbox collapses ingested-timesheet rows into
// one group per email_id — a multi-week email (e.g. an admin forwarding a
// month of weekly submissions) becomes a single row that expands to per-week
// children. Ported from frontend2/src/utils/inboxGrouping.ts, retyped to f3's
// IngestionSummary / SkippedEmail.

import type { IngestionSummary, SkippedEmail } from '@/types/admin';

export type TimesheetRowGroup = {
  key: string;
  status: string;
  timesheets: IngestionSummary[];
  primary: IngestionSummary;
  periods: number;
  totalHours: number;
  anomalyCount: number;
  kind?: 'timesheet' | 'skipped';
  skipped?: SkippedEmail;
};

/** Adapt a SkippedEmail into the same row-group shape used by the main table. */
export const buildSkippedRowGroup = (email: SkippedEmail): TimesheetRowGroup => {
  const primary = {
    id: 0,
    email_id: email.id,
    sender_email: email.sender_email,
    sender_name: email.sender_name ?? null,
    subject: email.subject,
    received_at: email.received_at,
    created_at: email.received_at ?? undefined,
    client_name: null,
    employee_name: null,
    extracted_employee_name: null,
    employee_id: null,
    client_id: null,
    period_start: null,
    period_end: null,
    total_hours: null,
    status: 'skipped',
    attachment_id: email.reprocessable_attachments[0]?.id as number | undefined ?? null,
    llm_anomalies: [],
  } as unknown as IngestionSummary;
  return {
    key: `skipped-${email.id}`,
    status: 'skipped',
    timesheets: [primary],
    primary,
    periods: 1,
    totalHours: 0,
    anomalyCount: 0,
    kind: 'skipped',
    skipped: email,
  };
};

/**
 * Collapse timesheet summaries into row-groups keyed by email_id.
 * options.includeRejected controls whether dismissed-as-duplicate rows
 * contribute to a group's aggregate count / hours / span.
 */
export const buildRowGroups = (
  timesheets: IngestionSummary[],
  options: { includeRejected?: boolean } = {},
): TimesheetRowGroup[] => {
  const map = new Map<string, TimesheetRowGroup>();

  const actionable = options.includeRejected
    ? timesheets
    : timesheets.filter((ts) => ts.status !== 'rejected');

  for (const ts of actionable) {
    const key = `email-${ts.email_id}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        status: ts.status,
        timesheets: [ts],
        primary: ts,
        periods: 1,
        totalHours: Number(ts.total_hours ?? 0),
        anomalyCount: ts.llm_anomalies?.length ?? 0,
        kind: 'timesheet',
      });
      continue;
    }

    const group = map.get(key)!;
    // Intra-group dedup: identical attachment + period + total is a duplicate
    // extraction, not a separate weekly submission.
    const isDuplicatePeriod = group.timesheets.some((existing) => {
      const existingSig = `${existing.attachment_id ?? 'no-att'}|${existing.period_start ?? ''}|${existing.period_end ?? ''}|${existing.total_hours ?? ''}`;
      const incomingSig = `${ts.attachment_id ?? 'no-att'}|${ts.period_start ?? ''}|${ts.period_end ?? ''}|${ts.total_hours ?? ''}`;
      return existingSig === incomingSig;
    });
    if (isDuplicatePeriod) continue;

    group.timesheets.push(ts);
    group.periods += 1;
    group.totalHours += Number(ts.total_hours ?? 0);
    group.anomalyCount += ts.llm_anomalies?.length ?? 0;

    if (ts.status === 'pending' || group.status === 'pending') {
      group.status = 'pending';
    } else if (ts.status === 'under_review' || group.status === 'under_review') {
      group.status = 'under_review';
    } else if (ts.status === 'rejected' || group.status === 'rejected') {
      group.status = 'rejected';
    } else if (ts.status === 'on_hold' || group.status === 'on_hold') {
      group.status = 'on_hold';
    } else if (group.timesheets.every((item) => item.status === 'approved')) {
      group.status = 'approved';
    }
  }

  return Array.from(map.values()).map((group) => ({
    ...group,
    timesheets: [...group.timesheets].sort((l, r) => {
      const lv = l.period_start ? new Date(l.period_start).getTime() : Number.MAX_SAFE_INTEGER;
      const rv = r.period_start ? new Date(r.period_start).getTime() : Number.MAX_SAFE_INTEGER;
      return lv - rv;
    }),
  }));
};

/** Count pending row-groups (shared with the dashboard "await review" tile). */
export const countPendingGroups = (timesheets: IngestionSummary[]): number =>
  buildRowGroups(timesheets, { includeRejected: false }).filter((g) => g.status === 'pending').length;
