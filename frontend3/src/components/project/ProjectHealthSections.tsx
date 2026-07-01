// Reusable, data-driven presentational components for the standardized Project
// Detail page. Each is pure: it binds a slice of the ProjectHealthView model and
// owns nothing but layout. The page composes these in a fixed order; the same
// components render for every project so the layout stays identical.

import { useState, type ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { healthMeta } from '@/lib/projectHealth';
import { InfoLabel } from '@/components/dashboard/InfoLabel';
import { Modal, Button, Input } from '@/components/ui';
import { useProjectNotes, useUpdateTask, useCreateClientNote, useUsers } from '@/hooks/useAdmin';
import type { TaskStatus } from '@/types/admin';
import {
  riskText,
  TASK_STATUS_LABEL,
  TASK_STATUS_TONE,
  type SummaryCardVM,
  type CriticalIssueVM,
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
  // Hours card: "allocated / logged" with only the logged figure colored.
  if (card.hours) {
    return (
      <div className="rounded-2xl border border-border bg-card px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{card.label}</p>
        {card.sub ? <p className="text-[11px] text-muted-foreground">{card.sub}</p> : null}
        <p className="mt-1 text-xl font-bold tabular-nums">
          <span className="text-foreground">{card.hours.allocated}</span>
          <span className="text-muted-foreground"> / </span>
          <span className={card.hours.loggedTone === 'neutral' ? 'text-foreground' : riskText(card.hours.loggedTone)}>
            {card.hours.logged}
          </span>
        </p>
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
export function CriticalIssuesPanel({ issues }: { issues: CriticalIssueVM[] }) {
  if (issues.length === 0) {
    return (
      <section>
        <div className="rounded-2xl border border-border bg-card px-4 py-4 text-sm text-muted-foreground">
          No major issues detected.
        </div>
      </section>
    );
  }
  return (
    <section>
      {/* No section heading, no icons, no side labels per design — each issue is
          just a plain red line: a small red dot bullet then the detail sentence. */}
      <ul className="space-y-2 rounded-2xl border border-border bg-card px-4 py-3">
        {issues.map((it) => (
          <li key={it.category} className="flex items-baseline gap-2.5 text-sm text-rose-600 dark:text-rose-400">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" />
            <span>{it.detail}</span>
          </li>
        ))}
      </ul>
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

// A compact task-status chip (To do / In progress / Blocked / Done), tone-colored
// to match the status semantics used elsewhere on the page.
const STATUS_CHIP_TONE: Record<RiskTone, string> = {
  critical: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  subtle: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  neutral: 'bg-muted text-muted-foreground',
};
function TaskStatusChip({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const label = TASK_STATUS_LABEL[status] ?? status;
  const tone = TASK_STATUS_TONE[status] ?? 'neutral';
  return (
    <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium', STATUS_CHIP_TONE[tone])}>
      {label}
    </span>
  );
}

// One clickable task row in the "Tasks" tile: name + status chip + allocated/logged
// (red when over the allocation) + an effort-share bar. Click opens the detail popup.
function TaskLine({ t, onOpen }: { t: TaskRowVM; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen}
        className="group w-full rounded-md px-1 -mx-1 py-0.5 text-left transition-colors hover:bg-foreground/[0.04]">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span
              className="min-w-0 truncate text-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 group-hover:decoration-foreground"
              title={t.name}
            >
              {t.name}
            </span>
            <TaskStatusChip status={t.task.status} />
          </span>
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
  tasks, effortTotal, workload, projectId, projectName, managerName, clientName, clientId,
}: {
  tasks: TaskRowVM[];
  effortTotal: string | null;
  workload: WorkloadPersonVM[];
  projectId: number;
  projectName: string;
  managerName?: string | null;
  clientName?: string | null;
  clientId?: number | null;
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

        <ExecCard title="Workload by resource">
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
          managerName={managerName} clientName={clientName} clientId={clientId}
        />
      ) : null}
    </section>
  );
}

const TASK_STATUS_OPTS: TaskStatus[] = ['to_do', 'in_progress', 'blocked', 'done'];

// Task-detail popup (item 7): INTERACTIVE — edit status, allocated hours, and
// assignees, and add a note, all saved live. Also shows project, PM, and the
// allocated-vs-logged hours. Closes on X, Escape, or outside click.
function TaskDetailModal({
  t, onClose, projectId, projectName, managerName, clientName, clientId,
}: {
  t: TaskRowVM;
  onClose: () => void;
  projectId: number;
  projectName: string;
  managerName?: string | null;
  clientName?: string | null;
  clientId?: number | null;
}) {
  const task = t.task;
  const updateTask = useUpdateTask();
  const createNote = useCreateClientNote();
  const usersQ = useUsers();
  const notesQ = useProjectNotes(projectId);
  const notes = (notesQ.data ?? []).filter(
    (n) => n.task_id === t.taskId || (n.task_id == null && n.project_id === projectId),
  );
  // Assigned resources (read-only). Prefer resolving assignee_ids against the
  // users list for full names; fall back to the name strings the breakdown ships.
  // This binds to the live task data, so assigning someone elsewhere shows here as
  // soon as the breakdown query refetches.
  const usersById = new Map((usersQ.data ?? []).map((u) => [u.id, u.full_name]));
  const assignedNames: string[] =
    task.assignee_ids && task.assignee_ids.length
      ? task.assignee_ids.map((id) => usersById.get(id) ?? `#${id}`)
      : (task.assignees ?? []);

  const [status, setStatus] = useState<TaskStatus>(task.status as TaskStatus);
  const [alloc, setAlloc] = useState<string>(t.allocated != null ? String(t.allocated) : '');
  const [noteText, setNoteText] = useState('');

  const save = (data: Parameters<typeof updateTask.mutate>[0]['data']) =>
    updateTask.mutate({ id: t.taskId, data });

  const addNote = () => {
    const body = noteText.trim();
    if (!body || clientId == null) return;
    createNote.mutate({ clientId, data: { body, project_id: projectId, task_id: t.taskId } });
    setNoteText('');
  };

  return (
    <Modal open onClose={onClose} title={t.name} className="max-w-lg">
      <div className="space-y-4 text-sm">
        <Row label="Project">{projectName}{clientName ? ` · ${clientName}` : ''}</Row>
        <Row label="Manager">{managerName || '—'}</Row>
        <Row label="Hours">
          <span className={cn('tabular-nums', t.over ? 'font-semibold text-rose-600 dark:text-rose-400' : 'text-foreground')}>
            {t.allocated != null ? `${t.allocated}h allocated / ${t.logged}h logged` : `${t.logged}h logged`}
          </span>
        </Row>

        {/* Editable: status + allocated hours */}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Status</span>
            <select
              value={status}
              onChange={(e) => { const v = e.target.value as TaskStatus; setStatus(v); save({ status: v }); }}
              className="mt-1 w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              {TASK_STATUS_OPTS.map((s) => <option key={s} value={s}>{TASK_STATUS_LABEL[s] ?? s}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Allocated hours</span>
            <Input
              type="number" min="0" step="1" value={alloc}
              onChange={(e) => setAlloc(e.target.value)}
              onBlur={() => save({ estimated_hours: alloc === '' ? null : Number(alloc) })}
              className="mt-1 h-9"
              placeholder="e.g. 100"
            />
          </label>
        </div>

        {/* Assigned to (read-only) — reflects the current assignment live. */}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Assigned to</p>
          {assignedNames.length ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {assignedNames.map((name, i) => (
                <span key={`${name}-${i}`} className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground">
                  {name}
                </span>
              ))}
            </div>
          ) : <p className="mt-0.5 text-[13px] text-muted-foreground">No one assigned yet.</p>}
        </div>

        {task.description ? (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Description</p>
            <p className="mt-0.5 whitespace-pre-wrap text-foreground">{task.description}</p>
          </div>
        ) : null}

        {/* Notes: list + add */}
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
          ) : <p className="mt-0.5 text-[13px] text-muted-foreground">No notes yet.</p>}
          {clientId != null ? (
            <div className="mt-2 flex items-start gap-2">
              <textarea
                value={noteText} onChange={(e) => setNoteText(e.target.value)}
                placeholder="Add a note…" rows={2}
                className="min-h-0 flex-1 resize-y rounded-lg border border-border bg-card px-2.5 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <Button size="sm" onClick={addNote} disabled={!noteText.trim() || createNote.isPending}>Add</Button>
            </div>
          ) : null}
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
