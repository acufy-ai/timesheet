import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, Search, Share2, Trash2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { CustomDashboard } from '@/types/customDashboard';

// Compact dashboard picker for the Insights toolbar. Replaces the old left rail
// so widgets get the full width. Shows the current dashboard as a button; the
// menu lists all dashboards with a search box, a shared indicator, and a
// per-row delete (owner only), plus "New dashboard".
export function DashboardSwitcher({
  dashboards, selectedId, onSelect, onNew, onDelete, onRename,
}: {
  dashboards: CustomDashboard[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
  onDelete: (d: CustomDashboard) => void;
  // When provided (owner), the current dashboard can be renamed from the menu.
  onRename?: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [rename, setRename] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const selected = dashboards.find((d) => d.id === selectedId) ?? null;

  // Seed the rename field from the current dashboard whenever the menu opens or
  // the selection changes (kept local so typing stays smooth).
  useEffect(() => { setRename(selected?.name ?? ''); }, [selected?.id, selected?.name, open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  useEffect(() => { if (!open) setQ(''); }, [open]);

  const term = q.trim().toLowerCase();
  const filtered = term ? dashboards.filter((d) => d.name.toLowerCase().includes(term)) : dashboards;

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 min-w-[180px] items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm font-semibold text-foreground transition-colors hover:border-primary/40">
        <span className="min-w-0 flex-1 truncate text-left">{selected?.name ?? 'Select dashboard'}</span>
        {selected?.share_token ? <Share2 className="h-3.5 w-3.5 shrink-0 text-primary" aria-label="Shared" /> : null}
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1.5 w-72 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          {onRename && selected ? (
            <div className="border-b border-border p-2">
              <label className="mb-1 block px-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Name</label>
              <input value={rename} onChange={(e) => { setRename(e.target.value); onRename(e.target.value); }} aria-label="Rename dashboard"
                className="h-8 w-full rounded-lg border border-border bg-transparent px-2 text-sm font-semibold text-foreground focus:border-primary focus:outline-none" />
            </div>
          ) : null}
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dashboards"
                className="h-8 w-full rounded-lg border border-border bg-transparent pl-8 pr-2 text-xs text-foreground focus:border-primary focus:outline-none" />
            </div>
          </div>
          <ul className="max-h-72 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <li className="px-2 py-3 text-center text-xs text-muted-foreground">No matches.</li>
            ) : filtered.map((d) => (
              <li key={d.id}
                className={cn('group flex items-center gap-1 rounded-lg pr-1', d.id === selectedId ? 'bg-primary/10' : 'hover:bg-primary/5')}>
                <button type="button" onClick={() => { onSelect(d.id); setOpen(false); }}
                  className={cn('flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm',
                    d.id === selectedId ? 'text-foreground' : 'text-muted-foreground')}>
                  {d.id === selectedId ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : <span className="w-3.5 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  {d.share_token ? <Share2 className="h-3 w-3 shrink-0 text-primary" aria-label="Shared via link" /> : null}
                </button>
                {d.is_owner ? (
                  <button type="button" onClick={() => onDelete(d)} title="Delete dashboard"
                    className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:bg-rose-500/10 hover:text-rose-600 group-hover:opacity-100">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="border-t border-border p-1">
            <button type="button" onClick={() => { onNew(); setOpen(false); }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-primary hover:bg-primary/10">
              <Plus className="h-4 w-4" /> New dashboard
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
