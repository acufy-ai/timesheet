import { Info } from 'lucide-react';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';

// Plain-English glossary for the manager-dashboard metrics. Keys are matched
// case-insensitively against the label text so callers can pass the label they
// already render (e.g. "Utilization", "Budget used").
const GLOSSARY: Record<string, string> = {
  revenue: 'Approved billable hours × each person’s resolved rate. Only approved time counts.',
  'approved hours': 'Total hours from time entries that have been approved (drafts and submitted-but-unapproved time are not included).',
  approved: 'Approved hours: time entries that have been approved. Drafts and submitted-but-unapproved time are not counted.',
  billable: 'Of the approved hours, the share marked billable (the hours that earn revenue).',
  utilization: 'Share of your team’s available working hours that went to billable work over the period. 100% means every available hour was billable.',
  'budget tracked': 'The combined budget of the projects shown here — the denominator behind “budget used”.',
  hours: 'Approved hours logged against this project over the period.',
  total: 'This person’s total approved hours across all projects shown, over the period.',
  'budget used': 'Approved revenue on this project as a percentage of the project’s budget.',
  'contract used': 'Approved revenue on this project as a percentage of its contract (MSA/SOW) value.',
  health: 'Based on budget consumed and time to the end date. Needs attention: over budget, or 30+ days overdue. At risk: within 7 days of the end date, or over 80% of budget used. Not set: no budget and no end date. Good: none of these.',
  budget: 'Approved revenue on this project as a percentage of its budget (only approved billable time counts).',
  'hours this week': 'Approved hours logged against this project during the current week.',
  'team on track': 'Direct reports whose projects are healthy (not at-risk or behind).',
  'approvals pending': 'Weeks of submitted time from your reports that are waiting for your approval.',
  'pto this week': 'Direct reports with approved time off during the current week.',
  'recent rejections': 'Time entries you sent back to a report in the recent window.',
  // PSA financial terms
  margin: 'Profit as a share of revenue: (revenue − labour cost) ÷ revenue. Cost is each person’s hourly cost × hours; revenue is billable hours × rate.',
  cost: 'Labour cost: each person’s hourly cost rate × hours worked (all hours, billable or not). What the work costs the firm.',
  // EVM (earned value) terms
  'planned (pv)': 'Planned Value — how much of the budget should be earned by now, based on the baseline schedule (linear over the plan dates).',
  'earned (ev)': 'Earned Value — budget × % of work actually complete (approved hours ÷ planned hours). What you’ve “earned” so far.',
  'actual (ac)': 'Actual Cost — the real labour cost incurred to date (sum of cost rate × hours).',
  pv: 'Planned Value — budget that should be earned by now per the baseline schedule.',
  ev: 'Earned Value — budget × % of work complete. The value actually delivered.',
  ac: 'Actual Cost — real labour cost incurred to date.',
  cpi: 'Cost Performance Index = Earned ÷ Actual. Above 1 = under cost; below 1 = over cost.',
  spi: 'Schedule Performance Index = Earned ÷ Planned. Above 1 = ahead of schedule; below 1 = behind.',
  'forecast (eac)': 'Estimate at Completion — projected final cost at the current efficiency (budget ÷ CPI). The “+x%” is the projected overrun vs. budget.',
  eac: 'Estimate at Completion — projected final cost at current efficiency (budget ÷ CPI).',
  risk: 'High = projected cost overrun AND behind schedule. Medium = one of the two. Low = forecast within plan.',
  recognized: 'Revenue recognised per the project’s method: as-billed (hours × rate) or % complete (contract/budget × % of work done).',
  billed: 'What has been billed: approved billable hours × rate.',
};

export function infoFor(label: string): string | undefined {
  return GLOSSARY[label.trim().toLowerCase()];
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
  return (
    <Tooltip label={desc} side={side} maxWidth={260}>
      <span className={cn('inline-flex cursor-help items-center gap-1', className)}>
        {label}
        <Info className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
      </span>
    </Tooltip>
  );
}
