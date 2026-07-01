import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3, Layers, LayoutDashboard, Loader2, Search, SlidersHorizontal, TrendingUp } from 'lucide-react';

import { Input, Pager, Tooltip, WorkspaceHeader } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/cn';
import { useClientPagination } from '@/hooks/useClientPagination';
import { useEvm, useManagerFinancials, usePortfolio, useRevenueRecognition, useTeamResourcing } from '@/hooks/useDashboard';
import { DashboardsTab } from '@/components/insights/DashboardsTab';
import { ResourceDetailPanel } from '@/components/insights/ResourceDetailPanel';
import { FinancialsReport } from '@/components/dashboard/reports/FinancialsReport';
import { InfoLabel, HealthInfoLabel } from '@/components/dashboard/InfoLabel';
import { HealthRulesModal } from '@/components/dashboard/HealthRulesModal';
import { fmtMoney } from '@/lib/format';
import { healthMeta } from '@/lib/projectHealth';

// A clickable client cell that routes to the client's page. Shared by the
// Insights tables so client names behave consistently.
function ClientLink({ clientId, name }: { clientId?: number | null; name: string }) {
  const navigate = useNavigate();
  if (!clientId) return <span className="text-[11px] text-muted-foreground">{name}</span>;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); navigate(`/client-management?client=${clientId}`); }}
      className="text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
    >
      {name}
    </button>
  );
}

// PSA "Insights" — the manager/viewer analytics section. Holds Financials,
// Resourcing, Portfolio, and Forecasts as the program builds them out. Admin
// is intentionally excluded (they manage the workspace, not the money), and
// employees never see it. Gated again here in case of direct navigation.
export type InsightTab = 'financials' | 'resourcing' | 'portfolio' | 'forecasts' | 'dashboards';

const TABS: { key: InsightTab; label: string; Icon: typeof BarChart3 }[] = [
  // Projects is the primary/first tab. key stays 'portfolio' (route/deep-link
  // stability); label is "Projects".
  { key: 'portfolio', label: 'Projects', Icon: TrendingUp },
  { key: 'financials', label: 'Financials', Icon: BarChart3 },
  { key: 'resourcing', label: 'Resources', Icon: Layers },
  // Forecasts tab disabled for now (kept the component + route for later).
  { key: 'dashboards', label: 'Dashboards', Icon: LayoutDashboard },
];

const VALID_TABS = new Set<InsightTab>(TABS.map((t) => t.key));

export function InsightsPage() {
  const { user } = useAuth();
  // The active tab lives in the URL (?tab=) so deep-links from the dashboard
  // land on the right tab AND the project-report "Back" can return to it.
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') as InsightTab | null;
  const tab: InsightTab = raw && VALID_TABS.has(raw) ? raw : 'portfolio';
  const setTab = (key: InsightTab) => setParams({ tab: key }, { replace: true });

  // Manager + viewer only.
  if (!user || (user.role !== 'MANAGER' && user.role !== 'VIEWER')) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        title="Insights"
        description="Project, financial and capacity analytics for your projects."
      />

      <div className="flex gap-1 border-b border-border">
        {TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              'flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors',
              tab === key
                ? 'rounded-t-lg bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {tab === 'financials' ? <FinancialsTab />
        : tab === 'resourcing' ? <ResourcingTab />
        : tab === 'dashboards' ? <DashboardsTab />
        : <PortfolioTab />}
    </div>
  );
}

// CPI/SPI tone: >=1 good (emerald), >=0.9 warn (amber), else bad (rose).
function indexTone(v: number | null | undefined): string {
  if (v == null) return 'text-muted-foreground';
  if (v >= 1) return 'text-emerald-600 dark:text-emerald-400';
  if (v >= 0.9) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}

