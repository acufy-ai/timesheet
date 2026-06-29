import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button, Input, Modal, FieldError, RequiredMark } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useCreateClientNote, useProjectNotes, useTaskNotes, useUpdateClientNote } from '@/hooks/useAdmin';
import { avatarTone, initials } from '@/lib/avatar';
import type { ClientNote, ClientNoteBody, FullProject, FullTask, TaskStatus } from '@/types/admin';

function fmtNoteDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Shared note authoring modal. Two launch modes:
//  - 'free'   : full Project + Task dropdowns (the client Notes tab). Pass the
//               client's projects + tasksByProject.
//  - 'locked' : opened FROM a specific project/task (a row action, the project
//               detail page, or My Work). The project/task are fixed and shown
//               as read-only chips; only the status + body are editable.
// On save with a task, the chosen status drives the task's status and (only when
// 'blocked') the body becomes the task's blocked reason — enforced server-side.

const labelClass = 'mb-1 block text-[13px] font-medium text-muted-foreground';
const selectClass =
  'h-9 w-full rounded-full border border-border bg-transparent px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';
const textareaClass =
  'w-full rounded-2xl border border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  to_do: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done',
};

export type NoteTarget =
  | { mode: 'free'; projects: FullProject[]; tasksByProject: Map<number, FullTask[]> }
  | {
      mode: 'locked';
      projectId: number; projectName: string; projectCode?: string | null;
      taskId?: number | null; taskName?: string | null; taskStatus?: string | null;
    };

function errText(e: unknown, fallback: string): string {
  const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof detail === 'string' ? detail : fallback;
}

