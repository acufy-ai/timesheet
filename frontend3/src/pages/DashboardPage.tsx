import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  TreePalm,
  Users,
} from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';

import { Card, StatTile, TonePill, WorkspaceHeader } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import {
  useManagerProjectHealth,
  useManagerTeamOverview,
} from '@/hooks/useDashboard';
import { useIngestionTimesheets } from '@/hooks/useAdmin';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import { EmployeeWidgets } from '@/components/dashboard/EmployeeWidgets';
import { QuickLogButton } from '@/components/my-time/QuickLogButton';
import { AdminOrgStats } from '@/components/dashboard/AdminOrgStats';
import { ManagerConversation } from '@/components/dashboard/ManagerConversation';
import type { ProjectHealth } from '@/types/dashboard';

// Manager dashboard per deck #dashboard: WorkspaceHeader + attention banner +
// tone-tinted stat tiles + project health table. Wired to the live
// /dashboard/manager-* endpoints. Employee/admin variants land later; for now
// non-managers see the same data their role is scoped to (empty is handled).

// Temporarily hide the manager "conversation" prose banner — its text
// generation needs rework. Set back to true to restore it.
const SHOW_MANAGER_CONVERSATION = false;

function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

const HEALTH_META: Record<ProjectHealth, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  healthy: { label: 'Healthy', tone: 'success' },
  'at-risk': { label: 'At risk', tone: 'warning' },
  'over-budget': { label: 'Over budget', tone: 'danger' },
  'not-set': { label: 'Not set', tone: 'neutral' },
};

