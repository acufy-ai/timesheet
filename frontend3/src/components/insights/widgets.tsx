import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { fmtMoney } from '@/lib/format';
import { healthMeta, type ProjectHealth } from '@/lib/projectHealth';
import type { WidgetConfig, WidgetInstance, WidgetType } from '@/types/customDashboard';
import { Donut, Bars, Line, type Slice, type Bar, type Point } from './svgCharts';
import { useWidgetData } from './WidgetDataContext';

// Loosely-typed views of the metric bundles. The widgets only touch a handful
// of fields each; full typing lives in the dashboard hooks/types.
type AnyData = Record<string, any>;

// ── widget data (shared hooks; all widgets read from these) ──────────────────
// Portfolio carries health counts + per-project rows; financials carries the
// money KPIs. Both are already fetched elsewhere, so this is cheap.

const HEALTH_TIERS: { key: keyof PortfolioCounts; health: ProjectHealth }[] = [
  { key: 'critical', health: 'critical' },
  { key: 'blocked', health: 'blocked' },
  { key: 'at_risk', health: 'at-risk' },
  { key: 'on_track', health: 'on-track' },
  { key: 'excellent', health: 'excellent' },
];
type PortfolioCounts = { critical: number; blocked: number; at_risk: number; on_track: number; excellent: number };

// Hex colors for the donut, derived from the health palette (svg needs literals).
const HEALTH_HEX: Record<string, string> = {
  critical: '#f43f5e', blocked: '#8b5cf6', 'at-risk': '#f59e0b', 'on-track': '#0ea5e9', excellent: '#10b981',
};

// ── KPI tile ─────────────────────────────────────────────────────────────────
export const KPI_METRICS: { key: string; label: string }[] = [
  { key: 'revenue', label: 'Total revenue' },
  { key: 'margin_pct', label: 'Margin %' },
  { key: 'cost', label: 'Total cost' },
  { key: 'at_risk', label: 'Projects needing attention' },
  { key: 'utilization', label: 'Utilization %' },
  { key: 'projects', label: 'Project count' },
  { key: 'billable_hours', label: 'Billable hours' },
  { key: 'budget', label: 'Total budget' },
  { key: 'billed', label: 'Revenue billed' },
  { key: 'recognized', label: 'Revenue recognized' },
  { key: 'on_time', label: 'On-time submissions %' },
];

const moneyTone = (m: number | null | undefined) =>
  m == null ? 'text-foreground' : m >= 40 ? 'text-emerald-600 dark:text-emerald-400' : m >= 15 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400';

function KpiWidget({ config }: { config?: WidgetConfig }) {
  const metric = config?.metric ?? 'revenue';
  const wd = useWidgetData();
  const portfolio = wd.portfolio;
  const financials = wd.financials;
  const revrec = wd.revrec;
  const ontime = wd.ontime;
  const loading = portfolio.isLoading || financials.isLoading;
  if (loading) return <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered>;
  const p = portfolio.data as AnyData | undefined;
  const f = (financials.data as AnyData | undefined)?.summary as AnyData | undefined;

  let value = '—'; let tone = 'text-foreground'; let label = '';
  switch (metric) {
    case 'revenue': value = fmtMoney(f?.total_revenue ?? p?.total_revenue ?? 0); label = 'Total revenue'; break;
    case 'cost': value = fmtMoney(f?.total_cost ?? p?.total_cost ?? 0); label = 'Total cost'; break;
    case 'budget': value = fmtMoney(f?.total_budget ?? 0); label = 'Total budget'; break;
    case 'billable_hours': value = `${Math.round(Number(f?.billable_hours ?? 0))}h`; label = 'Billable hours'; break;
    case 'margin_pct': {
      const m = f?.total_margin_pct ?? p?.total_margin_pct;
      value = m != null ? `${m}%` : '—'; label = 'Margin'; tone = moneyTone(m);
      break;
    }
    case 'utilization': value = f?.utilization_pct != null ? `${f.utilization_pct}%` : '—'; label = 'Utilization'; break;
    case 'at_risk': {
      const n = (p?.critical ?? 0) + (p?.blocked ?? 0) + (p?.at_risk ?? 0);
      value = String(n); label = 'Need attention'; tone = n > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400';
      break;
    }
    case 'projects': value = String(p?.project_count ?? 0); label = 'Projects'; break;
    case 'billed': value = fmtMoney((revrec.data as AnyData | undefined)?.total_billed ?? 0); label = 'Revenue billed'; break;
    case 'recognized': value = fmtMoney((revrec.data as AnyData | undefined)?.total_recognized ?? 0); label = 'Recognized'; break;
    case 'on_time': {
      const pct = (ontime.data as AnyData | undefined)?.team_on_time_pct as number | null | undefined;
      value = pct != null ? `${pct}%` : '—'; label = 'On-time'; tone = pct == null ? 'text-foreground' : pct >= 90 ? 'text-emerald-600 dark:text-emerald-400' : pct >= 70 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400';
      break;
    }
  }
  return (
    <div className="flex h-full flex-col justify-center px-1">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-2xl font-bold leading-tight tabular-nums', tone)}>{value}</p>
    </div>
  );
}

