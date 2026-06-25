import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

// Shared form-field primitives so every form marks required fields and shows
// validation consistently:
//   - RequiredMark  : a red asterisk that stays red in EVERY theme.
//   - FieldLabel    : the muted field label + optional RequiredMark.
//   - FieldError    : the small inline "X is required" message under a field.
//                     When it appears it also scrolls the FIRST invalid field of
//                     a submit into view (see scroll coordination below).
//   - fieldErrorClasses / errorBorder : border classes to splice into raw
//                     <select>/<textarea> elements that don't use <Input>.

const LABEL_BASE = 'mb-1 block text-[13px] font-medium text-muted-foreground';

// Theme-independent red. Uses an explicit Tailwind color (not a theme token)
// so the asterisk is red under light, dark, and every brand palette.
export function RequiredMark() {
  return <span className="text-rose-500" aria-hidden="true"> *</span>;
}

export function FieldLabel({
  children, required, className, htmlFor,
}: {
  children: ReactNode; required?: boolean; className?: string; htmlFor?: string;
}) {
  return (
    <label htmlFor={htmlFor} className={cn(LABEL_BASE, className)}>
      {children}
      {required ? <RequiredMark /> : null}
    </label>
  );
}

// ── Scroll-to-first-error coordination ───────────────────────────────────────
// When a form fails validation it may set several field errors at once, and the
// first invalid field can be scrolled out of view inside a tall modal (so the
// form looks broken: "nothing happened" when really an error is off-screen).
//
// Every <FieldError> that becomes visible registers its DOM node here. On the
// next microtask we pick the topmost one (smallest viewport `top`), scroll it
// into the center of its scroll container, and focus the nearest form control so
// the user lands exactly on the field that needs fixing. We coordinate across
// all FieldErrors so only ONE scroll happens per submit, not one per error.
let pending: HTMLElement[] = [];
let flushQueued = false;

function flushScroll() {
  flushQueued = false;
  const nodes = pending;
  pending = [];
  if (nodes.length === 0) return;
  // Topmost error in the viewport wins (the first field the user should fix).
  let top: HTMLElement | null = null;
  let topY = Infinity;
  for (const n of nodes) {
    const y = n.getBoundingClientRect().top;
    if (y < topY) { topY = y; top = n; }
  }
  if (!top) return;
  top.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // Focus the nearest labelled control so keyboard users land on the field.
  const fieldWrap = top.closest('[data-field]') ?? top.parentElement;
  const control = fieldWrap?.querySelector<HTMLElement>(
    'input:not([type="hidden"]), select, textarea, [tabindex]',
  );
  // Don't steal focus on smooth-scroll start in a way that cancels the scroll;
  // focus after a tick. preventScroll keeps the centered position intact.
  if (control) {
    setTimeout(() => control.focus({ preventScroll: true }), 60);
  }
}

// Inline per-field error message. Renders nothing when `error` is falsy, so
// callers can do `<FieldError error={errors.title} />` unconditionally. When it
// first shows an error it registers for the shared scroll-to-first-error pass.
export function FieldError({ error, className }: { error?: string | null; className?: string }) {
  const ref = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (!error || !ref.current) return;
    pending.push(ref.current);
    if (!flushQueued) {
      flushQueued = true;
      queueMicrotask(flushScroll);
    }
  }, [error]);
  if (!error) return null;
  return (
    <p ref={ref} className={cn('mt-1 text-[12.5px] text-rose-500', className)}>
      {error}
    </p>
  );
}

// For raw <select>/<textarea> (which don't use the <Input> component): splice
// `errorBorder(hasError)` into their className to get the same red invalid state.
export function errorBorder(hasError?: boolean): string {
  return hasError ? 'border-rose-500 focus:border-rose-500 focus:ring-rose-500/25' : '';
}
