import { useMemo, useState } from 'react';

// Slice an already-fetched array into pages in the browser. For tiles whose
// dataset is small enough to fetch whole (a manager's team) but can still grow
// tall enough to want paging. No network per page; flips are instant.
//
// Returns the current page's items plus everything a <Pager> needs. Clamps the
// page when the data shrinks (e.g. a filter cuts the list below the current
// page), so you never land on an empty page.
export interface ClientPagination<T> {
  pageItems: T[];
  page: number;
  pages: number;
  total: number;
  /** 1-based index of the first item on the page (0 when empty). */
  start: number;
  /** 1-based index of the last item on the page (0 when empty). */
  end: number;
  setPage: (page: number) => void;
}

export function useClientPagination<T>(items: T[], pageSize: number): ClientPagination<T> {
  const [rawPage, setRawPage] = useState(1);

  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  // Clamp so a shrinking list (or a pageSize change) never strands us past the end.
  const page = Math.min(Math.max(1, rawPage), pages);

  const pageItems = useMemo(() => {
    const startIdx = (page - 1) * pageSize;
    return items.slice(startIdx, startIdx + pageSize);
  }, [items, page, pageSize]);

  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return { pageItems, page, pages, total, start, end, setPage: setRawPage };
}
