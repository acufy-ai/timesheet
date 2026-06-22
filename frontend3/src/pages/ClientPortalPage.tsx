import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Briefcase, Check, ChevronRight, Folder, Loader2, Pencil, Plus, Shield, Trash2 } from 'lucide-react';

import { Button, Card, Empty, TonePill } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { clientPortalApi } from '@/api/client';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import type { ClientCapability, PortalProject, PortalTask } from '@/types/admin';

const CAPS: ClientCapability[] = ['create', 'read', 'update', 'delete'];
const CAP_LABEL: Record<ClientCapability, string> = { create: 'Create', read: 'Read', update: 'Update', delete: 'Delete' };
const STATUS_TONE: Record<string, 'success' | 'brand' | 'info' | 'neutral'> = {
  planning: 'info', in_progress: 'brand', on_hold: 'info', completed: 'success',
  to_do: 'info', done: 'success',
};
const fmt = (s?: string | null) => (s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '');
const TASK_STATUSES = ['to_do', 'in_progress', 'done'];

// The CLIENT user's portal. Lists only granted projects/tasks; every action is
// gated by the grant's capabilities (read = view; update = edit status +
// description; create = add tasks; delete = remove tasks). Mirrors the approved
// prototype (client-portal-redesign.html).
export function ClientPortalPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const projectsQ = useQuery({
    queryKey: ['client-portal', 'projects'],
    queryFn: () => clientPortalApi.myProjects().then((r) => r.data),
  });
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const flashAndFade = (tone: 'ok' | 'err', text: string) => {
    setFlash({ tone, text });
    window.setTimeout(() => setFlash(null), 4000);
  };
  const refresh = () => qc.invalidateQueries({ queryKey: ['client-portal', 'projects'] });

  const projects = projectsQ.data ?? [];
  const allCaps = new Set<ClientCapability>();
  projects.forEach((p) => {
    p.capabilities.forEach((c) => allCaps.add(c));
    p.tasks.forEach((t) => t.capabilities.forEach((c) => allCaps.add(c)));
  });
  const heroCaps = CAPS.filter((c) => allCaps.has(c));
  const clientLabel = (user as { title?: string } | null)?.title;

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-2xl text-white shadow-lg" style={{ background: 'linear-gradient(135deg, hsl(var(--primary)), hsl(var(--primary) / 0.7))' }}>
        <div className="flex items-center gap-4 px-6 py-6">
          <span className={cn('grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-lg font-bold ring-[3px] ring-white/25', avatarTone(user?.full_name ?? '?'))}>
            {initials(user?.full_name ?? '?')}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-[22px] font-bold tracking-tight">{user?.full_name ?? 'Client'}</h1>
            <div className="mt-0.5 text-[13px] text-white/90">{clientLabel ? `${clientLabel} · ` : ''}Client portal</div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {(heroCaps.length ? heroCaps : (['read'] as ClientCapability[])).map((c) => (
                <span key={c} className="rounded-full bg-white/20 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide">{CAP_LABEL[c]}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {flash ? (
        <div role="alert" className={cn('rounded-xl border px-3 py-2 text-sm',
          flash.tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300')}>
          {flash.text}
        </div>
      ) : null}

      <div>
        <h2 className="font-display text-lg font-bold">Your projects</h2>
        <p className="text-[13px] text-muted-foreground">Only the projects and tasks you've been given access to appear here.</p>
      </div>

      {projectsQ.isLoading ? (
        <div className="grid place-items-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : projects.length === 0 ? (
        <Empty Icon={Briefcase} title="Nothing shared yet" description="When your team gives you access to a project or task, it'll show up here." />
      ) : (
        <div className="space-y-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p}
              open={expanded[p.id] ?? true}
              onToggle={() => setExpanded((s) => ({ ...s, [p.id]: !(s[p.id] ?? true) }))}
              onFlash={flashAndFade} onChanged={refresh} />
          ))}
        </div>
      )}

      <div className="flex items-start gap-2.5 rounded-xl bg-primary/[0.06] px-4 py-3 text-[12.5px] text-muted-foreground">
        <Shield className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>The client portal shows <b className="text-foreground">only</b> the projects and tasks shared with you.</span>
      </div>
    </div>
  );
}

