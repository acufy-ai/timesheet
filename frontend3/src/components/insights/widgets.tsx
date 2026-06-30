import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Tooltip } from '@/components/ui';
import { fmtMoney } from '@/lib/format';
import { healthMeta, type ProjectHealth } from '@/lib/projectHealth';
import type { WidgetConfig, WidgetInstance, WidgetScope, WidgetType } from '@/types/customDashboard';
import { Donut, Bars, Columns, Line, type Slice } from './svgCharts';
import { useWidgetBundles } from './WidgetDataContext';
import { useDashboardScopeOptions } from '@/hooks/useCustomDashboards';
import { InfoLabel, infoTextFor } from '@/components/dashboard/InfoLabel';

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

function KpiWidget({ config, widgetId }: WidgetProps) {
  const metric = config?.metric ?? 'revenue';
  const wd = useWidgetBundles(config?.scope, widgetId);
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
  // Explain what this number represents on hover: the scope it spans (how many
  // projects/clients) + how the metric is composed.
  const projCount = (f?.projects as AnyData[] | undefined)?.length ?? (p?.project_count as number | undefined) ?? 0;
  const valueTip = (
    <KpiValueTip metric={metric} label={label} value={value} projCount={projCount} scope={config?.scope} />
  );
  return (
    <div className="flex h-full flex-col justify-center px-1">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <InfoLabel label={label} side="top" infoKey={KPI_INFO[metric]} />
      </p>
      <Tooltip label={valueTip} side="top" maxWidth={280}>
        <p className={cn('mt-0.5 inline-block cursor-help text-2xl font-bold leading-tight tabular-nums', tone)}>{value}</p>
      </Tooltip>
      <ScopeLine scope={config?.scope} />
    </div>
  );
}

// KPI label text is terse and doesn't always match a glossary key, so map each
// metric to the right glossary entry for its tooltip.
const KPI_INFO: Record<string, string> = {
  revenue: 'revenue', cost: 'cost', budget: 'budget burn', billable_hours: 'billable',
  margin_pct: 'margin', utilization: 'utilization', at_risk: 'health', projects: 'logged hours',
  billed: 'billed', recognized: 'recognized', on_time: 'on-time submissions',
};

// ── Health summary ───────────────────────────────────────────────────────────
// The health summary can render as cards (default), a donut, or bars — all show
// the same per-tier counts.
export type HealthView = 'cards' | 'donut' | 'bar';
export const HEALTH_VIEWS: { key: HealthView; label: string }[] = [
  { key: 'cards', label: 'Cards' }, { key: 'donut', label: 'Donut' }, { key: 'bar', label: 'Bars' },
];

function HealthSummaryWidget({ config, widgetId }: WidgetProps) {
  const portfolio = useWidgetBundles(config?.scope, widgetId).portfolio;
  if (portfolio.isLoading) return <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered>;
  const p = portfolio.data as AnyData | undefined;
  const view: HealthView = (config?.view as HealthView) ?? 'cards';
  const allRows: AnyData[] = (p?.rows as AnyData[]) ?? [];

  const tiers = HEALTH_TIERS.map(({ key, health }) => ({
    health, label: healthMeta(health).label, value: (p?.[key] as number) ?? 0, color: HEALTH_HEX[health],
    // The projects in THIS tier, so hovering lists exactly which ones they are.
    tip: <HealthTierTip label={healthMeta(health).label} health={health} rows={allRows} />,
  }));
  if (tiers.every((t) => t.value === 0)) return <Centered><span className="text-xs">No projects in this scope.</span></Centered>;

  if (view === 'donut') {
    return <div className="px-1 py-1"><Donut slices={tiers.filter((t) => t.value > 0).map((t) => ({ label: t.label, value: t.value, color: t.color, tip: t.tip }))} /></div>;
  }
  if (view === 'bar') {
    return <div className="px-1 py-1"><Bars bars={tiers.map((t) => ({ label: t.label, value: t.value, tip: t.tip }))} /></div>;
  }
  return (
    <div className="grid grid-cols-2 gap-2 px-1 py-1">
      {tiers.map((t) => (
        <Tooltip key={t.health} label={t.tip} side="top" maxWidth={300}>
          <div className="flex cursor-help items-center gap-2 rounded-lg border border-border px-2.5 py-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />
            <span className="text-xs text-muted-foreground">{t.label}</span>
            <span className="ml-auto text-sm font-bold tabular-nums text-foreground">{t.value}</span>
          </div>
        </Tooltip>
      ))}
    </div>
  );
}

