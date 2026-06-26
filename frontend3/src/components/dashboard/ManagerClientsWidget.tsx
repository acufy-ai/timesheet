import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, ChevronRight, Loader2 } from 'lucide-react';

import { Card, Pager } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useManagerClients } from '@/hooks/useDashboard';

// Small manager-dashboard tile: the manager's clients (collapsed) and the
// projects they run under each. Client and project names are clickable. Clients
// paginate at 10 per page. Scoped server-side to projects this manager owns.

const PAGE_SIZE = 10;

export function ManagerClientsWidget() {
  const q = useManagerClients();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const rows = q.data?.rows ?? [];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const start = (page - 1) * PAGE_SIZE;
  const pageRows = useMemo(() => rows.slice(start, start + PAGE_SIZE), [rows, start]);

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <Card>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-semibold text-foreground">Clients &amp; projects</p>
        {rows.length ? <p className="text-xs text-muted-foreground">{rows.length} {rows.length === 1 ? 'client' : 'clients'}</p> : null}
      </div>

      {q.isLoading ? (
        <div className="grid place-items-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" /></div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
          No clients yet. Projects you manage will appear here grouped by client.
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border/60">
            {pageRows.map((c) => {
              const isOpen = open.has(c.client_id);
              return (
                <li key={c.client_id}>
                  <div className="flex items-center gap-2 px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => toggle(c.client_id)}
                      aria-label={isOpen ? 'Collapse' : 'Expand'}
                      aria-expanded={isOpen}
                      className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
                    >
                      <ChevronRight className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-90')} />
                    </button>
                    <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <button
                      type="button"
                      onClick={() => navigate(`/client-management?client=${c.client_id}`)}
                      className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground underline-offset-2 hover:text-primary hover:underline"
                      title={c.client_name}
                    >
                      {c.client_name}
                    </button>
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
                      {c.project_count}
                    </span>
                  </div>
                  {isOpen ? (
                    <ul className="space-y-0.5 pb-2 pl-11 pr-4">
                      {c.projects.map((p) => (
                        <li key={p.project_id}>
                          <button
                            type="button"
                            onClick={() => navigate(`/insights/project/${p.project_id}?from=dashboard`)}
                            className="block w-full truncate rounded px-2 py-1 text-left text-[13px] text-muted-foreground hover:bg-foreground/[0.04] hover:text-primary"
                            title={p.project_name}
                          >
                            {p.project_name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <Pager
            page={page}
            pages={pages}
            total={rows.length}
            start={start + 1}
            end={Math.min(start + PAGE_SIZE, rows.length)}
            onPage={setPage}
            unit="clients"
          />
        </>
      )}
    </Card>
  );
}
