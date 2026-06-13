import { useState } from 'react';
import { Check, Loader2, Pencil, Plus, Power, Trash2, X } from 'lucide-react';

import { Button, Card, Input } from '@/components/ui';
import {
  useCreateDepartment,
  useCreateLeaveType,
  useDeleteDepartment,
  useDeleteLeaveType,
  useDepartments,
  useLeaveTypes,
  useUpdateLeaveType,
} from '@/hooks/useAdmin';

// Workforce Setup tab (admin): manage Departments and Leave Types. Mirrors
// frontend2's two-card layout with add forms + delete.
export function WorkforceSetupTab() {
  const depts = useDepartments();
  const leaveTypes = useLeaveTypes(true); // include inactive for management
  const createDept = useCreateDepartment();
  const delDept = useDeleteDepartment();
  const createLt = useCreateLeaveType();
  const delLt = useDeleteLeaveType();
  const updateLt = useUpdateLeaveType();

  const [deptName, setDeptName] = useState('');
  const [ltLabel, setLtLabel] = useState('');
  const [ltColor, setLtColor] = useState('#6366f1');
  const [err, setErr] = useState<string | null>(null);
  // Inline leave-type rename: id being edited + its working label.
  const [editLtId, setEditLtId] = useState<number | null>(null);
  const [editLtLabel, setEditLtLabel] = useState('');

  const errText = (e: unknown) => {
    const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
    return typeof d === 'string' ? d : 'Something went wrong. Please try again.';
  };

  async function addDept(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    if (!deptName.trim()) return;
    try { await createDept.mutateAsync(deptName.trim()); setDeptName(''); }
    catch (er) { setErr(errText(er)); }
  }
  async function addLt(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    if (!ltLabel.trim()) return;
    try { await createLt.mutateAsync({ label: ltLabel.trim(), color: ltColor }); setLtLabel(''); }
    catch (er) { setErr(errText(er)); }
  }
  async function saveLtRename(id: number) {
    const label = editLtLabel.trim();
    if (!label) { setEditLtId(null); return; }
    setErr(null);
    try { await updateLt.mutateAsync({ id, data: { label } }); setEditLtId(null); }
    catch (er) { setErr(errText(er)); }
  }
  async function toggleLtActive(id: number, isActive: boolean) {
    setErr(null);
    try { await updateLt.mutateAsync({ id, data: { is_active: !isActive } }); }
    catch (er) { setErr(errText(er)); }
  }
  function removeDept(id: number, name: string) {
    if (!window.confirm(`Remove the "${name}" department? Users assigned to it keep the name as a legacy value.`)) return;
    delDept.mutate(id);
  }

  return (
    <div className="space-y-4">
      {err ? <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">{err}</div> : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Departments */}
        <Card>
          <div className="border-b border-border px-4 py-3"><p className="text-sm font-semibold text-foreground">Departments</p></div>
          <form onSubmit={addDept} className="flex gap-2 border-b border-border p-3">
            <Input value={deptName} onChange={(e) => setDeptName(e.target.value)} placeholder="New department name" />
            <Button type="submit" disabled={createDept.isPending || !deptName.trim()}>
              {createDept.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </Button>
          </form>
          {depts.isLoading ? (
            <div className="grid place-items-center py-8 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" /></div>
          ) : (depts.data ?? []).length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">No departments yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {(depts.data ?? []).map((d) => (
                <div key={d.id} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm text-foreground">{d.name}</span>
                  <button type="button" aria-label="Delete department" onClick={() => removeDept(d.id, d.name)} className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Leave types */}
        <Card>
          <div className="border-b border-border px-4 py-3"><p className="text-sm font-semibold text-foreground">Leave types</p></div>
          <form onSubmit={addLt} className="flex items-center gap-2 border-b border-border p-3">
            <input type="color" value={ltColor} onChange={(e) => setLtColor(e.target.value)} aria-label="Leave type color" className="h-9 w-9 shrink-0 cursor-pointer rounded-md border border-border bg-transparent" />
            <Input value={ltLabel} onChange={(e) => setLtLabel(e.target.value)} placeholder="New leave type label" />
            <Button type="submit" disabled={createLt.isPending || !ltLabel.trim()}>
              {createLt.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </Button>
          </form>
          {leaveTypes.isLoading ? (
            <div className="grid place-items-center py-8 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" /></div>
          ) : (leaveTypes.data ?? []).length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">No leave types yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {(leaveTypes.data ?? []).map((lt) => (
                <div key={lt.id} className={'flex items-center justify-between px-4 py-2.5 ' + (lt.is_active ? '' : 'opacity-60')}>
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: lt.color }} />
                    {editLtId === lt.id ? (
                      <input
                        autoFocus
                        value={editLtLabel}
                        onChange={(e) => setEditLtLabel(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void saveLtRename(lt.id); if (e.key === 'Escape') setEditLtId(null); }}
                        className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm focus:border-primary focus:outline-none"
                      />
                    ) : (
                      <span className="truncate text-sm text-foreground">{lt.label}</span>
                    )}
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{lt.code}</span>
                    {!lt.is_active ? <span className="shrink-0 text-[10px] text-muted-foreground">(inactive)</span> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    {editLtId === lt.id ? (
                      <>
                        <button type="button" aria-label="Save name" onClick={() => void saveLtRename(lt.id)} className="grid h-8 w-8 place-items-center rounded-full text-emerald-600 hover:bg-emerald-500/10"><Check className="h-4 w-4" /></button>
                        <button type="button" aria-label="Cancel" onClick={() => setEditLtId(null)} className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10"><X className="h-4 w-4" /></button>
                      </>
                    ) : (
                      <>
                        <button type="button" aria-label="Rename leave type" onClick={() => { setEditLtId(lt.id); setEditLtLabel(lt.label); }} className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-primary/10 hover:text-primary"><Pencil className="h-3.5 w-3.5" /></button>
                        <button type="button" aria-label={lt.is_active ? 'Deactivate' : 'Reactivate'} title={lt.is_active ? 'Deactivate' : 'Reactivate'} onClick={() => void toggleLtActive(lt.id, lt.is_active)} className={'grid h-8 w-8 place-items-center rounded-full hover:bg-foreground/10 ' + (lt.is_active ? 'text-muted-foreground' : 'text-emerald-600')}><Power className="h-3.5 w-3.5" /></button>
                        <button type="button" aria-label="Delete leave type" onClick={() => { if (window.confirm(`Delete the "${lt.label}" leave type?`)) delLt.mutate(lt.id); }} className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