// ── Chart ────────────────────────────────────────────────────────────────────
// bar    = horizontal bars · column = vertical bars · donut/pie = ring/full
// circle · line = trend series.
export type ChartKind = 'bar' | 'column' | 'donut' | 'pie' | 'line';

// A chart DATASET ('what data') is decoupled from its KIND ('how to draw').
// `kinds` lists the visualizations that make sense for that data, so the user
// can switch among them. Labels never name the kind (no "(bars)").
export const CHART_SOURCES: { key: string; label: string; kinds: ChartKind[] }[] = [
  { key: 'health', label: 'Health distribution', kinds: ['donut', 'pie', 'bar', 'column'] },
  { key: 'revenue_by_project', label: 'Revenue by project', kinds: ['bar', 'column', 'donut', 'pie', 'line'] },
  { key: 'margin_by_project', label: 'Margin % by project', kinds: ['bar', 'column', 'line'] },
  { key: 'cost_by_project', label: 'Cost by project', kinds: ['bar', 'column', 'donut', 'pie', 'line'] },
  { key: 'on_time_trend', label: 'On-time trend', kinds: ['line', 'column', 'bar'] },
];

export const chartKindsFor = (source?: string): ChartKind[] =>
  CHART_SOURCES.find((s) => s.key === source)?.kinds ?? ['bar'];

// A dataset resolved to a label + series + colour + value formatter. Drawing is
// then a pure function of (dataset, kind).
interface ChartData { slices: Slice[]; color: string; format: (v: number) => string; pct?: boolean }

function ChartWidget({ config, widgetId }: WidgetProps) {
  const source = config?.source ?? 'health';
  const kinds = chartKindsFor(source);
  const kind: ChartKind = (config?.chartKind && kinds.includes(config.chartKind)) ? config.chartKind : kinds[0];
  const wd = useWidgetBundles(config?.scope, widgetId);
  const portfolio = wd.portfolio;
  const financials = wd.financials;
  const ontime = wd.ontime;
  const loading = portfolio.isLoading || financials.isLoading || (source === 'on_time_trend' && ontime.isLoading);
  if (loading) return <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered>;
  const p = portfolio.data as AnyData | undefined;

  // Resolve the dataset into a uniform shape.
  let data: ChartData;
  if (source === 'health') {
    data = {
      slices: HEALTH_TIERS.map(({ key, health }) => ({
        label: healthMeta(health).label, value: (p?.[key] as number) ?? 0, color: HEALTH_HEX[health],
      })).filter((s) => s.value > 0),
      color: 'hsl(var(--primary))', format: (v) => String(v),
    };
  } else if (source === 'on_time_trend') {
    const rows: AnyData[] = (ontime.data as AnyData | undefined)?.rows ?? [];
    const byWeek = new Map<string, { on: number; total: number }>();
    rows.forEach((r) => (r.recent_weeks ?? []).forEach((w: AnyData) => {
      if (w.status === 'none') return;
      const b = byWeek.get(w.week_start) ?? { on: 0, total: 0 };
      b.total += 1; if (w.status === 'on_time') b.on += 1;
      byWeek.set(w.week_start, b);
    }));
    const slices: Slice[] = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([wk, b]) => ({ label: wk.slice(5), value: b.total ? Math.round((b.on / b.total) * 100) : 0 }));
    data = { slices, color: 'hsl(var(--primary))', format: (v) => `${v}%`, pct: true };
  } else {
    const rows: AnyData[] = (financials.data as AnyData | undefined)?.projects ?? [];
    // A rich per-project tip: client + revenue + margin + budget burn, so
    // hovering any bar explains that project, not just its plotted value.
    const projTip = (r: AnyData) => (
      <ProjectTip name={r.project_name} client={r.client_name} revenue={r.revenue}
        currency={r.currency} marginPct={r.margin_pct} budgetPct={r.budget_pct} hours={r.logged_hours} />
    );
    if (source === 'revenue_by_project') {
      data = {
        slices: [...rows].sort((a, b) => Number(b.revenue) - Number(a.revenue)).slice(0, 6)
          .map((r) => ({ label: r.project_name, value: Number(r.revenue), tip: projTip(r) })),
        color: 'hsl(var(--primary))', format: (v) => fmtMoney(v),
      };
    } else if (source === 'cost_by_project') {
      data = {
        slices: [...rows].sort((a, b) => Number(b.cost ?? 0) - Number(a.cost ?? 0)).slice(0, 6)
          .map((r) => ({ label: r.project_name, value: Number(r.cost ?? 0), tip: projTip(r) })),
        color: '#f59e0b', format: (v) => fmtMoney(v),
      };
    } else { // margin_by_project
      data = {
        slices: [...rows].filter((r) => r.margin_pct != null).sort((a, b) => (a.margin_pct ?? 0) - (b.margin_pct ?? 0)).slice(0, 6)
          .map((r) => ({ label: r.project_name, value: r.margin_pct ?? 0, tip: projTip(r) })),
        color: 'hsl(var(--primary))', format: (v) => `${v}%`, pct: true,
      };
    }
  }

  if (!data.slices.length) return <Centered><span className="text-xs">No data for this scope.</span></Centered>;
  // h-full so a column chart can fill the tile body and scale its bars to the
  // available height; bar/donut/line are intrinsically sized and ignore it.
  return <div className="h-full px-1 py-1">{renderChart(kind, data)}</div>;
}

