import { Info } from 'lucide-react';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';

// Plain-English glossary for the manager-dashboard metrics. Keys are matched
// case-insensitively against the label text so callers can pass the label they
// already render (e.g. "Utilization", "Budget used").
const GLOSSARY: Record<string, string> = {
  revenue: 'Approved billable hours × each person’s resolved rate. Only approved time counts.',
  'approved hours': 'Total hours from time entries that have been approved (drafts and submitted-but-unapproved time are not included).',
  utilization: 'Share of your team’s available working hours that went to billable work over the period. 100% means every available hour was billable.',
  'budget tracked': 'The combined budget of the projects shown here — the denominator behind “budget used”.',
  hours: 'Approved hours logged against this project over the period.',
  total: 'This person’s total approved hours across all projects shown, over the period.',
  'budget used': 'Approved revenue on this project as a percentage of the project’s budget.',
  'contract used': 'Approved revenue on this project as a percentage of its contract (MSA/SOW) value.',
  'team on track': 'Direct reports whose projects are healthy (not at-risk or behind).',
  'approvals pending': 'Weeks of submitted time from your reports that are waiting for your approval.',
  'pto this week': 'Direct reports with approved time off during the current week.',
  'recent rejections': 'Time entries you sent back to a report in the recent window.',
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
