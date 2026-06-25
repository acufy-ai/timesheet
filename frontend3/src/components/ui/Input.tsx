import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  /** Render the invalid (red border + ring) state. */
  error?: boolean;
};

// Pill-shaped form input. Border picks up the theme `border` token; focus
// state uses primary with a soft ring. Backgrounds stay transparent so the
// page or card background shows through (consistent across light + dark).
// Pass `error` to mark the field invalid (red border/ring, theme-independent).
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, error, ...rest }, ref) => (
    <input
      ref={ref}
      aria-invalid={error || undefined}
      className={cn(
        'h-10 w-full rounded-full border border-border bg-transparent px-4 text-[15px] text-foreground placeholder:text-muted-foreground transition-colors',
        'focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        error && 'border-rose-500 focus:border-rose-500 focus:ring-rose-500/25',
        className,
      )}
      {...rest}
    />
  ),
);
Input.displayName = 'Input';
