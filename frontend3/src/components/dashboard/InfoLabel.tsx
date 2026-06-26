import { Info } from 'lucide-react';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { RichTip, healthLegendFromConfig, type RichTipSpec } from './RichTip';
import { useHealthConfig } from '@/hooks/useDashboard';

// Plain-English glossary for the manager-dashboard metrics. Keys are matched
// case-insensitively against the label text so callers can pass the label they
// already render (e.g. "Utilization", "Budget burn").
//
// A value is either a plain string (simple one-line definition) or a RichTipSpec
// (a lead line + optional `formula` + optional state legend) for the entries
// that actually carry structure — classification rules and computed ratios were
// unreadable crammed into a single paragraph.
const GLOSSARY: Record<string, string | RichTipSpec> = {
  revenue: { lead: 'Money earned from approved billable time. Only approved time counts.', formula: 'billable hours × resolved rate' },
  'approved hours': 'Hours from time entries that have been approved. Drafts and submitted-but-unapproved time are not counted.',
  approved: 'Hours from time entries that have been approved. Drafts and submitted-but-unapproved time are not counted.',
  billable: 'Of the approved hours, the share marked billable — the hours that earn revenue.',
  utilization: { lead: 'Share of your team’s available hours that went to billable work. 100% means every available hour was billable.', formula: 'billable hours ÷ available hours' },
  'budget tracked': 'The combined budget of the projects shown here — the denominator behind budget burn.',
  hours: 'Approved hours logged against this project over the period.',
  total: 'This person’s total approved hours across all projects shown, over the period.',
  'budget used': { lead: 'How much of the project’s dollar budget has been earned so far. Over 100% means it has billed past budget.', formula: 'approved revenue ÷ budget' },
  'budget burn': { lead: 'How much of the project’s dollar budget has been earned so far. Over 100% means it has billed past budget.', formula: 'approved revenue ÷ budget' },
  'contract used': { lead: 'How much of the total contract (MSA/SOW) value has been billed so far.', formula: 'approved revenue ÷ contract value' },
  'contract billed': { lead: 'How much of the total contract (MSA/SOW) value has been billed so far.', formula: 'approved revenue ÷ contract value' },
  health: {
    lead: 'How each project is flagged, from budget use and time to its end date.',
    legend: [
      { dot: 'rose', label: 'Needs attention', cond: 'over budget, or 30+ days overdue' },
      { dot: 'amber', label: 'At risk', cond: '7 days or less to the end date, or over 80% of budget used' },
      { dot: 'emerald', label: 'Good', cond: 'on budget and on schedule' },
      { dot: 'muted', label: 'Not set', cond: 'no budget and no end date' },
    ],
  },
  budget: { lead: 'How much of the project’s budget has been earned so far (approved billable time only).', formula: 'approved revenue ÷ budget' },
  'hours this week': 'Approved hours logged against this project during the current week.',
  'team on track': 'Direct reports whose projects are healthy — not at-risk or behind.',
  'approvals pending': 'Weeks of submitted time from your reports that are waiting for your approval.',
  'pto this week': 'Direct reports with approved time off during the current week.',
  'recent rejections': 'Time entries you sent back to a report in the recent window.',
  // PSA financial terms
  margin: { lead: 'Profit as a share of revenue. Cost is each person’s hourly cost × hours.', formula: '(revenue − labour cost) ÷ revenue' },
  cost: { lead: 'What the work costs the firm: every hour worked, billable or not.', formula: 'hourly cost rate × hours' },
  // EVM (earned value) terms
  'planned (pv)': { lead: 'Planned Value — how much of the budget should be earned by now, per the baseline schedule.', formula: 'budget × schedule elapsed %' },
  'earned (ev)': { lead: 'Earned Value — what you’ve actually earned so far.', formula: 'budget × work complete %' },
  'actual (ac)': { lead: 'Actual Cost — the real labour cost incurred to date.', formula: 'sum of cost rate × hours' },
  pv: { lead: 'Planned Value — budget that should be earned by now, per the baseline schedule.', formula: 'budget × schedule elapsed %' },
  ev: { lead: 'Earned Value — the value actually delivered so far.', formula: 'budget × work complete %' },
  ac: { lead: 'Actual Cost — real labour cost incurred to date.', formula: 'sum of cost rate × hours' },
  cpi: {
    lead: 'Cost Performance Index — are you earning more than you’re spending?',
    formula: 'earned ÷ actual',
    legend: [
      { dot: 'emerald', label: 'Above 1', cond: 'under cost' },
      { dot: 'rose', label: 'Below 1', cond: 'over cost' },
    ],
  },
  spi: {
    lead: 'Schedule Performance Index — are you ahead of or behind plan?',
    formula: 'earned ÷ planned',
    legend: [
      { dot: 'emerald', label: 'Above 1', cond: 'ahead of schedule' },
      { dot: 'rose', label: 'Below 1', cond: 'behind schedule' },
    ],
  },
  'forecast (eac)': { lead: 'Estimate at Completion — projected final cost at the current pace. The “+x%” is the projected overrun vs. budget.', formula: 'budget ÷ CPI' },
  eac: { lead: 'Estimate at Completion — projected final cost at the current pace.', formula: 'budget ÷ CPI' },
  risk: {
    lead: 'Where this project is likely to land, from its cost and schedule trend.',
    legend: [
      { dot: 'rose', label: 'High', cond: 'projected to overrun and run late' },
      { dot: 'amber', label: 'Medium', cond: 'one of the two' },
      { dot: 'emerald', label: 'Low', cond: 'forecast within plan' },
    ],
  },
  recognized: 'Revenue recognised per the project’s method: as-billed (hours × rate) or % complete (budget × work done).',
  billed: { lead: 'What has been billed so far.', formula: 'approved billable hours × rate' },
};

