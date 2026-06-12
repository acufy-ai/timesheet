import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

import { cn } from '@/lib/cn';

// Centered modal dialog with a backdrop. Closes on Escape and backdrop click.
// Body scroll is locked while open. Keep content small — this is for confirms
// and short forms, not full pages.
export function Modal({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'w-full max-w-md rounded-2xl border border-border bg-card text-card-foreground shadow-2xl',
          className,
        )}
      >
        {title ? (
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold text-foreground">{title}</p>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : null}
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
