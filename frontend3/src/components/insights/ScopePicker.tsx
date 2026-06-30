import { X } from 'lucide-react';

import { useDashboardScopeOptions } from '@/hooks/useCustomDashboards';
import { cn } from '@/lib/cn';
import type { ResourceMode, WidgetScope, WidgetType } from '@/types/customDashboard';

// The scope axes each widget type may use:
//   kpi          → client, project, task, resource (all four)
//   chart/table  → client, project, resource
//   health/evm   → client, project only
//   revrec/utilization/ontime → client, project, resource
// Clients and projects are MULTI-SELECT and unioned, so one widget can
// consolidate several clients/projects into a single metric. A task only makes
// sense for exactly one project, so it's offered only then.
type Axis = 'client' | 'project' | 'task' | 'resource';
const AXES_BY_TYPE: Record<WidgetType, Axis[]> = {
  kpi: ['client', 'project', 'task', 'resource'],
  chart: ['client', 'project', 'resource'],
  table: ['client', 'project', 'resource'],
  health: ['client', 'project'],
  evm: ['client', 'project'],
  revrec: ['client', 'project', 'resource'],
  utilization: ['client', 'project', 'resource'],
  ontime: ['client', 'project', 'resource'],
};

const selectClass =
  'h-9 w-full rounded-full border border-border bg-transparent px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

// Normalize the (possibly legacy single-id) scope into arrays we work with.
const clientsOf = (s: WidgetScope) => [...(s.clientIds ?? []), ...(s.clientId ? [s.clientId] : [])];
const projectsOf = (s: WidgetScope) => [...(s.projectIds ?? []), ...(s.projectId ? [s.projectId] : [])];

export function ScopePicker({ type, scope, onChange }: {
  type: WidgetType;
  scope: WidgetScope;
  onChange: (next: WidgetScope) => void;
}) {
  const { data, isLoading } = useDashboardScopeOptions();
  const axes = AXES_BY_TYPE[type] ?? [];
  if (!axes.length) return null;

  const clientIds = clientsOf(scope);
  const projectIds = projectsOf(scope);

  // Projects available to add: limited to the selected clients (or all if none),
  // minus already-selected projects.
  const availableProjects = (data?.projects ?? []).filter(
    (p) => (clientIds.length === 0 || (p.client_id != null && clientIds.includes(p.client_id)))
      && !projectIds.includes(p.id),
  );
  const tasks = (data?.tasks ?? []).filter((t) => projectIds.length === 1 && t.project_id === projectIds[0]);

  // Normalize away the legacy singulars on any edit.
  const set = (patch: Partial<WidgetScope>) =>
    onChange({ ...scope, clientId: undefined, projectId: undefined, ...patch });

  const nameOfClient = (id: number) => data?.clients.find((c) => c.id === id)?.name ?? `Client ${id}`;
  const nameOfProject = (id: number) => data?.projects.find((p) => p.id === id)?.name ?? `Project ${id}`;

  return (
    <div className="space-y-2 rounded-2xl border border-border p-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Scope</p>
        <button type="button" onClick={() => onChange({})} className="text-[11px] text-muted-foreground hover:text-foreground">
          Whole portfolio
        </button>
      </div>
      {isLoading ? <p className="text-[12px] text-muted-foreground">Loading options…</p> : null}

      {axes.includes('client') ? (
        <Field label="Clients">
          <Chips items={clientIds} label={nameOfClient}
            onRemove={(id) => set({ clientIds: clientIds.filter((c) => c !== id) })} />
          <select className={selectClass} value=""
            onChange={(e) => { if (e.target.value) set({ clientIds: [...new Set([...clientIds, Number(e.target.value)])] }); }}>
            <option value="">{clientIds.length ? 'Add another client…' : 'All clients'}</option>
            {(data?.clients ?? []).filter((c) => !clientIds.includes(c.id)).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
      ) : null}

      {axes.includes('project') ? (
        <Field label="Projects">
          <Chips items={projectIds} label={nameOfProject}
            onRemove={(id) => set({ projectIds: projectIds.filter((p) => p !== id), taskId: undefined })} />
          <select className={selectClass} value=""
            onChange={(e) => { if (e.target.value) set({ projectIds: [...new Set([...projectIds, Number(e.target.value)])], taskId: undefined }); }}>
            <option value="">{projectIds.length ? 'Add another project…' : 'All projects'}</option>
            {availableProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      ) : null}

      {axes.includes('task') ? (
        <Field label="Task">
          <select className={selectClass} value={scope.taskId ?? ''} disabled={projectIds.length !== 1}
            onChange={(e) => set({ taskId: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">{projectIds.length !== 1 ? 'Pick exactly one project first' : 'All tasks'}</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </Field>
      ) : null}

      {axes.includes('resource') ? (
        <Field label="Resource">
          <select className={selectClass} value={scope.userId ?? ''}
            onChange={(e) => set({ userId: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">Everyone</option>
            {(data?.people ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          {scope.userId != null ? (
            <div className="mt-1.5 flex gap-1.5">
              {(['contribution', 'projects'] as ResourceMode[]).map((m) => (
                <button key={m} type="button" onClick={() => set({ resourceMode: m })}
                  className={cn('flex-1 rounded-lg border px-2 py-1 text-[11px]', (scope.resourceMode ?? 'contribution') === m
                    ? 'border-primary bg-primary/5 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
                  {m === 'contribution' ? 'Their contribution' : 'Projects they’re on'}
                </button>
              ))}
            </div>
          ) : null}
        </Field>
      ) : null}
    </div>
  );
}

function Chips({ items, label, onRemove }: { items: number[]; label: (id: number) => string; onRemove: (id: number) => void }) {
  if (!items.length) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1">
      {items.map((id) => (
        <span key={id} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-foreground">
          {label(id)}
          <button type="button" onClick={() => onRemove(id)} className="text-muted-foreground hover:text-rose-600" aria-label={`Remove ${label(id)}`}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-0.5 block text-[12px] font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
