import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';

import { Button, Input, Modal, FieldError } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { CustomDashboardBody } from '@/types/customDashboard';
import type { WidgetInstance, WidgetType } from '@/types/customDashboard';
import {
  WIDGET_REGISTRY, WIDGET_TYPE_ORDER, WIDGET_DESC, KPI_METRICS, CHART_SOURCES, TABLE_SOURCES, makeWidget,
} from './widgets';

// Create a dashboard in ONE dialog: name it AND add starter widgets. The picker
// stages widgets into a list before the dashboard is created, so you don't make
// an empty dashboard and then go hunting for "add widget".

const selectClass =
  'h-9 w-full rounded-full border border-border bg-transparent px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

export function NewDashboardModal({ open, onClose, onCreate }: {
  open: boolean;
  onClose: () => void;
  onCreate: (payload: CustomDashboardBody) => Promise<void> | void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [staged, setStaged] = useState<WidgetInstance[]>([]);
  const [busy, setBusy] = useState(false);
  // Picker state.
  const [type, setType] = useState<WidgetType>('kpi');
  const [metric, setMetric] = useState(KPI_METRICS[0].key);
  const [source, setSource] = useState(CHART_SOURCES[0].key);
  const [table, setTable] = useState(TABLE_SOURCES[0].key);

  useEffect(() => {
    if (!open) return;
    setName(''); setError(''); setStaged([]); setBusy(false);
    setType('kpi'); setMetric(KPI_METRICS[0].key); setSource(CHART_SOURCES[0].key); setTable(TABLE_SOURCES[0].key);
  }, [open]);

  const addWidget = () => setStaged((s) => [...s, makeWidget(type, { metric, source, table })]);
  const removeStaged = (id: string) => setStaged((s) => s.filter((w) => w.id !== id));

  const create = async () => {
    if (!name.trim()) { setError('Give the dashboard a name.'); return; }
    setBusy(true);
    try {
      await onCreate({ name: name.trim(), layout: staged });
      onClose();
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="New dashboard" className="max-w-xl" flushBottom>
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Name</label>
          <Input value={name} onChange={(e) => { setName(e.target.value); setError(''); }} placeholder="e.g. Exec overview" autoFocus />
          <FieldError error={error} />
        </div>

        {/* Widget picker — add as many as you like before creating. */}
        <div className="rounded-2xl border border-border p-3">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Add widgets</p>
          <div className="mb-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {WIDGET_TYPE_ORDER.map((t) => (
              <button key={t} type="button" onClick={() => setType(t)}
                className={cn('rounded-lg border px-2 py-1.5 text-left text-[12px] transition-colors',
                  type === t ? 'border-primary bg-primary/5 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
                {WIDGET_REGISTRY[t].label}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              {type === 'kpi' ? (
                <select value={metric} onChange={(e) => setMetric(e.target.value)} className={selectClass}>
                  {KPI_METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
              ) : type === 'chart' ? (
                <select value={source} onChange={(e) => setSource(e.target.value)} className={selectClass}>
                  {CHART_SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              ) : type === 'table' ? (
                <select value={table} onChange={(e) => setTable(e.target.value)} className={selectClass}>
                  {TABLE_SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              ) : (
                <p className="text-[12px] text-muted-foreground">{WIDGET_DESC[type]}</p>
              )}
            </div>
            <Button type="button" size="sm" variant="secondary" onClick={addWidget}><Plus className="h-3.5 w-3.5" /> Add</Button>
          </div>

          {staged.length ? (
            <ul className="mt-3 space-y-1">
              {staged.map((w) => (
                <li key={w.id} className="flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5 text-[12px]">
                  <span className="min-w-0 flex-1 truncate text-foreground">{w.title}</span>
                  <span className="shrink-0 text-[10px] uppercase text-muted-foreground">{WIDGET_REGISTRY[w.type].label}</span>
                  <button type="button" onClick={() => removeStaged(w.id)} className="text-muted-foreground hover:text-rose-600" aria-label="Remove">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[12px] italic text-muted-foreground">No widgets added yet. You can add more later too.</p>
          )}
        </div>

        <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" onClick={create} disabled={busy}>
            {busy ? 'Creating…' : `Create dashboard${staged.length ? ` (${staged.length})` : ''}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
