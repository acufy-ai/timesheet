import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

// Pill-shaped form input. Border picks up the theme `border` token; focus
// state uses primary with a soft ring. Backgrounds stay transparent so the
// page or card background shows through (consistent across light + dark).
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-full border border-border bg-transparent px-4 text-sm text-foreground placeholder:text-muted-foreground transition-colors',
        'focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  ),
);
Input.displayName = 'Input';
