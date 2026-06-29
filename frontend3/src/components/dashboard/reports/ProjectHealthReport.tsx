import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Download, Pencil } from 'lucide-react';

import { TonePill } from '@/components/ui';
import { cn } from '@/lib/cn';
import { healthMeta, MANUAL_HEALTH } from '@/lib/projectHealth';
import { useSetProjectHealthOverride } from '@/hooks/useDashboard';
import type { ManagerProjectHealth, ProjectHealthRow } from '@/types/dashboard';

// Full "Project health" report. Standalone (data-only), modal today,
// route-ready later. Adds over the compact tile: days-until-end, budget hours
// remaining, sorting on every column, all rows, and CSV export. Health labels /
// tones / sort-rank come from lib/projectHealth (single source of truth).

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
        case 'health': return healthMeta(r.health).rank;
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
    const headers = ['Project', 'Client', 'Logged hours', 'Budget burn %', 'Budget hours remaining', 'Days until end', 'Health'];
    const lines = sorted.map((r) => [
      r.project_name, r.client_name,
      Math.round(Number(r.hours_this_week)),
      r.budget_pct ?? '', r.budget_hours_remaining ?? '',
      r.days_until_end ?? '', healthMeta(r.health).label,
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
      className={cn('table-header-cell table-header-cell-sticky sticky top-0 z-10 cursor-pointer select-none whitespace-nowrap', align === 'right' && 'text-right')}
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
            <tr>
              <SortHead label="Project" k="project" />
              <SortHead label="Client" k="client" />
              <SortHead label="Logged hours" k="hours" align="right" />
              <SortHead label="Budget burn" k="budget" align="right" />
              <SortHead label="Budget hrs left" k="budget" align="right" />
              <SortHead label="Ends in" k="ends" align="right" />
              <SortHead label="Health" k="health" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.project_id} className="border-b border-border/60">
                <td className="px-3 py-2 font-medium text-foreground">{r.project_name}</td>
                <td className="px-3 py-2 text-muted-foreground">{r.client_name}</td>
                <td className="px-3 py-2 text-right tabular-nums text-foreground">{Math.round(Number(r.hours_this_week))}h</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.budget_pct != null ? `${r.budget_pct}%` : 'N/A'}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.budget_hours_remaining != null ? `${Math.round(r.budget_hours_remaining)}h` : '·'}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.days_until_end != null ? `${r.days_until_end}d` : '·'}</td>
                <td className="px-3 py-2"><HealthCell row={r} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Health pill that doubles as a manual-override control. Clicking opens a small
// menu to set a tier (Excellent / On track / At risk / Critical) or clear the
// override (back to auto). A manual override is shown with a pencil mark and the
// "Manually set…" reason in the tooltip (health_reason from the API).
function HealthCell({ row }: { row: ProjectHealthRow }) {
  const meta = healthMeta(row.health);
  const setOverride = useSetProjectHealthOverride();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // The API prefixes overridden rows' reason with "Manually set".
  const isManual = (row.health_reason ?? '').startsWith('Manually set');

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (health: string | null) => {
    setOpen(false);
    setOverride.mutate({ projectId: row.project_id, health });
  };

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={setOverride.isPending}
        title={row.health_reason ?? undefined}
        aria-label={`Set status for ${row.project_name}`}
        className="inline-flex items-center gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
      >
        <TonePill tone={meta.tone}>{meta.label}</TonePill>
        {isManual ? <Pencil className="h-3 w-3 text-muted-foreground" aria-label="Manually set" /> : null}
      </button>
      {open ? (
        <div className="absolute right-0 top-7 z-50 w-44 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl">
          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Set status</p>
          {MANUAL_HEALTH.map((opt) => {
            const m = healthMeta(opt.value);
            const active = row.health === opt.value && isManual;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => pick(opt.value)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-primary/5"
              >
                <span className={cn('h-2 w-2 rounded-full', m.dot)} />
                <span className="flex-1">{opt.label}</span>
                {active ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
              </button>
            );
          })}
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={() => pick(null)}
            disabled={!isManual}
            className="w-full rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-primary/5 disabled:opacity-40"
          >
            Clear override (auto)
          </button>
        </div>
      ) : null}
    </div>
  );
}
