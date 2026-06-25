import type { LucideIcon } from 'lucide-react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Tooltip } from './Tooltip';

// Card-shaped count tile with a tone-tinted icon block at top, a large
// tabular-numeral value, a label, and a secondary hint. The 6-tone palette
// is the same shared list used across the app for stat tiles, icon chips,
// and avatar tints.

export type TileTone =
  | 'primary'
  | 'sky'
  | 'emerald'
  | 'violet'
  | 'amber'
  | 'rose';

const TONES: Record<TileTone, string> = {
  primary: 'bg-primary/10 text-primary',
  sky: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
  emerald: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
  violet: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
  amber: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
  rose: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',
};

interface StatTileProps {
  Icon: LucideIcon;
  tone: TileTone;
  label: string;
  value: number | string;
  hint?: string;
  // Optional plain-English explanation shown in a tooltip on the label.
  info?: string;
  className?: string;
  // When provided, the tile becomes an interactive button (clickable,
  // keyboard-focusable, hover affordance) — e.g. to drill into a list.
  onClick?: () => void;
}

export function StatTile({ Icon, tone, label, value, hint, info, className, onClick }: StatTileProps) {
  const interactive = typeof onClick === 'function';
  const content = (
    <>
      <div className={cn('grid h-9 w-9 place-items-center rounded-xl', TONES[tone])}>
        <Icon className="h-4 w-4" />
      </div>
      <p className="mt-3 text-2xl font-semibold tabular-nums leading-none text-foreground">
        {value}
      </p>
      {info ? (
        <Tooltip label={info} side="top" maxWidth={260}>
          <span className="mt-1 inline-flex cursor-help items-center gap-1 text-xs font-medium text-foreground">
            {label}<Info className="h-3 w-3 opacity-60" aria-hidden="true" />
          </span>
        </Tooltip>
      ) : (
        <p className="mt-1 text-xs font-medium text-foreground">{label}</p>
      )}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'rounded-2xl border border-border bg-card p-4 text-left transition-colors',
          'hover:border-primary/40 hover:bg-primary/5 focus:outline-none focus:ring-2 focus:ring-primary/30',
          className,
        )}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={cn('rounded-2xl border border-border bg-card p-4', className)}>
      {content}
    </div>
  );
}
