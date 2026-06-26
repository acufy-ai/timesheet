import { cn } from '@/lib/cn';
import type { HealthConfigBody } from '@/types/dashboard';

// Structured tooltip content for metric help. Three content shapes, because the
// glossary has three kinds of explanation and prose flattens them:
//   • lead     — one plain sentence: what the metric is.
//   • formula  — how it's computed, set in mono so it reads as math, not prose.
//   • legend   — state → condition rows with a colored dot, so a tooltip that
//                explains a status pill becomes a live key for it.
// A plain string label stays a plain string elsewhere; RichTip is opt-in for the
// entries that actually carry structure (health, risk, the EVM/financial ratios).

type Dot = 'rose' | 'amber' | 'emerald' | 'sky' | 'muted';

export interface RichTipSpec {
  lead: string;
  formula?: string;
  legend?: { dot: Dot; label: string; cond: string }[];
}

const DOT: Record<Dot, string> = {
  rose: 'bg-rose-500',
  amber: 'bg-amber-500',
  emerald: 'bg-emerald-500',
  sky: 'bg-sky-500',
  muted: 'bg-muted-foreground/40',
};

export function RichTip({ lead, formula, legend }: RichTipSpec) {
  return (
    <span className="block space-y-2">
      <span className="block text-popover-foreground">{lead}</span>

      {formula ? (
        <span className="block rounded bg-foreground/[0.05] px-1.5 py-1 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {formula}
        </span>
      ) : null}

      {legend ? (
        <span className="block space-y-1">
          {legend.map((row) => (
            <span key={row.label} className="flex items-baseline gap-1.5">
              <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', DOT[row.dot])} />
              <span className="leading-snug">
                <span className="font-semibold text-popover-foreground">{row.label}</span>
                <span className="text-muted-foreground"> — {row.cond}</span>
              </span>
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

// Strip a trailing .00 so 100.00 -> 100, but keep 12.5.
function num(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

const plural = (n: number) => (n === 1 ? '' : 's');

// Build the Health legend from the resolved config (override -> workspace),
// mirroring the backend _classify_health rules so the tooltip always matches
// the pills it explains. Honors each enable flag and the margin rule.
export function healthLegendFromConfig(cfg: HealthConfigBody): RichTipSpec['legend'] {
  const needs: string[] = [];
  const risk: string[] = [];

  if (cfg.budget_enabled) {
    needs.push(`over ${num(cfg.over_budget_pct)}% of budget`);
    risk.push(`over ${num(cfg.high_burn_pct)}% of budget`);
  }
  if (cfg.schedule_enabled) {
    needs.push(`${num(cfg.overdue_days)}+ day${plural(cfg.overdue_days)} overdue`);
    risk.push(`${num(cfg.ending_soon_days)} day${plural(cfg.ending_soon_days)} or less to the end date`);
  }
  if (cfg.margin_enabled) {
    risk.push(`margin below ${num(cfg.low_margin_pct)}%`);
  }

  const join = (parts: string[]) => parts.join(', or ');
  const legend: NonNullable<RichTipSpec['legend']> = [];
  if (needs.length) legend.push({ dot: 'rose', label: 'Needs attention', cond: join(needs) });
  if (risk.length) legend.push({ dot: 'amber', label: 'At risk', cond: join(risk) });
  legend.push({ dot: 'emerald', label: 'Good', cond: 'none of the above' });
  legend.push({ dot: 'muted', label: 'Not set', cond: 'no budget and no end date' });
  return legend;
}
