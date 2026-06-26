import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

import { cn } from '@/lib/cn';

// Centered modal dialog with a backdrop. Closes on Escape and backdrop click.
// Body scroll is locked while open. The dialog caps at the viewport height and
// scrolls its body internally, so a tall form's fields (and validation errors)
// are always reachable instead of spilling off-screen.
export function Modal({
  open,
  onClose,
  title,
  children,
  className,
  flushBottom = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Set when the modal's content ends in its OWN sticky bottom-0 footer (which
   * supplies pb-4 and seals the bottom). Those modals want a flush body so the
   * footer reaches the edge. Everything else gets symmetric bottom padding. */
  flushBottom?: boolean;
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
          // Flex column + capped height so the body scrolls internally (header
          // pinned) rather than the whole dialog overflowing the viewport.
          'flex max-h-[90vh] w-full max-w-md flex-col rounded-2xl border border-border bg-card text-card-foreground shadow-2xl',
          className,
        )}
      >
        {title ? (
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
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
        {/* Symmetric padding by default (pt-4/pb-4). flushBottom=true switches
            to pb-0 for modals that end in their own sticky footer, which supplies
            pb-4 and seals the bottom so scrolled content can't peek beneath it. */}
        <div className={cn('min-h-0 flex-1 overflow-y-auto px-4 pt-4', flushBottom ? 'pb-0' : 'pb-4')}>{children}</div>
      </div>
    </div>
  );
}
