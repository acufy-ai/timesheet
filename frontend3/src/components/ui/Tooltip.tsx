import React, { useCallback, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Lightweight hover/focus tooltip. No external dependency (the app has no
// Radix). The label is positioned with fixed coordinates measured from the
// trigger's bounding rect, so it escapes any overflow:hidden ancestor (e.g.
// the collapsed sidebar rail). Used primarily by the collapsed nav rail to
// show each icon's label to the side.
//
// Only `side="right"` is needed today; the other sides are supported so the
// component is reusable. Pointer-events are disabled on the bubble so it never
// blocks clicks on the trigger underneath.

type Side = 'right' | 'left' | 'top' | 'bottom';

interface TooltipProps {
  /** Plain string for a simple label, or rich content (a lead line + formula +
   * legend) for metric help — see RichTip in dashboard/tooltipContent. Rich
   * content implies a wrapped, max-width bubble. */
  label: React.ReactNode;
  side?: Side;
  /** Gap in px between the trigger and the tooltip. */
  offset?: number;
  /** When set, the bubble wraps to this max width (px) instead of one line.
   * Use for multi-sentence help text; omit for short single-line labels.
   * Auto-applied (280px) when `label` is not a plain string. */
  maxWidth?: number;
  children: React.ReactNode;
}

interface Coords {
  top: number;
  left: number;
  transform: string;
}

function computeCoords(rect: DOMRect, side: Side, offset: number): Coords {
  switch (side) {
    case 'left':
      return {
        top: rect.top + rect.height / 2,
        left: rect.left - offset,
        transform: 'translate(-100%, -50%)',
      };
    case 'top':
      return {
        top: rect.top - offset,
        left: rect.left + rect.width / 2,
        transform: 'translate(-50%, -100%)',
      };
    case 'bottom':
      return {
        top: rect.bottom + offset,
        left: rect.left + rect.width / 2,
        transform: 'translate(-50%, 0)',
      };
    case 'right':
    default:
      return {
        top: rect.top + rect.height / 2,
        left: rect.right + offset,
        transform: 'translate(0, -50%)',
      };
  }
}

export const Tooltip: React.FC<TooltipProps> = ({
  label,
  side = 'right',
  offset = 10,
  maxWidth,
  children,
}) => {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [coords, setCoords] = useState<Coords | null>(null);
  const tooltipId = useId();

  const show = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    // The wrapper uses `display:contents` (no box of its own), so measure the
    // actual rendered child element. Fall back to the wrapper if there's none.
    const measured = el.firstElementChild ?? el;
    const rect = measured.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    setCoords(computeCoords(rect, side, offset));
  }, [side, offset]);

  const hide = useCallback(() => setCoords(null), []);

  // Rich (non-string) content always wraps; default it to a comfortable
  // reading column so structured help (lead + formula + legend) lays out.
  const isRich = typeof label !== 'string';
  const effectiveMaxWidth = maxWidth ?? (isRich ? 280 : undefined);
  const wraps = effectiveMaxWidth != null;

  return (
    <span
      ref={triggerRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      className="contents"
      aria-describedby={coords ? tooltipId : undefined}
    >
      {children}
      {coords &&
        createPortal(
          <span
            id={tooltipId}
            role="tooltip"
            style={{ top: coords.top, left: coords.left, transform: coords.transform, maxWidth: effectiveMaxWidth }}
            className={
              'pointer-events-none fixed z-[100] block rounded-lg border border-border bg-popover text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95 ' +
              (isRich
                ? 'px-3 py-2.5 text-xs leading-snug'
                : 'px-2 py-1 text-xs font-medium ' + (wraps ? 'whitespace-normal leading-snug' : 'whitespace-nowrap'))
            }
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
};
