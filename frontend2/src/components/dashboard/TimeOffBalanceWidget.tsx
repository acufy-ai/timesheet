import React from 'react';
import { CalendarDays, Loader2 } from 'lucide-react';
import { WidgetShell } from './WidgetShell';
import { useTimeOffUsageSummary } from '@/hooks';

interface TimeOffTakenWidgetProps {
  onRemove: () => void;
}

const Row: React.FC<{ color: string; label: string; days: number }> = ({ color, label, days }) => (
  <div className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
    <span
      aria-hidden
      className="h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: color || '#6b7280' }}
    />
    <div className="flex-1 min-w-0">
      <p className="truncate text-sm font-medium text-foreground">{label}</p>
    </div>
    <span className="font-mono text-lg font-semibold text-foreground">{days.toFixed(days % 1 === 0 ? 0 : 1)}</span>
    <span className="text-xs text-muted-foreground">days</span>
  </div>
);

/** Sum of APPROVED time-off (in days, hours / 8) for the calling user
 *  this calendar year, grouped by leave type. The legacy version
 *  rendered hardcoded balances — this is the honest, server-backed
 *  replacement. */
export const TimeOffBalanceWidget: React.FC<TimeOffTakenWidgetProps> = ({ onRemove }) => {
  const year = new Date().getFullYear();
  const { data, isLoading, isError } = useTimeOffUsageSummary(year);
  const rows = Array.isArray(data) ? data : [];
  const totalDays = rows.reduce((sum, r) => sum + (r.days_taken || 0), 0);

  return (
    <WidgetShell widgetKey="timeoff" span={4} title={`Time Off Taken (${year})`} onRemove={onRemove}>
      {isLoading ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : isError ? (
        <p className="py-8 text-center text-sm text-destructive">
          Could not load time-off summary.
        </p>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-sm text-muted-foreground">
          <CalendarDays className="h-5 w-5" />
          No approved time off this year.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <Row key={row.leave_type} color={row.color} label={row.label} days={row.days_taken} />
          ))}
          <div className="flex items-center justify-between border-t border-border/60 pt-2.5 text-xs text-muted-foreground">
            <span>Total approved</span>
            <span className="font-mono text-sm font-semibold text-foreground">
              {totalDays.toFixed(totalDays % 1 === 0 ? 0 : 1)} days
            </span>
          </div>
        </div>
      )}
    </WidgetShell>
  );
};
