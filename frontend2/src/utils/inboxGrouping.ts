/**
 * Inbox row-group helpers, shared between InboxPage (the visible
 * table) and DashboardPage (the "X await review" tile count).
 *
 * The inbox collapses ``IngestionTimesheet`` rows into one group per
 * ``email_id`` — multi-week emails (e.g. an admin forwarding
 * "March 2026 Timesheets VYSystems → TechM" covering 14 weekly
 * submissions) become a single row in the queue. The dashboard
 * tile must use the SAME grouping or the two numbers disagree and
 * the user gets a "38 await review → opens inbox showing 10" UX
 * mismatch.
 */
import type { IngestionTimesheetSummary, SkippedEmail } from '@/types';

export type TimesheetRowGroup = {
  key: string;
  status: string;
  timesheets: IngestionTimesheetSummary[];
  primary: IngestionTimesheetSummary;
  periods: number;
  totalHours: number;
  anomalyCount: number;
  kind?: 'timesheet' | 'skipped';
  skipped?: SkippedEmail;
};

/** Adapt a SkippedEmail into the same row-group shape used by the
 * main table. ``status='skipped'`` and placeholder fields for
 * client/employee/week/hours. */
export const buildSkippedRowGroup = (email: SkippedEmail): TimesheetRowGroup => {
  const primary = {
    id: 0,
    email_id: email.id,
    sender_email: email.sender_email,
    sender_name: email.sender_name,
    subject: email.subject,
    received_at: email.received_at,
    created_at: email.received_at,
    mailbox_label: email.mailbox_label,
    client_name: null,
    employee_name: null,
    extracted_employee_name: null,
    employee_id: null,
    client_id: null,
    period_start: null,
    period_end: null,
    total_hours: null,
    status: 'skipped',
    attachment_id: email.reprocessable_attachments[0]?.id ?? null,
    llm_anomalies: [],
    is_likely_resubmission: false,
  } as unknown as IngestionTimesheetSummary;
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

/** Collapse a list of timesheet summaries into row-groups keyed by
 * ``email_id``. ``options.includeRejected`` controls whether
 * dismissed-as-duplicate rows contribute to a group's aggregate
 * count / hours / span; the regular inbox sets this false, the
 * Rejected tab sets it true.
 */
export const buildRowGroups = (
  timesheets: IngestionTimesheetSummary[],
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
      });
      continue;
    }

    const group = map.get(key)!;
    // Intra-group dedup: identical attachment + period + total is a
    // duplicate extraction, not a separate weekly submission.
    const isDuplicatePeriod = group.timesheets.some((existing) => {
      const existingSignature = `${existing.attachment_id ?? 'no-att'}|${existing.period_start ?? ''}|${existing.period_end ?? ''}|${existing.total_hours ?? ''}`;
      const incomingSignature = `${ts.attachment_id ?? 'no-att'}|${ts.period_start ?? ''}|${ts.period_end ?? ''}|${ts.total_hours ?? ''}`;
      return existingSignature === incomingSignature;
    });
    if (isDuplicatePeriod) {
      continue;
    }
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
    timesheets: [...group.timesheets].sort((left, right) => {
      const leftValue = left.period_start ? new Date(left.period_start).getTime() : Number.MAX_SAFE_INTEGER;
      const rightValue = right.period_start ? new Date(right.period_start).getTime() : Number.MAX_SAFE_INTEGER;
      return leftValue - rightValue;
    }),
  }));
};

/** Count pending row-groups (the unit shown in the inbox table).
 *
 * Pure helper so the dashboard tile and any other "how many are
 * waiting for review" indicator share one definition.
 */
export const countPendingGroups = (
  timesheets: IngestionTimesheetSummary[],
): number => {
  // The dashboard only needs the pending bucket. We deliberately do
  // NOT include skipped emails here — they live on a separate tab and
  // the "await review" label means "needs an approve/reject decision."
  return buildRowGroups(timesheets, { includeRejected: false })
    .filter((group) => group.status === 'pending')
    .length;
};
