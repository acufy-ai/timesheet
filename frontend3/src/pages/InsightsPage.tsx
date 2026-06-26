import { useMemo, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3, CalendarRange, Layers, Loader2, SlidersHorizontal, TrendingUp } from 'lucide-react';

import { Tooltip, WorkspaceHeader } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/cn';
import { useEvm, useManagerFinancials, usePortfolio, useRevenueRecognition, useTeamResourcing } from '@/hooks/useDashboard';
import { FinancialsReport } from '@/components/dashboard/reports/FinancialsReport';
import { InfoLabel, HealthInfoLabel } from '@/components/dashboard/InfoLabel';
import { HealthRulesModal } from '@/components/dashboard/HealthRulesModal';
import { fmtMoney } from '@/lib/format';

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
export type InsightTab = 'financials' | 'resourcing' | 'portfolio' | 'forecasts';

const TABS: { key: InsightTab; label: string; Icon: typeof BarChart3 }[] = [
  { key: 'financials', label: 'Financials', Icon: BarChart3 },
  { key: 'resourcing', label: 'Resourcing', Icon: Layers },
  // key stays 'portfolio' (route/deep-link stability); label is "Projects".
  { key: 'portfolio', label: 'Projects', Icon: TrendingUp },
  { key: 'forecasts', label: 'Forecasts', Icon: CalendarRange },
];

const VALID_TABS = new Set<InsightTab>(TABS.map((t) => t.key));

export function InsightsPage() {
  const { user } = useAuth();
  // The active tab lives in the URL (?tab=) so deep-links from the dashboard
  // land on the right tab AND the project-report "Back" can return to it.
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') as InsightTab | null;
  const tab: InsightTab = raw && VALID_TABS.has(raw) ? raw : 'financials';
  const setTab = (key: InsightTab) => setParams({ tab: key }, { replace: true });

  // Manager + viewer only.
  if (!user || (user.role !== 'MANAGER' && user.role !== 'VIEWER')) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        title="Insights"
        description="Financial, resourcing and portfolio analytics for your projects."
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
        : tab === 'portfolio' ? <PortfolioTab />
        : <ForecastsTab />}
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

