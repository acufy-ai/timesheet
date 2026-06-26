import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button, FieldError, Modal, RequiredMark, errorBorder } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useProjects, useTasks } from '@/hooks/useTime';
import { useCreateEntry } from '@/hooks/useTime';
import { formatElapsed, useTimer } from '@/hooks/useTimer';

// Shown automatically when the timer is stopped. Confirms project / task /
// notes, converts elapsed time to hours, creates a time entry for today, then
// discards the timer. Ported from frontend2's LogEntryModal.
export function LogEntryModal() {
  const { status, elapsedMs, projectId, taskId, notes, discard, setProject, setTask, setNotes } = useTimer();
  const projectsQ = useProjects();
  const tasksQ = useTasks();
  const create = useCreateEntry();
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (status !== 'stopped') return null;

  const totalHours = Number((elapsedMs / 3_600_000).toFixed(2)) || 0.01;
  const tooShort = elapsedMs < 60_000;
  const tasksForProject = (tasksQ.data ?? []).filter((t) => !projectId || t.project_id === projectId);

  async function save() {
    setError(null);
    if (!projectId) {
      setErrors({ project: 'Pick a project to log against.' });
      return;
    }
    setErrors({});
    try {
      await create.mutateAsync({
        project_id: projectId,
        task_id: taskId || undefined,
        description: notes || tasksForProject.find((t) => t.id === taskId)?.name || 'Logged time',
        hours: totalHours,
        entry_date: new Date().toISOString().split('T')[0],
      });
      discard();
    } catch (e) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof d === 'string' ? d : 'Could not save the entry.');
    }
  }

  return (
    <Modal open onClose={discard} title="Log tracked time" className="max-w-3xl" flushBottom>
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
        <div className="md:col-span-2 rounded-xl border border-border bg-muted/30 px-4 py-3 text-center">
          <p className="font-mono text-2xl font-bold tabular-nums text-foreground">{formatElapsed(elapsedMs)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{totalHours.toFixed(2)}h · today</p>
          {tooShort ? <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-300">Under a minute — rounded to {totalHours.toFixed(2)}h.</p> : null}
        </div>

        <div>
          <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Project<RequiredMark /></label>
          <select value={projectId ?? ''} onChange={(e) => { setProject(e.target.value ? Number(e.target.value) : null); setErrors((er) => ({ ...er, project: '' })); }} className={cn('h-9 w-full rounded-md border border-border bg-background px-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20', errorBorder(!!errors.project))}>
            <option value="">Select a project…</option>
            {(projectsQ.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <FieldError error={errors.project} />
        </div>

        <div>
          <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Task</label>
          <select value={taskId ?? ''} onChange={(e) => setTask(e.target.value ? Number(e.target.value) : null)} disabled={!projectId} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50">
            <option value="">No task</option>
            {tasksForProject.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>

        <div className="md:col-span-2">
          <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="What did you work on?" className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" />
        </div>

        {error ? <p className="md:col-span-2 text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}

        <div className="md:col-span-2 sticky bottom-0 -mx-4 mt-2 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          <Button variant="ghost" onClick={discard}>Discard</Button>
          <Button onClick={() => void save()} disabled={create.isPending || !projectId}>
            {create.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : 'Save entry'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
