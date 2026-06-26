import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Download } from 'lucide-react';

import { cn } from '@/lib/cn';
import { fmtMoneyExact } from '@/lib/format';
import type { TeamProjectMatrix, TeamProjectMatrixRow } from '@/types/dashboard';

// Full "Project hours by person" report. Standalone: takes only the matrix
// data, renders the complete (un-paginated) table with sorting, derived
// metrics, and CSV export. Mounted in a modal today; mountable at a dedicated
// /dashboard/reports route or a shareable dashboard later without change.
//
// What this adds over the compact dashboard tile:
//  - every person at once (no pagination)
//  - sort by any column (person, each project, total, revenue, share, $/hr)
//  - derived columns the tile omits: share of total hours, avg $/hour
//  - CSV export of the whole matrix

type SortKey = 'name' | 'total' | 'revenue' | 'share' | 'rate' | `proj:${number}`;
type SortDir = 'asc' | 'desc';

interface EnrichedRow {
  row: TeamProjectMatrixRow;
  hoursByProject: Map<number, number>;
  totalHours: number;
  revenue: number;
  share: number; // % of grand-total hours
  rate: number; // revenue / hours ($/hr), 0 when no hours
}

export function ProjectMatrixReport({ data }: { data: TeamProjectMatrix }) {
  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const baseRows = useMemo(
    () => data.rows.filter((r) => Number(r.total_hours) > 0),
    [data.rows],
  );

  const grandHours = useMemo(
    () => baseRows.reduce((s, r) => s + Number(r.total_hours), 0),
    [baseRows],
  );

  const enriched = useMemo<EnrichedRow[]>(() => {
    return baseRows.map((row) => {
      const hoursByProject = new Map<number, number>();
      for (const c of row.cells) hoursByProject.set(c.project_id, Number(c.hours));
      const totalHours = Number(row.total_hours);
      const revenue = Number(row.revenue ?? 0);
      return {
        row,
        hoursByProject,
        totalHours,
        revenue,
        share: grandHours > 0 ? (totalHours / grandHours) * 100 : 0,
        rate: totalHours > 0 ? revenue / totalHours : 0,
      };
    });
  }, [baseRows, grandHours]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const val = (e: EnrichedRow): number | string => {
      if (sortKey === 'name') return e.row.full_name.toLowerCase();
      if (sortKey === 'total') return e.totalHours;
      if (sortKey === 'revenue') return e.revenue;
      if (sortKey === 'share') return e.share;
      if (sortKey === 'rate') return e.rate;
      // proj:<id>
      const pid = Number(sortKey.slice(5));
      return e.hoursByProject.get(pid) ?? 0;
    };
    return [...enriched].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb) * dir;
      return ((va as number) - (vb as number)) * dir;
    });
  }, [enriched, sortKey, sortDir]);

  const maxCell = useMemo(() => {
    let m = 0;
    for (const r of baseRows) for (const c of r.cells) m = Math.max(m, Number(c.hours));
    return m;
  }, [baseRows]);
  const heat = (h: number): React.CSSProperties =>
    h > 0 && maxCell > 0
      ? { backgroundColor: `hsl(var(--primary) / ${(0.08 + 0.32 * (h / maxCell)).toFixed(3)})` }
      : {};

  const projectTotals = useMemo(() => {
    const m = new Map<number, number>();
    for (const p of data.projects) m.set(p.project_id, Number(p.total_hours));
    return m;
  }, [data.projects]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Names sort A→Z by default; numeric columns high→low.
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  const exportCsv = () => {
    const headers = [
      'Person',
      'Title',
      ...data.projects.map((p) => `${p.project_name} (${p.client_name}) hours`),
      'Total hours',
      'Share %',
      'Revenue',
      '$/hour',
    ];
    const lines = sorted.map((e) => {
      const cells = data.projects.map((p) => e.hoursByProject.get(p.project_id) ?? 0);
      return [
        e.row.full_name,
        e.row.title ?? '',
        ...cells,
        e.totalHours,
        e.share.toFixed(1),
        e.revenue.toFixed(0),
        e.rate.toFixed(2),
      ];
    });
    const esc = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers, ...lines].map((r) => r.map(esc).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `project-hours-by-person-last-${data.days_back}d.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const SortHead = ({
    label,
    sortKey: key,
    align = 'right',
    title,
  }: {
    label: string;
    sortKey: SortKey;
    align?: 'left' | 'right';
    title?: string;
  }) => (
    <th
      className={cn(
        'sticky top-0 z-10 cursor-pointer select-none bg-card px-3 py-2 font-semibold whitespace-nowrap',
        align === 'left' ? 'text-left' : 'text-right',
      )}
      onClick={() => onSort(key)}
      title={title}
    >
      <span className={cn('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
        {label}
        {sortKey === key ? (
          sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
        ) : null}
      </span>
    </th>
  );

  if (baseRows.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No hours logged in this window.</p>;
  }

  return (
    <div className="flex flex-col gap-3 pb-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {sorted.length} people · hours: last {data.days_back}d · revenue: all-time · approved only
        </p>
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
              <SortHead label="Person" sortKey="name" align="left" />
              {data.projects.map((p) => (
                <SortHead
                  key={p.project_id}
                  label={p.project_name}
                  sortKey={`proj:${p.project_id}`}
                  title={`${p.project_name} (${p.client_name})`}
                />
              ))}
              <SortHead label="Total" sortKey="total" title="Total approved hours in window" />
              <SortHead label="Share" sortKey="share" title="Share of total team hours" />
              <SortHead label="Revenue" sortKey="revenue" title="All-time billed revenue" />
              <SortHead label="$/hr" sortKey="rate" title="Revenue per hour (revenue ÷ hours)" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((e) => (
              <tr key={e.row.user_id} className="border-b border-border/60">
                <td className="px-3 py-2 text-foreground">
                  <span className="block leading-tight">{e.row.full_name}</span>
                  {e.row.title ? (
                    <span className="block text-[11px] leading-tight text-muted-foreground">{e.row.title}</span>
                  ) : null}
                </td>
                {data.projects.map((p) => {
                  const h = e.hoursByProject.get(p.project_id) ?? 0;
                  return (
                    <td
                      key={p.project_id}
                      className={cn('px-3 py-2 text-right tabular-nums', h > 0 ? 'text-foreground' : 'text-muted-foreground/30')}
                      style={heat(h)}
                    >
                      {h > 0 ? `${h}h` : '·'}
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-foreground">{e.totalHours}h</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{e.share.toFixed(1)}%</td>
                <td className="px-3 py-2 text-right tabular-nums text-foreground">
                  {e.revenue > 0 ? fmtMoneyExact(e.revenue) : '·'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {e.rate > 0 ? fmtMoneyExact(e.rate) : '·'}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border text-[11px] text-muted-foreground">
              <td className="px-3 py-2 font-semibold uppercase tracking-wider">Project total</td>
              {data.projects.map((p) => (
                <td key={p.project_id} className="px-3 py-2 text-right tabular-nums">
                  {projectTotals.get(p.project_id) ?? 0}h
                </td>
              ))}
              <td className="px-3 py-2 text-right font-semibold tabular-nums text-foreground">{grandHours}h</td>
              <td className="px-3 py-2 text-right tabular-nums">100%</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums text-foreground">
                {fmtMoneyExact(enriched.reduce((s, e) => s + e.revenue, 0))}
              </td>
              <td className="px-3 py-2" />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
