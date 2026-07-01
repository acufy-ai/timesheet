// Reusable, data-driven presentational components for the standardized Project
// Detail page. Each is pure: it binds a slice of the ProjectHealthView model and
// owns nothing but layout. The page composes these in a fixed order; the same
// components render for every project so the layout stays identical.

import { useState, type ReactNode } from 'react';
import { AlertTriangle, Ban, Clock, GitBranch, TrendingUp, Users, DollarSign, CalendarClock } from 'lucide-react';

import { cn } from '@/lib/cn';
import { healthMeta } from '@/lib/projectHealth';
import { InfoLabel } from '@/components/dashboard/InfoLabel';
import { Modal } from '@/components/ui';
import { useProjectNotes } from '@/hooks/useAdmin';
import {
  riskText,
  TASK_STATUS_LABEL,
  type SummaryCardVM,
  type CriticalIssueVM,
  type IssueCategory,
  type TaskRowVM,
  type WorkloadPersonVM,
  type KpiVM,
  type MetricRowVM,
  type RiskTone,
} from '@/lib/projectHealthView';

// ----------------------------------------------------------------------------
// Section 2: summary cards.
// ----------------------------------------------------------------------------
export function SummaryCard({ card }: { card: SummaryCardVM }) {
  if (card.isStatus && card.health) {
    const m = healthMeta(card.health);
    return (
      <div className="rounded-2xl border border-border bg-card px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{card.label}</p>
        <span className="mt-2 inline-flex items-center gap-1.5">
          <span className={cn('h-2.5 w-2.5 rounded-full', m.dot)} />
          <span className={cn('text-base font-semibold', m.text)}>{m.label}</span>
        </span>
        {/* Plain-language "why this status", so the pill isn't unexplained. */}
        {card.sub ? <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{card.sub}</p> : null}
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{card.label}</p>
      <p className={cn('mt-1 text-xl font-bold tabular-nums', card.emphasis ? riskText(card.tone) : 'text-foreground')}>
        {card.value}
      </p>
      {card.sub ? <p className="text-xs text-muted-foreground">{card.sub}</p> : null}
    </div>
  );
}

export function SummaryCardRow({ cards }: { cards: SummaryCardVM[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
      {cards.map((c) => <SummaryCard key={c.key} card={c} />)}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Section 3: critical issues.
// ----------------------------------------------------------------------------
const ISSUE_ICON: Record<IssueCategory, typeof Ban> = {
  health: AlertTriangle,
  blocked: Ban,
  dependency: GitBranch,
  overdue: Clock,
  budget: DollarSign,
  estimate_overrun: TrendingUp,
  schedule: CalendarClock,
  approval_bottleneck: AlertTriangle,
  resource_concentration: Users,
};

export function CriticalIssuesPanel({ issues }: { issues: CriticalIssueVM[] }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-foreground">Critical issues requiring attention</h2>
      {issues.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card px-4 py-4 text-sm text-muted-foreground">
          No major issues detected.
        </div>
      ) : (
        <ul className="space-y-2 rounded-2xl border border-border bg-card px-4 py-3">
          {issues.map((it) => {
            const Icon = ISSUE_ICON[it.category];
            return (
              <li key={it.category} className="flex gap-2.5 text-sm">
                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', riskText(it.tone))} />
                <span className="text-foreground">
                  <span className="font-medium">{it.label}:</span>{' '}
                  <span className="text-muted-foreground">{it.detail}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------
// Shared horizontal bar row (Highest effort + Workload).
// ----------------------------------------------------------------------------
export function BarRow({ name, right, pct }: { name: string; right: string; pct: number }) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="min-w-0 truncate text-foreground" title={name}>{name}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{right}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary/70" style={{ width: `${pct}%` }} />
      </div>
    </li>
  );
}

function ExecCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

// One clickable task row in the "Tasks" tile: name + allocated/logged (red when
// over the allocation) + an effort-share bar. Click opens the detail popup.
function TaskLine({ t, onOpen }: { t: TaskRowVM; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen}
        className="w-full rounded-md px-1 -mx-1 py-0.5 text-left transition-colors hover:bg-foreground/[0.04]">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="min-w-0 truncate text-foreground" title={t.name}>{t.name}</span>
          <span className={cn('shrink-0 tabular-nums', t.over ? 'font-semibold text-rose-600 dark:text-rose-400' : 'text-muted-foreground')}>
            {t.right}
          </span>
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full rounded-full', t.over ? 'bg-rose-500' : 'bg-primary/70')} style={{ width: `${t.pct}%` }} />
        </div>
      </button>
    </li>
  );
}

export function ExecutionStatus({
  tasks, effortTotal, workload, projectId, projectName, managerName, clientName,
}: {
  tasks: TaskRowVM[];
  effortTotal: string | null;
  workload: WorkloadPersonVM[];
  projectId: number;
  projectName: string;
  managerName?: string | null;
  clientName?: string | null;
}) {
  const [openTask, setOpenTask] = useState<TaskRowVM | null>(null);
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-foreground">Execution status</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <ExecCard title="Tasks">
          {tasks.length ? (
            <>
              <ul className="space-y-2">
                {tasks.map((t) => <TaskLine key={t.taskId} t={t} onOpen={() => setOpenTask(t)} />)}
              </ul>
              {effortTotal ? (
                <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm">
                  <span className="font-medium text-foreground">Total effort</span>
                  <span className="shrink-0 tabular-nums font-semibold text-foreground">{effortTotal}</span>
                </div>
              ) : null}
            </>
          ) : <p className="text-sm text-muted-foreground">No tasks on this project.</p>}
        </ExecCard>

        <ExecCard title="Workload by person">
          {workload.length ? (
            <ul className="space-y-2.5">
              {workload.map((p) => (
                <li key={p.userId}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-foreground" title={p.name}>{p.name}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{p.right}</span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary/70" style={{ width: `${p.pct}%` }} />
                  </div>
                  {/* Per-task split ON THIS PROJECT (item 9). */}
                  {p.tasks.length ? (
                    <ul className="mt-1 space-y-0.5 pl-2">
                      {p.tasks.map((pt) => (
                        <li key={pt.taskId} className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
                          <span className="min-w-0 truncate" title={pt.name}>{pt.name}</span>
                          <span className="shrink-0 tabular-nums">{pt.hours}h</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">No workload data.</p>}
        </ExecCard>
      </div>

      {openTask ? (
        <TaskDetailModal
          t={openTask} onClose={() => setOpenTask(null)}
          projectId={projectId} projectName={projectName}
          managerName={managerName} clientName={clientName}
        />
      ) : null}
    </section>
  );
}

// Task-detail popup (item 7): name, description, assignees, project, PM,
// allocated vs logged, and notes linked to this task/project. Closes on the X,
// Escape, or an outside click (all provided by <Modal>).
function TaskDetailModal({
  t, onClose, projectId, projectName, managerName, clientName,
}: {
  t: TaskRowVM;
  onClose: () => void;
  projectId: number;
  projectName: string;
  managerName?: string | null;
  clientName?: string | null;
}) {
  const notesQ = useProjectNotes(projectId);
  const notes = (notesQ.data ?? []).filter(
    (n) => n.task_id === t.taskId || (n.task_id == null && n.project_id === projectId),
  );
  const task = t.task;
  const assignees = task.assignees ?? [];
  return (
    <Modal open onClose={onClose} title={t.name}>
      <div className="space-y-3 text-sm">
        <Row label="Project">{projectName}{clientName ? ` · ${clientName}` : ''}</Row>
        <Row label="Manager">{managerName || '—'}</Row>
        <Row label="Status">{TASK_STATUS_LABEL[task.status] ?? task.status}</Row>
        <Row label="Hours">
          <span className={cn('tabular-nums', t.over ? 'font-semibold text-rose-600 dark:text-rose-400' : 'text-foreground')}>
            {t.allocated != null ? `${t.logged}h logged / ${t.allocated}h allocated` : `${t.logged}h logged`}
          </span>
        </Row>
        <Row label="Assignees">
          {assignees.length ? assignees.join(', ') : <span className="text-muted-foreground">Unassigned</span>}
        </Row>
        {task.description ? (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Description</p>
            <p className="mt-0.5 whitespace-pre-wrap text-foreground">{task.description}</p>
          </div>
        ) : null}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Notes</p>
          {notes.length ? (
            <ul className="mt-1 space-y-1.5">
              {notes.map((n) => (
                <li key={n.id} className="rounded-lg border border-border/70 px-2.5 py-1.5">
                  <p className="whitespace-pre-wrap text-[13px] text-foreground">{n.body}</p>
                  {n.author ? <p className="mt-0.5 text-[11px] text-muted-foreground">{n.author}</p> : null}
                </li>
              ))}
            </ul>
          ) : <p className="mt-0.5 text-[13px] text-muted-foreground">No notes for this task.</p>}
        </div>
      </div>
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-foreground">{children}</span>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Section 5: financial KPI cards.
// ----------------------------------------------------------------------------
export function KpiCard({ kpi }: { kpi: KpiVM }) {
  const colored = kpi.tone !== 'neutral';
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3">
      <InfoLabel label={kpi.label} className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground" />
      <p className={cn('mt-1 text-xl font-bold tabular-nums', colored ? riskText(kpi.tone) : 'text-foreground')}>
        {kpi.value}
      </p>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Sections 6-8: metric tables (Effort & budget, EVM, Revenue recognition).
// ----------------------------------------------------------------------------
export function MetricTable({ title, rows }: { title: string; rows: MetricRowVM[] }) {
  return (
    <div className="rounded-2xl border border-border bg-card">
      <div className="border-b border-border px-4 py-2.5">
        <p className="text-sm font-semibold text-foreground">{title}</p>
      </div>
      <div className="divide-y divide-border/60 px-4">
        {rows.map((r) => <MetricRow key={r.label} row={r} />)}
      </div>
    </div>
  );
}

export function MetricRow({ row }: { row: MetricRowVM }) {
  const colored = row.tone && row.tone !== 'neutral';
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span className="text-muted-foreground">
        {row.tooltip ? <InfoLabel label={row.label} /> : row.label}
      </span>
      <span className={cn('tabular-nums font-medium', colored ? riskText(row.tone as RiskTone) : 'text-foreground')}>
        {row.value}
      </span>
    </div>
  );
}
