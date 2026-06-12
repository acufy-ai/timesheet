import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button, Input, Modal } from '@/components/ui';
import { useCreateProject, useUpdateProject } from '@/hooks/useAdmin';
import type { FullProject, ProjectBody } from '@/types/admin';

// Create / edit a project under a client. Mirrors backend ProjectCreate/Update:
// name, billable_rate (required), code, description, start/end dates,
// estimated_hours, budget_amount, currency, is_active, quickbooks_project_id.
export function ProjectFormModal({
  open,
  clientId,
  project,
  onClose,
  onSaved,
}: {
  open: boolean;
  clientId: number;
  project: FullProject | null; // null = create
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const isEdit = !!project;
  const create = useCreateProject();
  const update = useUpdateProject();

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [rate, setRate] = useState('');
  const [budget, setBudget] = useState('');
  const [estHours, setEstHours] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [qbId, setQbId] = useState('');
  const [description, setDescription] = useState('');
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const numStr = (v: string | number | null | undefined) =>
    v == null || v === '' ? '' : String(typeof v === 'string' ? v : v);

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    setCode(project?.code ?? '');
    setRate(numStr(project?.billable_rate));
    setBudget(numStr(project?.budget_amount));
    setEstHours(numStr(project?.estimated_hours));
    setCurrency(project?.currency ?? 'USD');
    setStartDate(project?.start_date ?? '');
    setEndDate(project?.end_date ?? '');
    setQbId(project?.quickbooks_project_id ?? '');
    setDescription(project?.description ?? '');
    setActive(project?.is_active ?? true);
    setError(null);
  }, [open, project]);

  const saving = create.isPending || update.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Project name is required.'); return; }
    const rateNum = Number(rate);
    if (!Number.isFinite(rateNum) || rateNum < 0) { setError('Enter a valid billable rate.'); return; }

    const body: ProjectBody = {
      name: name.trim(),
      client_id: clientId,
      billable_rate: rateNum,
      code: code.trim() || null,
      description: description.trim() || null,
      start_date: startDate || null,
      end_date: endDate || null,
      estimated_hours: estHours ? Number(estHours) : null,
      budget_amount: budget ? Number(budget) : null,
      currency: currency.trim() || null,
      quickbooks_project_id: qbId.trim() || null,
      is_active: active,
    };
    try {
      if (isEdit && project) {
        await update.mutateAsync({ id: project.id, data: body });
        onSaved('Project updated.');
      } else {
        await create.mutateAsync(body);
        onSaved('Project created.');
      }
      onClose();
    } catch (err) {
      const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof d === 'string' ? d : 'Could not save the project.');
    }
  }

  const labelClass = 'mb-1 block text-xs font-medium text-muted-foreground';

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit project · ${project?.name}` : 'New project'} className="max-w-lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px]">
            <div>
              <label className={labelClass}>Name *</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Website redesign" required />
            </div>
            <div>
              <label className={labelClass}>Code</label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="WEB-01" />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className={labelClass}>Billable rate *</label>
              <Input type="number" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="150" required />
            </div>
            <div>
              <label className={labelClass}>Budget</label>
              <Input type="number" step="0.01" min="0" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="Optional" />
            </div>
            <div>
              <label className={labelClass}>Currency</label>
              <Input value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="USD" />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className={labelClass}>Est. hours</label>
              <Input type="number" step="1" min="0" value={estHours} onChange={(e) => setEstHours(e.target.value)} placeholder="Optional" />
            </div>
            <div>
              <label className={labelClass}>Start date</label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>End date</label>
              <Input type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
          <div>
            <label className={labelClass}>QuickBooks project ID</label>
            <Input value={qbId} onChange={(e) => setQbId(e.target.value)} placeholder="Optional" />
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
        </div>
        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</>) : isEdit ? 'Save changes' : 'Create project'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
