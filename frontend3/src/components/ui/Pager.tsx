import { ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/cn';

// Numbered-pager windowing: first, last, current +/-1, with gaps.
// Extracted from UserRail so any paginated surface (dashboard tiles, lists)
// shares one pager. Pure presentational: owns no state.
export function pageWindow(page: number, pages: number): (number | '...')[] {
  const set = new Set<number>([1, pages, page, page - 1, page + 1]);
  const seq = [...set].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const out: (number | '...')[] = [];
  let prev = 0;
  for (const p of seq) {
    if (p - prev > 1) out.push('...');
    out.push(p);
    prev = p;
  }
  return out;
}

interface PagerProps {
  page: number;
  pages: number;
  total: number;
  /** 1-based index of the first item on the current page. */
  start: number;
  /** 1-based index of the last item on the current page. */
  end: number;
  onPage: (page: number) => void;
  /** Noun for the count read-out, e.g. "people" -> "of 42 people". */
  unit?: string;
  className?: string;
}

export function Pager({ page, pages, total, start, end, onPage, unit, className }: PagerProps) {
  if (pages <= 1) return null;
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 border-t border-border bg-card px-3.5 py-2 text-[11.5px] text-muted-foreground',
        className,
      )}
    >
      <span className="tabular-nums">
        {start.toLocaleString()}–{end.toLocaleString()} of {total.toLocaleString()}
        {unit ? ` ${unit}` : ''}
      </span>
      <div className="flex items-center gap-1">
        <button type="button" className="pager-btn" disabled={page <= 1} title="Previous" onClick={() => onPage(page - 1)}>
          <ChevronLeft className="h-[15px] w-[15px]" />
        </button>
        {pageWindow(page, pages).map((p, i) =>
          p === '...' ? (
            <span key={`gap-${i}`} className="px-1 text-muted-foreground">…</span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPage(p)}
              className={cn('pager-num', p === page && 'pager-num-active')}
            >
              {p}
            </button>
          ),
        )}
        <button type="button" className="pager-btn" disabled={page >= pages} title="Next" onClick={() => onPage(page + 1)}>
          <ChevronRight className="h-[15px] w-[15px]" />
        </button>
      </div>
    </div>
  );
}
