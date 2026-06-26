import { useEffect, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';

import { Modal, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useClearHealthOverride, useHealthConfig, useSaveHealthConfig } from '@/hooks/useDashboard';
import type { HealthConfigBody } from '@/types/dashboard';

// Lets a manager tune HOW project health is classified. Two scopes:
//   • Workspace default — the shared baseline for the whole workspace.
//   • My override       — this manager's personal thresholds, which win for
//                         their own views when set.
// Each rule group (budget / schedule / margin) can be switched off so a team
// can judge health on, say, budget alone.

type Scope = 'workspace' | 'override';

const FALLBACK: HealthConfigBody = {
  budget_enabled: true, over_budget_pct: 100, high_burn_pct: 80,
  schedule_enabled: true, ending_soon_days: 7, overdue_days: 30,
  margin_enabled: false, low_margin_pct: 15,
};

export function HealthRulesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const q = useHealthConfig(open);
  const save = useSaveHealthConfig();
  const clear = useClearHealthOverride();

  const [scope, setScope] = useState<Scope>('override');
  const [form, setForm] = useState<HealthConfigBody>(FALLBACK);

  // Load the values for the active scope whenever it (or the data) changes.
  useEffect(() => {
    if (!q.data) return;
    const src = scope === 'override' ? (q.data.override ?? q.data.workspace) : q.data.workspace;
    setForm(src);
  }, [q.data, scope]);

  const set = <K extends keyof HealthConfigBody>(k: K, v: HealthConfigBody[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const onSave = async () => {
    await save.mutateAsync({ scope, body: form });
    onClose();
  };
  const onResetOverride = async () => {
    await clear.mutateAsync();
    setScope('workspace');
  };

  const hasOverride = !!q.data?.override;

  return (
    <Modal open={open} onClose={onClose} title="Project health rules" className="max-w-lg" flushBottom>
      <div className="space-y-4 pb-4">
        <p className="text-xs text-muted-foreground">
          Decide how projects are flagged <span className="font-medium text-rose-600 dark:text-rose-400">needs attention</span>,{' '}
          <span className="font-medium text-amber-600 dark:text-amber-400">at risk</span> or{' '}
          <span className="font-medium text-emerald-600 dark:text-emerald-400">good</span>. These rules drive the health pills across Insights and the dashboard.
        </p>

        {/* Scope switch */}
        <div className="inline-flex rounded-lg border border-border p-0.5 text-xs">
          {(['override', 'workspace'] as Scope[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={cn(
                'rounded-md px-3 py-1.5 font-medium transition-colors',
                scope === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {s === 'override' ? 'My rules' : 'Workspace default'}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {scope === 'override'
            ? hasOverride
              ? 'Your personal rules. These override the workspace default for your own views.'
              : 'No personal rules yet — saving here creates an override on top of the workspace default.'
            : 'The shared baseline for everyone in the workspace.'}
        </p>

        {q.isLoading ? (
          <div className="grid place-items-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <div className="space-y-3">
            <RuleGroup
              title="Budget"
              hint="Flag on how much of the dollar budget the approved revenue has consumed."
              enabled={form.budget_enabled}
              onToggle={(v) => set('budget_enabled', v)}
            >
              <NumField label="Needs attention above" suffix="% of budget" value={form.over_budget_pct} onChange={(v) => set('over_budget_pct', v)} tone="rose" />
              <NumField label="At risk above" suffix="% of budget" value={form.high_burn_pct} onChange={(v) => set('high_burn_pct', v)} tone="amber" />
            </RuleGroup>

            <RuleGroup
              title="Schedule"
              hint="Flag on how close the project is to (or past) its end date."
              enabled={form.schedule_enabled}
              onToggle={(v) => set('schedule_enabled', v)}
            >
              <NumField label="At risk within" suffix="days of end" value={form.ending_soon_days} onChange={(v) => set('ending_soon_days', v)} tone="amber" />
              <NumField label="Needs attention when overdue by" suffix="days" value={form.overdue_days} onChange={(v) => set('overdue_days', v)} tone="rose" />
            </RuleGroup>

            <RuleGroup
              title="Margin"
              hint="Optional: flag thin-margin projects even when budget and schedule look fine."
              enabled={form.margin_enabled}
              onToggle={(v) => set('margin_enabled', v)}
            >
              <NumField label="At risk when margin below" suffix="%" value={form.low_margin_pct} onChange={(v) => set('low_margin_pct', v)} tone="amber" />
            </RuleGroup>
          </div>
        )}

        {/* Footer */}
        <div className="sticky bottom-0 -mx-4 flex items-center justify-between gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          {scope === 'override' && hasOverride ? (
            <button
              type="button"
              onClick={onResetOverride}
              disabled={clear.isPending}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Use workspace default
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">Cancel</button>
            <button
              type="button"
              onClick={onSave}
              disabled={save.isPending || q.isLoading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {scope === 'override' ? 'Save my rules' : 'Save workspace default'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function RuleGroup({
  title, hint, enabled, onToggle, children,
}: {
  title: string; hint: string; enabled: boolean; onToggle: (v: boolean) => void; children: React.ReactNode;
}) {
  return (
    <div className={cn('rounded-xl border border-border p-3 transition-opacity', !enabled && 'opacity-60')}>
      <div className="flex items-center justify-between">
        <Tooltip label={hint} side="top" maxWidth={260}>
          <span className="cursor-help text-sm font-semibold text-foreground">{title}</span>
        </Tooltip>
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} className="accent-primary" />
          {enabled ? 'On' : 'Off'}
        </label>
      </div>
      <div className={cn('mt-3 grid gap-3 sm:grid-cols-2', !enabled && 'pointer-events-none')}>{children}</div>
    </div>
  );
}

function NumField({
  label, suffix, value, onChange, tone,
}: {
  label: string; suffix: string; value: number; onChange: (v: number) => void; tone: 'rose' | 'amber';
}) {
  const dot = tone === 'rose' ? 'bg-rose-500' : 'bg-amber-500';
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
        {label}
      </span>
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-20 rounded-lg border border-border bg-background px-2 py-1 text-sm tabular-nums text-foreground focus:border-primary focus:outline-none"
        />
        <span className="text-[11px] text-muted-foreground">{suffix}</span>
      </span>
    </label>
  );
}
