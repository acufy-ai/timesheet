import { useEffect } from 'react';
import { Loader2, X } from 'lucide-react';

import { cn } from '@/lib/cn';
import { fmtMoney } from '@/lib/format';
import { useResourceDetail } from '@/hooks/useDashboard';
import { AllocationManager } from './AllocationManager';
import type { ResourceDetail } from '@/types/dashboard';

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
    <aside className="sticky top-4 flex max-h-[calc(100vh-7rem)] min-w-0 flex-1 basis-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
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
      ) : d.is_client ? (
        <ClientResourceBody d={d} />
      ) : (
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {/* Capacity summary — why this person is over / at / under capacity. */}
            {d.capacity_summary ? (
              <div className={cn('rounded-lg border p-3', capacityClasses(d.capacity_state))}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-wide">{capacityLabel(d.capacity_state)}</span>
                  <span className="text-sm font-bold tabular-nums">{d.allocated_pct}% allocated</span>
                </div>
                <p className="mt-1 text-[12px] opacity-90">{d.capacity_summary}</p>
              </div>
            ) : null}

            {/* Plan forward work — placed right under the capacity summary it
                drives, so allocating/adjusting is the first thing you reach. The
                numbers above recompute as these change. */}
            {userId != null ? <AllocationManager userId={userId} /> : null}

            {/* Billing + hours summary */}
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
              <Stat label="Billed" value={fmtMoney(d.billed)} hint={`last ${d.days_back} days`} />
              <Stat label="Cost" value={fmtMoney(d.cost)} hint={d.cost_rate != null ? `${fmtMoney(d.cost_rate)}/h cost` : 'no cost rate'} />
              <Stat label="Approved hours" value={`${num(d.approved_hours)}h`} hint={`${num(d.billable_hours)}h billable`} />
              <Stat label="Submitted hours" value={`${num(d.submitted_hours)}h`} hint="submitted + approved" />
            </div>

            {/* Per-project: planned allocation (forward) reconciled with logged
                time (actuals). A project may show a planned % with 0h logged
                (allocated, not yet worked) — that's why the row and panel match. */}
            <Section title="Projects" count={d.projects.length}>
              {d.projects.length === 0 ? <Empty>No allocations or logged time in this window.</Empty> : (
                <div className="space-y-2.5">
                  {d.projects.map((p) => {
                    const tasks = d.tasks.filter((t) => t.project_id === p.project_id);
                    const plannedOnly = p.planned_pct != null && num(p.hours) === 0;
                    return (
                      <div key={p.project_id} className="rounded-lg border border-border/70 p-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-foreground">
                              {p.project_name}
                              {p.planned_pct != null ? (
                                <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{p.planned_pct}% planned</span>
                              ) : null}
                            </p>
                            {p.client_name ? <p className="truncate text-[11px] text-muted-foreground">{p.client_name}</p> : null}
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="text-sm font-semibold tabular-nums text-foreground">{num(p.hours)}h</p>
                            <p className="text-[11px] text-muted-foreground">{plannedOnly ? 'no time logged yet' : `${fmtMoney(p.billed)} billed`}</p>
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

// Client-side resource: no billing or capacity — a progress header plus their
// tasks grouped by project, so a manager can see client-side progress clearly.
function ClientResourceBody({ d }: { d: ResourceDetail }) {
  const total = d.task_total ?? d.tasks.length;
  const done = d.task_done ?? d.tasks.filter((t) => t.status === 'done').length;
  const pct = d.progress_pct ?? (total ? Math.round((done / total) * 100) : 0);
  // Group tasks by project, preserving the server's unfinished-first order.
  const byProject = new Map<number, { name: string; tasks: typeof d.tasks }>();
  for (const t of d.tasks) {
    const g = byProject.get(t.project_id) ?? { name: t.project_name, tasks: [] };
    g.tasks.push(t);
    byProject.set(t.project_id, g);
  }
  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-4">
      <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wide text-sky-700 dark:text-sky-300">Client resource</span>
          <span className="text-sm font-bold tabular-nums text-foreground">{total ? `${done}/${total} done` : 'No tasks'}</span>
        </div>
        {total ? (
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
        ) : null}
        <p className="mt-1.5 text-[12px] text-muted-foreground">
          {total
            ? `${pct}% of their assigned tasks complete. Client-side work isn't billed.`
            : 'No tasks assigned on your projects yet. Client-side work isn’t billed.'}
        </p>
      </div>

      {total === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Nothing to show yet.</p>
      ) : (
        <div className="space-y-3">
          {[...byProject.values()].map((g, gi) => (
            <div key={gi} className="rounded-lg border border-border p-3">
              <p className="mb-1.5 truncate text-sm font-semibold text-foreground">{g.name}</p>
              <ul className="space-y-1">
                {g.tasks.map((t, ti) => (
                  <li key={ti} className="flex items-center justify-between gap-2 text-[12.5px]">
                    <span className="min-w-0 truncate text-foreground">
                      {t.task_name}
                      {t.status === 'blocked' && t.blocked_reason ? (
                        <span className="ml-1.5 text-[11px] text-amber-600 dark:text-amber-400">— {t.blocked_reason}</span>
                      ) : null}
                    </span>
                    <TaskStatusPill status={t.status ?? 'to_do'} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskStatusPill({ status }: { status: string }) {
  const meta = status === 'done' ? { label: 'Done', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' }
    : status === 'in_progress' ? { label: 'In progress', cls: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' }
    : status === 'blocked' ? { label: 'Blocked', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' }
    : { label: 'To do', cls: 'bg-muted text-muted-foreground' };
  return <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium', meta.cls)}>{meta.label}</span>;
}

// Capacity banner styling per bucket. Uses the same status colours as the
// resourcing list (rose = over, emerald = at target, sky = available).
function capacityClasses(state: string): string {
  if (state === 'over') return 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300';
  if (state === 'under') return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300';
  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
}
function capacityLabel(state: string): string {
  if (state === 'over') return 'Over capacity';
  if (state === 'under') return 'Available capacity';
  return 'At target capacity';
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
