import { useEffect, useState } from 'react';

import { Button, Input, Modal } from '@/components/ui';
import type { WidgetInstance } from '@/types/customDashboard';
import { KPI_METRICS, CHART_SOURCES, TABLE_SOURCES, WIDGET_REGISTRY, defaultWidgetTitle } from './widgets';

// Configure a placed widget IN PLACE: its title, and (for kpi/chart/table) the
// metric / source / table it shows. config-less types (health/evm/revrec/...)
// only expose the title. Returns the updated widget to the parent.

const selectClass =
  'h-9 w-full rounded-full border border-border bg-transparent px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

export function WidgetConfigModal({ widget, onClose, onSave }: {
  widget: WidgetInstance | null;
  onClose: () => void;
  onSave: (w: WidgetInstance) => void;
}) {
  const [title, setTitle] = useState('');
  const [metric, setMetric] = useState(KPI_METRICS[0].key);
  const [source, setSource] = useState(CHART_SOURCES[0].key);
  const [table, setTable] = useState(TABLE_SOURCES[0].key);
  // Whether the user has overridden the title (else it tracks the metric/source).
  const [titleTouched, setTitleTouched] = useState(false);

  useEffect(() => {
    if (!widget) return;
    setTitle(widget.title ?? '');
    setTitleTouched(true); // keep an existing title as-is until changed
    setMetric((widget.config?.metric as string) ?? KPI_METRICS[0].key);
    setSource((widget.config?.source as string) ?? CHART_SOURCES[0].key);
    setTable((widget.config?.table as string) ?? TABLE_SOURCES[0].key);
  }, [widget]);

  if (!widget) return null;
  const meta = WIDGET_REGISTRY[widget.type];

  const nextConfig = widget.type === 'kpi' ? { metric }
    : widget.type === 'chart' ? { source }
      : widget.type === 'table' ? { table }
        : (widget.config ?? {});
  // Auto title (when the user hasn't typed their own) reflects the selection.
  const autoTitle = defaultWidgetTitle(widget.type, nextConfig);
  const effectiveTitle = titleTouched && title.trim() ? title.trim() : autoTitle;

  const save = () => { onSave({ ...widget, title: effectiveTitle, config: nextConfig }); onClose(); };

  return (
    <Modal open={!!widget} onClose={onClose} title={`Configure ${meta?.label ?? 'widget'}`} className="max-w-md" flushBottom>
      <div className="space-y-4">
        {widget.type === 'kpi' ? (
          <Field label="Metric">
            <select value={metric} onChange={(e) => { setMetric(e.target.value); setTitleTouched(false); }} className={selectClass}>
              {KPI_METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </Field>
        ) : widget.type === 'chart' ? (
          <Field label="Chart">
            <select value={source} onChange={(e) => { setSource(e.target.value); setTitleTouched(false); }} className={selectClass}>
              {CHART_SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </Field>
        ) : widget.type === 'table' ? (
          <Field label="Table">
            <select value={table} onChange={(e) => { setTable(e.target.value); setTitleTouched(false); }} className={selectClass}>
              {TABLE_SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </Field>
        ) : null}

        <Field label="Title">
          <Input value={titleTouched ? title : autoTitle} onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }} placeholder={autoTitle} />
        </Field>

        <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" onClick={save}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[13px] font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