function describeAge(hours: number | null): string {
  if (hours == null) return '';
  if (hours < 24) return `oldest ${Math.max(1, Math.round(hours))}h ago`;
  const days = Math.round(hours / 24);
  return `oldest ${days}d ago`;
}

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const team = useManagerTeamOverview();
  const projects = useManagerProjectHealth();
  // VIEWER sees the same team roster/tiles/health as a manager (read-only,
  // whole-tenant) but NOT the manager action card (no approvals/reminders).
  const isViewer = user?.role === 'VIEWER';
  const isManagerRole = user?.role === 'MANAGER';

  const now = useMemo(() => new Date(), []);
  const firstName = (user?.full_name ?? '').split(/\s+/)[0] || 'there';
  const dateLabel = now.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });

  const overview = team.data;
  const onTrack = overview
    ? overview.members.filter((m) => m.submitted_days >= m.working_days_in_week).length
    : 0;
  const behind = overview
    ? overview.members.filter((m) => m.submitted_days === 0).length
    : 0;
  const critical = overview ? overview.members.filter((m) => m.is_repeatedly_late).length : 0;
  const ptoThisWeek = overview
    ? overview.members.filter((m) => m.is_on_pto_this_week).length
    : 0;
  const pending = overview?.pending_approvals_count ?? 0;

  const loading = team.isLoading || projects.isLoading;

  // 403 = "not a manager" (e.g. EMPLOYEE, PLATFORM_ADMIN). That's not a
  // failure — it just means this user has no team view. Degrade gracefully
  // to a personal/empty dashboard rather than a hard error. Only genuine
  // errors (network, 5xx) show the retry card.
  const errStatus = (team.error as { response?: { status?: number } })?.response?.status;
  const noTeamAccess = errStatus === 403;
  const hardError = team.isError && !noTeamAccess;

  // Role routing: ADMIN -> Org stats (toggleable with My time = widget grid);
  // MANAGER/VIEWER -> team view; EMPLOYEE/PLATFORM_ADMIN (403) -> widget grid.
  const isAdmin = user?.role === 'ADMIN';
  const [adminView, setAdminView] = useState<'stats' | 'mine'>('stats');
  const [managerView, setManagerView] = useState<'team' | 'mine'>('team');
  const [rosterOpen, setRosterOpen] = useState(true);
  // Ingestion review is available to can_review non-admins; surfaces the inbox
  // line + CTA in the manager conversation.
  const managerIngestionEnabled = Boolean(user && user.role !== 'ADMIN' && user.can_review);
  // Count of pending ingestion timesheets, so the manager conversation's inbox
  // alert actually fires (previously the count was never passed -> always 0).
  const ingestionQ = useIngestionTimesheets(managerIngestionEnabled);
  const pendingIngestionCount = (ingestionQ.data ?? []).filter(
    (t) => (t.status ?? '').toLowerCase().replace(/\s+/g, '_') === 'pending',
  ).length;

  // Platform admins have no tenant, so the team/employee dashboard is
  // meaningless (and its tenant calls 400 for a PA). Send them to the platform
  // console. (Login already routes here, but this covers manual nav / the
  // "/" and wildcard redirects that target /dashboard.)
  if (user?.role === 'PLATFORM_ADMIN') {
    return <Navigate to="/platform" replace />;
  }

  // Admin dashboard: org stats or personal widget grid. (Role switching lives
  // in the UtilityBar; the header keeps Log time + the view toggle, matching
  // the target.)
  if (isAdmin) {
    return (
      <div className="space-y-6">
        <WorkspaceHeader
          eyebrow={dateLabel}
          title={<>{greeting(now)}, <span className="italic text-primary">{firstName}</span></>}
          description="Your workspace at a glance."
          primary={
            <>
              <QuickLogButton />
              <div className="inline-flex rounded-full border border-border bg-card p-0.5 text-sm">
                <button type="button" onClick={() => setAdminView('stats')} className={cn('rounded-full px-3 py-1', adminView === 'stats' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>Organization Stats</button>
                <button type="button" onClick={() => setAdminView('mine')} className={cn('rounded-full px-3 py-1', adminView === 'mine' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>My Time</button>
              </div>
            </>
          }
        />
        {adminView === 'stats' ? <AdminOrgStats /> : <EmployeeWidgets />}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow={dateLabel}
        title={
          <>
            {greeting(now)}, <span className="italic text-primary">{firstName}</span>
          </>
        }
        description={noTeamAccess ? 'Your week at a glance.' : "Your team's week at a glance."}
        primary={
          <>
            <QuickLogButton />
            {/* Managers can flip between their team view and their own time. */}
            {!noTeamAccess ? (
              <div className="inline-flex rounded-full border border-border bg-card p-0.5 text-sm">
                <button type="button" onClick={() => setManagerView('team')} className={cn('rounded-full px-3 py-1', managerView === 'team' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>Team</button>
                <button type="button" onClick={() => setManagerView('mine')} className={cn('rounded-full px-3 py-1', managerView === 'mine' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>My Time</button>
              </div>
            ) : null}
          </>
        }
      />

      {/* Manager conversation: prose status + dynamic CTAs (replaces the old
          attention banner). Managers only — viewers are read-only and have no
          approvals/reminders surface.
          TEMPORARILY HIDDEN: the prose text-generation needs rework; keep the
          banner off for users until it's revised. Flip SHOW_MANAGER_CONVERSATION
          back to true to re-enable. */}
      {SHOW_MANAGER_CONVERSATION && isManagerRole && managerView === 'team' && !loading && !hardError ? (
        <ManagerConversation overview={overview} ingestionEnabled={managerIngestionEnabled} pendingIngestionCount={pendingIngestionCount} />
      ) : null}
      {/* Viewers get a read-only header line instead of the action card. */}
      {isViewer && managerView === 'team' && !loading && !hardError && overview ? (
        <Card className="px-4 py-3 text-sm text-muted-foreground">
          Read-only overview of <strong className="text-foreground">{overview.team_size}</strong> {overview.team_size === 1 ? 'person' : 'people'} across the workspace.
        </Card>
      ) : null}

      {/* Non-manager roles (403) OR a manager who flipped to "My Time": the
          full analytics widget grid. */}
      {noTeamAccess || managerView === 'mine' ? <EmployeeWidgets /> : null}

      {/* Manager stat tiles + project health + roster (team view only). */}
      {noTeamAccess || managerView === 'mine' ? null : loading ? (
        <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
        </div>
      ) : hardError ? (
        <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">
          Couldn't load your dashboard. Try refreshing the page.
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile
              Icon={Users}
              tone="primary"
              value={`${onTrack}/${overview?.team_size ?? 0}`}
              label="Team on track"
              hint="as of today"
            />
            <StatTile
              Icon={Clock}
              tone="amber"
              value={pending}
              label="Approvals pending"
              hint={
                overview?.pending_approvals_oldest_hours != null
                  ? describeAge(overview.pending_approvals_oldest_hours)
                  : 'none waiting'
              }
              onClick={() => navigate('/approvals')}
            />
            <StatTile
              Icon={TreePalm}
              tone="sky"
              value={ptoThisWeek}
              label="PTO this week"
              hint={`${overview?.pending_time_off_count ?? 0} requests pending`}
            />
            <StatTile
              Icon={CheckCircle2}
              tone="emerald"
              value={overview?.rejected_recent_count ?? 0}
              label="Recent rejections"
              hint={overview?.rejected_recent_count ? 'needs follow-up' : 'all clear'}
            />
          </div>

          {/* Project health */}
          <Card>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <p className="text-sm font-semibold text-foreground">Project health</p>
              <p className="text-xs text-muted-foreground">Sorted by attention needed</p>
            </div>
            {projects.isLoading ? (
              <div className="grid place-items-center py-10 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" />
              </div>
            ) : !projects.data || projects.data.rows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <AlertTriangle className="h-5 w-5 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">No projects to show yet.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="px-4 py-2 font-semibold">Project</th>
                      <th className="px-4 py-2 font-semibold">Client</th>
                      <th className="px-4 py-2 font-semibold">Hours this week</th>
                      <th className="px-4 py-2 font-semibold">Budget</th>
                      <th className="px-4 py-2 font-semibold">Health</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.data.rows.map((row) => {
                      const meta = HEALTH_META[row.health] ?? HEALTH_META['not-set'];
                      return (
                        <tr
                          key={row.project_id}
                          className="border-b border-border last:border-0"
                        >
                          <td className="px-4 py-3 font-medium text-foreground">
                            {row.project_name}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {row.client_name}
                          </td>
                          <td className="px-4 py-3 tabular-nums text-foreground">
                            {Math.round(Number(row.hours_this_week))}h
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {row.budget_pct != null ? `${row.budget_pct}%` : 'N/A'}
                          </td>
                          <td className="px-4 py-3">
                            <TonePill tone={meta.tone}>{meta.label}</TonePill>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Team roster — collapsible, per-person status with summary pills.
              Rows link to My Team for follow-up. */}
          {overview && overview.members.length > 0 ? (
            <Card>
              <button type="button" onClick={() => setRosterOpen((v) => !v)} className="flex w-full items-center justify-between border-b border-border px-4 py-3 text-left hover:bg-primary/5">
                <div className="flex items-center gap-2">
                  {rosterOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                  <p className="text-sm font-semibold text-foreground">Team roster</p>
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  {critical > 0 ? <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-300"><span className="h-2 w-2 rounded-full bg-amber-500" /> {critical} late</span> : null}
                  <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-300"><span className="h-2 w-2 rounded-full bg-emerald-500" /> {onTrack} on track</span>
                  <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-300"><span className="h-2 w-2 rounded-full bg-rose-500" /> {behind} behind</span>
                  <span className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-300"><span className="h-2 w-2 rounded-full bg-sky-500" /> {ptoThisWeek} on PTO</span>
                </div>
              </button>
              {rosterOpen ? (
                <div className="divide-y divide-border">
                  {overview.members.map((m) => {
                    // Status (on-track / behind) stays driven by SUBMITTED days
                    // — that's what the manager chases. "Days logged" below
                    // includes drafts so in-progress work is visible.
                    const loggedDays = m.logged_days ?? m.submitted_days;
                    const onTrackMember = m.submitted_days >= m.working_days_in_week;
                    const none = m.submitted_days === 0;
                    const tone: 'info' | 'success' | 'danger' | 'warning' = m.is_on_pto_this_week ? 'info' : onTrackMember ? 'success' : none ? 'danger' : 'warning';
                    const label = m.is_on_pto_this_week ? 'On PTO' : onTrackMember ? 'On track' : none ? 'Not started' : 'In progress';
                    return (
                      <button key={m.user_id} type="button" onClick={() => navigate(`/user-management?q=${encodeURIComponent(m.full_name)}`)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-primary/5">
                        <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold', avatarTone(m.full_name))}>
                          {initials(m.full_name)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-foreground">
                            {m.full_name}
                            {m.is_repeatedly_late ? <span className="ml-1.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-amber-600 dark:text-amber-300">Late</span> : null}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {loggedDays}/{m.working_days_in_week} days logged this week
                            {loggedDays > m.submitted_days ? ` · ${m.submitted_days} submitted` : ''}
                            {m.upcoming_pto_starts_at ? ` · PTO from ${m.upcoming_pto_starts_at}` : ''}
                          </p>
                        </div>
                        <TonePill tone={tone}>{label}</TonePill>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
