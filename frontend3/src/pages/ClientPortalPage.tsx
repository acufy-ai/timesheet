import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Briefcase, CalendarClock, Check, ChevronRight, Folder, Loader2, Lock, MessageSquare, Pencil, Plus, Send, Trash2, UserRound } from 'lucide-react';

import { Button, Card, Empty, Toast, TonePill } from '@/components/ui';
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

// The CLIENT user's portal. Lists only granted projects/tasks; every action is
// gated by the grant's capabilities (read = view; update = edit status +
// description; create = add tasks; delete = remove tasks). Mirrors the approved
// prototype (client-portal-redesign.html).
export function ClientPortalPage() {
  // The project list lives in the sidebar now; this landing keeps the identity
  // hero and points the user at the sidebar to open a project.
  return (
    <div className="space-y-5">
      <PortalHero />
      <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center">
        <Briefcase className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
        <p className="text-[14px] font-semibold text-foreground">Select a project to get started</p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Your projects are listed in the sidebar. Pick one to view its tasks and your access.
        </p>
      </div>
    </div>
  );
}

// Soft, theme-blended hero (matches the User Management hero) with orienting
// context: which client org, the user's role, their client manager (for
// employees), and the account team (our internal PMs).
export function PortalHero() {
  const { user } = useAuth();
  const ctxQ = useQuery({
    queryKey: ['client-portal', 'context'],
    queryFn: () => clientPortalApi.portalContext().then((r) => r.data),
  });
  const ctx = ctxQ.data;
  const orgLine = ctx?.client_names?.length ? ctx.client_names.join(', ') : 'Client portal';
  const roleLabel = ctx?.role_label ?? 'Client';

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-primary/[0.05]">
      <div className="flex items-start gap-4 px-6 py-5">
        <span className={cn('grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-lg font-semibold ring-2 ring-primary/15', avatarTone(user?.full_name ?? '?'))}>
          {initials(user?.full_name ?? '?')}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[22px] font-bold tracking-tight text-foreground">{user?.full_name ?? 'Client'}</h1>
          <div className="mt-1 text-[13px] text-muted-foreground">{orgLine} · {roleLabel}</div>
          {/* Orienting context lines: manager (for employees) + account team. */}
          <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px] text-muted-foreground">
            {ctx?.manager ? (
              <span className="inline-flex items-center gap-1.5">
                <UserRound className="h-3.5 w-3.5 text-primary" />
                Your manager: <span className="font-medium text-foreground">{ctx.manager.name}</span>
              </span>
            ) : null}
            {ctx?.account_team?.length ? (
              <span className="inline-flex items-center gap-1.5">
                <Briefcase className="h-3.5 w-3.5 text-primary" />
                Account team: <span className="font-medium text-foreground">{ctx.account_team.map((p) => p.name).join(', ')}</span>
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// The scoped project/task list for a client-side user (their own granted work).
// Reused by ClientPortalPage (with the hero above) and the CLIENT_MANAGER portal's
// "My work" tab (no hero, since that portal has its own). Capability-gated:
// create/delete buttons appear only when the grant carries those caps.
export function ClientWorkView({ heading = true }: { heading?: boolean }) {
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
  const portalOff = (() => {
    const err = projectsQ.error as { response?: { status?: number; data?: { detail?: string } } } | null;
    const detail = err?.response?.data?.detail ?? '';
    return err?.response?.status === 403 && /disabled for this workspace/i.test(detail);
  })();

  return (
    <div className="space-y-5">
      {flash ? (
        <Toast tone={flash.tone} message={flash.text} onDismiss={() => setFlash(null)} />
      ) : null}

      {heading ? (
        <div>
          <h2 className="font-display text-lg font-bold">Your projects</h2>
          <p className="text-[13px] text-muted-foreground">Only the projects and tasks you've been given access to appear here.</p>
        </div>
      ) : null}

      {projectsQ.isLoading ? (
        <div className="grid place-items-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : portalOff ? (
        <Empty Icon={Lock} title="Client portal is turned off"
          description="Your workspace has paused the client portal. Please check back later or contact your project team." />
      ) : projects.length === 0 ? (
        <Empty Icon={Briefcase} title="Nothing shared yet" description="When your team gives you access to a project or task, it'll show up here." />
      ) : (
        <div className="space-y-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p}
              open={expanded[p.id] ?? false}
              onToggle={() => setExpanded((s) => ({ ...s, [p.id]: !(s[p.id] ?? false) }))}
              onFlash={flashAndFade} onChanged={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ProjectCard({
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
  // Plain-English access label for the project row (replaces cryptic "R" / "RU"
  // initials a client can't decode). Task-only grants (no project-level caps)
  // read as "Task access"; otherwise it's "Can edit" when any change capability
  // is present, else "View only".
  const canEditProject = pcaps.some((c) => c === 'update' || c === 'create' || c === 'delete');
  const accessLabel = !pcaps.length ? 'Task access' : canEditProject ? 'Can edit' : 'View only';
  const accessTone: 'brand' | 'neutral' = !pcaps.length ? 'neutral' : canEditProject ? 'brand' : 'neutral';

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
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold">{project.name}</span>
            {project.code ? <span className="rounded-full bg-muted px-2 text-[10px] font-semibold text-muted-foreground">{project.code}</span> : null}
            {project.status ? <TonePill tone={STATUS_TONE[project.status] ?? 'neutral'}>{fmt(project.status)}</TonePill> : null}
            {/* Client-facing health — rendered only when the team set it. */}
            {project.client_health ? <ClientHealthPill health={project.client_health} note={project.client_health_note} /> : null}
          </span>
          {project.client_name ? <span className="block text-[12px] text-muted-foreground">{project.client_name}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {project.progress?.total ? (
            <span className="hidden text-[11px] tabular-nums text-muted-foreground sm:inline">{project.progress.done}/{project.progress.total} done</span>
          ) : null}
          <TonePill tone={accessTone}>{accessLabel}</TonePill>
        </span>
      </button>

      {open ? (
        <div className="border-t border-border bg-background px-5 py-3">
          {/* Project-stand header: progress + target + contact, so the client
              sees "where does my project stand" at a glance. */}
          <ProjectStandHeader project={project} />
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
          ) : (() => {
            // "Needs your attention" = tasks the client can edit and that aren't
            // done, sorted overdue→soonest (no due date sorts last). The rest go
            // under "All tasks".
            const attention = project.tasks
              .filter((t) => (t.capabilities ?? []).includes('update') && t.status !== 'done')
              .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'));
            const attentionIds = new Set(attention.map((t) => t.id));
            const rest = project.tasks.filter((t) => !attentionIds.has(t.id));
            // The client has edit access somewhere on this project — so an empty
            // attention list is a positive "all caught up", not just absence.
            const clientEditsHere = project.tasks.some((t) => (t.capabilities ?? []).includes('update'));
            return (
              <div className="space-y-4">
                {attention.length ? (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-2.5">
                    <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="h-3.5 w-3.5" /> Needs your attention
                      <span className="ml-auto rounded-full bg-amber-500/15 px-1.5 text-[10px] font-bold tabular-nums">{attention.length}</span>
                    </div>
                    <div className="space-y-2">
                      {attention.map((t) => (
                        <TaskRow key={t.id} task={t} onFlash={onFlash} onChanged={onChanged} />
                      ))}
                    </div>
                  </div>
                ) : clientEditsHere ? (
                  <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.05] px-3 py-2 text-[12.5px] text-emerald-700 dark:text-emerald-400">
                    <Check className="h-4 w-4 shrink-0" /> You're all caught up — nothing needs your attention right now.
                  </div>
                ) : null}
                {rest.length ? (
                  <div>
                    {attention.length ? (
                      <p className="mb-2 px-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">All tasks</p>
                    ) : null}
                    <div className="space-y-2">
                      {rest.map((t) => (
                        <TaskRow key={t.id} task={t} onFlash={onFlash} onChanged={onChanged} />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })()}
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
  const [notesOpen, setNotesOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');

  const notesQuery = useQuery({
    queryKey: ['portal-task-notes', task.id],
    queryFn: () => clientPortalApi.listTaskNotes(task.id).then((r) => r.data),
    enabled: notesOpen,
  });
  const addNote = useMutation({
    mutationFn: () => clientPortalApi.addTaskNote(task.id, noteDraft.trim()).then((r) => r.data),
    onSuccess: () => { setNoteDraft(''); notesQuery.refetch(); onFlash('ok', 'Note added.'); },
    onError: () => onFlash('err', 'Could not add the note.'),
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => clientPortalApi.updateTask(task.id, { status }).then((r) => r.data),
    onSuccess: () => { onChanged(); },
    onError: (e: any) => onFlash('err', e?.response?.data?.detail ?? 'Could not update the status.'),
  });
  // Statuses the client may move this task to (server-provided). Includes the
  // current status so the select always shows where it is. Empty ⇒ read-only.
  const transitions = task.allowed_transitions ?? [];
  const statusOptions = task.status ? [task.status, ...transitions.filter((s) => s !== task.status)] : transitions;
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

  const checkboxBusy = setStatus.isPending;
  // A client can only EDIT status when the server gave at least one transition.
  const canEditStatus = canUpdate && transitions.length > 0;

  return (
    <div className="rounded-lg border border-border bg-card px-3.5 py-2.5">
      {/* Controls wrap below the title on narrow screens (items-start + the
          controls block goes full-width < sm), so they never crush the name. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
        <span className="flex min-w-0 items-start gap-3">
        {/* Completion checkbox: check ⇒ done, uncheck ⇒ to_do. Enabled only when
            the client can edit the task; the API re-validates the transition. */}
        <button type="button" onClick={() => { if (canUpdate) setStatus.mutate(done ? 'to_do' : 'done'); }}
          disabled={!canUpdate || checkboxBusy}
          title={canUpdate ? (done ? 'Mark as not done' : 'Mark as done') : (done ? 'Completed' : 'Not yet complete')}
          aria-pressed={done}
          className={cn('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border-[1.5px] transition-colors',
            done ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border text-transparent',
            canUpdate ? 'cursor-pointer hover:border-emerald-500/60' : 'cursor-default opacity-70')}>
          <Check className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className={cn('text-[13.5px] font-semibold', done && 'text-muted-foreground line-through')}>{task.name}</span>
            {task.due_date ? <DueBadge due={task.due_date} done={done} /> : null}
            {/* This client task is holding up internal work — a nudge to finish. */}
            {task.blocking_team && !done ? (
              <span title="The team is waiting on this task to continue their work"
                className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-rose-600 dark:text-rose-400">
                <AlertTriangle className="h-2.5 w-2.5" /> Blocking team
              </span>
            ) : null}
          </span>
          {task.description ? <span className="block text-[12px] text-foreground/80 whitespace-pre-wrap">{task.description}</span> : null}
          {task.status === 'blocked' && task.blocked_reason ? (
            <span className="mt-0.5 block text-[11.5px] text-rose-600 dark:text-rose-400">Blocked: {task.blocked_reason}</span>
          ) : null}
          {/* This task can't proceed until another of the client's tasks finishes. */}
          {task.blocked_by_client_task ? (
            <span className="mt-0.5 block text-[11.5px] text-amber-700 dark:text-amber-400">
              Waiting on your task: <span className="font-semibold">{task.blocked_by_client_task.name}</span>
            </span>
          ) : null}
          <span className="block text-[11px] text-muted-foreground">Your access: {accessLabel || 'Read'}</span>
        </span>
        </span>
        <div className="flex flex-wrap items-center gap-2 pl-8 sm:shrink-0 sm:pl-0">
          {/* StatusSelect: only the allowed transitions render; the API
              re-validates. Read-only tasks (no transitions) show a pill. */}
          {canEditStatus ? (
            <select value={task.status ?? 'to_do'} disabled={checkboxBusy}
              onChange={(e) => setStatus.mutate(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs font-medium focus:border-primary focus:outline-none disabled:opacity-60">
              {statusOptions.map((s) => <option key={s} value={s}>{fmt(s)}</option>)}
            </select>
          ) : task.status ? (
            <TonePill tone={STATUS_TONE[task.status] ?? 'neutral'}>{fmt(task.status)}</TonePill>
          ) : null}
          <button type="button" title="Notes" onClick={() => setNotesOpen((v) => !v)}
            className={cn('grid h-8 w-8 place-items-center rounded-md border border-border transition hover:border-primary/30 hover:bg-primary/[0.08] hover:text-primary',
              notesOpen ? 'border-primary/30 bg-primary/[0.08] text-primary' : 'text-muted-foreground')}>
            <MessageSquare className="h-3.5 w-3.5" />
          </button>
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

      {/* Notes thread — shared with the account team. View for anyone with task
          access; add a note when you can edit the task (read-only viewers can
          read but not post). */}
      {notesOpen ? (
        <div className="mt-2.5 space-y-2 border-t border-border pt-2.5">
          <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Notes</span>
          {notesQuery.isLoading ? (
            <div className="flex items-center gap-2 py-1 text-[12px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading notes…</div>
          ) : (notesQuery.data?.length ?? 0) === 0 ? (
            <p className="py-1 text-[12px] text-muted-foreground">No notes yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {notesQuery.data!.map((n) => (
                <li key={n.id} className="rounded-md border border-border/70 bg-background px-2.5 py-1.5">
                  <p className="text-[12.5px] text-foreground/90 whitespace-pre-wrap">{n.body}</p>
                  <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                    {n.author || 'Someone'}{n.created_at ? ` · ${new Date(n.created_at).toLocaleDateString()}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {canUpdate ? (
            <div className="flex items-start gap-2 pt-0.5">
              <textarea value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} rows={2}
                placeholder="Add a note…"
                className="flex-1 rounded-md border border-border bg-background px-2.5 py-2 text-[13px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" />
              <Button size="sm" disabled={!noteDraft.trim() || addNote.isPending} onClick={() => addNote.mutate()}>
                {addNote.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Add
              </Button>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">You have view-only access, so you can read notes but not add them.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── Client-facing project health pill ────────────────────────────────────────
const CLIENT_HEALTH_META: Record<string, { label: string; cls: string }> = {
  on_track: { label: 'On track', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  at_risk: { label: 'At risk', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  off_track: { label: 'Off track', cls: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300' },
};

// Due-date badge: overdue (red) / due soon ≤3d (amber) / future (muted). A done
// task shows no urgency styling.
function DueBadge({ due, done }: { due: string; done?: boolean }) {
  const d = new Date(due + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86400000);
  const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  let cls = 'bg-muted text-muted-foreground';
  let text = `Due ${label}`;
  if (!done) {
    if (days < 0) { cls = 'bg-rose-500/15 text-rose-600 dark:text-rose-400'; text = `Overdue · ${label}`; }
    else if (days <= 3) { cls = 'bg-amber-500/15 text-amber-600 dark:text-amber-400'; text = days === 0 ? 'Due today' : `Due ${label}`; }
  }
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold', cls)}>{text}</span>;
}

function ClientHealthPill({ health, note }: { health: string; note?: string | null }) {
  const m = CLIENT_HEALTH_META[health];
  if (!m) return null;
  return (
    <span title={note ?? undefined}
      className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold', m.cls)}>
      {health === 'off_track' ? <AlertTriangle className="h-3 w-3" /> : null}
      {m.label}
    </span>
  );
}

// Progress bar + meta (target date, contact, attention) shown atop an open
// project, answering "where does my project stand?".
function ProjectStandHeader({ project }: { project: PortalProject }) {
  const pct = project.progress?.pct ?? 0;
  const fmtDate = (d?: string | null) =>
    d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null;
  const target = fmtDate(project.target_date);
  return (
    <div className="mb-3 rounded-lg border border-border/70 bg-card p-3">
      {/* Progress */}
      <div className="mb-2">
        <div className="mb-1 flex items-center justify-between text-[11px]">
          <span className="font-bold uppercase tracking-wide text-muted-foreground">Progress</span>
          <span className="tabular-nums text-muted-foreground">{project.progress?.done ?? 0}/{project.progress?.total ?? 0} tasks · {pct}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all motion-reduce:transition-none" style={{ width: `${pct}%` }} />
        </div>
      </div>
      {/* Meta row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-muted-foreground">
        {target ? (
          <span className="inline-flex items-center gap-1"><CalendarClock className="h-3.5 w-3.5" /> Target {target}</span>
        ) : null}
        {project.contact_name ? (
          <span className="inline-flex items-center gap-1"><UserRound className="h-3.5 w-3.5" /> {project.contact_name}</span>
        ) : null}
        {(project.overdue_count ?? 0) > 0 ? (
          <span className="inline-flex items-center gap-1 font-semibold text-rose-600"><AlertTriangle className="h-3.5 w-3.5" /> {project.overdue_count} overdue</span>
        ) : (project.attention_count ?? 0) > 0 ? (
          <span className="inline-flex items-center gap-1 font-semibold text-amber-600">{project.attention_count} need{project.attention_count === 1 ? 's' : ''} attention</span>
        ) : null}
      </div>
    </div>
  );
}
