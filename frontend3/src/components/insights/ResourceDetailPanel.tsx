import { useEffect } from 'react';
import { Loader2, X } from 'lucide-react';

import { cn } from '@/lib/cn';
import { fmtMoney } from '@/lib/format';
import { useResourceDetail } from '@/hooks/useDashboard';

// Slide-over panel showing one employee's detail: billing, submitted/approved
// hours, billed vs cost, a per-project breakdown, and their tasks (with hours +
// which ones they're assigned to). Opened by clicking a resourcing row.
export function ResourceDetailPanel({ userId, name, onClose }: {
  userId: number | null;
  name?: string;
  onClose: () => void;
}) {
  const q = useResourceDetail(userId);
  const open = userId != null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const d = q.data;
  const num = (v: string | number | null | undefined) => Math.round(Number(v ?? 0));

  return (
    // In-flow side panel: sticks within the viewport while the list scrolls, and
    // doesn't overlay the list, so the user can keep clicking other employees.
    <aside className="sticky top-4 flex max-h-[calc(100vh-7rem)] w-[30rem] shrink-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-bold text-foreground">{d?.full_name ?? name ?? 'Employee'}</h2>
          {d?.title ? <p className="text-xs text-muted-foreground">{d.title}</p> : null}
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </header>

      {q.isLoading ? (
        <div className="grid flex-1 place-items-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : !d ? (
        <div className="grid flex-1 place-items-center px-6 py-16 text-center text-sm text-muted-foreground">Couldn't load this employee's detail.</div>
      ) : (
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {/* Billing + hours summary */}
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
              <Stat label="Billed" value={fmtMoney(d.billed)} hint={`last ${d.days_back} days`} />
              <Stat label="Cost" value={fmtMoney(d.cost)} hint={d.cost_rate != null ? `${fmtMoney(d.cost_rate)}/h` : 'no cost rate'} />
              <Stat label="Approved hours" value={`${num(d.approved_hours)}h`} hint={`${num(d.billable_hours)}h billable`} />
              <Stat label="Submitted hours" value={`${num(d.submitted_hours)}h`} hint="submitted + approved" />
            </div>

            {/* Per-project, with that project's tasks nested under it so the
                per-task hours reconcile with the project total (plus any time
                logged at the project level with no task). */}
            <Section title="Projects & tasks" count={d.projects.length}>
              {d.projects.length === 0 ? <Empty>No approved time in this window.</Empty> : (
                <div className="space-y-2.5">
                  {d.projects.map((p) => {
                    const tasks = d.tasks.filter((t) => t.project_id === p.project_id);
                    return (
                      <div key={p.project_id} className="rounded-lg border border-border/70 p-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-foreground">{p.project_name}</p>
                            {p.client_name ? <p className="truncate text-[11px] text-muted-foreground">{p.client_name}</p> : null}
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="text-sm font-semibold tabular-nums text-foreground">{num(p.hours)}h</p>
                            <p className="text-[11px] text-muted-foreground">{fmtMoney(p.billed)} billed</p>
                          </div>
                        </div>
                        {(tasks.length || num(p.untasked_hours) > 0) ? (
                          <ul className="mt-1.5 space-y-1 border-t border-border/50 pt-1.5">
                            {tasks.map((t) => (
                              <li key={`${t.project_id}-${t.task_id}`} className="flex items-center justify-between gap-2 text-[12px]">
                                <span className="min-w-0 truncate text-muted-foreground">
                                  {t.task_name}
                                  {t.assigned ? <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">Assigned</span> : null}
                                </span>
                                <span className={cn('shrink-0 tabular-nums', num(t.hours) > 0 ? 'text-foreground' : 'text-muted-foreground/60')}>{num(t.hours)}h</span>
                              </li>
                            ))}
                            {num(p.untasked_hours) > 0 ? (
                              <li className="flex items-center justify-between gap-2 text-[12px]">
                                <span className="italic text-muted-foreground/80">Project-level (no task)</span>
                                <span className="shrink-0 tabular-nums text-foreground">{num(p.untasked_hours)}h</span>
                              </li>
                            ) : null}
                          </ul>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>
          </div>
        )}
    </aside>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-card px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-base font-bold tabular-nums text-foreground">{value}</p>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{title} <span className="text-muted-foreground/70">{count}</span></p>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-xs text-muted-foreground">{children}</p>;
}
