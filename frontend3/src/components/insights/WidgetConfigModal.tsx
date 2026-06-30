import { useEffect, useState } from 'react';

import { Button, Input, Modal } from '@/components/ui';
import type { WidgetInstance, WidgetScope } from '@/types/customDashboard';
import { KPI_METRICS, CHART_SOURCES, TABLE_SOURCES, WIDGET_REGISTRY, defaultWidgetTitle, chartKindsFor, HEALTH_VIEWS, type ChartKind, type HealthView } from './widgets';
import { ScopePicker } from './ScopePicker';

const CHART_KIND_LABEL: Record<ChartKind, string> = {
  bar: 'Bars', column: 'Columns', donut: 'Donut', pie: 'Pie', line: 'Line',
};

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
  const [chartKind, setChartKind] = useState<ChartKind>('bar');
  const [healthView, setHealthView] = useState<HealthView>('cards');
  const [table, setTable] = useState(TABLE_SOURCES[0].key);
  const [scope, setScope] = useState<WidgetScope>({});
  // Whether the user has overridden the title (else it tracks the metric/source).
  const [titleTouched, setTitleTouched] = useState(false);

  useEffect(() => {
    if (!widget) return;
    setTitle(widget.title ?? '');
    setTitleTouched(true); // keep an existing title as-is until changed
    setMetric((widget.config?.metric as string) ?? KPI_METRICS[0].key);
    setSource((widget.config?.source as string) ?? CHART_SOURCES[0].key);
    setChartKind((widget.config?.chartKind as ChartKind) ?? chartKindsFor(widget.config?.source as string)[0]);
    setHealthView((widget.config?.view as HealthView) ?? 'cards');
    setTable((widget.config?.table as string) ?? TABLE_SOURCES[0].key);
    setScope((widget.config?.scope as WidgetScope) ?? {});
  }, [widget]);

  if (!widget) return null;
  const meta = WIDGET_REGISTRY[widget.type];

  const scopeHasAny = (scope.clientIds?.length || scope.projectIds?.length || scope.clientId || scope.projectId || scope.taskId || scope.userId);
  const scopeClean = scopeHasAny ? scope : undefined;
  const base = widget.type === 'kpi' ? { metric }
    : widget.type === 'chart' ? { source, chartKind }
      : widget.type === 'table' ? { table }
        : widget.type === 'health' ? { view: healthView }
          : {};
  const nextConfig = { ...base, ...(scopeClean ? { scope: scopeClean } : {}) };
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
          <>
            <Field label="Data">
              <select value={source}
                onChange={(e) => {
                  const next = e.target.value;
                  setSource(next); setTitleTouched(false);
                  // Keep the chart kind valid for the new data source.
                  const allowed = chartKindsFor(next);
                  if (!allowed.includes(chartKind)) setChartKind(allowed[0]);
                }}
                className={selectClass}>
                {CHART_SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="Chart type">
              <div className="inline-flex rounded-lg border border-border p-0.5">
                {chartKindsFor(source).map((k) => (
                  <button key={k} type="button" onClick={() => setChartKind(k)}
                    className={`rounded-md px-3 py-1 text-[12px] font-medium transition-colors ${chartKind === k
                      ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                    {CHART_KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </Field>
          </>
        ) : widget.type === 'table' ? (
          <Field label="Table">
            <select value={table} onChange={(e) => { setTable(e.target.value); setTitleTouched(false); }} className={selectClass}>
              {TABLE_SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </Field>
        ) : widget.type === 'health' ? (
          <Field label="View">
            <div className="inline-flex rounded-lg border border-border p-0.5">
              {HEALTH_VIEWS.map((v) => (
                <button key={v.key} type="button" onClick={() => setHealthView(v.key)}
                  className={`rounded-md px-3 py-1 text-[12px] font-medium transition-colors ${healthView === v.key
                    ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                  {v.label}
                </button>
              ))}
            </div>
          </Field>
        ) : null}

        <ScopePicker type={widget.type} scope={scope} onChange={(s) => { setScope(s); setTitleTouched(false); }} />

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
