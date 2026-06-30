import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Search,
  SlidersHorizontal,
  TreePalm,
  Users,
} from 'lucide-react';
import { Navigate, useNavigate, type NavigateFunction } from 'react-router-dom';

import { Card, Input, Pager, Skeleton, StatTile, TableSkeleton, TonePill, WorkspaceHeader } from '@/components/ui';
import { useClientPagination } from '@/hooks/useClientPagination';
import { fmtMoney } from '@/lib/format';
import { ManagerDashboardCustomizer } from '@/components/dashboard/ManagerDashboardCustomizer';
import { useManagerDashboardPrefs, type ManagerTileKey } from '@/hooks/useManagerDashboardPrefs';
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
import { InfoLabel, HealthInfoLabel, infoTextFor } from '@/components/dashboard/InfoLabel';
import { HealthRulesModal } from '@/components/dashboard/HealthRulesModal';
import { QuickLogButton } from '@/components/my-time/QuickLogButton';
import { AdminOrgStats } from '@/components/dashboard/AdminOrgStats';
import { ManagerConversation } from '@/components/dashboard/ManagerConversation';
import type {
  ManagerFinancials,
  ProjectHealthRow,
  TeamBillableStats,
  TeamOnTimeStats,
  TeamProjectMatrix,
} from '@/types/dashboard';
import { healthMeta, HEALTH_META, type ProjectHealth } from '@/lib/projectHealth';

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

