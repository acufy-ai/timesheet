import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
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
  useManagerFinancials,
  useManagerTeamOverview,
  useTeamBillableStats,
  useTeamDailyOverview,
  useTeamOnTimeStats,
  useTeamProjectMatrix,
} from '@/hooks/useDashboard';
import { useIngestionTimesheets } from '@/hooks/useAdmin';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import { EmployeeWidgets } from '@/components/dashboard/EmployeeWidgets';
import { QuickLogButton } from '@/components/my-time/QuickLogButton';
import { AdminOrgStats } from '@/components/dashboard/AdminOrgStats';
import { ManagerConversation } from '@/components/dashboard/ManagerConversation';
import type {
  ProjectHealth,
  TeamBillableStats,
  TeamOnTimeStats,
  TeamProjectMatrix,
} from '@/types/dashboard';

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
  good: { label: 'Good', tone: 'success' },
  'at-risk': { label: 'At risk', tone: 'warning' },
  'needs-attention': { label: 'Needs attention', tone: 'danger' },
  'not-set': { label: 'Not set', tone: 'neutral' },
};

// Compact money formatter for the financials widget. Large values abbreviate
// (e.g. $2.4M, $850k) so the table stays readable.
function fmtMoney(value: string | number | null | undefined, currency = 'USD'): string {
  const n = Number(value ?? 0);
  const sym = currency === 'USD' ? '$' : `${currency} `;
  if (Math.abs(n) >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1_000) return `${sym}${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return `${sym}${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function describeAge(hours: number | null): string {
  if (hours == null) return '';
  if (hours < 24) return `oldest ${Math.max(1, Math.round(hours))}h ago`;
  const days = Math.round(hours / 24);
  return `oldest ${days}d ago`;
}

// One column of the daily check-in widget: a count, a label, and the names
// behind it. Tone tints the count to read at a glance (green good, amber
// in-progress, rose needs-attention).
const DAILY_TONE: Record<'emerald' | 'amber' | 'rose', string> = {
  emerald: 'text-emerald-600 dark:text-emerald-400',
  amber: 'text-amber-600 dark:text-amber-400',
  rose: 'text-rose-600 dark:text-rose-400',
};

function DailyGroup({
  tone,
  label,
  count,
  names,
}: {
  tone: 'emerald' | 'amber' | 'rose';
  label: string;
  count: number;
  names: string[];
}) {
  return (
    <div className="bg-card px-4 py-3">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p className={cn('text-lg font-semibold tabular-nums', DAILY_TONE[tone])}>
          {count}
        </p>
      </div>
      {names.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground" title={names.join(', ')}>
          {names.slice(0, 4).join(', ')}
          {names.length > 4 ? ` +${names.length - 4} more` : ''}
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground/60">None</p>
      )}
    </div>
  );
}

// Small card shell for the team-quality stats (consistent header + body).
function StatCard({ icon, title, meta, children }: { icon: React.ReactNode; title: string; meta?: string; children: React.ReactNode }) {
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          {icon}
          <p className="text-sm font-semibold text-foreground">{title}</p>
        </div>
        {meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}
      </div>
      {children}
    </Card>
  );
}