function ProjectCard({
  project, open, onToggle, onFlash, onChanged,
}: {
  project: PortalProject;
  open: boolean;
  onToggle: () => void;
  onFlash: (t: 'ok' | 'err', m: string) => void;
  onChanged: () => void;
}) {
  const pcaps = project.capabilities;
  const canCreate = pcaps.includes('create');
  const canUpdateProject = pcaps.includes('update');
  const capSummary = pcaps.length ? CAPS.filter((c) => pcaps.includes(c)).map((c) => CAP_LABEL[c][0]).join('') : 'task access';

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(project.description ?? '');

  const createTask = useMutation({
    mutationFn: () => clientPortalApi.createTask({ project_id: project.id, name: newName.trim(), description: newDesc.trim() || undefined }).then((r) => r.data),
    onSuccess: () => { setAdding(false); setNewName(''); setNewDesc(''); onChanged(); onFlash('ok', 'Task added.'); },
    onError: () => onFlash('err', 'Could not add the task.'),
  });
  const saveProjectDesc = useMutation({
    mutationFn: () => clientPortalApi.updateProject(project.id, { description: descDraft.trim() }).then((r) => r.data),
    onSuccess: () => { setEditingDesc(false); onChanged(); onFlash('ok', 'Project description updated.'); },
    onError: () => onFlash('err', 'Could not update the description.'),
  });

  return (
    <Card className="overflow-hidden p-0">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-primary/[0.03]">
        <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Folder className="h-5 w-5 shrink-0 text-primary" />
        <span className="flex-1">
          <span className="flex items-center gap-2">
            <span className="text-[15px] font-semibold">{project.name}</span>
            {project.code ? <span className="rounded-full bg-muted px-2 text-[10px] font-semibold text-muted-foreground">{project.code}</span> : null}
            {project.status ? <TonePill tone={STATUS_TONE[project.status] ?? 'neutral'}>{fmt(project.status)}</TonePill> : null}
          </span>
          {project.client_name ? <span className="block text-[12px] text-muted-foreground">{project.client_name}</span> : null}
        </span>
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{capSummary}</span>
      </button>

      {open ? (
        <div className="border-t border-border bg-background px-5 py-3">
          {/* Project description (read; editable inline with project UPDATE) */}
          <div className="mb-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Description</span>
              {canUpdateProject && !editingDesc ? (
                <button type="button" onClick={() => { setDescDraft(project.description ?? ''); setEditingDesc(true); }}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline">
                  <Pencil className="h-3 w-3" /> Edit
                </button>
              ) : null}
            </div>
            {editingDesc ? (
              <div className="space-y-2">
                <textarea value={descDraft} onChange={(e) => setDescDraft(e.target.value)} rows={3}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  placeholder="Describe this project…" />
                <div className="flex gap-2">
                  <Button size="sm" disabled={saveProjectDesc.isPending} onClick={() => saveProjectDesc.mutate()}>
                    {saveProjectDesc.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingDesc(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <p className="text-[13px] text-foreground/90 whitespace-pre-wrap">{project.description || <span className="text-muted-foreground">No description.</span>}</p>
            )}
          </div>

          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Tasks</span>
            {canCreate ? (
              <Button size="sm" variant="secondary" onClick={() => setAdding((v) => !v)}>
                <Plus className="h-3.5 w-3.5" /> Add task
              </Button>
            ) : null}
          </div>

          {adding ? (
            <div className="mb-2 space-y-2 rounded-lg border border-dashed border-primary/30 bg-primary/[0.04] p-3">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Task name"
                className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" />
              <textarea value={newDesc} onChange={(e) => setNewDesc(e.target.value)} rows={2} placeholder="Description (optional)"
                className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-[13px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" />
              <div className="flex gap-2">
                <Button size="sm" disabled={!newName.trim() || createTask.isPending} onClick={() => createTask.mutate()}>
                  {createTask.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setNewName(''); setNewDesc(''); }}>Cancel</Button>
              </div>
            </div>
          ) : null}

          {project.tasks.length === 0 ? (
            <div className="py-3 text-center text-[12.5px] text-muted-foreground">No tasks shared on this project.</div>
          ) : (
            <div className="space-y-2">
              {project.tasks.map((t) => (
                <TaskRow key={t.id} task={t} onFlash={onFlash} onChanged={onChanged} />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function TaskRow({
  task, onFlash, onChanged,
}: {
  task: PortalTask;
  onFlash: (t: 'ok' | 'err', m: string) => void;
  onChanged: () => void;
}) {
  const caps = task.capabilities;
  const canUpdate = caps.includes('update');
  const canDelete = caps.includes('delete');
  const accessLabel = CAPS.filter((c) => caps.includes(c)).map((c) => CAP_LABEL[c]).join(' · ');
  const done = task.status === 'done';

  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(task.description ?? '');

  const setStatus = useMutation({
    mutationFn: (status: string) => clientPortalApi.updateTask(task.id, { status }).then((r) => r.data),
    onSuccess: () => { onChanged(); },
    onError: () => onFlash('err', 'Could not update the status.'),
  });
  const saveDesc = useMutation({
    mutationFn: () => clientPortalApi.updateTask(task.id, { description: descDraft.trim() }).then((r) => r.data),
    onSuccess: () => { setEditingDesc(false); onChanged(); onFlash('ok', 'Task updated.'); },
    onError: () => onFlash('err', 'Could not update the task.'),
  });
  const del = useMutation({
    mutationFn: () => clientPortalApi.deleteTask(task.id),
    onSuccess: () => { onChanged(); onFlash('ok', 'Task deleted.'); },
    onError: () => onFlash('err', 'Could not delete the task.'),
  });

  // Checkbox toggles done <-> to_do (only when the client can update).
  const toggleDone = () => { if (canUpdate) setStatus.mutate(done ? 'to_do' : 'done'); };
  const checkboxBusy = setStatus.isPending;

  return (
    <div className="rounded-lg border border-border bg-card px-3.5 py-2.5">
      <div className="flex items-start gap-3">
        {/* Functional checkbox: check = done */}
        <button type="button" onClick={toggleDone} disabled={!canUpdate || checkboxBusy}
          title={canUpdate ? (done ? 'Mark as not done' : 'Mark as done') : 'View only'}
          className={cn('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border-[1.5px] transition-colors',
            done ? 'border-primary bg-primary text-white' : 'border-border text-transparent',
            canUpdate ? 'cursor-pointer hover:border-primary/60' : 'cursor-default opacity-70')}>
          <Check className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-0 flex-1">
          <span className={cn('block text-[13.5px] font-semibold', done && 'text-muted-foreground line-through')}>{task.name}</span>
          {task.description ? <span className="block text-[12px] text-foreground/80 whitespace-pre-wrap">{task.description}</span> : null}
          <span className="block text-[11px] text-muted-foreground">Your access: {accessLabel || 'Read'}</span>
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {/* Inline status control (dropdown when editable, pill otherwise) */}
          {canUpdate ? (
            <select value={task.status ?? 'to_do'} disabled={checkboxBusy}
              onChange={(e) => setStatus.mutate(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs font-medium focus:border-primary focus:outline-none">
              {TASK_STATUSES.map((s) => <option key={s} value={s}>{fmt(s)}</option>)}
            </select>
          ) : task.status ? (
            <TonePill tone={STATUS_TONE[task.status] ?? 'neutral'}>{fmt(task.status)}</TonePill>
          ) : null}
          {canUpdate ? (
            <button type="button" title="Edit description" onClick={() => { setDescDraft(task.description ?? ''); setEditingDesc((v) => !v); }}
              className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground transition hover:border-primary/30 hover:bg-primary/[0.08] hover:text-primary">
              <Pencil className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {canDelete ? (
            <button type="button" title="Delete task"
              onClick={() => { if (window.confirm(`Delete task "${task.name}"?`)) del.mutate(); }}
              className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground transition hover:border-rose-400/40 hover:bg-rose-500/10 hover:text-rose-600">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {!canUpdate && !canDelete ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-semibold text-muted-foreground">View only</span>
          ) : null}
        </div>
      </div>

      {/* Inline description editor (pencil) */}
      {editingDesc ? (
        <div className="mt-2.5 space-y-2 border-t border-border pt-2.5">
          <label className="block text-[11px] font-medium text-muted-foreground">Description</label>
          <textarea value={descDraft} onChange={(e) => setDescDraft(e.target.value)} rows={2}
            className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-[13px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            placeholder="Describe this task…" />
          <div className="flex gap-2">
            <Button size="sm" disabled={saveDesc.isPending} onClick={() => saveDesc.mutate()}>
              {saveDesc.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditingDesc(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