// Exported (not rendered) so it's preserved for when the Forecasts tab is
// re-enabled; the tab is currently disabled in TABS above.
export function ForecastsTab() {
  const q = useEvm();
  const navigate = useNavigate();
  if (q.isLoading) {
    return <div className="grid place-items-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>;
  }
  const d = q.data;
  if (!d || d.rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-16 text-center">
        <p className="text-base font-semibold text-foreground">Earned value (EVM)</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">Set a baseline (planned hours, cost and dates) on a project to track planned vs. earned vs. actual value, CPI/SPI and variance here.</p>
      </div>
    );
  }
  const highRisk = d.rows.filter((r) => r.risk === 'high').length;
  const medRisk = d.rows.filter((r) => r.risk === 'medium').length;
  const riskMeta = (r: string) =>
    r === 'high' ? { label: 'High', cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-400' }
      : r === 'medium' ? { label: 'Medium', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' }
        : { label: 'Low', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <SummaryStat label="High risk" value={highRisk} tone="rose" hint="overrun + behind" />
        <SummaryStat label="Medium risk" value={medRisk} tone="amber" hint="cost or schedule slip" />
        <SummaryStat label="On track" value={d.rows.length - highRisk - medRisk} tone="emerald" hint="forecast within plan" />
      </div>
      <EvmLegend />
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2 font-semibold">Project</th>
                <th className="px-4 py-2 text-right font-semibold">% done</th>
                <th className="px-4 py-2 text-right font-semibold"><InfoLabel label="Earned (EV)" side="bottom" /></th>
                <th className="px-4 py-2 text-right font-semibold"><InfoLabel label="Actual (AC)" side="bottom" /></th>
                <th className="px-4 py-2 text-right font-semibold"><InfoLabel label="CPI" side="bottom" /></th>
                <th className="px-4 py-2 text-right font-semibold"><InfoLabel label="SPI" side="bottom" /></th>
                <th className="px-4 py-2 text-right font-semibold"><InfoLabel label="Forecast (EAC)" side="bottom" /></th>
                <th className="px-4 py-2 text-center font-semibold"><InfoLabel label="Risk" side="bottom" /></th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => {
                const rm = riskMeta(r.risk);
                return (
                  <tr
                    key={r.project_id}
                    onClick={() => navigate(`/insights/project/${r.project_id}?from=forecasts`)}
                    className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-foreground/[0.03]"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{r.project_name}</div>
                      <div className="text-[11px] text-muted-foreground">{r.client_name}</div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-foreground">{r.percent_complete}%</td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-foreground">{fmtMoney(r.ev, r.currency)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{fmtMoney(r.ac, r.currency)}</td>
                    <td className={cn('px-4 py-3 text-right tabular-nums font-semibold', indexTone(r.cpi))}>{r.cpi != null ? r.cpi.toFixed(2) : '—'}</td>
                    <td className={cn('px-4 py-3 text-right tabular-nums font-semibold', indexTone(r.spi))}>{r.spi != null ? r.spi.toFixed(2) : '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <span className="text-foreground">{fmtMoney(r.eac, r.currency)}</span>
                      {r.projected_overrun_pct > 0 ? <span className="ml-1 text-[11px] text-rose-600 dark:text-rose-400">+{r.projected_overrun_pct}%</span> : null}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', rm.cls)}>{rm.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Plain-English legend for the earned-value columns — the terms (PV/EV/AC,
// CPI/SPI, EAC) are jargon, so spell them out under the table.
function EvmLegend() {
  const items: [string, string][] = [
    ['PV — Planned value', 'Budget that should be earned by now, per the baseline schedule.'],
    ['EV — Earned value', 'Budget × % of work actually complete. The value delivered so far.'],
    ['AC — Actual cost', 'Real labour cost incurred to date.'],
    ['CPI', 'Earned ÷ Actual. ≥ 1 = under cost, < 1 = over cost.'],
    ['SPI', 'Earned ÷ Planned. ≥ 1 = ahead of schedule, < 1 = behind.'],
    ['EAC — Forecast', 'Projected final cost at the current pace (budget ÷ CPI). +x% = projected overrun vs. budget.'],
    ['Risk', 'High = projected overrun AND behind. Medium = one of the two. Low = on plan.'],
  ];
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="mb-2 text-xs font-semibold text-foreground">What the columns mean</p>
      <dl className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
        {items.map(([term, def]) => (
          <div key={term} className="flex gap-2">
            <dt className="shrink-0 font-medium text-foreground">{term}</dt>
            <dd className="text-muted-foreground">{def}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function marginColor(pct: number | null | undefined): string {
  if (pct == null) return 'text-muted-foreground';
  if (pct >= 40) return 'text-emerald-600 dark:text-emerald-400';
  if (pct >= 15) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}

function PortfolioTab() {
  const q = usePortfolio();
  const navigate = useNavigate();
  const [rulesOpen, setRulesOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Filter the portfolio rows by project name, client name, or health label
  // (so typing "critical" / "blocked" narrows to that health). Summary stats
  // stay portfolio-wide; only the table responds to the search.
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const all = q.data?.rows ?? [];
    if (!term) return all;
    return all.filter((r) =>
      r.project_name.toLowerCase().includes(term)
      || (r.client_name ?? '').toLowerCase().includes(term)
      || healthMeta(r.health).label.toLowerCase().includes(term));
  }, [q.data, search]);
  if (q.isLoading) {
    return <div className="grid place-items-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>;
  }
  const d = q.data;
  if (!d || d.rows.length === 0) {
    return (
      <>
        <div className="mb-3 flex justify-end"><HealthRulesButton onClick={() => setRulesOpen(true)} /></div>
        <div className="rounded-2xl border border-border bg-card px-6 py-16 text-center text-sm text-muted-foreground">
          No projects with approved time yet. The portfolio shows health, margin and budget across your book of work.
        </div>
        <HealthRulesModal open={rulesOpen} onClose={() => setRulesOpen(false)} />
      </>
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryStat label="Critical" value={d.critical} tone="rose" hint="over budget / overdue" />
        <SummaryStat label="Blocked" value={d.blocked} tone="violet" hint="has a blocked task" />
        <SummaryStat label="At risk" value={d.at_risk} tone="amber" hint="near end / high burn" />
        <SummaryStat label="On track" value={d.on_track} tone="sky" hint="on budget & schedule" />
        <SummaryStat label="Excellent" value={d.excellent} tone="emerald" hint="comfortably ahead" />
        <SummaryStat label="Total margin" value={d.total_margin_pct ?? 0} tone="sky" hint="across the portfolio" suffix="%" />
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-foreground">All projects</p>
            <p className="text-xs text-muted-foreground">{d.project_count} projects · sorted by attention</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative w-44 sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-8 pl-8 text-xs"
                placeholder="Search projects, clients, health..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <HealthRulesButton onClick={() => setRulesOpen(true)} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2 font-semibold">Project</th>
                <th className="px-4 py-2 font-semibold">
                  <HealthInfoLabel />
                </th>
                <th className="px-4 py-2 text-right font-semibold"><InfoLabel label="Revenue" side="bottom" /></th>
                <th className="px-4 py-2 text-right font-semibold"><InfoLabel label="Margin" side="bottom" /></th>
                <th className="px-4 py-2 text-right font-semibold"><InfoLabel label="Budget %" infoKey="budget burn" side="bottom" /></th>
                <th className="px-4 py-2 text-right font-semibold">Ends in</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">No projects match your search.</td></tr>
              ) : null}
              {rows.map((r) => {
                const h = healthMeta(r.health);
                const pill = (
                  <span className="inline-flex cursor-help items-center gap-1.5">
                    <span className={cn('h-2 w-2 rounded-full', h.dot)} />
                    <span className={cn('text-xs font-medium', h.text)}>{h.label}</span>
                  </span>
                );
                return (
                  <tr
                    key={r.project_id}
                    onClick={() => navigate(`/insights/project/${r.project_id}?from=portfolio`)}
                    className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-foreground/[0.03]"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{r.project_name}</div>
                      <ClientLink clientId={r.client_id} name={r.client_name} />
                    </td>
                    <td className="px-4 py-3">
                      {r.health_reason
                        ? <Tooltip label={r.health_reason} side="top" maxWidth={240}>{pill}</Tooltip>
                        : pill}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-foreground">{fmtMoney(r.revenue, r.currency)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {r.margin_pct != null ? <span className={cn('font-semibold', marginColor(r.margin_pct))}>{r.margin_pct}%</span> : <span className="text-muted-foreground">N/A</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {r.budget_used_pct != null ? <span className={r.budget_used_pct > 100 ? 'text-rose-600 dark:text-rose-400' : r.budget_used_pct > 80 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}>{r.budget_used_pct}%</span> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {r.days_until_end != null ? (r.days_until_end < 0 ? `${Math.abs(r.days_until_end)}d overdue` : `${r.days_until_end}d`) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <HealthRulesModal open={rulesOpen} onClose={() => setRulesOpen(false)} />
    </div>
  );
}

function HealthRulesButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <SlidersHorizontal className="h-3.5 w-3.5" /> Health Config
    </button>
  );
}

type CapacityFilter = 'all' | 'over' | 'ok' | 'under';

function ResourcingTab() {
  const q = useTeamResourcing(8);
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CapacityFilter>('all');
  const [openUser, setOpenUser] = useState<{ id: number; name: string } | null>(null);

  const d = q.data;

  // Deep-link: ?resource=<userId> opens that person's detail panel (used by the
  // dashboard's "project hours by person" widget). Resolve the name from the
  // loaded rows once available.
  const resourceParam = params.get('resource');
  useEffect(() => {
    if (!resourceParam || !d) return;
    const id = Number(resourceParam);
    const row = d.rows.find((r) => r.user_id === id);
    if (row) setOpenUser({ id, name: row.full_name });
    // Clear the param so closing the panel doesn't reopen on re-render.
    const next = new URLSearchParams(params);
    next.delete('resource');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceParam, d]);
  // Filter by the selected capacity bucket (KPI tile), then by the search term
  // (name / title / allocated project).
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    let all = d?.rows ?? [];
    // Capacity buckets only apply to internal team members — client-side rows
    // carry no capacity, so any active bucket filter hides them.
    if (filter !== 'all') all = all.filter((r) => !r.is_client && r.state === filter);
    if (term) {
      all = all.filter((r) =>
        r.full_name.toLowerCase().includes(term)
        || (r.title ?? '').toLowerCase().includes(term)
        || r.allocations.some((a) => a.project_name.toLowerCase().includes(term))
        || (r.project_names ?? []).some((n) => n.toLowerCase().includes(term)));
    }
    return all;
  }, [d, search, filter]);

  // Paginate the (filtered) list so the page shows a fixed number of rows and
  // the rest go to the next page. Page size shrinks when the detail panel is
  // open so the narrower list still fits without scrolling the whole page.
  const pageSize = openUser != null ? 8 : 12;
  const { pageItems, page, pages, total, start, end, setPage } = useClientPagination(rows, pageSize);
  // Reset to the first page whenever the filter/search changes the result set.
  useEffect(() => { setPage(1); }, [search, filter]);

  if (q.isLoading) {
    return <div className="grid place-items-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>;
  }
  if (!d || d.rows.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card px-6 py-16 text-center text-sm text-muted-foreground">
        No capacity data yet. Allocate people to projects to plan capacity and track utilization.
      </div>
    );
  }
  const stateMeta = (s: string) =>
    s === 'over' ? { label: 'Over capacity', bar: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400' }
      : s === 'under' ? { label: 'Available capacity', bar: 'bg-sky-500', text: 'text-sky-600 dark:text-sky-400' }
        : { label: 'At target capacity', bar: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' };
  const panelOpen = openUser != null;
  return (
    <div className="space-y-4">
      {/* summary — capacity utilization buckets for the upcoming window. Each
          tile is a filter: click to show only that bucket; click again to clear. */}
      <div className="grid grid-cols-3 gap-3">
        <SummaryStat label="Over capacity" value={d.over_allocated} tone="rose" hint="Allocated above 100%"
          active={filter === 'over'} onClick={() => setFilter((f) => (f === 'over' ? 'all' : 'over'))} />
        <SummaryStat label="At target capacity" value={d.team_size - d.over_allocated - d.under_utilized} tone="emerald" hint="60–100% allocated"
          active={filter === 'ok'} onClick={() => setFilter((f) => (f === 'ok' ? 'all' : 'ok'))} />
        <SummaryStat label="Available capacity" value={d.under_utilized} tone="sky" hint="Below 60% allocated"
          active={filter === 'under'} onClick={() => setFilter((f) => (f === 'under' ? 'all' : 'under'))} />
      </div>
      {/* List + (when open) an in-flow detail panel beside it: the list shrinks
          to make room, and rows stay clickable so you can switch employees. */}
      <div className="flex items-start gap-4">
        {/* When the detail panel is open the list and panel split the row 50/50
            (both flex-1 basis-0); when closed the list takes the full width. */}
        <div className={cn('min-w-0 rounded-2xl border border-border bg-card', panelOpen ? 'flex-1 basis-0' : 'flex-1')}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-foreground">Team capacity for the next {d.weeks_ahead} weeks</p>
              <p className="text-xs text-muted-foreground">
                {d.team_size} team {d.team_size === 1 ? 'member' : 'members'}
                {d.client_count ? ` · ${d.client_count} client-side` : ''} · capacity for the team, task progress for client resources · select a row for details
                {filter !== 'all' ? (
                  <button type="button" onClick={() => setFilter('all')} className="ml-2 text-primary hover:underline">Clear filter</button>
                ) : null}
              </p>
            </div>
            <div className="relative w-44 sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-8 pl-8 text-xs" placeholder="Search people or projects..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
          <div className="divide-y divide-border">
            {rows.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">No people match {search.trim() ? 'your search' : 'this filter'}.</p>
            ) : pageItems.map((r) => {
              const active = openUser?.id === r.user_id;
              // Client-side resources: no allocation/billing — show task progress.
              if (r.is_client) {
                const total = r.task_total ?? 0;
                const done = r.task_done ?? 0;
                const pct = r.progress_pct ?? 0;
                return (
                  <button type="button" key={r.user_id} onClick={() => setOpenUser({ id: r.user_id, name: r.full_name })}
                    className={cn('flex w-full items-center gap-4 px-4 py-2.5 text-left transition-colors', active ? 'bg-primary/10' : 'hover:bg-foreground/[0.03]')}>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                        {r.full_name}
                        <span className="shrink-0 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">Client</span>
                        {r.title ? <span className="truncate text-xs font-normal text-muted-foreground">{r.title}</span> : null}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {(r.project_names ?? []).join(' · ') || 'No project tasks yet'}
                      </p>
                    </div>
                    {/* Task-progress bar instead of a capacity bar. */}
                    <div className={cn('h-2 shrink-0 overflow-hidden rounded-full bg-muted', panelOpen ? 'w-24' : 'w-40')}>
                      <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                    <div className={cn('shrink-0 text-right text-sm font-semibold tabular-nums text-foreground', panelOpen ? 'w-20' : 'w-28')}>
                      {total ? `${done}/${total}` : '—'}
                      <span className="ml-1 block text-[10px] font-normal text-muted-foreground">{total ? `${pct}% done` : 'no tasks'}</span>
                    </div>
                  </button>
                );
              }
              const m = stateMeta(r.state);
              // 100% = a full bar. Over-capacity stays full (it can't exceed the
              // track) and is signalled by the rose colour + the % label.
              const width = Math.min(r.allocated_pct, 100);
              return (
                <button type="button" key={r.user_id} onClick={() => setOpenUser({ id: r.user_id, name: r.full_name })}
                  className={cn('flex w-full items-center gap-4 px-4 py-2.5 text-left transition-colors', active ? 'bg-primary/10' : 'hover:bg-foreground/[0.03]')}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{r.full_name}{r.title ? <span className="ml-1.5 text-xs text-muted-foreground">{r.title}</span> : null}</p>
                    {r.allocations.length ? (
                      <p className="truncate text-[11px] text-muted-foreground">{r.allocations.map((a) => `${a.project_name} ${a.percent}%`).join(' · ')}</p>
                    ) : <p className="text-[11px] text-muted-foreground/70">No allocations — available</p>}
                  </div>
                  {/* Allocation bar — narrower when the panel is open so the row
                      stays balanced in the narrower list. */}
                  <div className={cn('h-2 shrink-0 overflow-hidden rounded-full bg-muted', panelOpen ? 'w-24' : 'w-40')}>
                    <div className={cn('h-full rounded-full', m.bar)} style={{ width: `${width}%` }} />
                  </div>
                  <div className={cn('shrink-0 text-right text-sm font-semibold tabular-nums', panelOpen ? 'w-20' : 'w-28', m.text)}>
                    {r.allocated_pct}%
                    <span className="ml-1 block text-[10px] font-normal text-muted-foreground">{m.label}</span>
                  </div>
                </button>
              );
            })}
          </div>
          {pages > 1 ? (
            <Pager page={page} pages={pages} total={total} start={start} end={end} onPage={setPage} unit="people" />
          ) : null}
        </div>
        {panelOpen ? (
          <ResourceDetailPanel userId={openUser.id} name={openUser.name} onClose={() => setOpenUser(null)} />
        ) : null}
      </div>
    </div>
  );
}

function SummaryStat({ label, value, tone, hint, suffix, onClick, active }: {
  label: string; value: number; tone: 'rose' | 'emerald' | 'sky' | 'amber' | 'violet'; hint: string;
  suffix?: string; onClick?: () => void; active?: boolean;
}) {
  const toneCls = tone === 'rose' ? 'text-rose-600 dark:text-rose-400'
    : tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'amber' ? 'text-amber-600 dark:text-amber-400'
    : tone === 'violet' ? 'text-primary'
    : 'text-sky-600 dark:text-sky-400';
  const inner = (
    <>
      <p className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
        {active ? <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium normal-case text-primary">Filtered</span> : null}
      </p>
      <p className={cn('mt-1 text-2xl font-bold tabular-nums', toneCls)}>{value}{suffix ?? ''}</p>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </>
  );
  if (!onClick) {
    return <div className="rounded-2xl border border-border bg-card px-4 py-3">{inner}</div>;
  }
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn('rounded-2xl border bg-card px-4 py-3 text-left transition-colors hover:border-primary/40',
        active ? 'border-primary ring-1 ring-primary/30' : 'border-border')}>
      {inner}
    </button>
  );
}

function FinancialsTab() {
  const q = useManagerFinancials();
  const rr = useRevenueRecognition();

  if (q.isLoading) {
    return <div className="grid place-items-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>;
  }
  if (!q.data || q.data.projects.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card px-6 py-16 text-center text-sm text-muted-foreground">
        No financial data yet. Approve some time on budgeted projects to see revenue, cost and margins here.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-card p-4">
        <FinancialsReport data={q.data} revrec={rr.data} />
      </div>
    </div>
  );
}

