import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Briefcase, Check, ChevronRight, Folder, Loader2, Pencil, StickyNote, X } from 'lucide-react';

import { Card, Empty, TonePill } from '@/components/ui';
import { NoteModal, type NoteTarget } from '@/components/notes/NoteModal';
import { useMyWork, useUpdateTaskProgress } from '@/hooks/useDashboard';
import type { MyWorkProject, MyWorkTask } from '@/types/dashboard';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';

const STATUS_TONE: Record<string, 'success' | 'brand' | 'info' | 'neutral' | 'warning'> = {
  planning: 'info', in_progress: 'brand', on_hold: 'warning', completed: 'success',
  to_do: 'info', done: 'success',
};
const PRIORITY_TONE: Record<string, 'neutral' | 'warning' | 'danger'> = {
  low: 'neutral', medium: 'warning', high: 'danger',
};
const TASK_STATUSES = ['to_do', 'in_progress', 'blocked', 'done'] as const;
const fmt = (s?: string | null) => (s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '');
const num = (v: string | number) => Math.round(Number(v));

// Due-date badge: overdue (red) / due soon ≤3d (amber) / future (muted). A done
// task shows no urgency. Mirrors the client portal.
function DueBadge({ due, done }: { due: string; done?: boolean }) {
  const d = new Date(due + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86400000);
  const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  let cls = 'bg-muted text-muted-foreground'; let text = `Due ${label}`;
  if (!done) {
    if (days < 0) { cls = 'bg-rose-500/15 text-rose-600 dark:text-rose-400'; text = `Overdue · ${label}`; }
    else if (days <= 3) { cls = 'bg-amber-500/15 text-amber-600 dark:text-amber-400'; text = days === 0 ? 'Due today' : `Due ${label}`; }
  }
  return <span className={cn('inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold', cls)}>{text}</span>;
}