const CHART_PALETTE = ['#0ea5e9', '#8b5cf6', '#10b981', '#f59e0b', '#f43f5e', '#14b8a6'];

// Draw a resolved dataset as the chosen kind. donut/pie slices get a palette
// colour when the dataset doesn't carry its own; per-item `tip`s are preserved.
function renderChart(kind: ChartKind, d: ChartData) {
  if (kind === 'donut' || kind === 'pie') {
    const slices = d.slices.map((s, i) => ({ ...s, color: s.color ?? CHART_PALETTE[i % CHART_PALETTE.length] }));
    return <Donut slices={slices} format={d.format} pie={kind === 'pie'} />;
  }
  if (kind === 'line') {
    return <Line points={d.slices.map((s) => ({ label: s.label, value: s.value }))} format={d.format} />;
  }
  const bars = d.slices.map((s) => ({ label: s.label, value: s.value, tip: s.tip }));
  if (kind === 'column') {
    return <Columns bars={bars} color={d.color} format={d.format} />;
  }
  return <Bars bars={bars} color={d.color} format={d.format} />;
}

// ── EVM tile (CPI/SPI/EAC) ───────────────────────────────────────────────────
function EvmWidget({ config, widgetId }: WidgetProps) {
  const evm = useWidgetBundles(config?.scope, widgetId).evm;
  if (evm.isLoading) return <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered>;
  const rows: AnyData[] = (evm.data as AnyData | undefined)?.rows ?? [];
  if (!rows.length) return <Centered><span className="text-xs">No EVM baselines set.</span></Centered>;
  // Portfolio CPI/SPI = EV-weighted average; EAC = sum.
  let ev = 0, ac = 0, pv = 0, eac = 0;
  rows.forEach((r) => { ev += Number(r.ev); ac += Number(r.ac); pv += Number(r.pv); eac += Number(r.eac); });
  const cpi = ac > 0 ? ev / ac : null;
  const spi = pv > 0 ? ev / pv : null;
  const idxTone = (v: number | null) => v == null ? 'text-foreground' : v >= 1 ? 'text-emerald-600 dark:text-emerald-400' : v >= 0.9 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400';
  // Per-project breakdowns: each portfolio metric lists the projects behind it,
  // sorted to surface the ones that matter (worst index / biggest dollar first).
  const cpiOf = (r: AnyData) => Number(r.ac) > 0 ? Number(r.ev) / Number(r.ac) : null;
  const spiOf = (r: AnyData) => Number(r.pv) > 0 ? Number(r.ev) / Number(r.pv) : null;
  return (
    <div className="grid grid-cols-2 gap-2 px-1 py-1 text-center">
      <Metric label="CPI" value={cpi != null ? cpi.toFixed(2) : '—'} tone={idxTone(cpi)}
        tip={<EvmMetricTip title="Cost performance (CPI) by project" rows={[...rows].sort((a, b) => (cpiOf(a) ?? 9) - (cpiOf(b) ?? 9))}
          render={(r) => { const v = cpiOf(r); return v != null ? v.toFixed(2) : '—'; }} />} />
      <Metric label="SPI" value={spi != null ? spi.toFixed(2) : '—'} tone={idxTone(spi)}
        tip={<EvmMetricTip title="Schedule performance (SPI) by project" rows={[...rows].sort((a, b) => (spiOf(a) ?? 9) - (spiOf(b) ?? 9))}
          render={(r) => { const v = spiOf(r); return v != null ? v.toFixed(2) : '—'; }} />} />
      <Metric label="Earned (EV)" value={fmtMoney(ev)}
        tip={<EvmMetricTip title="Earned value (EV) by project" rows={[...rows].sort((a, b) => Number(b.ev) - Number(a.ev))}
          render={(r) => fmtMoney(Number(r.ev))} />} />
      <Metric label="Forecast (EAC)" value={fmtMoney(eac)}
        tip={<EvmMetricTip title="Forecast at completion (EAC) by project" rows={[...rows].sort((a, b) => Number(b.eac) - Number(a.eac))}
          render={(r) => fmtMoney(Number(r.eac))} />} />
    </div>
  );
}

