import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

// Centered empty-state block. Used inside cards and pages when there's no
// data yet but the surface should still look intentional.

interface EmptyProps {
  Icon?: LucideIcon;
  title: string;
  description?: string;
  // Optional primary action (usually a "+ create" button).
  action?: ReactNode;
  className?: string;
}

export function Empty({ Icon, title, description, action, className }: EmptyProps) {
  return (
    <div className={cn('rounded-2xl border border-border bg-card px-6 py-12 text-center', className)}>
      {Icon ? (
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
      ) : null}
      <p className="mt-3 font-semibold text-foreground">{title}</p>
      {description ? (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
