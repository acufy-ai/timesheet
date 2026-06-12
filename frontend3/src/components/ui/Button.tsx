import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

// Three visual variants, all pill-shaped. Sizes follow a 9 / 11 / 12 height
// scale that matches the rest of the frontend3 design vocabulary.
type Variant = 'primary' | 'secondary' | 'ghost' | 'destructive';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-primary text-primary-foreground shadow-sm hover:brightness-110 active:brightness-95',
  secondary:
    'border border-border bg-card text-foreground hover:border-primary/40 hover:bg-primary/5 hover:text-primary',
  ghost:
    'text-muted-foreground hover:bg-primary/10 hover:text-primary',
  destructive:
    'bg-rose-500 text-white shadow-sm hover:bg-rose-600',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
  lg: 'h-11 px-5 text-base',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className, ...rest }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  ),
);
Button.displayName = 'Button';