// Lists the per-project value behind one EVM metric (CPI/SPI/EV/EAC).
function EvmMetricTip({ title, rows, render }: { title: string; rows: AnyData[]; render: (r: AnyData) => string }) {
  return (
    <div className="space-y-1">
      <p className="font-semibold">{title}</p>
      <ul className="space-y-0.5">
        {rows.slice(0, 10).map((r) => (
          <li key={r.project_id} className="flex justify-between gap-4 leading-snug">
            <span className="truncate">{r.project_name}</span>
            <span className="shrink-0 font-medium tabular-nums">{render(r)}</span>
          </li>
        ))}
        {rows.length > 10 ? <li className="text-[11px] text-muted-foreground">+{rows.length - 10} more</li> : null}
      </ul>
    </div>
  );
}

// ── Revenue recognition tile ─────────────────────────────────────────────────
function RevRecWidget({ config, widgetId }: WidgetProps) {
  const rr = useWidgetBundles(config?.scope, widgetId).revrec;
  if (rr.isLoading) return <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered>;
  const d = rr.data as AnyData | undefined;
  const rows: AnyData[] = (d?.rows as AnyData[]) ?? [];
  return (
    <div className="grid grid-cols-2 gap-2 px-1 py-1 text-center">
      <Metric label="Billed" value={fmtMoney(d?.total_billed ?? 0)}
        tip={<EvmMetricTip title="Billed by project" rows={[...rows].sort((a, b) => Number(b.billed) - Number(a.billed))}
          render={(r) => fmtMoney(Number(r.billed), r.currency)} />} />
      <Metric label="Recognized" value={fmtMoney(d?.total_recognized ?? 0)}
        tip={<EvmMetricTip title="Recognized by project" rows={[...rows].sort((a, b) => Number(b.recognized) - Number(a.recognized))}
          render={(r) => fmtMoney(Number(r.recognized), r.currency)} />} />
    </div>
  );
}

