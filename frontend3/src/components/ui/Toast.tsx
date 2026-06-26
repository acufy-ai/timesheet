import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';

import { cn } from '@/lib/cn';

// Transient corner toast. Visibility is the whole point, so it does NOT use a
// translucent same-hue wash (green-on-green vanished on the mint/teal themes).
// Instead it's a distinct floating object: an OPAQUE elevated surface with a
// strong shadow and a COLORED ACCENT (left bar + icon chip) for tone — so it
// pops on every one of the app's themes, light or dark.
//
// State + auto-dismiss timing live with the caller (e.g. flashAndFade); this is
// purely the presentation. Portaled to <body> so it floats over any layout.

export type ToastTone = 'ok' | 'err';

export function Toast({
  tone, message, onDismiss,
}: {
  tone: ToastTone;
  message: string;
  onDismiss?: () => void;
}) {
  const ok = tone === 'ok';
  return createPortal(
    <div className="pointer-events-none fixed bottom-5 right-5 z-[120] flex max-w-sm flex-col items-end gap-2">
      <div
        role="status"
        className="pointer-events-auto flex items-start gap-3 overflow-hidden rounded-xl border border-border bg-popover py-2.5 pl-0 pr-3 text-popover-foreground shadow-xl animate-in fade-in-0 slide-in-from-bottom-2"
      >
        {/* Colored accent bar — the tone signal, full-height on the left. */}
        <span className={cn('w-1 self-stretch shrink-0', ok ? 'bg-emerald-500' : 'bg-rose-500')} aria-hidden />
        <span className={cn('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full',
          ok ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/15 text-rose-600 dark:text-rose-400')}>
          {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
        </span>
        <span className="pt-0.5 text-sm font-medium text-foreground">{message}</span>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="-mr-1 ml-1 mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