// Billable — collapses to one line when the whole team is 100% billable (or
// uniformly the same), since per-person bars add nothing then.
function BillableCard({ data }: { data: TeamBillableStats }) {
  const rows = data.rows.filter((r) => Number(r.approved_hours) > 0);
  const allFull = rows.length > 0 && rows.every((r) => (r.billable_pct ?? 0) >= 100);
  const meta = `last ${data.days_back}d${data.team_billable_pct != null ? ` · team ${data.team_billable_pct}%` : ''}`;
  return (
    <StatCard icon={<Clock className="h-4 w-4 text-muted-foreground" />} title="Billable split" meta={meta}>
      {allFull ? (
        <p className="px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400">
          All {Number(data.team_billable_hours)}h approved this window are billable (100%).
        </p>
      ) : (
        <div className="px-4 py-3">
          <div className="space-y-2">
            {rows.map((r) => {
              const pct = r.billable_pct ?? 0;
              return (
                <div key={r.user_id} className="text-sm">
                  <div className="mb-0.5 flex items-center justify-between">
                    <span className="text-foreground">{r.full_name}</span>
                    <span className="tabular-nums text-muted-foreground" title={`${Number(r.billable_hours)}h billable of ${Number(r.approved_hours)}h approved`}>
                      {r.billable_pct}% · {Number(r.billable_hours)}/{Number(r.approved_hours)}h
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn('h-full rounded-full', pct >= 70 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-rose-500')}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </StatCard>
  );
}

// One on-time week dot. Filled green = on time, red = late, hollow = no activity.
function WeekDot({ status, label }: { status: 'on_time' | 'late' | 'none'; label: string }) {
  return (
    <span
      title={label}
      className={cn(
        'inline-block h-2.5 w-2.5 rounded-full',
        status === 'on_time' ? 'bg-emerald-500' : status === 'late' ? 'bg-rose-500' : 'border border-border bg-transparent',
      )}
    />
  );
}

// On-time — recent-weeks sparkline (dots) per person so a manager sees who's
// slipping NOW, plus the overall % for context.
function OnTimeCard({ data }: { data: TeamOnTimeStats }) {
  const rows = data.rows.filter((r) => r.weeks_with_activity > 0);
  const meta = `${data.team_on_time_pct != null ? `team ${data.team_on_time_pct}% · ` : ''}recent weeks`;
  const fmtWeek = (iso: string) => {
    const d = new Date(iso + 'T00:00:00');
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  return (
    <StatCard icon={<CheckCircle2 className="h-4 w-4 text-muted-foreground" />} title="On-time submissions" meta={meta}>
      <div className="px-4 py-3">
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.user_id} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 flex-1 truncate text-foreground">{r.full_name}</span>
              <span className="flex shrink-0 items-center gap-1">
                {r.recent_weeks.map((w) => (
                  <WeekDot key={w.week_start} status={w.status} label={`Week of ${fmtWeek(w.week_start)}: ${w.status === 'on_time' ? 'on time' : w.status === 'late' ? 'late' : 'no activity'}`} />
                ))}
              </span>
              <span
                className={cn('w-10 shrink-0 text-right tabular-nums font-semibold', (r.on_time_pct ?? 0) >= 80 ? 'text-emerald-600 dark:text-emerald-400' : (r.on_time_pct ?? 0) >= 50 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400')}
                title={`${r.on_time_weeks} on-time of ${r.weeks_with_activity} active weeks (all-time in window)`}
              >
                {r.on_time_pct}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </StatCard>
  );
}

// Project matrix — heat-shaded cells (opacity scales with hours vs the busiest
// cell) so heavy allocations stand out; project totals header + grand total.
function ProjectMatrixCard({ data }: { data: TeamProjectMatrix }) {
  const rows = data.rows.filter((r) => Number(r.total_hours) > 0);
  // Max single-cell hours drives the heat scale.
  let maxCell = 0;
  for (const r of rows) for (const c of r.cells) maxCell = Math.max(maxCell, Number(c.hours));
  const heat = (h: number): React.CSSProperties =>
    h > 0 && maxCell > 0 ? { backgroundColor: `hsl(var(--primary) / ${(0.08 + 0.32 * (h / maxCell)).toFixed(3)})` } : {};
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-semibold text-foreground">Project hours by person</p>
        <p className="text-xs text-muted-foreground">hours: last {data.days_back}d · revenue: all-time · approved</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-2 font-semibold">Person</th>
              {data.projects.map((p) => (
                <th key={p.project_id} className="px-3 py-2 text-right font-semibold" title={`${p.project_name} (${p.client_name}) · ${Number(p.total_hours)}h`}>
                  {p.project_name}
                </th>
              ))}
              <th className="px-4 py-2 text-right font-semibold">Total</th>
              <th className="px-4 py-2 text-right font-semibold" title="All-time billed revenue this person generated on these projects (approved billable hours x rate)">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.user_id} className="border-b border-border/60">
                <td className="px-4 py-2 text-foreground">
                  <span className="block leading-tight">{r.full_name}</span>
                  {r.title ? <span className="block text-[11px] leading-tight text-muted-foreground">{r.title}</span> : null}
                </td>
                {r.cells.map((c) => {
                  const h = Number(c.hours);
                  return (
                    <td key={c.project_id} className={cn('px-3 py-2 text-right tabular-nums', h > 0 ? 'text-foreground' : 'text-muted-foreground/30')} style={heat(h)}>
                      {h > 0 ? `${h}h` : '·'}
                    </td>
                  );
                })}
                <td className="px-4 py-2 text-right font-semibold tabular-nums text-foreground">{Number(r.total_hours)}h</td>
                <td className="px-4 py-2 text-right tabular-nums text-foreground">{Number(r.revenue) > 0 ? fmtMoney(r.revenue) : '·'}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border text-[11px] text-muted-foreground">
              <td className="px-4 py-2 font-semibold uppercase tracking-wider">Project total</td>
              {data.projects.map((p) => (
                <td key={p.project_id} className="px-3 py-2 text-right tabular-nums">{Number(p.total_hours)}h</td>
              ))}
              <td className="px-4 py-2 text-right font-semibold tabular-nums text-foreground">{Number(data.grand_total_hours)}h</td>
              <td className="px-4 py-2 text-right font-semibold tabular-nums text-foreground">{fmtMoney(rows.reduce((s, r) => s + Number(r.revenue), 0))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const team = useManagerTeamOverview();
  const billable = useTeamBillableStats();
  const onTime = useTeamOnTimeStats();
  const projectMatrix = useTeamProjectMatrix();
  const projects = useManagerProjectHealth();
  const financials = useManagerFinancials();
  const daily = useTeamDailyOverview();
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

          {/* ── Top section: Project health → Project hours by person →
              Financials (the work-and-money view, surfaced first). ── */}

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

          {/* Project hours by person: approved hours per person per project. */}
          {projectMatrix.data && projectMatrix.data.projects.length > 0 ? (
            <ProjectMatrixCard data={projectMatrix.data} />
          ) : null}

          {/* Financials — real revenue from approved time x resolved rates. */}
          {financials.data && financials.data.projects.length > 0 ? (
            <Card>
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <p className="text-sm font-semibold text-foreground">Financials</p>
                <p className="text-xs text-muted-foreground">Approved time × rate · revenue, budget &amp; contract burn</p>
              </div>
              {/* Summary tiles */}
              <div className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-4">
                {[
                  ['Revenue', fmtMoney(financials.data.summary.total_revenue, financials.data.summary.currency)],
                  ['Approved hours', `${Math.round(Number(financials.data.summary.total_approved_hours))}h`],
                  ['Utilization', financials.data.summary.utilization_pct != null ? `${financials.data.summary.utilization_pct}%` : 'N/A'],
                  ['Budget tracked', fmtMoney(financials.data.summary.total_budget, financials.data.summary.currency)],
                ].map(([label, val]) => (
                  <div key={label} className="bg-card px-4 py-3">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
                    <p className="mt-0.5 text-[15px] font-bold tabular-nums text-foreground">{val}</p>
                  </div>
                ))}
              </div>
              {/* Per-project rows */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="px-4 py-2 font-semibold">Project</th>
                      <th className="px-4 py-2 font-semibold">Hours</th>
                      <th className="px-4 py-2 font-semibold">Revenue</th>
                      <th className="px-4 py-2 font-semibold">Budget used</th>
                      <th className="px-4 py-2 font-semibold">Contract used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {financials.data.projects.map((row) => (
                      <tr key={row.project_id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3">
                          <div className="font-medium text-foreground">{row.project_name}</div>
                          <div className="text-[11px] text-muted-foreground">{row.client_name}</div>
                        </td>
                        <td className="px-4 py-3 tabular-nums text-foreground">{Math.round(Number(row.approved_hours))}h</td>
                        <td className="px-4 py-3 tabular-nums font-semibold text-foreground">{fmtMoney(row.revenue, row.currency)}</td>
                        <td className="px-4 py-3">
                          {row.budget_used_pct != null ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="tabular-nums text-foreground">{row.budget_used_pct}%</span>
                              <span className="text-[11px] text-muted-foreground">of {fmtMoney(row.budget_amount ?? 0, row.currency)}</span>
                            </span>
                          ) : <span className="text-muted-foreground">N/A</span>}
                        </td>
                        <td className="px-4 py-3">
                          {row.contract_used_pct != null ? (
                            <span className="inline-flex items-center gap-1.5" title={row.contract_title ?? undefined}>
                              <span className="tabular-nums text-foreground">{row.contract_used_pct}%</span>
                              <span className="text-[11px] text-muted-foreground">of {fmtMoney(row.contract_value ?? 0, row.currency)}</span>
                            </span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {/* ── Lower section: standup + quality + roster ── */}

          {/* Daily standup: yesterday's submission status. */}
          {daily.data && daily.data.team_size > 0 ? (
            <Card>
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div className="flex items-center gap-2">
                  <CalendarClock className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-semibold text-foreground">Daily check-in</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(daily.data.date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
                  {daily.data.has_time_remaining_until_deadline
                    ? ` · deadline ${new Date(daily.data.submission_deadline_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
                    : ' · deadline passed'}
                </p>
              </div>
              <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-3">
                <DailyGroup tone="emerald" label="Submitted" count={daily.data.submitted_yesterday_count} names={daily.data.submitted_yesterday.map((m) => m.full_name)} />
                <DailyGroup tone="amber" label={daily.data.has_time_remaining_until_deadline ? 'Still drafting' : 'Drafting'} count={daily.data.draft_yesterday_count} names={daily.data.draft_yesterday.map((m) => m.full_name)} />
                <DailyGroup tone="rose" label={daily.data.has_time_remaining_until_deadline ? 'Not started' : 'Missed deadline'} count={daily.data.missing_yesterday_count} names={daily.data.missing_yesterday.map((m) => m.full_name)} />
              </div>
            </Card>
          ) : null}

          {/* Team quality stats — Billable, On-time in a 2-up grid. Each
              collapses to a one-line summary when there's no variation worth a
              full list. (Rejections card removed.) */}
          {(billable.data || onTime.data) ? (
            <div className="grid gap-4 md:grid-cols-2">
              {billable.data && billable.data.rows.some((r) => Number(r.approved_hours) > 0)
                ? <BillableCard data={billable.data} />
                : null}
              {onTime.data && onTime.data.rows.some((r) => r.weeks_with_activity > 0)
                ? <OnTimeCard data={onTime.data} />
                : null}
            </div>
          ) : null}

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
