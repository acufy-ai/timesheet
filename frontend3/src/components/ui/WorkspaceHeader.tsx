import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

// Page-level header. Title + optional description on the left, optional
// primary action on the right. Stacks on small viewports.

interface WorkspaceHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  // Right-side content (usually one or two buttons).
  primary?: ReactNode;
  // Optional eyebrow shown above the title (e.g. "Friday · Jun 5").
  eyebrow?: ReactNode;
  className?: string;
}

export function WorkspaceHeader({
  title,
  description,
  primary,
  eyebrow,
  className,
}: WorkspaceHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0 flex-1">
        {eyebrow ? (
          <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-4xl font-bold text-foreground">{title}</h1>
        {description ? (
          <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {primary ? <div className="flex shrink-0 items-center gap-2">{primary}</div> : null}
    </div>
  );
}
