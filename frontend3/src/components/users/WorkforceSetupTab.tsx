import { useState } from 'react';
import {
  Building2,
  Calendar,
  Check,
  Loader2,
  Pencil,
  Plus,
  Power,
  Tags,
  Trash2,
  X,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import {
  useCreateDepartment,
  useCreateLeaveType,
  useCreateTitle,
  useDeleteDepartment,
  useDeleteLeaveType,
  useDeleteTitle,
  useDepartments,
  useLeaveTypes,
  useTitles,
  useUpdateLeaveType,
} from '@/hooks/useAdmin';

// Organization tab (admin): one panel with a rail of catalogs (Departments,
// Titles, Leave types) and a focused worksheet for the active one. Replaces the
// old three-stacked-cards layout. Leave-type color is a fixed preset palette
// (not a native color input) so colors stay recognizable and on-brand.

type CatalogKey = 'dept' | 'title' | 'leave';

// Fixed leave-type colors — recognizable category hues. (Hex, since the leave
// type stores a literal color string.)
const LEAVE_COLORS: { name: string; hex: string }[] = [
  { name: 'Slate', hex: '#64748b' },
  { name: 'Gray', hex: '#6b7280' },
  { name: 'Teal', hex: '#0891b2' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Amber', hex: '#f59e0b' },
  { name: 'Rose', hex: '#dc2626' },
  { name: 'Violet', hex: '#7c3aed' },
  { name: 'Blue', hex: '#2563eb' },
];

export function WorkforceSetupTab() {
  const depts = useDepartments();
  const titles = useTitles();
  const leaveTypes = useLeaveTypes(true); // include inactive for management
  const createDept = useCreateDepartment();
  const delDept = useDeleteDepartment();
  const createTitle = useCreateTitle();
  const delTitle = useDeleteTitle();
  const createLt = useCreateLeaveType();
  const delLt = useDeleteLeaveType();
  const updateLt = useUpdateLeaveType();

  const [active, setActive] = useState<CatalogKey>('dept');
  const [deptName, setDeptName] = useState('');
  const [titleName, setTitleName] = useState('');
  const [ltLabel, setLtLabel] = useState('');
  const [ltColor, setLtColor] = useState(LEAVE_COLORS[2].hex); // teal default
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
  async function addTitle(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    if (!titleName.trim()) return;
    try { await createTitle.mutateAsync(titleName.trim()); setTitleName(''); }
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
  function removeTitle(id: number, name: string) {
    if (!window.confirm(`Remove the "${name}" title? Users assigned to it keep the name as a legacy value.`)) return;
    delTitle.mutate(id);
  }

  const CATALOGS = [
    { key: 'dept' as const, label: 'Departments', Icon: Building2, where: 'used in the Add user form', count: (depts.data ?? []).length, loading: depts.isLoading },
    { key: 'title' as const, label: 'Titles', Icon: Tags, where: 'used in the Add user form', count: (titles.data ?? []).length, loading: titles.isLoading },
    { key: 'leave' as const, label: 'Leave types', Icon: Calendar, where: 'used in time-off requests', count: (leaveTypes.data ?? []).length, loading: leaveTypes.isLoading },
  ];
  const current = CATALOGS.find((c) => c.key === active)!;

  return (
    <div className="space-y-4">
      {err ? <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">{err}</div> : null}

      <div className="grid grid-cols-1 overflow-hidden rounded-2xl border border-border bg-card md:grid-cols-[230px_1fr]">
        {/* ── Rail ── */}
        <aside className="flex flex-col gap-3 border-b border-border bg-muted/30 p-3 md:border-b-0 md:border-r">
          <p className="px-2 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Catalogs</p>
          <nav className="flex gap-1.5 overflow-x-auto md:flex-col">
            {CATALOGS.map(({ key, label, Icon, count }) => {
              const on = key === active;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActive(key)}
                  className={cn(
                    'flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-xl border px-2.5 py-2 text-left transition-colors',
                    on ? 'border-primary/25 bg-primary/10' : 'border-transparent hover:bg-foreground/[0.04]',
                  )}
                >
                  <Icon className={cn('h-4 w-4 shrink-0', on ? 'text-primary' : 'text-muted-foreground')} />
                  <span className={cn('flex-1 text-sm', on ? 'font-semibold text-foreground' : 'font-medium text-foreground/80')}>{label}</span>
                  <span className={cn(
                    'min-w-[22px] rounded-full px-1.5 py-px text-center font-mono text-[11px] tabular-nums',
                    on ? 'bg-primary text-primary-foreground' : count === 0 ? 'bg-muted text-muted-foreground/70' : 'bg-muted text-muted-foreground',
                  )}>{count}</span>
                </button>
              );
            })}
          </nav>
          <p className="mt-auto hidden border-t border-border px-2 pt-3 text-[11px] leading-relaxed text-muted-foreground md:block">
            These lists feed the <span className="font-semibold text-foreground/80">Add user</span> form and time-off requests. Keep them short and current.
          </p>
        </aside>

        {/* ── Worksheet ── */}
        <section className="flex min-w-0 flex-col">
          <header className="flex items-end gap-3 border-b border-border px-5 py-4">
            <h3 className="text-[17px] font-semibold tracking-tight text-foreground">{current.label}</h3>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[12px] tabular-nums text-primary">{current.count}</span>
            <span className="ml-auto text-xs text-muted-foreground">{current.where}</span>
          </header>

          {active === 'dept' ? (
            <SimpleCatalog
              q={depts}
              value={deptName}
              setValue={setDeptName}
              onSubmit={addDept}
              pending={createDept.isPending}
              placeholder="Add a department"
              emptyLabel="departments"
              where={current.where}
              onRemove={(id, name) => removeDept(id, name)}
            />
          ) : active === 'title' ? (
            <SimpleCatalog
              q={titles}
              value={titleName}
              setValue={setTitleName}
              onSubmit={addTitle}
              pending={createTitle.isPending}
              placeholder="Add a job title"
              emptyLabel="titles"
              where={current.where}
              onRemove={(id, name) => removeTitle(id, name)}
            />
          ) : (
            <>
              {/* add bar with preset color swatches */}
              <form onSubmit={addLt} className="flex items-center gap-2.5 border-b border-border bg-primary/[0.04] px-5 py-2.5">
                <div className="flex shrink-0 items-center gap-1.5" role="radiogroup" aria-label="Leave type color">
                  {LEAVE_COLORS.map((c) => (
                    <button
                      key={c.hex}
                      type="button"
                      onClick={() => setLtColor(c.hex)}
                      title={c.name}
                      aria-label={c.name}
                      aria-pressed={c.hex === ltColor}
                      className={cn(
                        'h-[18px] w-[18px] rounded-full ring-1 ring-inset ring-black/10 transition-transform hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                        c.hex === ltColor && 'ring-2 ring-offset-2 ring-offset-card',
                      )}
                      style={c.hex === ltColor
                        ? { background: c.hex, ['--tw-ring-color' as string]: c.hex }
                        : { background: c.hex }}
                    />
                  ))}
                </div>
                <input
                  value={ltLabel}
                  onChange={(e) => setLtLabel(e.target.value)}
                  placeholder="Add a leave type"
                  aria-label="Add a leave type"
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
                <button type="submit" disabled={createLt.isPending || !ltLabel.trim()} className="shrink-0 rounded-lg bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-45">
                  {createLt.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add'}
                </button>
              </form>

              {leaveTypes.isLoading ? (
                <Loading />
              ) : (leaveTypes.data ?? []).length === 0 ? (
                <Empty Icon={Calendar} label="leave types" where={current.where} />
              ) : (
                <div className="divide-y divide-border">
                  {(leaveTypes.data ?? []).map((lt) => (
                    <div key={lt.id} className={cn('group flex items-center gap-2.5 px-5 hover:bg-primary/[0.04]', lt.is_active ? '' : 'opacity-60')} style={{ minHeight: 38 }}>
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: lt.color }} />
                      {editLtId === lt.id ? (
                        <input
                          autoFocus
                          value={editLtLabel}
                          onChange={(e) => setEditLtLabel(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') void saveLtRename(lt.id); if (e.key === 'Escape') setEditLtId(null); }}
                          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm focus:border-primary focus:outline-none"
                        />
                      ) : (
                        <span className={cn('truncate text-sm text-foreground', lt.is_active ? '' : 'line-through')}>{lt.label}</span>
                      )}
                      <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">{lt.code}</span>
                      {!lt.is_active ? <span className="shrink-0 text-[10.5px] italic text-muted-foreground">inactive</span> : null}
                      <span className="flex-1" />
                      <div className="flex shrink-0 items-center gap-0.5">
                        {editLtId === lt.id ? (
                          <>
                            <button type="button" aria-label="Save name" onClick={() => void saveLtRename(lt.id)} className="grid h-7 w-7 place-items-center rounded-lg text-emerald-600 hover:bg-emerald-500/10"><Check className="h-4 w-4" /></button>
                            <button type="button" aria-label="Cancel" onClick={() => setEditLtId(null)} className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/10"><X className="h-4 w-4" /></button>
                          </>
                        ) : (
                          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                            <button type="button" aria-label="Rename leave type" onClick={() => { setEditLtId(lt.id); setEditLtLabel(lt.label); }} className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground hover:bg-primary/10 hover:text-primary"><Pencil className="h-3.5 w-3.5" /></button>
                            <button type="button" aria-label={lt.is_active ? 'Deactivate' : 'Reactivate'} title={lt.is_active ? 'Deactivate' : 'Reactivate'} onClick={() => void toggleLtActive(lt.id, lt.is_active)} className={cn('grid h-7 w-7 place-items-center rounded-lg hover:bg-foreground/10', lt.is_active ? 'text-muted-foreground' : 'text-emerald-600')}><Power className="h-3.5 w-3.5" /></button>
                            <button type="button" aria-label="Delete leave type" onClick={() => { if (window.confirm(`Delete the "${lt.label}" leave type?`)) delLt.mutate(lt.id); }} className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// ── Shared bits ──

function Loading() {
  return <div className="grid place-items-center py-12 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" /></div>;
}

function Empty({ Icon, label, where }: { Icon: typeof Calendar; label: string; where: string }) {
  return (
    <div className="grid flex-1 place-items-center px-5 py-12 text-center">
      <div>
        <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary"><Icon className="h-5 w-5" /></div>
        <p className="text-sm font-semibold text-foreground">No {label} yet</p>
        <p className="mx-auto mt-1 max-w-[280px] text-xs text-muted-foreground">Add your first one above — it’ll show up wherever it’s {where}.</p>
      </div>
    </div>
  );
}

// A plain name-list catalog (Departments, Titles): add bar + tight rows with
// hover-delete + empty state.
function SimpleCatalog({
  q, value, setValue, onSubmit, pending, placeholder, emptyLabel, where, onRemove,
}: {
  q: { data?: { id: number; name: string }[]; isLoading: boolean };
  value: string;
  setValue: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  pending: boolean;
  placeholder: string;
  emptyLabel: string;
  where: string;
  onRemove: (id: number, name: string) => void;
}) {
  const rows = q.data ?? [];
  return (
    <>
      <form onSubmit={onSubmit} className="flex items-center gap-2 border-b border-border bg-primary/[0.04] px-5 py-2.5">
        <Plus className="h-4 w-4 shrink-0 text-primary" />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <button type="submit" disabled={pending || !value.trim()} className="shrink-0 rounded-lg bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-45">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add'}
        </button>
      </form>
      {q.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty Icon={Tags} label={emptyLabel} where={where} />
      ) : (
        <div className="divide-y divide-border">
          {rows.map((r) => (
            <div key={r.id} className="group flex items-center gap-2.5 px-5 hover:bg-primary/[0.04]" style={{ minHeight: 38 }}>
              <span className="text-sm text-foreground/90">{r.name}</span>
              <span className="flex-1" />
              <button
                type="button"
                aria-label={`Remove ${r.name}`}
                title={`Remove ${r.name}`}
                onClick={() => onRemove(r.id, r.name)}
                className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground opacity-0 transition-opacity hover:bg-rose-500/10 hover:text-rose-500 group-hover:opacity-100"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