// An assignee's task row in My Work: status is an inline dropdown and the
// description is editable (scoped /tasks/{id}/progress). Read-only fallback if
// the task isn't editable by the caller.
function TaskRow({ task, onFlash, onAddNote }: { task: MyWorkTask; onFlash: (tone: 'ok' | 'err', text: string) => void; onAddNote: () => void }) {
  const update = useUpdateTaskProgress();
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(task.description ?? '');
  const canEdit = task.can_edit !== false;

  const saveStatus = (status: string) => {
    update.mutate(
      { taskId: task.task_id, status },
      { onError: () => onFlash('err', 'Could not update status.') },
    );
  };
  const saveDesc = () => {
    update.mutate(
      { taskId: task.task_id, description: descDraft.trim() },
      {
        onSuccess: () => { setEditingDesc(false); onFlash('ok', 'Task updated.'); },
        onError: () => onFlash('err', 'Could not save the description.'),
      },
    );
  };
  const done = task.status === 'done';
  const toggleDone = () => { if (canEdit) saveStatus(done ? 'to_do' : 'done'); };

  return (
    <div className="rounded-md px-2 py-1.5 hover:bg-primary/[0.04]">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {/* Completion checkbox: check = done, uncheck = to_do. */}
          <button type="button" onClick={toggleDone} disabled={!canEdit || update.isPending}
            title={canEdit ? (done ? 'Mark as not done' : 'Mark as done') : (done ? 'Completed' : 'Not done')}
            className={cn('grid h-4 w-4 shrink-0 place-items-center rounded border-[1.5px] transition-colors',
              done ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border text-transparent',
              canEdit ? 'cursor-pointer hover:border-emerald-500/60' : 'cursor-default opacity-70')}>
            <Check className="h-3 w-3" />
          </button>
          <span className={cn('truncate text-[13px] text-foreground', done && 'text-muted-foreground line-through')}>{task.name}</span>
          {task.due_date ? <DueBadge due={task.due_date} done={done} /> : null}
          {task.blocking_others && !done ? (
            <span title="Other work is waiting on this task"
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-rose-600 dark:text-rose-400">
              <AlertTriangle className="h-2.5 w-2.5" /> Blocking
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {task.priority ? <TonePill tone={PRIORITY_TONE[task.priority] ?? 'neutral'}>{fmt(task.priority)}</TonePill> : null}
          {canEdit ? (
            <select
              value={task.status ?? 'to_do'}
              disabled={update.isPending}
              onChange={(e) => saveStatus(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-[12px] font-medium text-foreground disabled:opacity-60"
            >
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>{fmt(s)}</option>
              ))}
            </select>
          ) : task.status ? (
            <TonePill tone={STATUS_TONE[task.status] ?? 'neutral'}>{fmt(task.status)}</TonePill>
          ) : null}
          {canEdit && !editingDesc ? (
            <button
              type="button"
              onClick={() => { setDescDraft(task.description ?? ''); setEditingDesc(true); }}
              className="rounded-md p-1 text-muted-foreground hover:bg-primary/10 hover:text-foreground"
              title="Edit task description"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={onAddNote}
            className="rounded-md p-1 text-muted-foreground hover:bg-primary/10 hover:text-foreground"
            title="Add a note to this task"
          >
            <StickyNote className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      {/* Description: the single "what this task is" field, ALWAYS visible (no
          need to open edit to read it). Distinct from the note icon above, which
          adds dated, authored notes. Editing it overwrites the one description. */}
      {editingDesc ? (
        <div className="mt-1.5 space-y-1.5">
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Description</label>
          <textarea
            value={descDraft}
            onChange={(e) => setDescDraft(e.target.value)}
            rows={2}
            placeholder="Describe what this task involves…"
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12.5px] text-foreground"
          />
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={saveDesc} disabled={update.isPending}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[12px] font-medium text-primary-foreground disabled:opacity-60">
              <Check className="h-3.5 w-3.5" /> Save
            </button>
            <button type="button" onClick={() => setEditingDesc(false)}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted">
              <X className="h-3.5 w-3.5" /> Cancel
            </button>
          </div>
        </div>
      ) : task.description ? (
        <p className="mt-1 text-[12px] text-muted-foreground">
          <span className="font-medium text-foreground/70">Description: </span>{task.description}
        </p>
      ) : canEdit ? (
        <button
          type="button"
          onClick={() => { setDescDraft(''); setEditingDesc(true); }}
          className="mt-1 text-[12px] italic text-muted-foreground/70 hover:text-primary"
        >
          Add a description
        </button>
      ) : null}
      {/* Blocked reason (when status = blocked) and blocker linkage. */}
      {task.status === 'blocked' && task.blocked_reason ? (
        <p className="mt-1 text-[11.5px] text-rose-600 dark:text-rose-400">Blocked: {task.blocked_reason}</p>
      ) : null}
      {task.blocked_by ? (
        <p className="mt-1 text-[11.5px] text-amber-700 dark:text-amber-400">
          Waiting on task: <span className="font-semibold">{task.blocked_by.name}</span>
        </p>
      ) : null}
    </div>
  );
}

// "My Work" — an employee's assigned projects/tasks, master-detail like the
// Clients page: a left rail listing the clients they work for, and a right pane
// showing that client's projects (expandable to tasks) + per-project hours.
export function MyWorkPage() {
  const workQ = useMyWork();
  const data = workQ.data;
  const clients = data?.clients ?? [];

  // Selected client persisted in the URL (?client=<id>) so a refresh keeps the
  // same view (mirrors the Clients page).
  const [searchParams, setSearchParams] = useSearchParams();
  const activeClientId = searchParams.get('client') ? Number(searchParams.get('client')) : null;
  const setActiveClientId = (id: number) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('client', String(id));
      return next;
    }, { replace: true });
  };

  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const flashAndFade = (tone: 'ok' | 'err', text: string) => {
    setFlash({ tone, text });
    window.setTimeout(() => setFlash(null), 2500);
  };
  // Add-note from a task row: a locked target (this client/project/task), the
  // note authored by the current resource. The backend allows it because they're
  // an assignee on the task.
  const [noteModal, setNoteModal] = useState<{ open: boolean; clientId: number; target: NoteTarget } | null>(null);
  const addNote = (clientId: number, p: MyWorkProject, t: MyWorkTask) => setNoteModal({
    open: true,
    clientId,
    target: {
      mode: 'locked',
      projectId: p.project_id, projectName: p.project_name, projectCode: p.code,
      taskId: t.task_id, taskName: t.name, taskStatus: t.status ?? null,
    },
  });

  // Default-select the first client once data lands (or if the URL points at a
  // client this person no longer has work under).
  useEffect(() => {
    if (!clients.length) return;
    const picked = activeClientId != null && clients.some((c) => c.client_id === activeClientId);
    if (!picked) setActiveClientId(clients[0].client_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClientId, clients]);

  const activeClient = clients.find((c) => c.client_id === activeClientId) ?? null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">My Work</h1>
        <p className="text-[13px] text-muted-foreground">The projects and tasks assigned to you, by client.</p>
      </div>

      {flash ? (
        <div className={cn(
          'rounded-md border px-3 py-2 text-[13px]',
          flash.tone === 'ok'
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700'
            : 'border-red-500/30 bg-red-500/10 text-red-700',
        )}>{flash.text}</div>
      ) : null}

      {/* Summary tiles */}
      {data ? (
        <div className="grid grid-cols-3 gap-3">
          {[
            ['Projects', data.total_projects],
            ['Tasks', data.total_tasks],
            ['Hours logged', `${num(data.total_hours)}h`],
          ].map(([label, val]) => (
            <Card key={label} className="px-4 py-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className="mt-0.5 text-xl font-bold tabular-nums">{val}</p>
            </Card>
          ))}
        </div>
      ) : null}

      {workQ.isLoading ? (
        <div className="grid place-items-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : clients.length === 0 ? (
        <Empty Icon={Briefcase} title="No work assigned yet" description="When you're assigned to a project or task, it'll show up here." />
      ) : (
        // Master-detail: client rail + project/task pane (mirrors Clients page).
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          {/* Left: clients */}
          <Card className="h-fit overflow-hidden p-2">
            <div className="px-2 pb-1.5 pt-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
              Clients · {clients.length}
            </div>
            {clients.map((c) => {
              const active = c.client_id === activeClientId;
              return (
                <button
                  key={c.client_id}
                  type="button"
                  onClick={() => setActiveClientId(c.client_id)}
                  className={cn(
                    'mb-1 flex w-full items-center gap-3 rounded-xl border px-2.5 py-2 text-left transition-colors',
                    active ? 'border-primary/30 bg-primary/10' : 'border-transparent hover:bg-primary/5',
                  )}
                >
                  <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl text-xs font-semibold', avatarTone(c.client_name))}>
                    {initials(c.client_name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">{c.client_name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {c.projects.length} {c.projects.length === 1 ? 'project' : 'projects'}
                    </span>
                  </span>
                </button>
              );
            })}
          </Card>

          {/* Right: selected client's projects + tasks */}
          <div className="space-y-2">
            {activeClient ? (
              <>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[13px] font-bold text-foreground">{activeClient.client_name}</span>
                  <span className="text-[12px] text-muted-foreground">
                    {activeClient.projects.length} {activeClient.projects.length === 1 ? 'project' : 'projects'}
                  </span>
                </div>
                {activeClient.projects.map((p) => {
                  const isOpen = open[p.project_id] ?? false;
                  return (
                    <Card key={p.project_id} className="overflow-hidden p-0">
                      <button type="button" onClick={() => setOpen((s) => ({ ...s, [p.project_id]: !(s[p.project_id] ?? false) }))}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-primary/[0.03]">
                        <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
                        <Folder className="h-4 w-4 shrink-0 text-primary" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="text-[14px] font-semibold">{p.project_name}</span>
                            {p.code ? <span className="rounded-full bg-muted px-2 text-[10px] font-semibold text-muted-foreground">{p.code}</span> : null}
                            <span className="text-[12px] text-muted-foreground">{p.tasks.length} {p.tasks.length === 1 ? 'task' : 'tasks'}</span>
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-3 text-[12px] text-muted-foreground">
                          <span>
                            {num(p.my_hours)}h logged{Number(p.approved_hours) > 0 ? ` · ${num(p.approved_hours)}h approved` : ''}
                          </span>
                          {p.status ? <TonePill tone={STATUS_TONE[p.status] ?? 'neutral'}>{fmt(p.status)}</TonePill> : null}
                        </span>
                      </button>
                      {isOpen ? (
                        <div className="border-t border-border bg-muted/30 px-4 py-3">
                          {p.tasks.length === 0 ? (
                            <p className="py-1 text-[12.5px] text-muted-foreground">No specific tasks assigned — you have project-level access.</p>
                          ) : (() => {
                            // "Needs your attention" = editable, non-done tasks
                            // sorted overdue→soonest (no due date last). The rest
                            // go under "All tasks".
                            const attention = p.tasks
                              .filter((t) => t.can_edit !== false && t.status !== 'done')
                              .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'));
                            const attentionIds = new Set(attention.map((t) => t.task_id));
                            const rest = p.tasks.filter((t) => !attentionIds.has(t.task_id));
                            const rowFor = (t: MyWorkTask) => (
                              <TaskRow key={t.task_id} task={t} onFlash={flashAndFade} onAddNote={() => addNote(activeClient.client_id, p, t)} />
                            );
                            return (
                              <div className="space-y-3">
                                {attention.length ? (
                                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-2">
                                    <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                                      <AlertTriangle className="h-3.5 w-3.5" /> Needs your attention
                                      <span className="ml-auto rounded-full bg-amber-500/15 px-1.5 text-[10px] font-bold tabular-nums">{attention.length}</span>
                                    </div>
                                    <div className="space-y-1">{attention.map(rowFor)}</div>
                                  </div>
                                ) : null}
                                {rest.length ? (
                                  <div>
                                    {attention.length ? (
                                      <p className="mb-1 px-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">All tasks</p>
                                    ) : (
                                      <div className="mb-1.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                                        <span>Tasks in {p.project_name}</span>
                                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">{p.tasks.length}</span>
                                      </div>
                                    )}
                                    <div className="space-y-1 border-l-2 border-primary/20 pl-2.5">{rest.map(rowFor)}</div>
                                  </div>
                                ) : null}
                              </div>
                            );
                          })()}
                        </div>
                      ) : null}
                    </Card>
                  );
                })}
              </>
            ) : (
              <p className="px-1 py-8 text-center text-sm text-muted-foreground">Select a client to see your work.</p>
            )}
          </div>
        </div>
      )}

      {noteModal ? (
        <NoteModal
          open={noteModal.open}
          clientId={noteModal.clientId}
          target={noteModal.target}
          onClose={() => setNoteModal(null)}
          onSaved={(m) => { flashAndFade('ok', m); }}
          onError={(m) => flashAndFade('err', m)}
        />
      ) : null}
    </div>
  );
}
