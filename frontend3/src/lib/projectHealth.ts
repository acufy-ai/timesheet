import type { Tone } from '@/components/ui';

// Single source of truth for the five-tier project-health model. The backend
// classifier (_classify_health) emits these kebab-case values; every pill,
// legend, sort, and CSV export reads label/tone/dot/text/rank from here so the
// five tiers stay consistent across the dashboard widget, the portfolio tab,
// and the project report. (Replaces three duplicated HEALTH_META maps.)
//
// Severity worst -> best: critical -> blocked -> at-risk -> on-track ->
// excellent -> not-set. Lower `rank` = more urgent (used for sorting).

export type ProjectHealth =
  | 'excellent'
  | 'on-track'
  | 'at-risk'
  | 'critical'
  | 'blocked'
  | 'not-set'
  | 'not-started';

export interface HealthMeta {
  label: string;
  tone: Tone;           // drives the TonePill / StatusBadge color
  dot: string;          // tailwind bg-* for legend dots
  text: string;         // tailwind text-* for inline colored figures
  rank: number;         // severity sort key (lower = more urgent)
}

export const HEALTH_META: Record<ProjectHealth, HealthMeta> = {
  critical: {
    label: 'Critical', tone: 'danger', rank: 0,
    dot: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400',
  },
  blocked: {
    label: 'Blocked', tone: 'brand', rank: 1,
    dot: 'bg-primary', text: 'text-primary',
  },
  'at-risk': {
    label: 'At risk', tone: 'warning', rank: 2,
    dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400',
  },
  'on-track': {
    label: 'On track', tone: 'info', rank: 3,
    dot: 'bg-sky-500', text: 'text-sky-600 dark:text-sky-400',
  },
  excellent: {
    label: 'Excellent', tone: 'success', rank: 4,
    dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400',
  },
  'not-set': {
    label: 'Not set', tone: 'neutral', rank: 5,
    dot: 'bg-muted-foreground/40', text: 'text-muted-foreground',
  },
  // No time logged yet. Distinct from 'not-set' (which is "has data but no
  // budget/dates to assess"). Quiet grey, ranked last (not urgent).
  'not-started': {
    label: 'Not started', tone: 'neutral', rank: 6,
    dot: 'bg-muted-foreground/30', text: 'text-muted-foreground',
  },
};

export function healthMeta(health: string): HealthMeta {
  return HEALTH_META[(health as ProjectHealth)] ?? HEALTH_META['not-set'];
}

// The tiers a manager may set as a manual override. 'blocked' is auto-derived
// from tasks and 'not-set' means "no data", so neither is offered.
export const MANUAL_HEALTH: Array<{ value: ProjectHealth; label: string }> = [
  { value: 'excellent', label: 'Excellent' },
  { value: 'on-track', label: 'On track' },
  { value: 'at-risk', label: 'At risk' },
  { value: 'critical', label: 'Critical' },
];
