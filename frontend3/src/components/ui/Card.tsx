import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

// 2xl-rounded card with a 1px border on the theme `border` token. Used as
// the container for everything page-level.
export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...rest }, ref) => (
    <div
      ref={ref}
      className={cn('rounded-2xl border border-border bg-card text-card-foreground', className)}
      {...rest}
    />
  ),
);
Card.displayName = 'Card';

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...rest }, ref) => (
    <div
      ref={ref}
      className={cn('flex items-center justify-between gap-3 border-b border-border px-4 py-3', className)}
      {...rest}
    />
  ),
);
CardHeader.displayName = 'CardHeader';

export const CardBody = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...rest }, ref) => (
    <div ref={ref} className={cn('p-4', className)} {...rest} />
  ),
);
CardBody.displayName = 'CardBody';
