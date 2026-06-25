import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';

import { Button, FieldError, RequiredMark, errorBorder } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useCreateEntry, useProjects } from '@/hooks/useTime';

function isoFor(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function labelFor(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// Fast-path "Log time" popover — pick project, hours, optional note, today or
// yesterday, save. No navigation. Ported from frontend2's QuickLogButton.
export function QuickLogButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [hours, setHours] = useState('');
  const [description, setDescription] = useState('');
  const [day, setDay] = useState<'today' | 'yesterday'>('today');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);

  const projectsQ = useProjects();
  const create = useCreateEntry();

  function reset() { setProjectId(''); setHours(''); setDescription(''); setDay('today'); setError(null); setErrors({}); }
  function close() { setOpen(false); setError(null); setErrors({}); }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    const t = window.setTimeout(() => selectRef.current?.focus(), 0);
    return () => { window.removeEventListener('keydown', onKey); window.clearTimeout(t); };
  }, [open]);

  async function submit() {
    setError(null);
    const pid = Number(projectId);
    const h = Number(hours);
    const next: Record<string, string> = {};
    if (!Number.isInteger(pid) || pid <= 0) next.projectId = 'Pick a project.';
    if (!hours.trim()) next.hours = 'This field is required.';
    else if (!Number.isFinite(h) || h <= 0 || h > 24) next.hours = 'Hours must be between 0 and 24.';
    else if (Math.round(h * 2) !== h * 2) next.hours = 'Hours must be in 0.5 increments.';
    if (Object.keys(next).length) { setErrors(next); return; }
    setErrors({});
    try {
      await create.mutateAsync({
        project_id: pid,
        entry_date: day === 'today' ? isoFor(0) : isoFor(-1),
        hours: h,
        description: description.trim() || 'Logged time',
        is_billable: true,
      });
      setSaved(true); window.setTimeout(() => setSaved(false), 1200);
      reset(); close();
    } catch (e) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof d === 'string' ? d : 'Could not log time.');
    }
  }

  const inputClass = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

  return (
    <div className={'relative ' + (className ?? '')}>
      <Button onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}>
        <Plus className="h-4 w-4" /> Log time
      </Button>
      {saved ? <span className="ml-2 text-xs font-medium text-emerald-600 dark:text-emerald-300">Saved</span> : null}

      {open ? (
        <>
          <div className="fixed inset-0 z-50" role="presentation" onClick={close} />
          <div role="dialog" aria-label="Quick log time" onClick={(e) => e.stopPropagation()} className="absolute right-0 z-[60] mt-2 w-[360px] rounded-2xl border border-border bg-card p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-foreground">Quick log <span className="ml-1 font-normal text-muted-foreground">{labelFor(day === 'today' ? 0 : -1)}</span></h4>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setDay((d) => (d === 'today' ? 'yesterday' : 'today'))} className="text-[11px] font-medium text-primary hover:underline">
                  {day === 'today' ? 'Switch to yesterday' : 'Switch to today'}
                </button>
                <button type="button" onClick={close} aria-label="Close" className="text-muted-foreground hover:text-foreground">×</button>
              </div>
            </div>
            <div className="space-y-2">
              <div>
                <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Project<RequiredMark /></label>
                <select ref={selectRef} value={projectId} onChange={(e) => { setProjectId(e.target.value); setErrors((p) => ({ ...p, projectId: '' })); }} className={cn(inputClass, errorBorder(!!errors.projectId))}>
                  <option value="">Pick a project</option>
                  {(projectsQ.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <FieldError error={errors.projectId} />
              </div>
              <div>
                <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Hours<RequiredMark /></label>
                <input type="number" min={0} max={24} step={0.5} inputMode="decimal" placeholder="Hours (e.g. 1.5)" value={hours} onChange={(e) => { setHours(e.target.value); setErrors((p) => ({ ...p, hours: '' })); }} className={cn(inputClass, errorBorder(!!errors.hours))} />
                <FieldError error={errors.hours} />
              </div>
              <input type="text" placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }} className={inputClass} />
              {error ? <p className="text-xs text-rose-600 dark:text-rose-300">{error}</p> : null}
              <Button onClick={() => void submit()} disabled={create.isPending} className="w-full justify-center">
                {create.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Logging…</> : 'Log'}
              </Button>
              <p className="text-[11px] text-muted-foreground">Enter to log. Esc to close.</p>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