export function NoteModal({
  open, clientId, target, note, onClose, onSaved, onError,
}: {
  open: boolean;
  clientId: number;
  target: NoteTarget;
  note?: ClientNote | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const isEdit = !!note;
  const locked = target.mode === 'locked';
  const create = useCreateClientNote();
  const update = useUpdateClientNote();

  const [date, setDate] = useState('');
  const [body, setBody] = useState('');
  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [taskStatus, setTaskStatus] = useState<TaskStatus | ''>('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Tabs: the form, or the read-only note history for this task/project. History
  // is only meaningful for a locked (single task or project) target.
  const [tab, setTab] = useState<'add' | 'history'>('add');

  // Tasks of the chosen project (free mode only).
  const projectTasks = !locked && projectId
    ? (target.tasksByProject.get(Number(projectId)) ?? [])
    : [];

  // Note history: every note attached to this task (preferred) or project, any
  // author/source. Fetched only when the history tab is open on a locked target.
  const lockedTaskId = locked && target.taskId != null ? target.taskId : null;
  const lockedProjectId = locked ? target.projectId : null;
  const showHistory = locked;
  const taskHistory = useTaskNotes(lockedTaskId, showHistory && tab === 'history' && lockedTaskId != null);
  const projectHistory = useProjectNotes(
    lockedProjectId, showHistory && tab === 'history' && lockedTaskId == null && lockedProjectId != null);
  const history = lockedTaskId != null ? taskHistory : projectHistory;

  useEffect(() => {
    if (!open) return;
    const today = (() => {
      const d = new Date();
      const m = `${d.getMonth() + 1}`.padStart(2, '0');
      const day = `${d.getDate()}`.padStart(2, '0');
      return `${d.getFullYear()}-${m}-${day}`;
    })();
    setDate(note?.note_date ?? today);
    setBody(note?.body ?? '');
    setErrors({});
    setTab('add');
    if (locked) {
      setProjectId(String(target.projectId));
      setTaskId(target.taskId != null ? String(target.taskId) : '');
      setTaskStatus(target.taskId != null ? ((target.taskStatus as TaskStatus) ?? 'to_do') : '');
    } else {
      setProjectId(note?.project_id != null ? String(note.project_id) : '');
      setTaskId(note?.task_id != null ? String(note.task_id) : '');
      setTaskStatus('');
    }
  }, [open, note, target, locked]);

  // Free mode: prefill status from the picked task's current status.
  useEffect(() => {
    if (locked || !taskId) { if (!locked) setTaskStatus(''); return; }
    const t = projectTasks.find((x) => x.id === Number(taskId));
    setTaskStatus((t?.status as TaskStatus) ?? 'to_do');
  }, [taskId, projectTasks, locked]);

  const saving = create.isPending || update.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) { setErrors({ body: 'Note body is required.' }); return; }
    const data: ClientNoteBody = {
      note_date: date || null,
      body: body.trim(),
      project_id: projectId ? Number(projectId) : null,
      task_id: taskId ? Number(taskId) : null,
      task_status: taskId && taskStatus ? taskStatus : null,
    };
    try {
      if (isEdit && note) {
        await update.mutateAsync({ clientId, id: note.id, data });
        onSaved('Note updated.');
      } else {
        await create.mutateAsync({ clientId, data });
        onSaved('Note created.');
      }
      onClose();
    } catch (err) {
      onError(errText(err, 'Could not save the note.'));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit note' : 'New note'} className="max-w-2xl" flushBottom>
      {/* Tabs (locked target only): the form, and the read-only note history for
          this task/project — every note attached to it, from any source. */}
      {showHistory ? (
        <div className="mb-3 flex gap-1 rounded-lg border border-border p-0.5 text-sm">
          <button type="button" onClick={() => setTab('add')}
            className={cn('flex-1 rounded-md px-3 py-1.5 font-medium transition-colors',
              tab === 'add' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
            {isEdit ? 'Edit note' : 'Add note'}
          </button>
          <button type="button" onClick={() => setTab('history')}
            className={cn('flex-1 rounded-md px-3 py-1.5 font-medium transition-colors',
              tab === 'history' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
            Notes history
          </button>
        </div>
      ) : null}

      {showHistory && tab === 'history' ? (
        <NoteHistory query={history} scope={lockedTaskId != null ? 'task' : 'project'} />
      ) : (
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Target: locked chips, or free dropdowns. */}
        {locked ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
              {target.projectName}{target.projectCode ? ` · ${target.projectCode}` : ''}
            </span>
            {target.taskName ? (
              <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                {target.taskName}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Project</label>
              <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setTaskId(''); }} className={selectClass}>
                <option value="">No project</option>
                {target.projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.code ? ` · ${p.code}` : ''}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Task</label>
              <select value={taskId} onChange={(e) => setTaskId(e.target.value)} disabled={!projectId} className={cn(selectClass, !projectId && 'opacity-60')}>
                <option value="">{projectId ? 'No task' : 'Pick a project first'}</option>
                {projectTasks.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Task status: shown once a task is targeted. */}
        {taskId ? (
          <div className="sm:max-w-[50%]">
            <label className={labelClass}>Task status</label>
            <select value={taskStatus} onChange={(e) => setTaskStatus(e.target.value as TaskStatus)} className={selectClass}>
              {(Object.keys(TASK_STATUS_LABEL) as TaskStatus[]).map((s) => (
                <option key={s} value={s}>{TASK_STATUS_LABEL[s]}</option>
              ))}
            </select>
          </div>
        ) : null}

        <div>
          <label className={labelClass}>Date</label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <p className="mt-1 text-[11px] text-muted-foreground">The note is recorded under your name automatically.</p>
        </div>

        <div>
          <label className={labelClass}>Note<RequiredMark /></label>
          <textarea
            value={body}
            onChange={(e) => { setBody(e.target.value); setErrors((p) => ({ ...p, body: '' })); }}
            rows={4}
            placeholder="Write your note..."
            className={cn(textareaClass, errors.body && 'border-rose-400')}
            required
          />
          <FieldError error={errors.body} />
          {taskId && taskStatus === 'blocked' ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              The task status is "Blocked", so this note becomes its "Why is it blocked?" reason.
            </p>
          ) : null}
        </div>

        <div className="sticky bottom-0 -mx-4 mt-2 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</> : isEdit ? 'Save changes' : 'Create note'}
          </Button>
        </div>
      </form>
      )}
    </Modal>
  );
}

// Read-only note history for a task / project: every note attached to it, any
// author or source (a resource on My Work, a manager in Client Management, or a
// client with access). Newest first.
function NoteHistory({ query, scope }: { query: { data?: ClientNote[]; isLoading: boolean; isError: boolean }; scope: 'task' | 'project' }) {
  if (query.isLoading) {
    return <div className="grid place-items-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }
  if (query.isError) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Couldn't load the note history.</p>;
  }
  const notes = query.data ?? [];
  if (notes.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No notes on this {scope} yet.</p>;
  }
  return (
    <div className="max-h-[60vh] space-y-2 overflow-y-auto pb-2">
      {notes.map((n) => {
        const author = n.author || 'Unknown';
        return (
          <div key={n.id} className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-start gap-2.5">
              <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[10px] font-semibold', avatarTone(author))}>
                {initials(author)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-[13px] font-semibold text-foreground">{author}</span>
                  {n.note_date ? <span className="text-[11px] text-muted-foreground">{fmtNoteDate(n.note_date)}</span> : null}
                </div>
                {/* For a project-scope history, show which task each note is on. */}
                {scope === 'project' && n.task_name ? (
                  <span className="mt-0.5 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">{n.task_name}</span>
                ) : null}
                <p className="mt-1 whitespace-pre-wrap text-[13px] text-foreground">{n.body}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
