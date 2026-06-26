import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp, Download } from 'lucide-react';

import { cn } from '@/lib/cn';
import { fmtMoneyExact } from '@/lib/format';
import { InfoLabel } from '@/components/dashboard/InfoLabel';
import type { ManagerFinancials, ProjectFinancialRow } from '@/types/dashboard';

// Full "Financials" report. Standalone (data-only), modal today, route-ready
// later. Adds over the compact tile: billable vs approved hours split, budget
// and contract dollars remaining, margin/cost, sorting, all rows, CSV export.

// Margin %% color: healthy (>=40) emerald, thin (>=15) amber, weak/negative rose.
function marginTone(pct: number): string {
  if (pct >= 40) return 'text-emerald-600 dark:text-emerald-400';
  if (pct >= 15) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}

type SortKey = 'project' | 'hours' | 'billable' | 'revenue' | 'cost' | 'margin' | 'budget' | 'contract';
type SortDir = 'asc' | 'desc';

export function FinancialsReport({ data }: { data: ManagerFinancials }) {
  const navigate = useNavigate();
  const [sortKey, setSortKey] = useState<SortKey>('revenue');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const currency = data.summary.currency;

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
    const headers = ['Project', 'Client', 'Approved hours', 'Billable hours', 'Revenue', 'Cost', 'Margin', 'Margin %', 'Budget used %', 'Budget amount', 'Contract used %', 'Contract value'];
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
      className={cn('sticky top-0 z-10 cursor-pointer select-none bg-card px-3 py-2 font-semibold whitespace-nowrap', align === 'left' ? 'text-left' : 'text-right')}
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
      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
        {[
          ['Revenue', fmtMoneyExact(data.summary.total_revenue, currency)],
          ['Approved hours', `${Math.round(Number(data.summary.total_approved_hours))}h`],
          ['Billable hours', `${Math.round(Number(data.summary.billable_hours))}h`],
          ['Utilization', data.summary.utilization_pct != null ? `${data.summary.utilization_pct}%` : 'N/A'],
        ].map(([label, val]) => (
          <div key={label} className="bg-card px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
            <p className="mt-0.5 text-[15px] font-bold tabular-nums text-foreground">{val}</p>
          </div>
        ))}
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
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <SortHead label="Project" k="project" />
              <SortHead label="Approved" k="hours" align="right" />
              <SortHead label="Billable" k="billable" align="right" />
              <SortHead label="Revenue" k="revenue" align="right" />
              <SortHead label="Cost" k="cost" align="right" />
              <SortHead label="Margin" k="margin" align="right" />
              <SortHead label="Budget used" k="budget" align="right" />
              <SortHead label="Contract used" k="contract" align="right" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={r.project_id}
                onClick={() => navigate(`/insights/project/${r.project_id}`)}
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
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
