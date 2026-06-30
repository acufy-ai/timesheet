import { useEffect, useState } from 'react';

import { Button, Modal } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { WidgetInstance, WidgetScope, WidgetType } from '@/types/customDashboard';
import { WIDGET_REGISTRY, KPI_METRICS, CHART_SOURCES, TABLE_SOURCES, WIDGET_TYPE_ORDER, WIDGET_DESC, makeWidget } from './widgets';
import { ScopePicker } from './ScopePicker';

// Pick a widget type, its metric/source, AND its scope — the widget is fully
// configured here, before it's placed. Returns a finished WidgetInstance.

const TYPE_ORDER = WIDGET_TYPE_ORDER;

export function WidgetLibrary({ open, onClose, onAdd }: {
  open: boolean;
  onClose: () => void;
  onAdd: (w: WidgetInstance) => void;
}) {
  const [type, setType] = useState<WidgetType>('kpi');
  const [metric, setMetric] = useState(KPI_METRICS[0].key);
  const [source, setSource] = useState(CHART_SOURCES[0].key);
  const [table, setTable] = useState(TABLE_SOURCES[0].key);
  const [scope, setScope] = useState<WidgetScope>({});

  // Reset everything when the dialog reopens.
  useEffect(() => {
    if (!open) return;
    setType('kpi'); setMetric(KPI_METRICS[0].key); setSource(CHART_SOURCES[0].key);
    setTable(TABLE_SOURCES[0].key); setScope({});
  }, [open]);

  const add = () => {
    onAdd(makeWidget(type, { metric, source, table, scope }));
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Add widget" className="max-w-lg" flushBottom>
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Widget type</label>
          <div className="grid grid-cols-2 gap-2">
            {TYPE_ORDER.map((t) => (
              <button key={t} type="button" onClick={() => { setType(t); setScope({}); }}
                className={cn('rounded-xl border px-3 py-2 text-left text-sm transition-colors',
                  type === t ? 'border-primary bg-primary/5 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
                <span className="font-medium">{WIDGET_REGISTRY[t].label}</span>
              </button>
            ))}
          </div>
        </div>

        {type === 'kpi' ? (
          <Field label="Metric">
            <select value={metric} onChange={(e) => setMetric(e.target.value)} className={selectClass}>
              {KPI_METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </Field>
        ) : type === 'chart' ? (
          <Field label="Chart">
            <select value={source} onChange={(e) => setSource(e.target.value)} className={selectClass}>
              {CHART_SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </Field>
        ) : type === 'table' ? (
          <Field label="Table">
            <select value={table} onChange={(e) => setTable(e.target.value)} className={selectClass}>
              {TABLE_SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </Field>
        ) : (
          <p className="text-[13px] text-muted-foreground">{WIDGET_DESC[type] ?? 'Adds this widget with its default configuration.'}</p>
        )}

        <ScopePicker type={type} scope={scope} onChange={setScope} />

        <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" onClick={add}>Add to dashboard</Button>
        </div>
      </div>
    </Modal>
  );
}

const selectClass =
  'h-9 w-full rounded-full border border-border bg-transparent px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[13px] font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
