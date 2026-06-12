import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button, Input, Modal } from '@/components/ui';
import { useCreateTask, useUpdateTask } from '@/hooks/useAdmin';
import type { FullTask, TaskBody } from '@/types/admin';

// Create / edit a task under a project. Mirrors backend TaskCreate/Update:
// name, code, description, is_active (project_id is supplied by the parent).
export function TaskFormModal({
  open,
  projectId,
  task,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: number;
  task: FullTask | null; // null = create
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const isEdit = !!task;
  const create = useCreateTask();
  const update = useUpdateTask();

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(task?.name ?? '');
    setCode(task?.code ?? '');
    setDescription(task?.description ?? '');
    setActive(task?.is_active ?? true);
    setError(null);
  }, [open, task]);

  const saving = create.isPending || update.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Task name is required.'); return; }
    const body: TaskBody = {
      project_id: projectId,
      name: name.trim(),
      code: code.trim() || null,
      description: description.trim() || null,
      is_active: active,
    };
    try {
      if (isEdit && task) {
        await update.mutateAsync({ id: task.id, data: body });
        onSaved('Task updated.');
      } else {
        await create.mutateAsync(body);
        onSaved('Task created.');
      }
      onClose();
    } catch (err) {
      const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof d === 'string' ? d : 'Could not save the task.');
    }
  }

  const labelClass = 'mb-1 block text-xs font-medium text-muted-foreground';

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit task · ${task?.name}` : 'New task'} className="max-w-md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px]">
          <div>
            <label className={labelClass}>Name *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Discovery" required />
          </div>
          <div>
            <label className={labelClass}>Code</label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="DISC" />
          </div>
        </div>
        <div>
          <label className={labelClass}>Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Optional"
            className="w-full rounded-2xl border border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]" />
          Active
        </label>
        {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</>) : isEdit ? 'Save changes' : 'Create task'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