export function infoFor(label: string): string | RichTipSpec | undefined {
  return GLOSSARY[label.trim().toLowerCase()];
}

// Plain-text version of a glossary entry, for non-tooltip callers (e.g. a stat
// tile's `info` prop that only takes a string). Flattens a RichTipSpec.
export function infoTextFor(label: string): string | undefined {
  const v = infoFor(label);
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  const parts = [v.lead];
  if (v.formula) parts.push(`(${v.formula})`);
  if (v.legend) parts.push(v.legend.map((r) => `${r.label}: ${r.cond}`).join('; '));
  return parts.join(' ');
}

// A metric label with a small info icon that reveals a plain-English definition
// on hover/focus. Falls back to a plain label when there's no glossary entry.
export function InfoLabel({
  label, side = 'top', className,
}: {
  label: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}) {
  const desc = infoFor(label);
  if (!desc) return <span className={className}>{label}</span>;
  const content = typeof desc === 'string' ? desc : <RichTip {...desc} />;
  return (
    <Tooltip label={content} side={side} maxWidth={typeof desc === 'string' ? 260 : undefined}>
      <span className={cn('inline-flex cursor-help items-center gap-1', className)}>
        {label}
        <Info className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
      </span>
    </Tooltip>
  );
}

// The "Health" column label, but its tooltip is built from the manager's LIVE
// health rules (override → workspace default), so it reflects whatever
// thresholds are actually in effect — including the margin rule and any
// disabled rule group — instead of a hardcoded default. Falls back to the
// static glossary entry until the config loads.
export function HealthInfoLabel({
  label = 'Health', side = 'top', className,
}: {
  label?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}) {
  const { data } = useHealthConfig();
  const cfg = data ? (data.override ?? data.workspace) : null;
  const spec: RichTipSpec = cfg
    ? { lead: 'How each project is flagged, from your current health rules.', legend: healthLegendFromConfig(cfg) }
    : (infoFor('health') as RichTipSpec);
  return (
    <Tooltip label={<RichTip {...spec} />} side={side}>
      <span className={cn('inline-flex cursor-help items-center gap-1', className)}>
        {label}
        <Info className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
      </span>
    </Tooltip>
  );
}
