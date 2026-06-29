import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Trash2, type LucideIcon } from 'lucide-react';

import { Button } from './Button';
import { Modal } from './Modal';

// Shared confirmation dialog — the ONE styled replacement for native
// window.confirm() across the app. Destructive confirms get a danger icon chip
// and a destructive-token confirm button; non-destructive (archive, etc.) read
// calmer without the chip and use the primary button.
//
// Two ways to use it:
//   1. <ConfirmDialog state={...} onClose={...} onConfirm={...} />  (controlled)
//   2. const confirm = useConfirm(); if (await confirm({...})) { ... }  (imperative,
//      the drop-in replacement for `if (window.confirm(msg)) { ... }`)

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  /** Destructive styling (danger chip + destructive button). Default true so it
   *  matches the most common case: delete/remove. Pass false for archive etc. */
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmIcon?: LucideIcon;
}

export interface ConfirmState extends ConfirmOptions {
  onConfirm: () => void;
}

/** Controlled presentation. Renders nothing until `state` is set. */
export function ConfirmDialog({
  state,
  onClose,
  onConfirm,
}: {
  state: ConfirmState | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const danger = state?.danger ?? true;
  const label = state?.confirmLabel ?? 'Delete';
  const Icon = state?.confirmIcon ?? Trash2;
  return (
    <Modal open={!!state} onClose={onClose} title="" className="max-w-sm">
      {state ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            {danger ? (
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-destructive/10 text-destructive">
                <Icon className="h-5 w-5" />
              </span>
            ) : null}
            <div className="min-w-0">
              <p className="text-base font-semibold text-foreground">{state.title}</p>
              <div className="mt-1 text-sm text-muted-foreground">{state.message}</div>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {state.cancelLabel ?? 'Cancel'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={danger ? 'destructive' : 'primary'}
              onClick={onConfirm}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

// ── Imperative API ──────────────────────────────────────────────────────────
// Wrap the app once in <ConfirmProvider>, then call useConfirm() anywhere.

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setState({ ...opts, onConfirm: () => {} });
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    resolverRef.current?.(ok);
    resolverRef.current = null;
    setState(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog state={state} onClose={() => settle(false)} onConfirm={() => settle(true)} />
    </ConfirmContext.Provider>
  );
}

/** Returns an async confirm() — `if (await confirm({ title, message })) { ... }`.
 *  Drop-in replacement for `if (window.confirm(msg)) { ... }`. */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a <ConfirmProvider>');
  return ctx;
}
