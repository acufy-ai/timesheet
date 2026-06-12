import { useMemo, useState } from 'react';
import { ChevronRight, Download, Loader2, Pencil, Plus, Search, Trash2 } from 'lucide-react';

import { Button, Card, Empty, Input, TonePill, WorkspaceHeader } from '@/components/ui';
import { usersApi } from '@/api/client';
import {
  useAllProjects,
  useAllTasks,
  useClients,
  useDeleteClient,
  useDeleteProject,
  useDeleteTask,
} from '@/hooks/useAdmin';
import { ClientFormModal } from '@/components/clients/ClientFormModal';
import { ProjectFormModal } from '@/components/clients/ProjectFormModal';
import { TaskFormModal } from '@/components/clients/TaskFormModal';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import type { Client, FullProject, FullTask } from '@/types/admin';

const num = (v: string | number | null | undefined) =>
  v == null || v === '' ? 0 : typeof v === 'string' ? parseFloat(v) : v;

// Three-level master-detail: clients → projects (under a client) → tasks
// (under a project). Each level supports create / edit / delete. Breadcrumb
// drives navigation. Admin-only surface (nav already gates it).
export function ClientsPage() {
  const clientsQ = useClients();
  const projectsQ = useAllProjects();
  const tasksQ = useAllTasks();

  const delClient = useDeleteClient();
  const delProject = useDeleteProject();
  const delTask = useDeleteTask();

  const [activeClientId, setActiveClientId] = useState<number | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'internal' | 'external'>('all');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  // Modal state
  const [clientModal, setClientModal] = useState<{ open: boolean; client: Client | null }>({ open: false, client: null });
  const [exporting, setExporting] = useState(false);

  async function exportClients() {
    setExporting(true);
    try {
      const res = await usersApi.exportClients();
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'clients.csv'; a.click();
      URL.revokeObjectURL(url);
    } finally { setExporting(false); }
  }
  const [projectModal, setProjectModal] = useState<{ open: boolean; project: FullProject | null }>({ open: false, project: null });
  const [taskModal, setTaskModal] = useState<{ open: boolean; task: FullTask | null }>({ open: false, task: null });

  const flashAndFade = (tone: 'ok' | 'err', text: string) => {
    setFlash({ tone, text });
    window.setTimeout(() => setFlash(null), 4000);
  };

  const clients = clientsQ.data ?? [];
  const projects = (projectsQ.data ?? []) as unknown as FullProject[];
  const tasks = (tasksQ.data ?? []) as unknown as FullTask[];

  const projectsByClient = useMemo(() => {
    const m = new Map<number, FullProject[]>();
    projects.forEach((p) => { const l = m.get(p.client_id) ?? []; l.push(p); m.set(p.client_id, l); });
    return m;
  }, [projects]);
  const tasksByProject = useMemo(() => {
    const m = new Map<number, FullTask[]>();
    tasks.forEach((t) => { const l = m.get(t.project_id) ?? []; l.push(t); m.set(t.project_id, l); });
    return m;
  }, [tasks]);

  const activeClient = clients.find((c) => c.id === activeClientId) ?? null;
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  // ── Delete handlers ──────────────────────────────────────────────
  async function removeClient(c: Client) {
    if (!window.confirm(`Delete client "${c.name}"? Projects and tasks under it may be affected.`)) return;
    try { await delClient.mutateAsync(c.id); flashAndFade('ok', 'Client deleted.'); if (activeClientId === c.id) setActiveClientId(null); }
    catch (e) { flashAndFade('err', errText(e, 'Could not delete the client.')); }
  }
  async function removeProject(p: FullProject) {
    if (!window.confirm(`Delete project "${p.name}"?`)) return;
    try { await delProject.mutateAsync(p.id); flashAndFade('ok', 'Project deleted.'); if (activeProjectId === p.id) setActiveProjectId(null); }
    catch (e) { flashAndFade('err', errText(e, 'Could not delete the project.')); }
  }
  async function removeTask(t: FullTask) {
    if (!window.confirm(`Delete task "${t.name}"?`)) return;
    try { await delTask.mutateAsync(t.id); flashAndFade('ok', 'Task deleted.'); }
    catch (e) { flashAndFade('err', errText(e, 'Could not delete the task.')); }
  }

  // ── Header / breadcrumb ──────────────────────────────────────────
  const totalProjects = projects.length;

  const flashBar = flash ? (
    <div role="alert" className={'rounded-xl border px-3 py-2 text-sm ' + (flash.tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300')}>
      {flash.text}
    </div>
  ) : null;

  // ── TASKS view (drilled into a project) ──────────────────────────
  if (activeProject && activeClient) {
    const projTasks = tasksByProject.get(activeProject.id) ?? [];
    return (
      <div className="space-y-5">
        <Breadcrumb
          trail={[
            { label: 'Clients', onClick: () => { setActiveClientId(null); setActiveProjectId(null); } },
            { label: activeClient.name, onClick: () => setActiveProjectId(null) },
            { label: activeProject.name },
          ]}
        />
        <WorkspaceHeader
          title={activeProject.name}
          description={`${projTasks.length} ${projTasks.length === 1 ? 'task' : 'tasks'} · ${activeProject.is_active ? 'Active' : 'Inactive'} · $${num(activeProject.billable_rate).toFixed(2)}/h`}
          primary={<Button onClick={() => setTaskModal({ open: true, task: null })}><Plus className="h-4 w-4" /> Add task</Button>}
        />
        {flashBar}
        {tasksQ.isLoading ? (
          <Loader />
        ) : projTasks.length === 0 ? (
          <Empty Icon={Plus} title="No tasks yet" description="Break this project into tasks people can log time against." action={<Button size="sm" onClick={() => setTaskModal({ open: true, task: null })}>Add task</Button>} />
        ) : (
          <Card className="divide-y divide-border overflow-hidden">
            {projTasks.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">{t.name}</p>
                    {t.code ? <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t.code}</span> : null}
                    {!t.is_active ? <TonePill tone="neutral">Inactive</TonePill> : null}
                  </div>
                  {t.description ? <p className="truncate text-xs text-muted-foreground">{t.description}</p> : null}
                </div>
                <RowActions onEdit={() => setTaskModal({ open: true, task: t })} onDelete={() => removeTask(t)} />
              </div>
            ))}
          </Card>
        )}
        <TaskFormModal open={taskModal.open} projectId={activeProject.id} task={taskModal.task} onClose={() => setTaskModal({ open: false, task: null })} onSaved={(m) => flashAndFade('ok', m)} />
      </div>
    );
  }

  // ── PROJECTS view (drilled into a client) ────────────────────────
  if (activeClient) {
    const clientProjects = projectsByClient.get(activeClient.id) ?? [];
    return (
      <div className="space-y-5">
        <Breadcrumb
          trail={[
            { label: 'Clients', onClick: () => setActiveClientId(null) },
            { label: activeClient.name },
          ]}
        />
        <WorkspaceHeader
          title={activeClient.name}
          description={`${clientProjects.length} ${clientProjects.length === 1 ? 'project' : 'projects'} · ${activeClient.client_type === 'internal' ? 'Internal' : 'External'}${activeClient.contact_name ? ` · ${activeClient.contact_name}` : ''}`}
          primary={
            <>
              <Button onClick={() => setProjectModal({ open: true, project: null })}><Plus className="h-4 w-4" /> Add project</Button>
              <Button variant="secondary" onClick={() => setClientModal({ open: true, client: activeClient })}>Edit client</Button>
            </>
          }
        />
        {flashBar}
        {projectsQ.isLoading ? (
          <Loader />
        ) : clientProjects.length === 0 ? (
          <Empty Icon={Plus} title="No projects yet" description="Add a project so the team can log time against this client." action={<Button size="sm" onClick={() => setProjectModal({ open: true, project: null })}>Add project</Button>} />
        ) : (
          <Card className="divide-y divide-border overflow-hidden">
            {clientProjects.map((p) => {
              const taskCount = (tasksByProject.get(p.id) ?? []).length;
              return (
                <div key={p.id} className="flex items-center gap-3 px-4 py-3 hover:bg-primary/5">
                  <button type="button" onClick={() => setActiveProjectId(p.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                        {p.code ? <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{p.code}</span> : null}
                        {!p.is_active ? <TonePill tone="neutral">Inactive</TonePill> : null}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        ${num(p.billable_rate).toFixed(2)}/h
                        {p.budget_amount ? ` · budget ${num(p.budget_amount).toFixed(0)} ${p.currency ?? ''}` : ''}
                        {` · ${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                  <RowActions onEdit={() => setProjectModal({ open: true, project: p })} onDelete={() => removeProject(p)} />
                </div>
              );
            })}
          </Card>
        )}
        <ProjectFormModal open={projectModal.open} clientId={activeClient.id} project={projectModal.project} onClose={() => setProjectModal({ open: false, project: null })} onSaved={(m) => flashAndFade('ok', m)} />
        <ClientFormModal open={clientModal.open} client={clientModal.client} onClose={() => setClientModal({ open: false, client: null })} onSaved={(m) => flashAndFade('ok', m)} />
      </div>
    );
  }

  // ── CLIENTS grid (top level) ─────────────────────────────────────
  const filtered = clients.filter((c) => {
    const q = search.trim().toLowerCase();
    const matchesSearch = !q || c.name.toLowerCase().includes(q) || (c.quickbooks_customer_id ?? '').toLowerCase().includes(q);
    const matchesType = typeFilter === 'all' || c.client_type === typeFilter;
    return matchesSearch && matchesType;
  });

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        title="Client Management"
        description={`${clients.length} clients · ${totalProjects} projects`}
        primary={
          <>
            <Button onClick={() => setClientModal({ open: true, client: null })}><Plus className="h-4 w-4" /> Add client</Button>
            <Button variant="secondary" onClick={() => void exportClients()} disabled={exporting}>
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Export
            </Button>
          </>
        }
      />
      {flashBar}

      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search clients by name or QuickBooks ID..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex items-center gap-1.5">
          {(['all', 'internal', 'external'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTypeFilter(t)} className={cn('pill text-xs capitalize', typeFilter === t ? 'pill-active' : 'pill-idle bg-muted')}>
              {t === 'all' ? 'All types' : t}
            </button>
          ))}
        </div>
      </Card>

      {clientsQ.isLoading ? (
        <Loader />
      ) : clientsQ.isError ? (
        <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">Couldn't load clients. Try refreshing.</Card>
      ) : filtered.length === 0 ? (
        <Empty Icon={Search} title="No clients match" description="Try a different search or filter, or add a client." action={<Button size="sm" onClick={() => setClientModal({ open: true, client: null })}>Add client</Button>} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((c) => {
            const internal = c.client_type === 'internal';
            const projCount = (projectsByClient.get(c.id) ?? []).length;
            return (
              <Card key={c.id} className="group relative p-4 transition-shadow hover:border-primary/30 hover:shadow-sm">
                <button type="button" onClick={() => setActiveClientId(c.id)} className="block w-full text-left">
                  <div className="flex items-center justify-between">
                    <span className={cn('grid h-9 w-9 place-items-center rounded-xl text-sm font-semibold', avatarTone(c.name))}>{initials(c.name)}</span>
                    <TonePill tone={internal ? 'success' : 'neutral'}>{internal ? 'Internal' : 'External'}</TonePill>
                  </div>
                  <p className="mt-3 truncate text-sm font-semibold text-foreground" title={c.name}>{c.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {projCount} {projCount === 1 ? 'project' : 'projects'} · QBID: {c.quickbooks_customer_id ?? 'N/A'}
                  </p>
                </button>
                {/* Hover actions */}
                <div className="absolute right-3 top-12 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button type="button" aria-label="Edit client" onClick={() => setClientModal({ open: true, client: c })} className="grid h-7 w-7 place-items-center rounded-full bg-card/90 text-muted-foreground shadow hover:text-foreground">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" aria-label="Delete client" onClick={() => removeClient(c)} className="grid h-7 w-7 place-items-center rounded-full bg-card/90 text-muted-foreground shadow hover:text-rose-500">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <ClientFormModal open={clientModal.open} client={clientModal.client} onClose={() => setClientModal({ open: false, client: null })} onSaved={(m) => flashAndFade('ok', m)} />
    </div>
  );
}

function errText(err: unknown, fallback: string): string {
  const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof d === 'string' ? d : fallback;
}

function Loader() {
  return (
    <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
    </div>
  );
}

function RowActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button type="button" aria-label="Edit" onClick={onEdit} className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
        <Pencil className="h-4 w-4" />
      </button>
      <button type="button" aria-label="Delete" onClick={onDelete} className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500">
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function Breadcrumb({ trail }: { trail: Array<{ label: string; onClick?: () => void }> }) {
  return (
    <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
      {trail.map((seg, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {seg.onClick ? (
            <button type="button" onClick={seg.onClick} className="hover:text-primary">{seg.label}</button>
          ) : (
            <span className="font-medium text-foreground">{seg.label}</span>
          )}
          {i < trail.length - 1 ? <ChevronRight className="h-3.5 w-3.5" /> : null}
        </span>
      ))}
    </nav>
  );
}