// ── Health summary ───────────────────────────────────────────────────────────
function HealthSummaryWidget() {
  const portfolio = useWidgetData().portfolio;
  if (portfolio.isLoading) return <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered>;
  const p = portfolio.data as AnyData | undefined;
  return (
    <div className="grid grid-cols-2 gap-2 px-1 py-1">
      {HEALTH_TIERS.map(({ key, health }) => {
        const m = healthMeta(health);
        const n = (p?.[key] as number) ?? 0;
        return (
          <div key={key} className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5">
            <span className={cn('h-2.5 w-2.5 rounded-full', m.dot)} />
            <span className="text-xs text-muted-foreground">{m.label}</span>
            <span className="ml-auto text-sm font-bold tabular-nums text-foreground">{n}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Chart ────────────────────────────────────────────────────────────────────
export const CHART_SOURCES: { key: string; label: string }[] = [
  { key: 'health', label: 'Health distribution (donut)' },
  { key: 'revenue_by_project', label: 'Revenue by project (bars)' },
  { key: 'margin_by_project', label: 'Margin % by project (bars)' },
  { key: 'cost_by_project', label: 'Cost by project (bars)' },
  { key: 'on_time_trend', label: 'On-time trend (line)' },
];

function ChartWidget({ config }: { config?: WidgetConfig }) {
  const source = config?.source ?? 'health';
  const wd = useWidgetData();
  const portfolio = wd.portfolio;
  const financials = wd.financials;
  const ontime = wd.ontime;
  const loading = portfolio.isLoading || financials.isLoading;
  if (loading) return <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered>;
  const p = portfolio.data as AnyData | undefined;

  if (source === 'health') {
    const slices: Slice[] = HEALTH_TIERS.map(({ key, health }) => ({
      label: healthMeta(health).label, value: (p?.[key] as number) ?? 0, color: HEALTH_HEX[health],
    })).filter((s) => s.value > 0);
    return <div className="px-1 py-1"><Donut slices={slices} /></div>;
  }
  if (source === 'on_time_trend') {
    if (ontime.isLoading) return <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered>;
    // Aggregate the per-person recent-weeks into a team on-time % per week.
    const rows: AnyData[] = (ontime.data as AnyData | undefined)?.rows ?? [];
    const byWeek = new Map<string, { on: number; total: number }>();
    rows.forEach((r) => (r.recent_weeks ?? []).forEach((w: AnyData) => {
      if (w.status === 'none') return;
      const b = byWeek.get(w.week_start) ?? { on: 0, total: 0 };
      b.total += 1; if (w.status === 'on_time') b.on += 1;
      byWeek.set(w.week_start, b);
    }));
    const points: Point[] = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([wk, b]) => ({ label: wk.slice(5), value: b.total ? Math.round((b.on / b.total) * 100) : 0 }));
    return <div className="px-1 py-1"><Line points={points} format={(v) => `${v}%`} /></div>;
  }
  const rows: AnyData[] = (financials.data as AnyData | undefined)?.projects ?? [];
  if (source === 'revenue_by_project') {
    const bars: Bar[] = [...rows].sort((a, b) => Number(b.revenue) - Number(a.revenue)).slice(0, 6)
      .map((r) => ({ label: r.project_name, value: Number(r.revenue) }));
    return <div className="px-1 py-1"><Bars bars={bars} format={(v) => fmtMoney(v)} /></div>;
  }
  if (source === 'cost_by_project') {
    const bars: Bar[] = [...rows].sort((a, b) => Number(b.cost ?? 0) - Number(a.cost ?? 0)).slice(0, 6)
      .map((r) => ({ label: r.project_name, value: Number(r.cost ?? 0) }));
    return <div className="px-1 py-1"><Bars bars={bars} color="#f59e0b" format={(v) => fmtMoney(v)} /></div>;
  }
  // margin_by_project
  const bars: Bar[] = [...rows].filter((r) => r.margin_pct != null).sort((a, b) => (a.margin_pct ?? 0) - (b.margin_pct ?? 0)).slice(0, 6)
    .map((r) => ({ label: r.project_name, value: r.margin_pct ?? 0 }));
  return <div className="px-1 py-1"><Bars bars={bars} color="hsl(var(--primary))" format={(v) => `${v}%`} /></div>;
}

// ── EVM tile (CPI/SPI/EAC) ───────────────────────────────────────────────────
function EvmWidget() {
  const evm = useWidgetData().evm;
  if (evm.isLoading) return <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered>;
  const rows: AnyData[] = (evm.data as AnyData | undefined)?.rows ?? [];
  if (!rows.length) return <Centered><span className="text-xs">No EVM baselines set.</span></Centered>;
  // Portfolio CPI/SPI = EV-weighted average; EAC = sum.
  let ev = 0, ac = 0, pv = 0, eac = 0;
  rows.forEach((r) => { ev += Number(r.ev); ac += Number(r.ac); pv += Number(r.pv); eac += Number(r.eac); });
  const cpi = ac > 0 ? ev / ac : null;
  const spi = pv > 0 ? ev / pv : null;
  const idxTone = (v: number | null) => v == null ? 'text-foreground' : v >= 1 ? 'text-emerald-600 dark:text-emerald-400' : v >= 0.9 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400';
  return (
    <div className="grid grid-cols-2 gap-2 px-1 py-1 text-center">
      <Metric label="CPI" value={cpi != null ? cpi.toFixed(2) : '—'} tone={idxTone(cpi)} />
      <Metric label="SPI" value={spi != null ? spi.toFixed(2) : '—'} tone={idxTone(spi)} />
      <Metric label="Earned (EV)" value={fmtMoney(ev)} />
      <Metric label="Forecast (EAC)" value={fmtMoney(eac)} />
    </div>
  );
}

// ── Revenue recognition tile ─────────────────────────────────────────────────
function RevRecWidget() {
  const rr = useWidgetData().revrec;
  if (rr.isLoading) return <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered>;
  const d = rr.data as AnyData | undefined;
  return (
    <div className="grid grid-cols-2 gap-2 px-1 py-1 text-center">
      <Metric label="Billed" value={fmtMoney(d?.total_billed ?? 0)} />
      <Metric label="Recognized" value={fmtMoney(d?.total_recognized ?? 0)} />
    </div>
  );
}

// ── Utilization / resourcing tile ────────────────────────────────────────────
function UtilizationWidget() {
  const wd = useWidgetData();
  const res = wd.resourcing;
  const fin = wd.financials;
  if (res.isLoading || fin.isLoading) return <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered>;
  const r = res.data as AnyData | undefined;
  const util = (fin.data as AnyData | undefined)?.summary?.utilization_pct as number | null | undefined;
  return (
    <div className="grid grid-cols-2 gap-2 px-1 py-1 text-center">
      <Metric label="Utilization" value={util != null ? `${util}%` : '—'} tone={util == null ? 'text-foreground' : util >= 80 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'} />
      <Metric label="Team size" value={String(r?.team_size ?? 0)} />
      <Metric label="Over-allocated" value={String(r?.over_allocated ?? 0)} tone={(r?.over_allocated ?? 0) > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'} />
      <Metric label="Under-utilized" value={String(Math.max(0, r?.under_utilized ?? 0))} />
    </div>
  );
}

// ── On-time submissions tile ─────────────────────────────────────────────────
function OnTimeWidget() {
  const ot = useWidgetData().ontime;
  if (ot.isLoading) return <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered>;
  const d = ot.data as AnyData | undefined;
  const pct = d?.team_on_time_pct as number | null | undefined;
  const tone = pct == null ? 'text-foreground' : pct >= 90 ? 'text-emerald-600 dark:text-emerald-400' : pct >= 70 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400';
  return (
    <div className="flex h-full flex-col justify-center px-1">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">On-time submissions</p>
      <p className={cn('mt-1 text-3xl font-bold tabular-nums', tone)}>{pct != null ? `${pct}%` : '—'}</p>
      <p className="text-xs text-muted-foreground">{(d?.rows?.length ?? 0)} people · last 90 days</p>
    </div>
  );
}

function Metric({ label, value, tone = 'text-foreground' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border px-2 py-1.5">
      <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn('text-base font-bold tabular-nums', tone)}>{value}</p>
    </div>
  );
}

// ── Table ────────────────────────────────────────────────────────────────────
export const TABLE_SOURCES: { key: string; label: string }[] = [
  { key: 'top_projects', label: 'Projects by attention' },
  { key: 'financials', label: 'Financials by project' },
];

function TableWidget({ config }: { config?: WidgetConfig }) {
  const table = config?.table ?? 'top_projects';
  const wd = useWidgetData();
  const portfolio = wd.portfolio;
  const financials = wd.financials;
  if (portfolio.isLoading || financials.isLoading) return <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered>;

  if (table === 'financials') {
    const rows: AnyData[] = ((financials.data as AnyData | undefined)?.projects ?? []).slice(0, 8);
    return (
      <div className="overflow-auto">
        <table className="w-full text-xs">
          <thead><tr className="table-header-row">
            <th className="table-header-cell">Project</th>
            <th className="table-header-cell text-right">Revenue</th>
            <th className="table-header-cell text-right">Margin</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.project_id} className="border-b border-border/50 last:border-0">
                <td className="px-3 py-1.5 text-foreground">{r.project_name}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-foreground">{fmtMoney(r.revenue, r.currency)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.margin_pct != null ? `${r.margin_pct}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  // top_projects (by attention = health rank ascending)
  const rows: AnyData[] = [...(((portfolio.data as AnyData | undefined)?.rows ?? []))]
    .sort((a, b) => healthMeta(a.health).rank - healthMeta(b.health).rank).slice(0, 8);
  return (
    <div className="overflow-auto">
      <table className="w-full text-xs">
        <thead><tr className="table-header-row">
          <th className="table-header-cell">Project</th>
          <th className="table-header-cell">Health</th>
          <th className="table-header-cell text-right">Budget</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => {
            const m = healthMeta(r.health);
            return (
              <tr key={r.project_id} className="border-b border-border/50 last:border-0">
                <td className="px-3 py-1.5 text-foreground">{r.project_name}</td>
                <td className="px-3 py-1.5"><span className={cn('inline-flex items-center gap-1', m.text)}><span className={cn('h-1.5 w-1.5 rounded-full', m.dot)} />{m.label}</span></td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.budget_used_pct != null ? `${r.budget_used_pct}%` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center py-6 text-muted-foreground">{children}</div>;
}

// ── registry: the single source of truth for widget types ────────────────────
export interface WidgetMeta {
  type: WidgetType;
  label: string;
  defaultW: number;
  defaultH: number;
  Component: (props: { config?: WidgetConfig }) => JSX.Element;
}

// Default footprint is sized to the widget's content. Single-value tiles (kpi,
// ontime) get a small box; multi-stat tiles (revrec/evm/utilization) a bit
// wider; visual widgets (chart/table/health) get real room. Grid rows are 64px.
export const WIDGET_REGISTRY: Record<WidgetType, WidgetMeta> = {
  kpi: { type: 'kpi', label: 'KPI tile', defaultW: 2, defaultH: 2, Component: KpiWidget },
  health: { type: 'health', label: 'Health summary', defaultW: 4, defaultH: 3, Component: HealthSummaryWidget },
  chart: { type: 'chart', label: 'Chart', defaultW: 5, defaultH: 3, Component: ChartWidget },
  table: { type: 'table', label: 'Table', defaultW: 6, defaultH: 4, Component: TableWidget },
  evm: { type: 'evm', label: 'Earned value (EVM)', defaultW: 4, defaultH: 3, Component: EvmWidget },
  revrec: { type: 'revrec', label: 'Revenue recognition', defaultW: 3, defaultH: 2, Component: RevRecWidget },
  utilization: { type: 'utilization', label: 'Utilization / resourcing', defaultW: 4, defaultH: 3, Component: UtilizationWidget },
  ontime: { type: 'ontime', label: 'On-time submissions', defaultW: 2, defaultH: 2, Component: OnTimeWidget },
};

// Default title shown on a freshly-added widget.
export function defaultWidgetTitle(type: WidgetType, config?: WidgetConfig): string {
  if (type === 'kpi') return KPI_METRICS.find((m) => m.key === config?.metric)?.label ?? 'KPI';
  if (type === 'chart') return CHART_SOURCES.find((s) => s.key === config?.source)?.label ?? 'Chart';
  if (type === 'table') return TABLE_SOURCES.find((s) => s.key === config?.table)?.label ?? 'Table';
  return WIDGET_REGISTRY[type]?.label ?? 'Widget';
}

// Order shown in the widget pickers + short descriptions for config-less types.
export const WIDGET_TYPE_ORDER: WidgetType[] = ['kpi', 'chart', 'table', 'health', 'evm', 'revrec', 'utilization', 'ontime'];
export const WIDGET_DESC: Partial<Record<WidgetType, string>> = {
  health: 'A compact rollup of project health (counts per tier).',
  evm: 'Earned-value summary: portfolio CPI, SPI, earned value, and forecast (EAC).',
  revrec: 'Revenue billed vs. recognized across the portfolio.',
  utilization: 'Team utilization, size, and over/under-allocation.',
  ontime: 'Share of timesheet submissions made on time (last 90 days).',
};

let widgetCounter = 0;
export const newWidgetId = () => `w_${Date.now().toString(36)}_${(widgetCounter++).toString(36)}`;

// Build a fresh widget instance from a type + its (type-specific) config.
export function makeWidget(type: WidgetType, config: WidgetConfig): WidgetInstance {
  const meta = WIDGET_REGISTRY[type];
  const clean = type === 'kpi' ? { metric: config.metric }
    : type === 'chart' ? { source: config.source }
      : type === 'table' ? { table: config.table }
        : {};
  return { id: newWidgetId(), type, x: 0, y: 0, w: meta.defaultW, h: meta.defaultH, title: defaultWidgetTitle(type, clean), config: clean };
}