// ── Utilization / resourcing tile ────────────────────────────────────────────
function UtilizationWidget({ config, widgetId }: WidgetProps) {
  const wd = useWidgetBundles(config?.scope, widgetId);
  const res = wd.resourcing;
  const fin = wd.financials;
  if (res.isLoading || fin.isLoading) return <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered>;
  const r = res.data as AnyData | undefined;
  const util = (fin.data as AnyData | undefined)?.summary?.utilization_pct as number | null | undefined;
  const people: AnyData[] = (r?.rows as AnyData[]) ?? [];
  const inState = (s: string) => people.filter((u) => u.state === s);
  return (
    <div className="grid grid-cols-2 gap-2 px-1 py-1 text-center">
      <Metric label="Utilization" value={util != null ? `${util}%` : '—'} tone={util == null ? 'text-foreground' : util >= 80 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'} />
      <Metric label="Team size" value={String(r?.team_size ?? 0)}
        tip={<PeopleTip title="Team" people={people} />} />
      <Metric label="Over-allocated" value={String(r?.over_allocated ?? 0)} tone={(r?.over_allocated ?? 0) > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}
        tip={<PeopleTip title="Over-allocated (over 100%)" people={inState('over')} />} />
      <Metric label="Under-utilized" value={String(Math.max(0, r?.under_utilized ?? 0))}
        tip={<PeopleTip title="Under-utilized (below 60%)" people={inState('under')} />} />
    </div>
  );
}

// Lists people behind a resourcing count (team / over-allocated / under-utilized).
function PeopleTip({ title, people }: { title: string; people: AnyData[] }) {
  if (!people.length) return <span>No one in this group.</span>;
  return (
    <div className="space-y-1">
      <p className="font-semibold">{title} · {people.length}</p>
      <ul className="space-y-0.5">
        {people.slice(0, 12).map((u) => (
          <li key={u.user_id} className="flex justify-between gap-4 leading-snug">
            <span className="truncate">{u.full_name}</span>
            <span className="shrink-0 font-medium tabular-nums">{u.allocated_pct}%</span>
          </li>
        ))}
        {people.length > 12 ? <li className="text-[11px] text-muted-foreground">+{people.length - 12} more</li> : null}
      </ul>
    </div>
  );
}

// ── On-time submissions tile ─────────────────────────────────────────────────
function OnTimeWidget({ config, widgetId }: WidgetProps) {
  const ot = useWidgetBundles(config?.scope, widgetId).ontime;
  if (ot.isLoading) return <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered>;
  const d = ot.data as AnyData | undefined;
  const pct = d?.team_on_time_pct as number | null | undefined;
  const tone = pct == null ? 'text-foreground' : pct >= 90 ? 'text-emerald-600 dark:text-emerald-400' : pct >= 70 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400';
  return (
    <div className="flex h-full flex-col justify-center px-1">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <InfoLabel label="On-time submissions" side="top" />
      </p>
      <p className={cn('mt-1 text-3xl font-bold tabular-nums', tone)}>{pct != null ? `${pct}%` : '—'}</p>
      <p className="text-xs text-muted-foreground">{(d?.rows?.length ?? 0)} people · last 90 days</p>
    </div>
  );
}

// A small labelled stat. The label is wrapped in InfoLabel so abbreviations like
// CPI/SPI/EAC explain themselves on hover (it falls back to plain text when the
// label has no glossary entry, so no harm for self-evident labels).
function Metric({ label, value, tone = 'text-foreground', tip }: { label: string; value: string; tone?: string; tip?: React.ReactNode }) {
  const body = (
    <div className={cn('rounded-lg border border-border px-2 py-1.5', tip && 'cursor-help')}>
      <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        <InfoLabel label={label} side="top" />
      </p>
      <p className={cn('text-base font-bold tabular-nums', tone)}>{value}</p>
    </div>
  );
  // When a per-item breakdown is provided, hovering the WHOLE tile reveals it.
  return tip ? <Tooltip label={tip} side="top" maxWidth={320}>{body}</Tooltip> : body;
}

// ── Table ────────────────────────────────────────────────────────────────────
export const TABLE_SOURCES: { key: string; label: string }[] = [
  { key: 'top_projects', label: 'Projects by attention' },
  { key: 'financials', label: 'Financials by project' },
];

function TableWidget({ config, widgetId }: WidgetProps) {
  const table = config?.table ?? 'top_projects';
  const wd = useWidgetBundles(config?.scope, widgetId);
  const portfolio = wd.portfolio;
  const financials = wd.financials;
  if (portfolio.isLoading || financials.isLoading) return <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered>;

  if (table === 'financials') {
    const rows: AnyData[] = ((financials.data as AnyData | undefined)?.projects ?? []).slice(0, 8);
    return (
      <div className="w-full">
        <table className="w-full table-fixed text-xs">
          <colgroup><col /><col className="w-[72px]" /><col className="w-[56px]" /></colgroup>
          <thead><tr className="table-header-row">
            <th className="table-header-cell !px-2 !py-2">Project</th>
            <th className="table-header-cell !px-2 !py-2 text-right">Revenue</th>
            <th className="table-header-cell !px-2 !py-2 text-right">Margin</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.project_id} className="border-b border-border/50 last:border-0">
                <td className="truncate px-2 py-1.5 text-foreground" title={r.project_name}>{r.project_name}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-foreground">{fmtMoney(r.revenue, r.currency)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{r.margin_pct != null ? `${r.margin_pct}%` : '—'}</td>
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
    <div className="w-full">
      <table className="w-full table-fixed text-xs">
        <colgroup><col /><col className="w-[88px]" /><col className="w-[56px]" /></colgroup>
        <thead><tr className="table-header-row">
          <th className="table-header-cell !px-2 !py-2">Project</th>
          <th className="table-header-cell !px-2 !py-2">Health</th>
          <th className="table-header-cell !px-2 !py-2 text-right">Budget</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => {
            const m = healthMeta(r.health);
            return (
              <tr key={r.project_id} className="border-b border-border/50 last:border-0">
                <td className="truncate px-2 py-1.5 text-foreground" title={r.project_name}>{r.project_name}</td>
                <td className="px-2 py-1.5"><span className={cn('inline-flex items-center gap-1 truncate', m.text)}><span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', m.dot)} />{m.label}</span></td>
                <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{r.budget_used_pct != null ? `${r.budget_used_pct}%` : '—'}</td>
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

// Explains what a KPI number represents on hover: its scope (whole portfolio vs
// a client/project subset, and how many projects feed it) + the metric formula.
function KpiValueTip({ metric, label, value, projCount, scope }: {
  metric: string; label: string; value: string; projCount: number; scope?: WidgetScope;
}) {
  const def = infoTextFor(KPI_INFO[metric] ?? label);
  const clients = [...(scope?.clientIds ?? []), ...(scope?.clientId ? [scope.clientId] : [])].length;
  const projects = [...(scope?.projectIds ?? []), ...(scope?.projectId ? [scope.projectId] : [])].length;
  const scoped = clients > 0 || projects > 0 || scope?.taskId || scope?.userId;
  // Describe the breadth of what the number aggregates.
  let across: string;
  if (scope?.taskId) across = 'this one task';
  else if (projects === 1 && clients === 0) across = 'this one project';
  else if (scoped) across = `${projCount} project${projCount === 1 ? '' : 's'} in the selected scope`;
  else across = `all ${projCount} project${projCount === 1 ? '' : 's'} in your portfolio`;
  return (
    <div className="space-y-1">
      <p><span className="font-semibold">{value}</span> is {label.toLowerCase()} across <span className="font-medium">{across}</span>{scope?.userId ? ' (one resource)' : ''}.</p>
      {def ? <p className="text-[11px] text-muted-foreground">{def}</p> : null}
      <p className="text-[11px] text-muted-foreground">Live: recomputed from approved time, not a single project or client.</p>
    </div>
  );
}

// A short, always-visible line under a scoped tile's value that names what the
// tile covers (which clients/projects/task/resource), so the number isn't
// ambiguous without hovering. Renders nothing for a whole-portfolio tile.
function ScopeLine({ scope }: { scope?: WidgetScope }) {
  const clientIds = [...(scope?.clientIds ?? []), ...(scope?.clientId ? [scope.clientId] : [])];
  const projectIds = [...(scope?.projectIds ?? []), ...(scope?.projectId ? [scope.projectId] : [])];
  const hasScope = clientIds.length || projectIds.length || scope?.taskId || scope?.userId;
  // Only fetch the name directory when this tile is actually scoped.
  const { data } = useDashboardScopeOptions(!!hasScope);
  if (!hasScope) {
    return <p className="truncate text-[10px] text-muted-foreground">Whole portfolio</p>;
  }
  const nameOf = (list: any[] | undefined, id: number, key: 'name' | 'title', fallback: string) =>
    list?.find((x) => x.id === id)?.[key] ?? fallback;
  const parts: string[] = [];
  if (clientIds.length === 1) parts.push(nameOf(data?.clients, clientIds[0], 'name', 'client'));
  else if (clientIds.length > 1) parts.push(`${clientIds.length} clients`);
  if (projectIds.length === 1) parts.push(nameOf(data?.projects, projectIds[0], 'name', 'project'));
  else if (projectIds.length > 1) parts.push(`${projectIds.length} projects`);
  if (scope?.taskId) parts.push(nameOf(data?.tasks, scope.taskId, 'title', 'task'));
  if (scope?.userId) parts.push(nameOf(data?.people, scope.userId, 'name', 'resource'));
  const text = parts.join(' · ');
  return (
    <Tooltip label={text} side="top" maxWidth={260}>
      <p className="truncate text-[10px] text-muted-foreground">{text}</p>
    </Tooltip>
  );
}

// Lists the projects in a given health tier, so hovering "Critical 3" shows
// which 3 projects are critical (with their client + the reason). Reads the
// per-project rows the portfolio response already carries — no extra fetch.
function HealthTierTip({ label, health, rows }: { label: string; health: string; rows: AnyData[] }) {
  const matched = rows.filter((r) => r.health === health);
  if (!matched.length) return <span>No projects are {label.toLowerCase()}.</span>;
  return (
    <div className="space-y-1">
      <p className="font-semibold">{label} · {matched.length}</p>
      <ul className="space-y-0.5">
        {matched.slice(0, 10).map((r) => (
          <li key={r.project_id} className="leading-snug">
            <span className="font-medium">{r.project_name}</span>
            {r.client_name ? <span className="text-muted-foreground"> · {r.client_name}</span> : null}
            {r.health_reason ? <span className="block text-[11px] text-muted-foreground">{r.health_reason}</span> : null}
          </li>
        ))}
        {matched.length > 10 ? <li className="text-[11px] text-muted-foreground">+{matched.length - 10} more</li> : null}
      </ul>
    </div>
  );
}

// Per-project summary shown when hovering a project's value in a chart.
function ProjectTip({ name, client, revenue, currency, marginPct, budgetPct, hours }: {
  name: string; client?: string; revenue?: number | string; currency?: string;
  marginPct?: number | null; budgetPct?: number | null; hours?: number | null;
}) {
  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex justify-between gap-4"><span className="text-muted-foreground">{k}</span><span className="font-medium tabular-nums">{v}</span></div>
  );
  return (
    <div className="space-y-0.5">
      <p className="font-semibold">{name}</p>
      {client ? <p className="text-[11px] text-muted-foreground">{client}</p> : null}
      <div className="mt-1 space-y-0.5">
        {revenue != null ? <Row k="Revenue" v={fmtMoney(revenue, currency)} /> : null}
        {marginPct != null ? <Row k="Margin" v={`${marginPct}%`} /> : null}
        {budgetPct != null ? <Row k="Budget burn" v={`${budgetPct}%`} /> : null}
        {hours != null ? <Row k="Logged hours" v={`${Math.round(Number(hours))}h`} /> : null}
      </div>
    </div>
  );
}

// ── registry: the single source of truth for widget types ────────────────────
export interface WidgetProps { config?: WidgetConfig; widgetId?: string }
export interface WidgetMeta {
  type: WidgetType;
  label: string;
  defaultW: number;
  defaultH: number;
  Component: (props: WidgetProps) => JSX.Element;
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

// Plain-English description shown as the widget header's hover tooltip. For the
// configurable types (kpi/chart/table) it reflects the chosen metric/source.
export function widgetHeaderInfo(type: WidgetType, config?: WidgetConfig): string {
  if (type === 'kpi') {
    const m = KPI_METRICS.find((x) => x.key === config?.metric)?.label ?? 'metric';
    return `A single headline number: ${m.toLowerCase()}, across the portfolio.`;
  }
  if (type === 'chart') {
    return CHART_SOURCES.find((x) => x.key === config?.source)?.label ?? 'A chart of portfolio data.';
  }
  if (type === 'table') {
    return TABLE_SOURCES.find((x) => x.key === config?.table)?.label ?? 'A table of portfolio data.';
  }
  return WIDGET_DESC[type] ?? WIDGET_REGISTRY[type]?.label ?? 'Widget.';
}

let widgetCounter = 0;
export const newWidgetId = () => `w_${Date.now().toString(36)}_${(widgetCounter++).toString(36)}`;

// Build a fresh widget instance from a type + its (type-specific) config. A
// non-empty scope is carried onto the new widget so it can be fully configured
// at creation time.
export function makeWidget(type: WidgetType, config: WidgetConfig): WidgetInstance {
  const meta = WIDGET_REGISTRY[type];
  const base = type === 'kpi' ? { metric: config.metric }
    : type === 'chart' ? { source: config.source }
      : type === 'table' ? { table: config.table }
        : {};
  const scope = config.scope;
  const hasScope = !!scope && (scope.clientIds?.length || scope.projectIds?.length || scope.clientId || scope.projectId || scope.taskId || scope.userId);
  const clean = { ...base, ...(hasScope ? { scope } : {}) };
  return { id: newWidgetId(), type, x: 0, y: 0, w: meta.defaultW, h: meta.defaultH, title: defaultWidgetTitle(type, clean), config: clean };
}
