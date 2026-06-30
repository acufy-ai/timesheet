import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Trash2, Pencil, Check, X, AlertTriangle } from 'lucide-react';

import { cn } from '@/lib/cn';
import { resourceAllocationsApi } from '@/api/client';
import { useDashboardScopeOptions } from '@/hooks/useCustomDashboards';
import { useAuth } from '@/contexts/AuthContext';
import type { ResourceAllocation, ResourceAllocationBody } from '@/types/dashboard';

// The WRITE side of the Resourcing view: list a person's planned allocations and
// add/edit/remove them. The manager enters DAYS/WEEK or HOURS/WEEK (what they
// actually think in); the % is computed and a live "this puts them at X%"
// preview warns before saving. Manager/Admin only.
export function AllocationManager({ userId, onChanged }: { userId: number; onChanged?: () => void }) {
  const { user } = useAuth();
  const canEdit = user?.role === 'MANAGER' || user?.role === 'ADMIN' || user?.role === 'PLATFORM_ADMIN';
  const qc = useQueryClient();
  const listQ = useQuery({
    queryKey: ['resource-allocations', userId],
    queryFn: () => resourceAllocationsApi.list({ user_id: userId }).then((r) => r.data),
    enabled: userId != null,
  });
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['resource-allocations', userId] });
    // The capacity numbers in the resourcing list + detail recompute from these.
    qc.invalidateQueries({ queryKey: ['dashboard', 'team-resourcing'] });
    qc.invalidateQueries({ queryKey: ['dashboard', 'resource', userId] });
    onChanged?.();
  };

  const del = useMutation({
    mutationFn: (id: number) => resourceAllocationsApi.remove(id),
    onSuccess: refresh,
  });

  const allocations = listQ.data ?? [];

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
          Planned allocations <span className="text-muted-foreground/70">{allocations.length}</span>
        </p>
        {canEdit && !adding && editId == null ? (
          <button type="button" onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline">
            <Plus className="h-3.5 w-3.5" /> Allocate
          </button>
        ) : null}
      </div>

      {listQ.isLoading ? (
        <div className="flex items-center gap-2 py-2 text-[12px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
      ) : null}

      {adding ? (
        <AllocationForm userId={userId} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); refresh(); }} />
      ) : null}

      <div className="space-y-1.5">
        {allocations.map((a) => (
          editId === a.id ? (
            <AllocationForm key={a.id} userId={userId} existing={a}
              onCancel={() => setEditId(null)} onSaved={() => { setEditId(null); refresh(); }} />
          ) : (
            <div key={a.id} className="flex items-center gap-2 rounded-md border border-border/70 bg-card px-2.5 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] font-medium text-foreground">{a.project_name ?? `Project ${a.project_id}`}</p>
                <p className="text-[11px] text-muted-foreground">
                  {pctLabel(a)} · {fmtRange(a.start_date, a.end_date)}
                </p>
              </div>
              {canEdit ? (
                <>
                  <button type="button" title="Edit" onClick={() => setEditId(a.id)}
                    className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" title="Remove" disabled={del.isPending}
                    onClick={() => { if (window.confirm('Remove this allocation?')) del.mutate(a.id); }}
                    className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : null}
            </div>
          )
        ))}
        {!listQ.isLoading && !allocations.length && !adding ? (
          <p className="py-1 text-[12px] text-muted-foreground">No planned allocations.</p>
        ) : null}
      </div>
    </div>
  );
}

// ── the add/edit form, with a live capacity preview ──────────────────────────
type IntensityMode = 'days' | 'hours' | 'percent';

