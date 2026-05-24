import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

import { cn } from '@/lib/utils';

// ── ConfirmDialog ────────────────────────────────────────────────────
//
// Shared destructive-confirmation dialog. Replaces ad-hoc window.confirm
// calls and one-off modals scattered across the codebase. Supports two
// modes:
//
//   1. "click" - one-click confirm with a primary button (default).
//   2. "type"  - operator must type ``expectedTypedValue`` exactly into
//      a text input before the confirm button enables. Used for
//      destructive actions on the platform Advanced tab (suspend,
//      mark inactive, delete tenant) where typing the tenant name is
//      a deliberate friction gate.
//
// Audit pattern: when the action succeeds, the calling code is
// responsible for writing the PlatformAuditEvent. This component does
// not write audit events itself - it would be wrong to entangle a
// presentational component with a backend side-effect. Callers
// receive the typed value via onConfirm so they can include it in
// the audit payload (proving the operator typed the exact name).

export type ConfirmTone = 'destructive' | 'warning' | 'info';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  /** Tone drives the icon color, button color, and copy framing. */
  tone?: ConfirmTone;
  confirmLabel: string;
  cancelLabel?: string;
  /** When non-null, the user must type this exact string to enable the confirm button. */
  expectedTypedValue?: string;
  /** Label above the typed-input. Defaults to "Type to confirm". */
  typeFieldLabel?: string;
  /** Hint placeholder inside the input. */
  typeFieldPlaceholder?: string;
  /**
   * Called when the user confirms. Receives the value the user typed
   * (or null if not in "type" mode). The caller should run the actual
   * mutation + write the audit event with this token in the payload.
   */
  onConfirm: (typedValue: string | null) => void | Promise<void>;
  onCancel: () => void;
  isPending?: boolean;
  /** Error from the caller's mutation; rendered under the input. */
  errorMessage?: string | null;
}

const TONE_CLASSES: Record<ConfirmTone, {
  icon: string;
  iconBg: string;
  button: string;
}> = {
  destructive: {
    icon: 'text-rose-400',
    iconBg: 'bg-rose-500/15',
    button: 'bg-rose-600 hover:bg-rose-700 focus:ring-rose-500 text-white',
  },
  warning: {
    icon: 'text-amber-400',
    iconBg: 'bg-amber-500/15',
    button: 'bg-amber-600 hover:bg-amber-700 focus:ring-amber-500 text-white',
  },
  info: {
    icon: 'text-sky-400',
    iconBg: 'bg-sky-500/15',
    button: 'bg-sky-600 hover:bg-sky-700 focus:ring-sky-500 text-white',
  },
};

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  tone = 'destructive',
  confirmLabel,
  cancelLabel = 'Cancel',
  expectedTypedValue,
  typeFieldLabel = 'Type to confirm',
  typeFieldPlaceholder,
  onConfirm,
  onCancel,
  isPending = false,
  errorMessage,
}) => {
  const [typedValue, setTypedValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the typed value every time the dialog opens. Without this,
  // re-opening after a cancelled flow would prefill the input with the
  // previous attempt's value.
  useEffect(() => {
    if (open) {
      setTypedValue('');
      // Focus the input (or the cancel button when not in type mode) so
      // keyboard users can dismiss without reaching for the mouse.
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [open]);

  // Esc closes the dialog as long as we aren't mid-flight.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isPending) {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, isPending, onCancel]);

  if (!open) return null;

  const needsTyping = typeof expectedTypedValue === 'string' && expectedTypedValue.length > 0;
  const matches = !needsTyping || typedValue === expectedTypedValue;
  const confirmDisabled = !matches || isPending;
  const toneClasses = TONE_CLASSES[tone];

  const handleConfirm = () => {
    if (confirmDisabled) return;
    void onConfirm(needsTyping ? typedValue : null);
  };

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/40 px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div className="w-full max-w-[480px] rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-start gap-4 px-5 py-4">
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
              toneClasses.iconBg,
            )}
          >
            <AlertTriangle className={cn('h-5 w-5', toneClasses.icon)} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 id="confirm-dialog-title" className="text-base font-semibold text-foreground">
              {title}
            </h2>
            {description && (
              <div className="mt-2 text-sm text-muted-foreground">
                {description}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground transition hover:text-foreground disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {needsTyping && (
          <div className="px-5 pb-4">
            <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {typeFieldLabel}
            </label>
            <p className="mt-1 text-xs text-muted-foreground">
              Type <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">{expectedTypedValue}</code> to enable the {tone === 'destructive' ? 'destructive ' : ''}action.
            </p>
            <input
              ref={inputRef}
              type="text"
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && matches && !isPending) {
                  e.preventDefault();
                  handleConfirm();
                }
              }}
              placeholder={typeFieldPlaceholder ?? expectedTypedValue}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={isPending}
              className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
            />
          </div>
        )}

        {errorMessage && (
          <div className="mx-5 mb-3 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
            {errorMessage}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-border bg-background/40 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="inline-flex items-center rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={confirmDisabled}
            className={cn(
              'inline-flex items-center rounded-md px-3 py-1.5 text-sm font-semibold transition focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
              toneClasses.button,
            )}
          >
            {isPending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
