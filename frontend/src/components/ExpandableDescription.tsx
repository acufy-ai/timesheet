import React, { useLayoutEffect, useRef, useState } from 'react';

interface Props {
  /** The description text to render. ``null`` / empty renders nothing. */
  text: string | null | undefined;
  /** Maximum line count when collapsed. Defaults to 2. */
  lines?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Additional classes for the text container. */
  className?: string;
}

/**
 * Long-description handler shared by the My Time week editor and the
 * Admin → Approved Timesheets view.
 *
 * Clamps to ``lines`` lines via Tailwind's ``line-clamp`` utility, and
 * surfaces a "Show more" link only when the rendered content is taller
 * than the clamped box. The overflow check uses ``scrollHeight`` vs
 * ``clientHeight`` (not a brittle character-count heuristic) so a
 * 200-char paragraph with newlines correctly shows the toggle while a
 * 90-char single sentence does not.
 *
 * State is per-instance — expanding one row doesn't bloat the rest.
 */
export const ExpandableDescription: React.FC<Props> = ({
  text,
  lines = 2,
  className,
}) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Reading scroll metrics on the clamped node is cheaper than
    // mounting a hidden mirror to measure — we just compare what's
    // visible vs what would render uncapped.
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [text, lines]);

  if (!text) return null;

  // Tailwind 3.4 ships line-clamp built-in. Class is selected by the
  // ``lines`` prop so consumers can pick the height.
  const clampClass = expanded ? '' : LINE_CLAMP[lines];

  return (
    <div className="min-w-0">
      <div
        ref={ref}
        className={`whitespace-pre-wrap break-words ${clampClass} ${className ?? ''}`}
      >
        {text}
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 inline-flex items-center text-[11px] font-medium text-primary hover:underline"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
};

const LINE_CLAMP: Record<NonNullable<Props['lines']>, string> = {
  1: 'line-clamp-1',
  2: 'line-clamp-2',
  3: 'line-clamp-3',
  4: 'line-clamp-4',
  5: 'line-clamp-5',
  6: 'line-clamp-6',
};
