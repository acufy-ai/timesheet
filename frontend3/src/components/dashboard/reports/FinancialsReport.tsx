import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp, Download } from 'lucide-react';

import { cn } from '@/lib/cn';
import { fmtMoneyExact } from '@/lib/format';
import { Tooltip } from '@/components/ui';
import { InfoLabel } from '@/components/dashboard/InfoLabel';
import type { ManagerFinancials, ProjectFinancialRow, RevRec } from '@/types/dashboard';

// Full "Financials" report. Standalone (data-only), modal today, route-ready
// later. Adds over the compact tile: billable vs approved hours split, budget
// and contract dollars remaining, margin/cost, sorting, all rows, CSV export.

// Margin %% color: healthy (>=40) emerald, thin (>=15) amber, weak/negative rose.
function marginTone(pct: number): string {
  if (pct >= 40) return 'text-emerald-600 dark:text-emerald-400';
  if (pct >= 15) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}

type SortKey = 'project' | 'hours' | 'billable' | 'revenue' | 'cost' | 'margin' | 'budget' | 'contract' | 'recognized';
type SortDir = 'asc' | 'desc';

export function FinancialsReport({ data, revrec }: { data: ManagerFinancials; revrec?: RevRec }) {
  const navigate = useNavigate();
  const [sortKey, setSortKey] = useState<SortKey>('revenue');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const currency = data.summary.currency;

  // Join the revenue-recognition rows (method / % complete / billed /
  // recognized) onto each project so the single table carries the rev-rec
  // detail too — no separate near-duplicate table.
  const rrByProject = useMemo(() => {
    const m = new Map<number, RevRec['rows'][number]>();
    (revrec?.rows ?? []).forEach((r) => m.set(r.project_id, r));
    return m;
  }, [revrec]);

  // Per-client rollups for the tile hover breakdowns (the tiles are portfolio
  // totals across all this manager's projects; hover shows the client split).
  const byClient = useMemo(() => {
    const m = new Map<string, { client: string; revenue: number; approved: number; billable: number }>();
    for (const p of data.projects) {
      const key = p.client_name || 'No client';
      const e = m.get(key) ?? { client: key, revenue: 0, approved: 0, billable: 0 };
      e.revenue += Number(p.revenue);
      e.approved += Number(p.approved_hours);
      e.billable += Number(p.billable_hours);
      m.set(key, e);
    }
    return [...m.values()].sort((a, b) => b.revenue - a.revenue);
  }, [data.projects]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const val = (r: ProjectFinancialRow): number | string => {
      switch (sortKey) {
        case 'project': return r.project_name.toLowerCase();
        case 'hours': return Number(r.approved_hours);
        case 'billable': return Number(r.billable_hours);
        case 'revenue': return Number(r.revenue);
        case 'cost': return Number(r.cost ?? 0);
        case 'margin': return r.margin_pct ?? -999;
        case 'budget': return r.budget_used_pct ?? -1;
        case 'contract': return r.contract_used_pct ?? -1;
        case 'recognized': return Number(rrByProject.get(r.project_id)?.recognized ?? -1);
      }
    };
    return [...data.projects].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb) * dir;
      return ((va as number) - (vb as number)) * dir;
    });
  }, [data.projects, sortKey, sortDir]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'project' ? 'asc' : 'desc'); }
  };

  const exportCsv = () => {
    const headers = ['Project', 'Client', 'Approved hours', 'Billable hours', 'Revenue', 'Cost', 'Margin', 'Margin %', 'Budget burn %', 'Budget amount', 'Contract billed %', 'Contract value'];
    const lines = sorted.map((r) => [
      r.project_name, r.client_name,
      Math.round(Number(r.approved_hours)), Math.round(Number(r.billable_hours)),
      Number(r.revenue).toFixed(0),
      Number(r.cost ?? 0).toFixed(0), Number(r.margin ?? 0).toFixed(0), r.margin_pct ?? '',
      r.budget_used_pct ?? '', r.budget_amount != null ? Number(r.budget_amount).toFixed(0) : '',
      r.contract_used_pct ?? '', r.contract_value != null ? Number(r.contract_value).toFixed(0) : '',
    ]);
    const esc = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers, ...lines].map((r) => r.map(esc).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'financials.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const SortHead = ({ label, k, align = 'left' }: { label: string; k: SortKey; align?: 'left' | 'right' }) => (
    <th
      className={cn('table-header-cell table-header-cell-sticky sticky top-0 z-10 cursor-pointer select-none whitespace-nowrap', align === 'right' && 'text-right')}
      onClick={() => onSort(k)}
    >
      <span className={cn('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
        <InfoLabel label={label} side="bottom" />
        {sortKey === k ? (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : null}
      </span>
    </th>
  );

  if (data.projects.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No financial data yet.</p>;
  }

  const totalRevenue = sorted.reduce((s, r) => s + Number(r.revenue), 0);

  return (
    <div className="flex flex-col gap-3 pb-4">
      {/* Summary strip. These are TOTALS across all of this manager's projects;
          hovering a money/hours tile shows the per-client breakdown. */}
      <div>
        <p className="mb-1 text-[11px] text-muted-foreground">Totals across all your projects · hover a value for the client breakdown</p>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
          <SummaryTile label="Revenue" value={fmtMoneyExact(data.summary.total_revenue, currency)}
            breakdown={byClient.map((c) => ({ k: c.client, v: fmtMoneyExact(c.revenue, currency) }))} />
          <SummaryTile label="Approved hours" value={`${Math.round(Number(data.summary.total_approved_hours))}h`}
            breakdown={byClient.map((c) => ({ k: c.client, v: `${Math.round(c.approved)}h` }))} />
          <SummaryTile label="Billable hours" value={`${Math.round(Number(data.summary.billable_hours))}h`}
            breakdown={byClient.map((c) => ({ k: c.client, v: `${Math.round(c.billable)}h` }))} />
          <SummaryTile label="Utilization" value={data.summary.utilization_pct != null ? `${data.summary.utilization_pct}%` : 'N/A'} />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{sorted.length} projects · approved time × resolved rate</p>
        <button
          type="button"
          onClick={exportCsv}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.04]"
        >
          <Download className="h-3.5 w-3.5" /> Export CSV
        </button>
      </div>

      <div className="overflow-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <SortHead label="Project" k="project" />
              <SortHead label="Approved" k="hours" align="right" />
              <SortHead label="Billable" k="billable" align="right" />
              <SortHead label="Revenue" k="revenue" align="right" />
              <SortHead label="Cost" k="cost" align="right" />
              <SortHead label="Margin" k="margin" align="right" />
              <SortHead label="Budget burn" k="budget" align="right" />
              <SortHead label="Contract billed" k="contract" align="right" />
              {revrec ? <th className="table-header-cell table-header-cell-sticky sticky top-0 z-10 whitespace-nowrap text-center">Rev-rec method</th> : null}
              {revrec ? <SortHead label="Recognized" k="recognized" align="right" /> : null}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={r.project_id}
                onClick={() => navigate(`/insights/project/${r.project_id}?from=financials`)}
                className="cursor-pointer border-b border-border/60 hover:bg-foreground/[0.03]"
              >
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{r.project_name}</div>
                  {r.client_id ? (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); navigate(`/client-management?client=${r.client_id}`); }}
                      className="text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                    >
                      {r.client_name}
                    </button>
                  ) : (
                    <div className="text-[11px] text-muted-foreground">{r.client_name}</div>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-foreground">{Math.round(Number(r.approved_hours))}h</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{Math.round(Number(r.billable_hours))}h</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-foreground">{fmtMoneyExact(r.revenue, r.currency)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{Number(r.cost ?? 0) > 0 ? fmtMoneyExact(r.cost ?? 0, r.currency) : '·'}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.margin_pct != null ? (
                    <span className={cn('font-semibold', marginTone(r.margin_pct))}>{r.margin_pct}%</span>
                  ) : <span className="text-muted-foreground">N/A</span>}
                </td>
                <td className="px-3 py-2 text-right">
                  {r.budget_used_pct != null ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="tabular-nums text-foreground">{r.budget_used_pct}%</span>
                      <span className="text-[11px] text-muted-foreground">of {fmtMoneyExact(r.budget_amount ?? 0, r.currency)}</span>
                    </span>
                  ) : <span className="text-muted-foreground">N/A</span>}
                </td>
                <td className="px-3 py-2 text-right">
                  {r.contract_used_pct != null ? (
                    <span className="inline-flex items-center gap-1.5" title={r.contract_title ?? undefined}>
                      <span className="tabular-nums text-foreground">{r.contract_used_pct}%</span>
                      <span className="text-[11px] text-muted-foreground">of {fmtMoneyExact(r.contract_value ?? 0, r.currency)}</span>
                    </span>
                  ) : <span className="text-muted-foreground">—</span>}
                </td>
                {revrec ? (() => {
                  const rec = rrByProject.get(r.project_id);
                  return (
                    <>
                      <td className="px-3 py-2 text-center">
                        {rec ? (
                          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', rec.method === 'percent_complete' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}>
                            {rec.method === 'percent_complete' ? `% complete${rec.percent_complete != null ? ` · ${rec.percent_complete}%` : ''}` : 'As billed'}
                          </span>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-foreground">
                        {rec ? fmtMoneyExact(rec.recognized, rec.currency) : <span className="font-normal text-muted-foreground">—</span>}
                      </td>
                    </>
                  );
                })() : null}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border text-[11px] text-muted-foreground">
              <td className="px-3 py-2 font-semibold uppercase tracking-wider">Total</td>
              <td className="px-3 py-2 text-right tabular-nums">{Math.round(Number(data.summary.total_approved_hours))}h</td>
              <td className="px-3 py-2 text-right tabular-nums">{Math.round(Number(data.summary.billable_hours))}h</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums text-foreground">{fmtMoneyExact(totalRevenue, currency)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtMoneyExact(data.summary.total_cost ?? 0, currency)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{data.summary.total_margin_pct != null ? <span className={cn('font-semibold', marginTone(data.summary.total_margin_pct))}>{data.summary.total_margin_pct}%</span> : '—'}</td>
              <td className="px-3 py-2" />
              <td className="px-3 py-2" />
              {revrec ? <td className="px-3 py-2" /> : null}
              {revrec ? <td className="px-3 py-2 text-right font-semibold tabular-nums text-foreground">{fmtMoneyExact(revrec.total_recognized, currency)}</td> : null}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// A summary tile. When `breakdown` is given, hovering the value reveals the
// per-client split (the tile itself is a portfolio total).
function SummaryTile({ label, value, breakdown }: {
  label: string; value: string; breakdown?: { k: string; v: string }[];
}) {
  const body = (
    <div className="bg-card px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-[15px] font-bold tabular-nums text-foreground', breakdown?.length && 'cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-4')}>{value}</p>
    </div>
  );
  if (!breakdown?.length) return body;
  const tip = (
    <div className="space-y-0.5">
      <p className="mb-1 font-semibold">{label} by client</p>
      {breakdown.map((r) => (
        <div key={r.k} className="flex justify-between gap-6">
          <span className="text-muted-foreground">{r.k}</span>
          <span className="font-medium tabular-nums">{r.v}</span>
        </div>
      ))}
    </div>
  );
  return <Tooltip label={tip} side="bottom" maxWidth={260}>{body}</Tooltip>;
}
