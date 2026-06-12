import { Fragment } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card } from '@/components/ui';
import type { ManagerTeamOverview } from '@/types/dashboard';

// A prose status summary + dynamic action buttons for the manager dashboard.
// Mirrors frontend2's ManagerConversation: classifies the team into
// on-track / behind / critical(repeatedly-late) / PTO and writes a sentence,
// then surfaces the relevant CTAs (review approvals, open inbox, send reminder,
// open follow-ups). Routes "behind/critical" to My Team (un-submitted work
// can't be approved) and pending approvals to /approvals.
export function ManagerConversation({
  overview,
  ingestionEnabled = false,
  pendingIngestionCount = 0,
}: {
  overview: ManagerTeamOverview | undefined;
  ingestionEnabled?: boolean;
  pendingIngestionCount?: number;
}) {
  const navigate = useNavigate();
  if (!overview) return null;

  const members = overview.members;
  const onTrack = members.filter((m) => !m.is_repeatedly_late && !m.is_on_pto_today && (m.working_days_in_week === 0 || m.submitted_days >= m.working_days_in_week)).length;
  const critical = members.filter((m) => m.is_repeatedly_late);
  const behind = members.filter((m) => !m.is_repeatedly_late && !m.is_on_pto_today && m.working_days_in_week > 0 && m.submitted_days < m.working_days_in_week);
  const ptoToday = members.filter((m) => m.is_on_pto_today);
  const noSubmissionsYet = overview.team_size > 0 && critical.length === 0 && behind.length === 0 && ptoToday.length === 0 && members.every((m) => m.submitted_days === 0);
  const pending = overview.pending_approvals_count;
  const oldestH = overview.pending_approvals_oldest_hours;

  const frags: React.ReactNode[] = [];
  if (overview.team_size === 0) {
    frags.push(<span key="empty"><strong>You have no direct reports yet.</strong> </span>);
  } else if (onTrack === overview.team_size) {
    frags.push(<span key="good" className="font-semibold text-emerald-700 dark:text-emerald-300">Everyone on your team is on track for the week. </span>);
  } else if (noSubmissionsYet) {
    frags.push(<span key="early">No entries from your team yet this week. </span>);
  } else {
    if (critical.length > 0) {
      const linkable = critical.slice(0, 2);
      frags.push(
        <span key="crit">
          {linkable.map((m, i) => (
            <Fragment key={m.user_id}>
              <button type="button" onClick={() => navigate('/user-management')} className="font-semibold text-amber-700 hover:underline dark:text-amber-300">{m.full_name.split(' ')[0]}</button>
              {i < linkable.length - 1 ? ' and ' : ''}
            </Fragment>
          ))}
          {' '}{critical.length === 1 ? 'needs' : 'need'} follow-up. {critical.length === 1 ? 'Has missed multiple deadlines recently.' : `${critical.length} people have missed multiple deadlines recently.`}{' '}
        </span>,
      );
    }
    if (behind.length > 0) {
      frags.push(
        <span key="behind">
          <button type="button" onClick={() => navigate('/user-management')} className="font-semibold text-amber-700 hover:underline dark:text-amber-300">{behind.length} {behind.length === 1 ? 'other' : 'others'}</button>
          {' '}haven't logged all of this week's days yet.{' '}
        </span>,
      );
    }
    if (ptoToday.length > 0) frags.push(<span key="pto"><strong>{ptoToday.length} on PTO today.</strong> </span>);
  }
  if (pending > 0) {
    const ageSuffix = oldestH == null ? '' : oldestH < 12 ? ' (oldest is from today)' : oldestH < 36 ? ' (oldest is from yesterday)' : ' (oldest is over a day old)';
    frags.push(
      <span key="appr">
        <button type="button" onClick={() => navigate('/approvals')} className="font-semibold text-amber-700 hover:underline dark:text-amber-300">{pending} {pending === 1 ? 'timesheet entry' : 'timesheet entries'}</button>
        {' '}{pending === 1 ? 'is' : 'are'} waiting for your approval{ageSuffix}.{' '}
      </span>,
    );
  }
  if (ingestionEnabled && pendingIngestionCount > 0) {
    frags.push(
      <span key="inbox">
        <button type="button" onClick={() => navigate('/ingestion/inbox')} className="font-semibold text-amber-700 hover:underline dark:text-amber-300">{pendingIngestionCount} {pendingIngestionCount === 1 ? 'timesheet' : 'timesheets'} in the email inbox</button>
        {' '}{pendingIngestionCount === 1 ? 'is' : 'are'} waiting for your review.{' '}
      </span>,
    );
  }

  const actions: { label: string; primary?: boolean; onClick: () => void }[] = [];
  if (pending > 0) actions.push({ label: `Review approvals (${pending})`, primary: true, onClick: () => navigate('/approvals') });
  if (ingestionEnabled && pendingIngestionCount > 0) actions.push({ label: `Open inbox (${pendingIngestionCount})`, primary: actions.length === 0, onClick: () => navigate('/ingestion/inbox') });
  if (behind.length > 0) actions.push({ label: `Send reminder (${behind.length})`, onClick: () => navigate('/user-management') });
  if (critical.length > 0) actions.push({ label: `Open follow-ups (${critical.length})`, onClick: () => navigate('/user-management') });
  if (actions.length === 0) actions.push({ label: 'View team', onClick: () => navigate('/user-management') });

  return (
    <Card className="p-6">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
      </p>
      <p className="text-base leading-relaxed text-foreground">{frags}</p>
      <div className="mt-5 flex flex-wrap gap-2">
        {actions.map((a) => (
          <Button key={a.label} variant={a.primary ? 'primary' : 'secondary'} size="sm" onClick={a.onClick}>{a.label}</Button>
        ))}
      </div>
    </Card>
  );
}