// Compact money formatter for the financials widget. Large values abbreviate
// (e.g. $2.4M, $850k) so the table stays readable.
// Margin %% color: healthy (>=40) emerald, thin (>=15) amber, weak/negative rose.
function marginTone(pct: number): string {
  if (pct >= 40) return 'text-emerald-600 dark:text-emerald-400';
  if (pct >= 15) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
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
// Week stepper for the team-at-a-glance stats. Steps back one week at a time
// (◀), forward toward the present (▶, disabled at the current week since there's
// no future to show), and the label doubles as a "back to this week" reset.
function WeekToggle({
  offset, onChange, weekStart, weekEnd,
}: {
  offset: number;
  onChange: (o: number) => void;
  weekStart?: string;
  weekEnd?: string;
}) {
  const atCurrent = offset === 0;
  const fmt = (iso?: string) =>
    iso ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
  const label = atCurrent
    ? 'This week'
    : weekStart && weekEnd
      ? `${fmt(weekStart)} – ${fmt(weekEnd)}`
      : offset === -1 ? 'Last week' : `${-offset} weeks ago`;
  const AT_LIMIT = -12;
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-border bg-card p-0.5 text-sm">
      <button
        type="button"
        onClick={() => onChange(Math.max(AT_LIMIT, offset - 1))}
        disabled={offset <= AT_LIMIT}
        aria-label="Previous week"
        className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground disabled:opacity-40"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onChange(0)}
        disabled={atCurrent}
        title={atCurrent ? undefined : 'Back to this week'}
        className={cn(
          'min-w-[6.5rem] rounded-full px-2 py-1 text-center text-xs font-medium tabular-nums transition-colors',
          atCurrent ? 'text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
        )}
      >
        {label}
      </button>
      <button
        type="button"
        onClick={() => onChange(Math.min(0, offset + 1))}
        disabled={atCurrent}
        aria-label="Next week"
        className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground disabled:opacity-40"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

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
// People per page in the matrix tile. Small so the tile stays compact even as
// the team grows; the full report view (later) shows everyone at once.
const MATRIX_PAGE_SIZE = 10;

// The manager dashboard "Projects" tile. Shows ALL active projects the manager
// runs (started or not), GROUPED BY CLIENT, each with its current health. A
// search box filters by any client/project metadata; a Health-column filter
// floats clients containing a chosen health to the top; clients paginate.
// Few clients per page so the whole widget (header + rows + pager) fits in one
// view without scrolling to reach the pager.
const PROJECTS_CLIENTS_PER_PAGE = 4;
// When the Client column is shown the list is flat (no group bands), so we can
// fit more projects per page than the per-client unit.
const PROJECTS_PER_PAGE = 8;
// The health states offered in the column filter, in severity order.
const HEALTH_FILTER_ORDER: ProjectHealth[] = [
  'critical', 'blocked', 'at-risk', 'on-track', 'excellent', 'not-started', 'not-set',
];

type ClientGroup = { clientId: number | null; clientName: string; projects: ProjectHealthRow[] };

// Financials tile: summary tiles + a per-project table. Paginated so the widget
// stays a fixed height regardless of how many projects the manager runs.
const FINANCIALS_PAGE_SIZE = 6;

function FinancialsWidget({
  data, showCol, onNavigate,
}: {
  data: ManagerFinancials;
  showCol: (c: string) => boolean;
  onNavigate: NavigateFunction;
}) {
  const { pageItems, page, pages, total, start, end, setPage } =
    useClientPagination(data.projects, FINANCIALS_PAGE_SIZE);
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-semibold text-foreground">Financials</p>
        <div className="flex items-center gap-3">
          <p className="hidden text-xs text-muted-foreground sm:block">Approved time × rate · revenue, budget &amp; contract burn</p>
          <button
            type="button"
            onClick={() => onNavigate('/insights?tab=financials')}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.04]"
          >
            View all <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {/* Summary tiles */}
      <div className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-4">
        {[
          ['Revenue', fmtMoney(data.summary.total_revenue, data.summary.currency)],
          ['Margin', data.summary.total_margin_pct != null ? `${fmtMoney(data.summary.total_margin ?? 0, data.summary.currency)} · ${data.summary.total_margin_pct}%` : 'N/A'],
          ['Utilization', data.summary.utilization_pct != null ? `${data.summary.utilization_pct}%` : 'N/A'],
          ['Approved hours', `${Math.round(Number(data.summary.total_approved_hours))}h`],
        ].map(([label, val]) => (
          <div key={label} className="bg-card px-4 py-3">
            <InfoLabel label={label} className="text-[10px] uppercase tracking-wider text-muted-foreground" />
            <p className="mt-0.5 text-[15px] font-bold tabular-nums text-foreground">{val}</p>
          </div>
        ))}
      </div>
      {/* Per-project rows (paginated). */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="table-header-row">
              <th className="table-header-cell">Project</th>
              {showCol('hours') ? <th className="table-header-cell"><InfoLabel label="Hours" /></th> : null}
              {showCol('revenue') ? <th className="table-header-cell"><InfoLabel label="Revenue" /></th> : null}
              <th className="table-header-cell"><InfoLabel label="Margin" /></th>
              {showCol('budget_used') ? <th className="table-header-cell"><InfoLabel label="Budget burn" /></th> : null}
              {showCol('contract_used') ? <th className="table-header-cell"><InfoLabel label="Contract billed" /></th> : null}
            </tr>
          </thead>
          <tbody>
            {pageItems.map((row) => (
              <tr
                key={row.project_id}
                role="link"
                tabIndex={0}
                onClick={() => onNavigate(`/insights/project/${row.project_id}?from=dashboard`)}
                onKeyDown={(e) => { if (e.key === 'Enter') onNavigate(`/insights/project/${row.project_id}?from=dashboard`); }}
                className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-foreground/[0.03] focus:bg-foreground/[0.03] focus:outline-none"
              >
                <td className="px-4 py-3">
                  <div className="font-medium text-foreground hover:text-primary">{row.project_name}</div>
                  <div className="text-[11px] text-muted-foreground">{row.client_name}</div>
                </td>
                {showCol('hours') ? <td className="px-4 py-3 tabular-nums text-foreground">{Math.round(Number(row.approved_hours))}h</td> : null}
                {showCol('revenue') ? <td className="px-4 py-3 tabular-nums font-semibold text-foreground">{fmtMoney(row.revenue, row.currency)}</td> : null}
                <td className="px-4 py-3 tabular-nums">
                  {row.margin_pct != null ? (
                    <span className={cn('font-semibold', marginTone(row.margin_pct))}>{row.margin_pct}%</span>
                  ) : <span className="text-muted-foreground">N/A</span>}
                </td>
                {showCol('budget_used') ? (
                  <td className="px-4 py-3">
                    {row.budget_used_pct != null ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="tabular-nums text-foreground">{row.budget_used_pct}%</span>
                        <span className="text-[11px] text-muted-foreground">of {fmtMoney(row.budget_amount ?? 0, row.currency)}</span>
                      </span>
                    ) : <span className="text-muted-foreground">N/A</span>}
                  </td>
                ) : null}
                {showCol('contract_used') ? (
                  <td className="px-4 py-3">
                    {row.contract_used_pct != null ? (
                      <span className="inline-flex items-center gap-1.5" title={row.contract_title ?? undefined}>
                        <span className="tabular-nums text-foreground">{row.contract_used_pct}%</span>
                        <span className="text-[11px] text-muted-foreground">of {fmtMoney(row.contract_value ?? 0, row.currency)}</span>
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 ? (
        <Pager page={page} pages={pages} total={total} start={start} end={end} onPage={setPage} unit="projects" />
      ) : null}
    </Card>
  );
}

function ProjectsWidget({
  rows, loading, showCol, onNavigate,
}: {
  rows: ProjectHealthRow[];
  loading: boolean;
  showCol: (c: string) => boolean;
  onNavigate: NavigateFunction;
}) {
  const [search, setSearch] = useState('');
  const [healthFilter, setHealthFilter] = useState<ProjectHealth | null>(null);
  const [page, setPage] = useState(1);
  const [healthConfigOpen, setHealthConfigOpen] = useState(false);

  // 1) Search any project/client metadata.
  const q = search.trim().toLowerCase();
  const matched = useMemo(() => {
    if (!q) return rows;
    return rows.filter((r) => [
      r.project_name, r.code ?? '', r.client_name,
      healthMeta(r.health).label, r.status ?? '',
      `${Math.round(Number(r.hours_this_week))}h`,
      r.budget_pct != null ? `${r.budget_pct}%` : '',
    ].some((f) => f.toLowerCase().includes(q)));
  }, [rows, q]);

  // The Client column is the source of truth for which client a project belongs
  // to. When it's shown, grouping by client would just repeat that value in a
  // band above each group — redundant and confusing under the Project header.
  // So: client column ON  -> flat project list (Client column carries it).
  //     client column OFF -> grouped-by-client bands (so context isn't lost).
  const grouped = !showCol('client');

  // 2) Health filter (a real filter, not a reorder): keep only projects with the
  //    selected health, across all clients.
  const visible = useMemo(
    () => (healthFilter ? matched.filter((r) => r.health === healthFilter) : matched),
    [matched, healthFilter],
  );

  // Flat list: sorted by client then project so rows still read in a sensible
  // order even without group bands.
  const flat = useMemo(
    () => [...visible].sort((a, b) =>
      a.client_name.localeCompare(b.client_name) || a.project_name.localeCompare(b.project_name)),
    [visible],
  );

  // Grouped list (only used when the Client column is hidden).
  const groups = useMemo(() => {
    const byClient = new Map<number | null, ClientGroup>();
    for (const r of visible) {
      const key = r.client_id ?? null;
      let g = byClient.get(key);
      if (!g) { g = { clientId: key, clientName: r.client_name || 'No client', projects: [] }; byClient.set(key, g); }
      g.projects.push(r);
    }
    const list = [...byClient.values()];
    list.forEach((g) => g.projects.sort((a, b) => a.project_name.localeCompare(b.project_name)));
    list.sort((a, b) => a.clientName.localeCompare(b.clientName));
    return list;
  }, [visible]);

  // 3) Paginate the visible unit: projects (flat) or clients (grouped). A
  //    client's projects never split across pages in grouped mode.
  const pageSize = grouped ? PROJECTS_CLIENTS_PER_PAGE : PROJECTS_PER_PAGE;
  const totalUnits = grouped ? groups.length : flat.length;
  const pages = Math.max(1, Math.ceil(totalUnits / pageSize));
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * pageSize;
  const pageGroups = groups.slice(start, start + pageSize);
  const pageRows = flat.slice(start, start + pageSize);

  const colCount = 2 + (showCol('client') ? 1 : 0) + (showCol('hours_this_week') ? 1 : 0) + (showCol('budget') ? 1 : 0);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <p className="text-sm font-semibold text-foreground">Projects</p>
        <div className="flex items-center gap-2">
          <div className="relative w-44 sm:w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 pl-8 text-xs"
              placeholder="Search projects or clients..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <button
            type="button"
            onClick={() => setHealthConfigOpen(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" /> Health Config
          </button>
          {rows.length > 0 ? (
            <button
              type="button"
              onClick={() => onNavigate('/insights?tab=portfolio')}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.04]"
            >
              View all projects <ChevronRight className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={5} cols={5} />
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <AlertTriangle className="h-5 w-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No projects to show yet.</p>
        </div>
      ) : groups.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
          {healthFilter ? `No projects are ${HEALTH_META[healthFilter].label.toLowerCase()}.` : 'No projects match your search.'}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                {/* Shared header treatment: subtle themed tint + divider so the
                    header reads distinctly from the data rows across all themes. */}
                <tr className="table-header-row">
                  <th className="table-header-cell">Project</th>
                  {showCol('client') ? <th className="table-header-cell">Client</th> : null}
                  {showCol('hours_this_week') ? <th className="table-header-cell"><InfoLabel label="Logged hours" /></th> : null}
                  {showCol('budget') ? <th className="table-header-cell"><InfoLabel label="Budget burn" /></th> : null}
                  <th className="table-header-cell">
                    <span className="inline-flex items-center gap-1">
                      <HealthInfoLabel />
                      <HealthFilterMenu value={healthFilter} onChange={(h) => { setHealthFilter(h); setPage(1); }} />
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {grouped
                  ? pageGroups.map((g) => (
                      <Fragment key={g.clientId ?? 'none'}>
                        {/* Client group header (only when the Client column is hidden). */}
                        <tr className="border-b border-border bg-foreground/[0.02]">
                          <td colSpan={colCount} className="px-4 py-2">
                            <span className="inline-flex items-center gap-2">
                              <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                              {g.clientId != null ? (
                                <button
                                  type="button"
                                  onClick={() => onNavigate(`/client-management?client=${g.clientId}`)}
                                  className="text-sm font-semibold text-foreground underline-offset-2 hover:text-primary hover:underline"
                                >
                                  {g.clientName}
                                </button>
                              ) : (
                                <span className="text-sm font-semibold text-foreground">{g.clientName}</span>
                              )}
                              <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">{g.projects.length}</span>
                            </span>
                          </td>
                        </tr>
                        {g.projects.map((row) => (
                          <ProjectRow key={row.project_id} row={row} showCol={showCol} onNavigate={onNavigate} indent />
                        ))}
                      </Fragment>
                    ))
                  : pageRows.map((row) => (
                      <ProjectRow key={row.project_id} row={row} showCol={showCol} onNavigate={onNavigate} />
                    ))}
              </tbody>
            </table>
          </div>
          {pages > 1 ? (
            <Pager
              page={safePage}
              pages={pages}
              total={totalUnits}
              start={start + 1}
              end={Math.min(start + pageSize, totalUnits)}
              onPage={setPage}
              unit={grouped ? 'clients' : 'projects'}
            />
          ) : null}
        </>
      )}
      <HealthRulesModal open={healthConfigOpen} onClose={() => setHealthConfigOpen(false)} />
    </Card>
  );
}

// One project row in the Projects widget. Shared by both modes: flat (Client
// column shown) and grouped-by-client (Client column hidden, `indent` aligns the
// project name under the client band). The whole row links to the project; the
// project/client names deep-link into Client Management.
function ProjectRow({
  row, showCol, onNavigate, indent = false,
}: {
  row: ProjectHealthRow;
  showCol: (c: string) => boolean;
  onNavigate: NavigateFunction;
  indent?: boolean;
}) {
  const meta = healthMeta(row.health);
  const openProject = () => onNavigate(`/insights/project/${row.project_id}?from=dashboard`);
  const openClient = row.client_id != null ? () => onNavigate(`/client-management?client=${row.client_id}`) : null;
  const openProjectInClients = row.client_id != null
    ? () => onNavigate(`/client-management?client=${row.client_id}&project=${row.project_id}`)
    : null;
  return (
    <tr
      role="link"
      tabIndex={0}
      onClick={openProject}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProject(); } }}
      aria-label={`Open ${row.project_name}`}
      className="cursor-pointer border-b border-border outline-none transition-colors last:border-0 hover:bg-primary/5 focus-visible:bg-primary/5"
    >
      <td className={cn('py-3 pr-4 font-medium text-foreground', indent ? 'pl-9' : 'pl-4')}>
        {openProjectInClients ? (
          <button type="button" onClick={(e) => { e.stopPropagation(); openProjectInClients(); }}
            aria-label={`Open ${row.project_name} in Client Management`}
            className="rounded text-left underline-offset-2 outline-none hover:underline hover:text-primary focus-visible:underline">
            {row.project_name}
          </button>
        ) : <span>{row.project_name}</span>}
      </td>
      {showCol('client') ? (
        <td className="px-4 py-3 text-muted-foreground">
          {openClient ? (
            <button type="button" onClick={(e) => { e.stopPropagation(); openClient(); }}
              aria-label={`Open ${row.client_name} in Client Management`}
              className="rounded text-left underline-offset-2 outline-none hover:underline hover:text-primary focus-visible:underline">
              {row.client_name}
            </button>
          ) : <span>{row.client_name}</span>}
        </td>
      ) : null}
      {showCol('hours_this_week') ? (
        <td className="px-4 py-3 tabular-nums text-foreground">{Math.round(Number(row.hours_this_week))}h</td>
      ) : null}
      {showCol('budget') ? (
        <td className="px-4 py-3 text-muted-foreground">{row.budget_pct != null ? `${row.budget_pct}%` : 'N/A'}</td>
      ) : null}
      <td className="px-4 py-3">
        <TonePill tone={meta.tone}>{meta.label}</TonePill>
      </td>
    </tr>
  );
}

// Health-column filter: a chevron that opens a menu of the health states. Picking
// one floats clients/projects of that health to the top (handled by the parent).
// The menu is portaled to <body> with fixed positioning so it escapes the table's
// `overflow-x-auto` scroll container (which would otherwise clip it and spawn a
// stray scrollbar) and floats over the rows instead of pushing them down.
function HealthFilterMenu({ value, onChange }: { value: ProjectHealth | null; onChange: (h: ProjectHealth | null) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  // Anchor the fixed menu to the button's current viewport rect.
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const close = () => setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    // Reposition/dismiss if the page scrolls or resizes under the open menu.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <span className="inline-block">
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label="Filter by health"
        className={cn('grid h-4 w-4 place-items-center rounded transition-colors hover:text-foreground',
          value ? 'text-primary' : 'text-muted-foreground')}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 60 }}
              className="w-40 rounded-xl border border-border bg-popover p-1 text-left text-popover-foreground shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <button type="button" onClick={() => { onChange(null); setOpen(false); }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-normal normal-case tracking-normal hover:bg-primary/5">
                <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                <span className="flex-1">All</span>
                {value == null ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
              </button>
              {HEALTH_FILTER_ORDER.map((h) => {
                const m = HEALTH_META[h];
                return (
                  <button key={h} type="button" onClick={() => { onChange(h); setOpen(false); }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-normal normal-case tracking-normal hover:bg-primary/5">
                    <span className={cn('h-2 w-2 rounded-full', m.dot)} />
                    <span className="flex-1">{m.label}</span>
                    {value === h ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

function ProjectMatrixCard({ data, columns = [] }: { data: TeamProjectMatrix; columns?: string[] }) {
  const navigate = useNavigate();
  // columns = hidden column keys for this tile (from user prefs).
  const showProjects = !columns.includes('projects');
  const showRevenue = !columns.includes('revenue');
  const rows = data.rows.filter((r) => Number(r.total_hours) > 0);
  // Paginate the PEOPLE only. Columns and the tfoot totals use the full set.
  const { pageItems, page, pages, total, start, end, setPage } = useClientPagination(rows, MATRIX_PAGE_SIZE);
  // Max single-cell hours drives the heat scale — computed across ALL rows so
  // the color scale is stable page to page, not relative to the visible page.
  let maxCell = 0;
  for (const r of rows) for (const c of r.cells) maxCell = Math.max(maxCell, Number(c.hours));
  const heat = (h: number): React.CSSProperties =>
    h > 0 && maxCell > 0 ? { backgroundColor: `hsl(var(--primary) / ${(0.08 + 0.32 * (h / maxCell)).toFixed(3)})` } : {};
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-semibold text-foreground">Project hours by person</p>
        <div className="flex items-center gap-3">
          <p className="hidden text-xs text-muted-foreground sm:block">hours: last {data.days_back}d · revenue: all-time · approved</p>
          <button
            type="button"
            onClick={() => navigate('/insights?tab=resourcing')}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.04]"
          >
            View all resources <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="table-header-row">
              <th className="table-header-cell">Person</th>
              {showProjects && data.projects.map((p) => (
                <th key={p.project_id} className="table-header-cell text-right" title={`${p.project_name} (${p.client_name}) · ${Number(p.total_hours)}h`}>
                  {p.project_name}
                </th>
              ))}
              <th className="table-header-cell text-right"><InfoLabel label="Total" /></th>
              {showRevenue && <th className="table-header-cell text-right"><InfoLabel label="Revenue" /></th>}
            </tr>
          </thead>
          <tbody>
            {pageItems.map((r) => (
              <tr key={r.user_id} className="border-b border-border/60">
                <td className="px-4 py-2 text-foreground">
                  <button
                    type="button"
                    onClick={() => navigate(`/insights?tab=resourcing&resource=${r.user_id}`)}
                    className="block text-left leading-tight hover:text-primary hover:underline"
                  >
                    {r.full_name}
                  </button>
                  {r.title ? <span className="block text-[11px] leading-tight text-muted-foreground">{r.title}</span> : null}
                </td>
                {showProjects && r.cells.map((c) => {
                  const h = Number(c.hours);
                  return (
                    <td key={c.project_id} className={cn('px-3 py-2 text-right tabular-nums', h > 0 ? 'text-foreground' : 'text-muted-foreground/30')} style={heat(h)}>
                      {h > 0 ? `${h}h` : '·'}
                    </td>
                  );
                })}
                <td className="px-4 py-2 text-right font-semibold tabular-nums text-foreground">{Number(r.total_hours)}h</td>
                {showRevenue && <td className="px-4 py-2 text-right tabular-nums text-foreground">{Number(r.revenue) > 0 ? fmtMoney(r.revenue) : '·'}</td>}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border text-[11px] text-muted-foreground">
              <td className="px-4 py-2 font-semibold uppercase tracking-wider">Project total</td>
              {showProjects && data.projects.map((p) => (
                <td key={p.project_id} className="px-3 py-2 text-right tabular-nums">{Number(p.total_hours)}h</td>
              ))}
              <td className="px-4 py-2 text-right font-semibold tabular-nums text-foreground">{Number(data.grand_total_hours)}h</td>
              {showRevenue && <td className="px-4 py-2 text-right font-semibold tabular-nums text-foreground">{fmtMoney(rows.reduce((s, r) => s + Number(r.revenue), 0))}</td>}
            </tr>
          </tfoot>
        </table>
      </div>
      <Pager page={page} pages={pages} total={total} start={start} end={end} onPage={setPage} unit="people" />
    </Card>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  // Which week the team-at-a-glance stats show: 0 = current, -1 = last week, …
  const [weekOffset, setWeekOffset] = useState(0);
  const team = useManagerTeamOverview(true, weekOffset);
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
  const [customizeOpen, setCustomizeOpen] = useState(false);
  // Drill-down report modals for the inline tiles (matrix owns its own).
  // Per-user tile customization (show/hide, order, columns). Persisted server-side.
  const dashPrefs = useManagerDashboardPrefs();
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
            {/* Week stepper: look back at previous weeks' team stats. Team view
                only — the per-week roster/tiles come from the team overview. */}
            {!noTeamAccess && managerView === 'team' ? (
              <WeekToggle
                offset={weekOffset}
                onChange={setWeekOffset}
                weekStart={overview?.week_start}
                weekEnd={overview?.week_end}
              />
            ) : null}
            {/* Customize: tailor which tiles show, their order, and columns. */}
            {!noTeamAccess && managerView === 'team' ? (
              <button
                type="button"
                onClick={() => setCustomizeOpen(true)}
                title="Customize dashboard"
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <SlidersHorizontal className="h-4 w-4" /> Customize
              </button>
            ) : null}
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
        <div className="space-y-5" role="status" aria-label="Loading dashboard">
          {/* Mirror the real layout: a row of stat tiles over the project table. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-2xl" />
            ))}
          </div>
          <Card className="overflow-hidden p-0">
            <TableSkeleton rows={5} cols={5} />
          </Card>
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
              info={infoTextFor('Team on track')}
              hint={weekOffset < 0 ? 'full week' : 'as of today'}
            />
            <StatTile
              Icon={Clock}
              tone="amber"
              value={pending}
              label="Approvals pending"
              info={infoTextFor('Approvals pending')}
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
              label={weekOffset < 0 ? 'PTO that week' : 'PTO this week'}
              info={infoTextFor('PTO this week')}
              hint={`${overview?.pending_time_off_count ?? 0} requests pending`}
            />
            <StatTile
              Icon={CheckCircle2}
              tone="emerald"
              value={overview?.rejected_recent_count ?? 0}
              label="Recent rejections"
              info={infoTextFor('Recent rejections')}
              hint={overview?.rejected_recent_count ? 'needs follow-up' : 'all clear'}
            />
          </div>

          {/* Tiles render in the user's customized order, hidden ones skipped.
              Each tile's JSX is keyed in tileNodes; the registry/prefs drive
              which appear and in what sequence. */}
          {(() => {
            const tileNodes: Partial<Record<ManagerTileKey, React.ReactNode>> = {};

            tileNodes['project-health'] = (
              <ProjectsWidget
                rows={projects.data?.rows ?? []}
                loading={projects.isLoading}
                showCol={(c) => !dashPrefs.isColumnHidden('project-health', c)}
                onNavigate={navigate}
              />
            );

            // Project hours by person: approved hours per person per project.
            tileNodes['project-matrix'] = projectMatrix.data && projectMatrix.data.projects.length > 0 ? (
            <ProjectMatrixCard data={projectMatrix.data} columns={dashPrefs.prefs.hiddenColumns['project-matrix'] ?? []} />
          ) : null;

            // Financials — real revenue from approved time x resolved rates.
            tileNodes['financials'] = financials.data && financials.data.projects.length > 0 ? (
              <FinancialsWidget
                data={financials.data}
                showCol={(c) => !dashPrefs.isColumnHidden('financials', c)}
                onNavigate={navigate}
              />
            ) : null;

            // Daily standup: yesterday's submission status.
            tileNodes['daily'] = daily.data && daily.data.team_size > 0 ? (
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
          ) : null;

            // Team quality stats — Billable, On-time in a 2-up grid. Each
            // collapses to a one-line summary when there's no variation worth a
            // full list. (Rejections card removed.)
            tileNodes['quality'] = (billable.data || onTime.data) ? (
            <div className="grid gap-4 md:grid-cols-2">
              {billable.data && billable.data.rows.some((r) => Number(r.approved_hours) > 0)
                ? <BillableCard data={billable.data} />
                : null}
              {onTime.data && onTime.data.rows.some((r) => r.weeks_with_activity > 0)
                ? <OnTimeCard data={onTime.data} />
                : null}
            </div>
          ) : null;

            // Team roster — collapsible, per-person status with summary pills.
            // Rows link to My Team for follow-up.
            tileNodes['roster'] = overview && overview.members.length > 0 ? (
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
                            {loggedDays}/{m.working_days_in_week} days logged {weekOffset < 0 ? 'that week' : 'this week'}
                            {loggedDays > m.submitted_days ? ` · ${m.submitted_days} submitted` : ''}
                            {weekOffset === 0 && m.upcoming_pto_starts_at ? ` · PTO from ${m.upcoming_pto_starts_at}` : ''}
                          </p>
                        </div>
                        <TonePill tone={tone}>{label}</TonePill>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </Card>
          ) : null;

            // Emit tiles in the user's order, skipping hidden ones.
            return dashPrefs.prefs.order
              .filter((k) => !dashPrefs.isHidden(k))
              .map((k) => <Fragment key={k}>{tileNodes[k]}</Fragment>);
          })()}
        </>
      )}

      <ManagerDashboardCustomizer open={customizeOpen} onClose={() => setCustomizeOpen(false)} />
    </div>
  );
}
