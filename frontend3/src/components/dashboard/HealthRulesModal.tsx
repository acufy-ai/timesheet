import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Modal, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useHealthConfig, useSaveHealthConfig } from '@/hooks/useDashboard';
import type { HealthConfigBody } from '@/types/dashboard';

// Lets a manager tune HOW project health is classified. One shared config for
// the whole workspace (persisted on the workspace scope). Each rule group
// (budget / schedule / margin) can be switched off so a team can judge health
// on, say, budget alone.

const FALLBACK: HealthConfigBody = {
  budget_enabled: true, over_budget_pct: 100, high_burn_pct: 80, excellent_under_pct: 50,
  schedule_enabled: true, ending_soon_days: 7, overdue_days: 30,
  margin_enabled: false, low_margin_pct: 15,
};

export function HealthRulesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const q = useHealthConfig(open);
  const save = useSaveHealthConfig();

  const [form, setForm] = useState<HealthConfigBody>(FALLBACK);

  // One shared config for the whole workspace — load it whenever data changes.
  useEffect(() => {
    if (!q.data) return;
    setForm(q.data.workspace);
  }, [q.data]);

  const set = <K extends keyof HealthConfigBody>(k: K, v: HealthConfigBody[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const onSave = async () => {
    await save.mutateAsync({ scope: 'workspace', body: form });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Project Health" className="max-w-3xl" flushBottom>
      <div className="space-y-5 pb-4">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Decide how projects are flagged <span className="font-semibold text-rose-600 dark:text-rose-400">critical</span>,{' '}
          <span className="font-semibold text-amber-600 dark:text-amber-400">at risk</span>,{' '}
          <span className="font-semibold text-sky-600 dark:text-sky-400">on track</span> or{' '}
          <span className="font-semibold text-emerald-600 dark:text-emerald-400">excellent</span>. These rules apply across the whole workspace and drive the health pills throughout Insights and the dashboard. (Blocked is set automatically when a project has a blocked task.)
        </p>

        {q.isLoading ? (
          <div className="grid place-items-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <div className="space-y-4">
            <RuleGroup
              title="Budget"
              hint="Flag on how much of the dollar budget the approved revenue has consumed."
              enabled={form.budget_enabled}
              onToggle={(v) => set('budget_enabled', v)}
            >
              <NumRow label="Critical above" suffix="% of budget" value={form.over_budget_pct} onChange={(v) => set('over_budget_pct', v)} tone="rose" />
              <NumRow label="At risk above" suffix="% of budget" value={form.high_burn_pct} onChange={(v) => set('high_burn_pct', v)} tone="amber" />
              <NumRow label="Excellent below" suffix="% of budget" value={form.excellent_under_pct} onChange={(v) => set('excellent_under_pct', v)} tone="emerald" />
            </RuleGroup>

            <RuleGroup
              title="Schedule"
              hint="Flag on how close the project is to (or past) its end date."
              enabled={form.schedule_enabled}
              onToggle={(v) => set('schedule_enabled', v)}
            >
              <NumRow label="At risk within" suffix="days of end" value={form.ending_soon_days} onChange={(v) => set('ending_soon_days', v)} tone="amber" />
              <NumRow label="Critical when overdue by" suffix="days" value={form.overdue_days} onChange={(v) => set('overdue_days', v)} tone="rose" />
            </RuleGroup>

            <RuleGroup
              title="Margin"
              hint="Optional: flag thin-margin projects even when budget and schedule look fine."
              enabled={form.margin_enabled}
              onToggle={(v) => set('margin_enabled', v)}
            >
              <NumRow label="At risk when margin below" suffix="%" value={form.low_margin_pct} onChange={(v) => set('low_margin_pct', v)} tone="amber" />
            </RuleGroup>
          </div>
        )}

        {/* Footer */}
        <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground">Cancel</button>
          <button
            type="button"
            onClick={onSave}
            disabled={save.isPending || q.isLoading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save rules
          </button>
        </div>
      </div>
    </Modal>
  );
}

// A rule group rendered as a titled table: each row is (rule name | threshold |
// unit). Larger type + a real table so the thresholds line up and read clearly.
function RuleGroup({
  title, hint, enabled, onToggle, children,
}: {
  title: string; hint: string; enabled: boolean; onToggle: (v: boolean) => void; children: React.ReactNode;
}) {
  return (
    <div className={cn('overflow-hidden rounded-xl border border-border transition-opacity', !enabled && 'opacity-60')}>
      <div className="flex items-center justify-between border-b border-border bg-foreground/[0.03] px-4 py-2.5">
        <Tooltip label={hint} side="top" maxWidth={280}>
          <span className="cursor-help text-base font-semibold text-foreground">{title}</span>
        </Tooltip>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} className="h-4 w-4 accent-primary" />
          {enabled ? 'On' : 'Off'}
        </label>
      </div>
      <table className={cn('w-full text-sm', !enabled && 'pointer-events-none')}>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// One rule row: colored dot + label on the left, the threshold input and its
// unit right-aligned. Table row so every group's thresholds line up.
function NumRow({
  label, suffix, value, onChange, tone,
}: {
  label: string; suffix: string; value: number; onChange: (v: number) => void; tone: 'rose' | 'amber' | 'emerald';
}) {
  const dot = tone === 'rose' ? 'bg-rose-500' : tone === 'emerald' ? 'bg-emerald-500' : 'bg-amber-500';
  return (
    <tr className="border-b border-border/60 last:border-b-0">
      <td className="px-4 py-3">
        <span className="flex items-center gap-2 text-[15px] text-foreground">
          <span className={cn('h-2 w-2 rounded-full', dot)} />
          {label}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        <span className="inline-flex items-center gap-2">
          <input
            type="number"
            value={Number.isFinite(value) ? value : 0}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-24 rounded-lg border border-border bg-background px-3 py-2 text-right text-[15px] tabular-nums text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <span className="w-24 text-left text-sm text-muted-foreground">{suffix}</span>
        </span>
      </td>
    </tr>
  );
}