function ForecastsTab() {
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

const HEALTH_META: Record<string, { label: string; dot: string; text: string }> = {
  'needs-attention': { label: 'Needs attention', dot: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400' },
  'at-risk': { label: 'At risk', dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  good: { label: 'Good', dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
  'not-set': { label: 'Not set', dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
};

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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryStat label="Needs attention" value={d.needs_attention} tone="rose" hint="over budget / overdue" />
        <SummaryStat label="At risk" value={d.at_risk} tone="amber" hint="near end / high burn" />
        <SummaryStat label="Good" value={d.good} tone="emerald" hint="on track" />
        <SummaryStat label="Total margin" value={d.total_margin_pct ?? 0} tone="sky" hint="across the portfolio" suffix="%" />
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-foreground">All projects</p>
            <p className="text-xs text-muted-foreground">{d.project_count} projects · sorted by attention</p>
          </div>
          <HealthRulesButton onClick={() => setRulesOpen(true)} />
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
                <th className="px-4 py-2 text-right font-semibold"><InfoLabel label="Budget burn" side="bottom" /></th>
                <th className="px-4 py-2 text-right font-semibold">Ends in</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => {
                const h = HEALTH_META[r.health] ?? HEALTH_META['not-set'];
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
      <SlidersHorizontal className="h-3.5 w-3.5" /> Health rules
    </button>
  );
}

function ResourcingTab() {
  const q = useTeamResourcing(8);
  if (q.isLoading) {
    return <div className="grid place-items-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>;
  }
  const d = q.data;
  if (!d || d.rows.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card px-6 py-16 text-center text-sm text-muted-foreground">
        No resourcing data yet. Allocate people to projects to plan capacity and spot over/under-utilization.
      </div>
    );
  }
  const stateMeta = (s: string) =>
    s === 'over' ? { label: 'Over-allocated', bar: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400' }
      : s === 'under' ? { label: 'Under-utilized', bar: 'bg-sky-500', text: 'text-sky-600 dark:text-sky-400' }
        : { label: 'On track', bar: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' };
  return (
    <div className="space-y-4">
      {/* summary */}
      <div className="grid grid-cols-3 gap-3">
        <SummaryStat label="Over-allocated" value={d.over_allocated} tone="rose" hint="above 100% capacity" />
        <SummaryStat label="On track" value={d.team_size - d.over_allocated - d.under_utilized} tone="emerald" hint="60–100% allocated" />
        <SummaryStat label="Under-utilized" value={d.under_utilized} tone="sky" hint="below 60% — bench" />
      </div>
      <div className="rounded-2xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-semibold text-foreground">Allocation next {d.weeks_ahead} weeks</p>
          <p className="text-xs text-muted-foreground">{d.team_size} people · planned allocation vs. weekly capacity</p>
        </div>
        <div className="divide-y divide-border">
          {d.rows.map((r) => {
            const m = stateMeta(r.state);
            const width = Math.min(r.allocated_pct, 150) / 1.5; // 150% maps to full bar
            return (
              <div key={r.user_id} className="flex items-center gap-4 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{r.full_name}{r.title ? <span className="ml-1.5 text-xs text-muted-foreground">{r.title}</span> : null}</p>
                  {r.allocations.length ? (
                    <p className="truncate text-[11px] text-muted-foreground">{r.allocations.map((a) => `${a.project_name} ${a.percent}%`).join(' · ')}</p>
                  ) : <p className="text-[11px] text-muted-foreground/70">No allocations — available</p>}
                </div>
                <div className="h-2 w-40 shrink-0 overflow-hidden rounded-full bg-muted">
                  <div className={cn('h-full rounded-full', m.bar)} style={{ width: `${width}%` }} />
                </div>
                <div className={cn('w-28 shrink-0 text-right text-sm font-semibold tabular-nums', m.text)}>
                  {r.allocated_pct}%
                  <span className="ml-1 block text-[10px] font-normal text-muted-foreground">{m.label}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SummaryStat({ label, value, tone, hint, suffix }: { label: string; value: number; tone: 'rose' | 'emerald' | 'sky' | 'amber'; hint: string; suffix?: string }) {
  const toneCls = tone === 'rose' ? 'text-rose-600 dark:text-rose-400'
    : tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'amber' ? 'text-amber-600 dark:text-amber-400'
    : 'text-sky-600 dark:text-sky-400';
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-2xl font-bold tabular-nums', toneCls)}>{value}{suffix ?? ''}</p>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function FinancialsTab() {
  const q = useManagerFinancials();
  // What-if levers: adjust bill / cost rates by a % and see margins recompute
  // live. Hypothetical only — never touches real data ("unlimited scenarios").
  const [billAdj, setBillAdj] = useState(0); // -50..+50 %
  const [costAdj, setCostAdj] = useState(0);
  const whatIf = billAdj !== 0 || costAdj !== 0;

  const adjusted = useMemo(() => {
    if (!q.data) return q.data;
    if (!whatIf) return q.data;
    const bf = 1 + billAdj / 100;
    const cf = 1 + costAdj / 100;
    const projects = q.data.projects.map((p) => {
      const revenue = Number(p.revenue) * bf;
      const cost = Number(p.cost ?? 0) * cf;
      const margin = revenue - cost;
      const margin_pct = revenue > 0 ? Math.round((margin / revenue) * 100) : null;
      const budget_used_pct = p.budget_amount && Number(p.budget_amount) > 0
        ? Math.round((revenue / Number(p.budget_amount)) * 100) : p.budget_used_pct;
      return { ...p, revenue, cost, margin, margin_pct, budget_used_pct };
    });
    const total_revenue = projects.reduce((s, p) => s + Number(p.revenue), 0);
    const total_cost = projects.reduce((s, p) => s + Number(p.cost ?? 0), 0);
    const total_margin = total_revenue - total_cost;
    const total_margin_pct = total_revenue > 0 ? Math.round((total_margin / total_revenue) * 100) : null;
    return { ...q.data, projects, summary: { ...q.data.summary, total_revenue, total_cost, total_margin, total_margin_pct } };
  }, [q.data, billAdj, costAdj, whatIf]);

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
  const baseMargin = q.data.summary.total_margin_pct ?? 0;
  const newMargin = adjusted?.summary.total_margin_pct ?? baseMargin;
  const baseMarginDollars = Number(q.data.summary.total_margin ?? 0);
  const newMarginDollars = Number(adjusted?.summary.total_margin ?? baseMarginDollars);
  return (
    <div className="space-y-4">
      <MarginSimulator
        billAdj={billAdj} costAdj={costAdj}
        onBill={setBillAdj} onCost={setCostAdj}
        active={whatIf}
        baseMarginPct={baseMargin} newMarginPct={newMargin}
        baseMarginDollars={baseMarginDollars} newMarginDollars={newMarginDollars}
        onReset={() => { setBillAdj(0); setCostAdj(0); }}
      />
      <div className="rounded-2xl border border-border bg-card p-4">
        <FinancialsReport data={adjusted ?? q.data} />
      </div>
      <RevenueRecognitionCard />
    </div>
  );
}

function RevenueRecognitionCard() {
  const q = useRevenueRecognition();
  if (q.isLoading || !q.data || q.data.rows.length === 0) return null;
  const d = q.data;
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Revenue recognition</p>
          <p className="text-xs text-muted-foreground">Recognized per each project's method (as-billed or % complete).</p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">Billed <span className="font-semibold text-foreground">{fmtMoney(d.total_billed)}</span></span>
          <span className="text-muted-foreground">Recognized <span className="font-semibold text-foreground">{fmtMoney(d.total_recognized)}</span></span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-2 font-semibold">Project</th>
              <th className="px-4 py-2 font-semibold">Method</th>
              <th className="px-4 py-2 text-right font-semibold">% complete</th>
              <th className="px-4 py-2 text-right font-semibold">Billed</th>
              <th className="px-4 py-2 text-right font-semibold">Recognized</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.project_id} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-3">
                  <div className="font-medium text-foreground">{r.project_name}</div>
                  <div className="text-[11px] text-muted-foreground">{r.client_name}</div>
                </td>
                <td className="px-4 py-3">
                  <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', r.method === 'percent_complete' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}>
                    {r.method === 'percent_complete' ? '% complete' : 'As billed'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{r.percent_complete != null ? `${r.percent_complete}%` : '—'}</td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{fmtMoney(r.billed, r.currency)}</td>
                <td className="px-4 py-3 text-right tabular-nums font-semibold text-foreground">{fmtMoney(r.recognized, r.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Margin simulator: model how rate changes move the portfolio margin. The
// outcome (today -> simulated margin, in points AND dollars) is the hero; the
// two rate levers sit underneath in the same surface so cause and effect read
// as one object. Hypothetical only — nothing is saved.
function MarginSimulator({
  billAdj, costAdj, onBill, onCost, active,
  baseMarginPct, newMarginPct, baseMarginDollars, newMarginDollars, onReset,
}: {
  billAdj: number; costAdj: number;
  onBill: (v: number) => void; onCost: (v: number) => void;
  active: boolean;
  baseMarginPct: number; newMarginPct: number;
  baseMarginDollars: number; newMarginDollars: number;
  onReset: () => void;
}) {
  const ptsDelta = newMarginPct - baseMarginPct;
  const dollarDelta = newMarginDollars - baseMarginDollars;
  const up = ptsDelta > 0;
  const down = ptsDelta < 0;
  const deltaColor = up ? 'text-emerald-600 dark:text-emerald-400'
    : down ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground';

  return (
    <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-bold text-foreground">Margin simulator</h2>
          <p className="text-xs text-muted-foreground">
            Move your bill or cost rates to see where total margin would land. Nothing here is saved.
          </p>
        </div>
        {active ? (
          <button
            type="button" onClick={onReset}
            className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Reset to today
          </button>
        ) : null}
      </div>

      {/* Outcome headline — the thesis. Today (anchor) -> simulated (hero). */}
      <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Today</p>
          <p className="font-display text-3xl font-bold tabular-nums text-muted-foreground">{baseMarginPct}%</p>
          <p className="text-xs tabular-nums text-muted-foreground">{fmtMoney(baseMarginDollars)} margin</p>
        </div>
        <span aria-hidden className="mb-7 text-2xl text-muted-foreground">→</span>
        <div>
          <p className={cn('text-[11px] font-semibold uppercase tracking-wider', active ? 'text-primary' : 'text-muted-foreground')}>
            Simulated
          </p>
          <p className={cn('font-display text-5xl font-extrabold leading-none tabular-nums', marginColor(newMarginPct))}>
            {newMarginPct}%
          </p>
          <p className="mt-1 text-xs tabular-nums text-muted-foreground">{fmtMoney(newMarginDollars)} margin</p>
        </div>
        {active ? (
          <div className="mb-7 flex flex-col gap-1">
            <span className={cn('inline-flex w-fit items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-bold tabular-nums', deltaColor)}>
              {up ? '▲' : down ? '▼' : ''}{up ? '+' : ''}{ptsDelta} pts
            </span>
            <span className={cn('text-xs tabular-nums', deltaColor)}>
              {dollarDelta >= 0 ? '+' : '−'}{fmtMoney(Math.abs(dollarDelta))}
            </span>
          </div>
        ) : null}
      </div>

      {/* Levers — under the result they drive. Polarity is in the track color. */}
      <div className="mt-5 grid gap-x-8 gap-y-5 sm:grid-cols-2">
        <RateLever
          label="Bill rate" value={billAdj} onChange={onBill}
          tone="good" hint="Raising it lifts margin"
        />
        <RateLever
          label="Cost rate" value={costAdj} onChange={onCost}
          tone="cost" hint="Raising it trims margin"
        />
      </div>
    </section>
  );
}

// One rate lever. The track is tinted by financial polarity — emerald for the
// lever that helps margin (bill), rose for the one that costs (cost) — so you
// know which way is "good" before touching it. A center notch marks neutral (0).
function RateLever({
  label, value, onChange, tone, hint,
}: {
  label: string; value: number; onChange: (v: number) => void;
  tone: 'good' | 'cost'; hint: string;
}) {
  const trackColor = tone === 'good' ? '#10b981' : '#f43f5e'; // emerald-500 / rose-500
  const rail = 'rgba(128,128,140,0.28)'; // theme-neutral unfilled rail
  // Fill the track from the center (0) out to the thumb so the lever reads as a
  // delta from neutral, not an absolute 0..100 bar.
  const pct = (value + 50); // 0..100 thumb position
  const center = 50;
  const lo = Math.min(pct, center);
  const hi = Math.max(pct, center);
  const fill = `linear-gradient(to right, ${rail} 0%, ${rail} ${lo}%, ${trackColor} ${lo}%, ${trackColor} ${hi}%, ${rail} ${hi}%, ${rail} 100%)`;

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-foreground">{label}</span>
          <span className="text-[11px] text-muted-foreground">{hint}</span>
        </div>
        <span className={cn('text-sm font-bold tabular-nums',
          value === 0 ? 'text-muted-foreground'
            : (tone === 'good') === (value > 0) ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
          {value > 0 ? '+' : ''}{value}%
        </span>
      </div>
      <div className="relative flex h-5 items-center">
        {/* Colored rail: neutral track with the from-0 fill in the lever's tone. */}
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full" style={{ background: fill }} />
        {/* Neutral (0) notch */}
        <span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-foreground/30" />
        <input
          type="range" min={-50} max={50} step={1} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={`${label} adjustment percent`}
          className="lever-range relative z-20 h-5 w-full cursor-pointer appearance-none bg-transparent"
          style={{ ['--thumb' as string]: trackColor } as React.CSSProperties}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>−50%</span><span>0</span><span>+50%</span>
      </div>
    </div>
  );
}