function AllocationForm({ userId, existing, onCancel, onSaved }: {
  userId: number;
  existing?: ResourceAllocation;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { data: scope } = useDashboardScopeOptions();
  const projects = scope?.projects ?? [];

  const [projectId, setProjectId] = useState<number | ''>(existing?.project_id ?? '');
  const [start, setStart] = useState(existing?.start_date ?? '');
  const [end, setEnd] = useState(existing?.end_date ?? '');
  // Default to days/week (how managers think); seed from an existing % if editing.
  const [mode, setMode] = useState<IntensityMode>(existing?.hours_per_week != null ? 'hours' : 'days');
  const [amount, setAmount] = useState<string>(() => {
    if (existing?.hours_per_week != null) return String(Number(existing.hours_per_week));
    if (existing?.percent != null) return String(Math.round((Number(existing.percent) / 100) * 5 * 10) / 10); // % -> days
    return '';
  });

  // Resolve the entered amount to the API body (percent or hours_per_week). days
  // -> hours (×8) -> let the backend store as hours; percent passes straight.
  const body: ResourceAllocationBody | null = useMemo(() => {
    if (projectId === '' || !start || !end || amount === '') return null;
    const n = Number(amount);
    if (Number.isNaN(n) || n < 0) return null;
    const base: ResourceAllocationBody = { user_id: userId, project_id: Number(projectId), start_date: start, end_date: end };
    if (mode === 'percent') return { ...base, percent: n };
    if (mode === 'hours') return { ...base, hours_per_week: n };
    return { ...base, hours_per_week: n * 8 }; // days/week → hours/week (8h day)
  }, [userId, projectId, start, end, mode, amount]);

  // Live preview: what this allocation does to the person's 8-week capacity.
  const previewQ = useQuery({
    queryKey: ['allocation-preview', userId, body, existing?.id],
    queryFn: () => resourceAllocationsApi.preview(body!, existing?.id).then((r) => r.data),
    enabled: !!body,
  });

  const save = useMutation({
    mutationFn: () => existing
      ? resourceAllocationsApi.update(existing.id, body!).then((r) => r.data)
      : resourceAllocationsApi.create(body!).then((r) => r.data),
    onSuccess: onSaved,
  });

  const pv = previewQ.data;
  const modeLabel = mode === 'days' ? 'days / week' : mode === 'hours' ? 'hours / week' : '% of capacity';

  return (
    <div className="mb-2 space-y-2 rounded-md border border-dashed border-primary/30 bg-primary/[0.03] p-2.5">
      <select value={projectId} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : '')}
        className="h-8 w-full rounded-md border border-border bg-background px-2 text-[12.5px] focus:border-primary focus:outline-none">
        <option value="">Select a project…</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>

      <div className="flex items-center gap-2">
        <input type="number" min="0" step="0.5" value={amount} onChange={(e) => setAmount(e.target.value)}
          placeholder="0" className="h-8 w-20 rounded-md border border-border bg-background px-2 text-[12.5px] focus:border-primary focus:outline-none" />
        <select value={mode} onChange={(e) => setMode(e.target.value as IntensityMode)}
          className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-[12.5px] focus:border-primary focus:outline-none">
          <option value="days">days / week</option>
          <option value="hours">hours / week</option>
          <option value="percent">% of capacity</option>
        </select>
      </div>

      <div className="flex items-center gap-2">
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)}
          className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-[12px] focus:border-primary focus:outline-none" />
        <span className="text-[11px] text-muted-foreground">to</span>
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)}
          className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-[12px] focus:border-primary focus:outline-none" />
      </div>

      {/* Live capacity preview — the whole point: shows the resulting % and warns
          before saving if it tips the person over capacity. */}
      {body ? (
        <div className={cn('rounded-md border px-2.5 py-1.5 text-[11.5px]',
          pv?.after_state === 'over' ? 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
            : 'border-border bg-muted/40 text-muted-foreground')}>
          {previewQ.isLoading || !pv ? (
            <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Calculating…</span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              {pv.after_state === 'over' ? <AlertTriangle className="h-3.5 w-3.5" /> : null}
              This would put them at <span className="font-bold tabular-nums">{pv.after_pct}%</span>
              {' '}allocated over the next 8 weeks{pv.after_state === 'over' ? ' — over capacity.' : '.'}
              {pv.before_pct !== pv.after_pct ? <span className="opacity-70"> (now {pv.before_pct}%)</span> : null}
            </span>
          )}
        </div>
      ) : null}

      {save.isError ? (
        <p className="text-[11px] text-rose-600">{anyErr(save.error) ?? 'Could not save the allocation.'}</p>
      ) : null}

      <div className="flex gap-2">
        <button type="button" disabled={!body || save.isPending} onClick={() => save.mutate()}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[12px] font-semibold text-primary-foreground disabled:opacity-50">
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save
        </button>
        <button type="button" onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-foreground/[0.04]">
          <X className="h-3.5 w-3.5" /> Cancel
        </button>
        <span className="ml-auto self-center text-[10.5px] text-muted-foreground">{modeLabel}</span>
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────
function pctLabel(a: ResourceAllocation): string {
  if (a.percent != null) return `${Math.round(Number(a.percent))}%`;
  if (a.hours_per_week != null) return `${Number(a.hours_per_week)}h/wk`;
  return '—';
}
function fmtRange(s: string, e: string): string {
  const f = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${f(s)} – ${f(e)}`;
}
function anyErr(e: unknown): string | undefined {
  const d = (e as any)?.response?.data?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d[0]?.msg;
  return undefined;
}
