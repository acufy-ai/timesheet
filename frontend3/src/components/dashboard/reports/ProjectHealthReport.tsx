import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Download } from 'lucide-react';

import { TonePill } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { ManagerProjectHealth, ProjectHealth, ProjectHealthRow } from '@/types/dashboard';

// Full "Project health" report. Standalone (data-only), modal today,
// route-ready later. Adds over the compact tile: days-until-end, budget hours
// remaining, sorting on every column, all rows, and CSV export.

const HEALTH_META: Record<ProjectHealth, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; rank: number }> = {
  'needs-attention': { label: 'Needs attention', tone: 'danger', rank: 0 },
  'at-risk': { label: 'At risk', tone: 'warning', rank: 1 },
  good: { label: 'Good', tone: 'success', rank: 2 },
  'not-set': { label: 'Not set', tone: 'neutral', rank: 3 },
};

type SortKey = 'project' | 'client' | 'hours' | 'budget' | 'ends' | 'health';
type SortDir = 'asc' | 'desc';

export function ProjectHealthReport({ data }: { data: ManagerProjectHealth }) {
  const [sortKey, setSortKey] = useState<SortKey>('health');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const val = (r: ProjectHealthRow): number | string => {
      switch (sortKey) {
        case 'project': return r.project_name.toLowerCase();
        case 'client': return r.client_name.toLowerCase();
        case 'hours': return Number(r.hours_this_week);
        case 'budget': return r.budget_pct ?? -1;
        case 'ends': return r.days_until_end ?? Number.MAX_SAFE_INTEGER;
        case 'health': return HEALTH_META[r.health]?.rank ?? 99;
      }
    };
    return [...data.rows].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb) * dir;
      return ((va as number) - (vb as number)) * dir;
    });
  }, [data.rows, sortKey, sortDir]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'project' || key === 'client' ? 'asc' : key === 'health' ? 'asc' : 'desc'); }
  };

  const exportCsv = () => {
    const headers = ['Project', 'Client', 'Hours this week', 'Budget burn %', 'Budget hours remaining', 'Days until end', 'Health'];
    const lines = sorted.map((r) => [
      r.project_name, r.client_name,
      Math.round(Number(r.hours_this_week)),
      r.budget_pct ?? '', r.budget_hours_remaining ?? '',
      r.days_until_end ?? '', HEALTH_META[r.health]?.label ?? r.health,
    ]);
    const esc = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers, ...lines].map((r) => r.map(esc).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'project-health.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const SortHead = ({ label, k, align = 'left' }: { label: string; k: SortKey; align?: 'left' | 'right' }) => (
    <th
      className={cn('sticky top-0 z-10 cursor-pointer select-none bg-card px-3 py-2 font-semibold whitespace-nowrap', align === 'left' ? 'text-left' : 'text-right')}
      onClick={() => onSort(k)}
    >
      <span className={cn('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
        {label}
        {sortKey === k ? (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : null}
      </span>
    </th>
  );

  if (data.rows.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No projects to show.</p>;
  }

  return (
    <div className="flex flex-col gap-3 pb-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{sorted.length} projects · sorted by {sortKey}</p>
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
              <SortHead label="Client" k="client" />
              <SortHead label="Hours this week" k="hours" align="right" />
              <SortHead label="Budget burn" k="budget" align="right" />
              <SortHead label="Budget hrs left" k="budget" align="right" />
              <SortHead label="Ends in" k="ends" align="right" />
              <SortHead label="Health" k="health" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const meta = HEALTH_META[r.health] ?? HEALTH_META['not-set'];
              return (
                <tr key={r.project_id} className="border-b border-border/60">
                  <td className="px-3 py-2 font-medium text-foreground">{r.project_name}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.client_name}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-foreground">{Math.round(Number(r.hours_this_week))}h</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.budget_pct != null ? `${r.budget_pct}%` : 'N/A'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.budget_hours_remaining != null ? `${Math.round(r.budget_hours_remaining)}h` : '·'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.days_until_end != null ? `${r.days_until_end}d` : '·'}</td>
                  <td className="px-3 py-2"><TonePill tone={meta.tone}>{meta.label}</TonePill></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
