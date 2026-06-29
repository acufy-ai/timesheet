import { useMemo, useState } from 'react';
import {
  LayoutGrid, Table2, CalendarDays, GanttChartSquare, ChevronLeft, ChevronRight, Plus,
} from 'lucide-react';

import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useUpdateTask, useTaskDependencies } from '@/hooks/useAdmin';
import { initials, avatarTone } from '@/lib/avatar';
import type { FullTask, FullProject, TaskStatus, TaskPriority } from '@/types/admin';

// Flexible task views for a project's tasks: List (default) / Grid / Kanban /
// Calendar / Gantt. Same task data, different perspectives. Status/dates/priority
// are editable inline (the views the user toggles between drive what's editable);
// name/assignees still go through the existing Edit Task modal (onEditTask).

type ViewKey = 'list' | 'grid' | 'kanban' | 'calendar' | 'gantt';

const VIEWS: { key: ViewKey; label: string; Icon: typeof Table2 }[] = [
  { key: 'list', label: 'List', Icon: Table2 },
  { key: 'grid', label: 'Grid', Icon: LayoutGrid },
  { key: 'kanban', label: 'Board', Icon: LayoutGrid },
  { key: 'calendar', label: 'Calendar', Icon: CalendarDays },
  { key: 'gantt', label: 'Timeline', Icon: GanttChartSquare },
];

const STATUS_ORDER: TaskStatus[] = ['to_do', 'in_progress', 'blocked', 'done'];
const STATUS_LABEL: Record<TaskStatus, string> = {
  to_do: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done',
};
const STATUS_DOT: Record<TaskStatus, string> = {
  to_do: 'bg-muted-foreground/40', in_progress: 'bg-primary', blocked: 'bg-rose-500', done: 'bg-emerald-500',
};
const STATUS_BAR: Record<TaskStatus, string> = {
  to_do: 'bg-muted-foreground/50', in_progress: 'bg-primary', blocked: 'bg-rose-500', done: 'bg-emerald-500',
};
const PRIORITY_LABEL: Record<TaskPriority, string> = { low: 'Low', medium: 'Medium', high: 'High' };
const PRIORITY_DOT: Record<TaskPriority, string> = {
  high: 'bg-rose-500', medium: 'bg-amber-500', low: 'bg-muted-foreground',
};

const selClass =
  'cursor-pointer rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px] font-medium text-foreground hover:border-primary/40 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 disabled:opacity-60';
const dateClass =
  'rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px] text-foreground hover:border-primary/40 focus:border-primary focus:outline-none';

// ── helpers ──────────────────────────────────────────────────────────────────
const ymd = (d: Date) => `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
const parse = (iso?: string | null) => (iso ? new Date(`${iso}T00:00:00`) : null);
const dayDiff = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

export function ProjectTaskViews({
  project, tasks, nameOf, onAddTask, onEditTask, renderList, views,
}: {
  project: FullProject;
  tasks: FullTask[];
  nameOf: (uid: number) => string;
  onAddTask: () => void;
  onEditTask: (t: FullTask) => void;
  // The existing List rendering is passed in so 'List' stays byte-identical.
  renderList: () => React.ReactNode;
  // Which view tabs to offer. Defaults to all; pass a subset to hide some.
  views?: ViewKey[];
}) {
  const shownViews = views ? VIEWS.filter((v) => views.includes(v.key)) : VIEWS;
  const [view, setView] = useState<ViewKey>('list');
  const update = useUpdateTask();
  const patch = (t: FullTask, data: Partial<FullTask>) =>
    void update.mutateAsync({ id: t.id, data: { project_id: t.project_id, ...data } as never });

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
          {shownViews.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setView(key)}
              className={cn('inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium transition-colors',
                view === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>
        <Button size="sm" variant="secondary" onClick={onAddTask}>
          <Plus className="h-3.5 w-3.5" /> Add task
        </Button>
      </div>

      {tasks.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No tasks yet. Add one and assign it to your team.
        </p>
      ) : view === 'list' ? (
        renderList()
      ) : view === 'grid' ? (
        <GridView tasks={tasks} nameOf={nameOf} onEditTask={onEditTask} patch={patch} busy={update.isPending} />
      ) : view === 'kanban' ? (
        <KanbanView tasks={tasks} nameOf={nameOf} onEditTask={onEditTask} patch={patch} />
      ) : view === 'calendar' ? (
        <CalendarView tasks={tasks} onEditTask={onEditTask} />
      ) : (
        <GanttView project={project} tasks={tasks} onEditTask={onEditTask} />
      )}
    </div>
  );
}

// ── Grid: dense table with inline status / priority / dates ──────────────────
function GridView({
  tasks, nameOf, onEditTask, patch, busy,
}: {
  tasks: FullTask[];
  nameOf: (uid: number) => string;
  onEditTask: (t: FullTask) => void;
  patch: (t: FullTask, d: Partial<FullTask>) => void;
  busy: boolean;
}) {
  type SortKey = 'name' | 'status' | 'priority' | 'start' | 'due';
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const sorted = useMemo(() => {
    const val = (t: FullTask): string | number => {
      switch (sort.key) {
        case 'name': return t.name.toLowerCase();
        case 'status': return STATUS_ORDER.indexOf((t.status ?? 'to_do') as TaskStatus);
        case 'priority': return ['low', 'medium', 'high'].indexOf(t.priority ?? 'medium');
        case 'start': return t.start_date ?? '9999';
        case 'due': return t.due_date ?? '9999';
      }
    };
    return [...tasks].sort((a, b) => {
      const va = val(a); const vb = val(b);
      if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb) * sort.dir;
      return ((va as number) - (vb as number)) * sort.dir;
    });
  }, [tasks, sort]);
  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }));
  const Th = ({ k, children, right }: { k: SortKey; children: React.ReactNode; right?: boolean }) => (
    <th className={cn('table-header-cell cursor-pointer select-none whitespace-nowrap', right && 'text-right')} onClick={() => onSort(k)}>
      {children}{sort.key === k ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
    </th>
  );

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead><tr className="table-header-row">
          <Th k="name">Task</Th>
          <Th k="status">Status</Th>
          <Th k="priority">Priority</Th>
          <th className="table-header-cell">Assignees</th>
          <Th k="start">Start</Th>
          <Th k="due">Due</Th>
        </tr></thead>
        <tbody>
          {sorted.map((t) => {
            const status = (t.status ?? 'to_do') as TaskStatus;
            const priority = (t.priority ?? 'medium') as TaskPriority;
            const ids = t.assignee_ids ?? [];
            return (
              <tr key={t.id} className="border-b border-border/60 last:border-0 hover:bg-primary/[0.03]">
                <td className="px-4 py-2 font-medium text-foreground">
                  <button type="button" onClick={() => onEditTask(t)} className="rounded text-left underline-offset-2 hover:text-primary hover:underline">{t.name}</button>
                </td>
                <td className="px-4 py-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[status])} />
                    <select value={status} disabled={busy} onChange={(e) => patch(t, { status: e.target.value as TaskStatus })} className={selClass} aria-label={`Status for ${t.name}`}>
                      {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                    </select>
                  </span>
                </td>
                <td className="px-4 py-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn('h-2 w-2 rounded-full', PRIORITY_DOT[priority])} />
                    <select value={priority} disabled={busy} onChange={(e) => patch(t, { priority: e.target.value as TaskPriority })} className={selClass} aria-label={`Priority for ${t.name}`}>
                      {(['low', 'medium', 'high'] as TaskPriority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                    </select>
                  </span>
                </td>
                <td className="px-4 py-2">
                  {ids.length ? (
                    <span className="flex items-center">
                      {ids.slice(0, 3).map((id, i) => {
                        const nm = nameOf(id);
                        return <span key={id} title={nm} className={cn('grid h-6 w-6 place-items-center rounded-full text-[9px] font-semibold ring-2 ring-card', avatarTone(nm), i > 0 && '-ml-1.5')}>{initials(nm)}</span>;
                      })}
                      {ids.length > 3 ? <span className="-ml-1.5 grid h-6 w-6 place-items-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground ring-2 ring-card">+{ids.length - 3}</span> : null}
                    </span>
                  ) : <span className="text-xs italic text-muted-foreground">Unassigned</span>}
                </td>
                <td className="px-4 py-2"><input type="date" value={t.start_date ?? ''} onChange={(e) => patch(t, { start_date: e.target.value || null })} className={dateClass} aria-label={`Start date for ${t.name}`} /></td>
                <td className="px-4 py-2"><input type="date" value={t.due_date ?? ''} onChange={(e) => patch(t, { due_date: e.target.value || null })} className={dateClass} aria-label={`Due date for ${t.name}`} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Kanban: status columns, drag a card to change status ─────────────────────
function KanbanView({
  tasks, nameOf, onEditTask, patch,
}: {
  tasks: FullTask[];
  nameOf: (uid: number) => string;
  onEditTask: (t: FullTask) => void;
  patch: (t: FullTask, d: Partial<FullTask>) => void;
}) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [overCol, setOverCol] = useState<TaskStatus | null>(null);
  const byStatus = (s: TaskStatus) => tasks.filter((t) => (t.status ?? 'to_do') === s);

  const drop = (s: TaskStatus) => {
    const t = tasks.find((x) => x.id === dragId);
    if (t && (t.status ?? 'to_do') !== s) patch(t, { status: s });
    setDragId(null); setOverCol(null);
  };

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {STATUS_ORDER.map((s) => (
        <div
          key={s}
          onDragOver={(e) => { e.preventDefault(); setOverCol(s); }}
          onDragLeave={() => setOverCol((c) => (c === s ? null : c))}
          onDrop={() => drop(s)}
          className={cn('rounded-xl border bg-muted/30 p-2', overCol === s ? 'border-primary' : 'border-border')}
        >
          <div className="mb-2 flex items-center gap-1.5 px-1">
            <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[s])} />
            <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{STATUS_LABEL[s]}</span>
            <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">{byStatus(s).length}</span>
          </div>
          <div className="space-y-2">
            {byStatus(s).map((t) => {
              const ids = t.assignee_ids ?? [];
              const priority = (t.priority ?? 'medium') as TaskPriority;
              return (
                <div
                  key={t.id}
                  draggable
                  onDragStart={() => setDragId(t.id)}
                  onDragEnd={() => { setDragId(null); setOverCol(null); }}
                  className="cursor-grab rounded-lg border border-border bg-card p-2.5 shadow-sm active:cursor-grabbing"
                >
                  <button type="button" onClick={() => onEditTask(t)} className="block text-left text-[13px] font-medium text-foreground hover:text-primary">{t.name}</button>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <span className={cn('h-1.5 w-1.5 rounded-full', PRIORITY_DOT[priority])} />{PRIORITY_LABEL[priority]}
                      {t.due_date ? <span className="ml-1 text-muted-foreground">· due {parse(t.due_date)!.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span> : null}
                    </span>
                    {ids.length ? (
                      <span className="flex items-center">
                        {ids.slice(0, 3).map((id, i) => {
                          const nm = nameOf(id);
                          return <span key={id} title={nm} className={cn('grid h-5 w-5 place-items-center rounded-full text-[8px] font-semibold ring-2 ring-card', avatarTone(nm), i > 0 && '-ml-1.5')}>{initials(nm)}</span>;
                        })}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {byStatus(s).length === 0 ? <p className="px-1 py-3 text-center text-[11px] text-muted-foreground">Drop tasks here</p> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Calendar: month grid, task chips on their due date ───────────────────────
function CalendarView({ tasks, onEditTask }: { tasks: FullTask[]; onEditTask: (t: FullTask) => void }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const startPad = first.getDay(); // Sun-first
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(month.getFullYear(), month.getMonth(), d));
  while (cells.length % 7 !== 0) cells.push(null);

  const dueOn = (d: Date) => tasks.filter((t) => t.due_date && t.due_date === ymd(d));
  const undated = tasks.filter((t) => !t.due_date);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-foreground">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="rounded-md border border-border p-1 text-muted-foreground hover:text-foreground"><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }} className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">Today</button>
          <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="rounded-md border border-border p-1 text-muted-foreground hover:text-foreground"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border text-center">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div key={d} className="bg-muted/50 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{d}</div>
        ))}
        {cells.map((d, i) => (
          <div key={i} className="min-h-[78px] bg-card p-1 text-left align-top">
            {d ? (
              <>
                <span className={cn('text-[11px]', ymd(d) === ymd(new Date()) ? 'font-bold text-primary' : 'text-muted-foreground')}>{d.getDate()}</span>
                <div className="mt-0.5 space-y-0.5">
                  {dueOn(d).slice(0, 3).map((t) => {
                    const status = (t.status ?? 'to_do') as TaskStatus;
                    return (
                      <button key={t.id} type="button" onClick={() => onEditTask(t)} title={t.name}
                        className={cn('block w-full truncate rounded px-1 py-0.5 text-left text-[10px] font-medium text-white', STATUS_BAR[status])}>
                        {t.name}
                      </button>
                    );
                  })}
                  {dueOn(d).length > 3 ? <span className="px-1 text-[9px] text-muted-foreground">+{dueOn(d).length - 3} more</span> : null}
                </div>
              </>
            ) : null}
          </div>
        ))}
      </div>
      {undated.length ? (
        <p className="text-[11px] text-muted-foreground">{undated.length} task{undated.length === 1 ? '' : 's'} with no due date (set due dates in Grid to place them).</p>
      ) : null}
    </div>
  );
}

// ── Gantt: timeline bars + dependency arrows + critical path ─────────────────
function GanttView({ project, tasks, onEditTask }: { project: FullProject; tasks: FullTask[]; onEditTask: (t: FullTask) => void }) {
  const deps = useTaskDependencies(project.id);
  // Tasks with at least a due date can be placed; default a 1-day bar when only
  // due is set, or start..due when both.
  const dated = tasks.filter((t) => t.start_date || t.due_date);
  const undated = tasks.length - dated.length;

  const range = useMemo(() => {
    const ds: Date[] = [];
    dated.forEach((t) => { const s = parse(t.start_date) ?? parse(t.due_date); const e = parse(t.due_date) ?? parse(t.start_date); if (s) ds.push(s); if (e) ds.push(e); });
    if (!ds.length) return null;
    const min = new Date(Math.min(...ds.map((d) => d.getTime())));
    const max = new Date(Math.max(...ds.map((d) => d.getTime())));
    min.setDate(min.getDate() - 2); max.setDate(max.getDate() + 2);
    return { min, max, days: dayDiff(min, max) + 1 };
  }, [dated]);

  // Critical path: longest dependency chain by total duration (simple DAG longest-path).
  const critical = useMemo(() => {
    if (!deps.data?.length) return new Set<number>();
    const dur = (id: number) => { const t = tasks.find((x) => x.id === id); const s = parse(t?.start_date); const e = parse(t?.due_date); return s && e ? Math.max(1, dayDiff(s, e) + 1) : 1; };
    const preds = new Map<number, number[]>(); // task -> tasks it depends on
    deps.data.forEach((d) => { const a = preds.get(d.task_id) ?? []; a.push(d.depends_on_task_id); preds.set(d.task_id, a); });
    const memo = new Map<number, { len: number; path: number[] }>();
    const best = (id: number): { len: number; path: number[] } => {
      if (memo.has(id)) return memo.get(id)!;
      const ps = preds.get(id) ?? [];
      let chosen = { len: 0, path: [] as number[] };
      for (const p of ps) { const b = best(p); if (b.len > chosen.len) chosen = b; }
      const res = { len: chosen.len + dur(id), path: [...chosen.path, id] };
      memo.set(id, res); return res;
    };
    let top = { len: 0, path: [] as number[] };
    tasks.forEach((t) => { const b = best(t.id); if (b.len > top.len) top = b; });
    return new Set(top.path);
  }, [deps.data, tasks]);

  if (!range) {
    return <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">No task has a start or due date yet. Add dates in Grid to see the timeline.</p>;
  }

  const LABEL_W = 180;
  const DAY_W = 26;
  const left = (d: Date) => dayDiff(range.min, d) * DAY_W;
  const idIndex = new Map(dated.map((t, i) => [t.id, i]));
  const ROW_H = 30;

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-border">
        <div style={{ minWidth: LABEL_W + range.days * DAY_W }}>
          {/* header: day ticks */}
          <div className="flex border-b border-border bg-muted/40 text-[9px] text-muted-foreground" style={{ paddingLeft: LABEL_W }}>
            {Array.from({ length: range.days }).map((_, i) => {
              const d = new Date(range.min); d.setDate(d.getDate() + i);
              const isMonth = d.getDate() === 1 || i === 0;
              return <div key={i} className="shrink-0 border-l border-border/50 py-0.5 text-center" style={{ width: DAY_W }}>{isMonth ? d.toLocaleDateString(undefined, { month: 'short' }) : d.getDate()}</div>;
            })}
          </div>
          {/* rows */}
          <div className="relative">
            {dated.map((t) => {
              const s = parse(t.start_date) ?? parse(t.due_date)!;
              const e = parse(t.due_date) ?? parse(t.start_date)!;
              const w = Math.max(DAY_W, (dayDiff(s, e) + 1) * DAY_W);
              const status = (t.status ?? 'to_do') as TaskStatus;
              const onCritical = critical.has(t.id);
              return (
                <div key={t.id} className="flex items-center border-b border-border/40" style={{ height: ROW_H }}>
                  <div className="shrink-0 truncate px-2 text-[12px] text-foreground" style={{ width: LABEL_W }} title={t.name}>
                    {onCritical ? <span className="mr-1 text-rose-500">●</span> : null}{t.name}
                  </div>
                  <div className="relative h-full flex-1">
                    <button
                      type="button"
                      onClick={() => onEditTask(t)}
                      title={`${t.name}${t.start_date ? ` · ${t.start_date}` : ''}${t.due_date ? ` → ${t.due_date}` : ''}`}
                      className={cn('absolute top-1/2 -translate-y-1/2 rounded-md text-left', STATUS_BAR[status], onCritical && 'ring-2 ring-rose-400')}
                      style={{ left: left(s), width: w, height: 16 }}
                    />
                  </div>
                </div>
              );
            })}
            {/* dependency arrows (simple elbow connectors) */}
            <svg className="pointer-events-none absolute inset-0 h-full w-full" style={{ left: LABEL_W, width: range.days * DAY_W }}>
              {(deps.data ?? []).map((d) => {
                const fi = idIndex.get(d.depends_on_task_id); const ti = idIndex.get(d.task_id);
                const from = dated.find((x) => x.id === d.depends_on_task_id); const to = dated.find((x) => x.id === d.task_id);
                if (fi == null || ti == null || !from || !to) return null;
                const fe = parse(from.due_date) ?? parse(from.start_date)!;
                const ts = parse(to.start_date) ?? parse(to.due_date)!;
                const x1 = left(fe) + DAY_W; const y1 = fi * ROW_H + ROW_H / 2;
                const x2 = left(ts); const y2 = ti * ROW_H + ROW_H / 2;
                const crit = critical.has(d.task_id) && critical.has(d.depends_on_task_id);
                return <path key={d.id} d={`M ${x1} ${y1} L ${x1 + 8} ${y1} L ${x1 + 8} ${y2} L ${x2} ${y2}`} fill="none" stroke={crit ? '#f43f5e' : 'currentColor'} strokeWidth={crit ? 1.5 : 1} className={crit ? '' : 'text-muted-foreground/40'} markerEnd="url(#arrow)" />;
              })}
              <defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="currentColor" className="text-muted-foreground/60" /></marker></defs>
            </svg>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="text-rose-500">●</span> on critical path</span>
        {undated ? <span>{undated} task{undated === 1 ? '' : 's'} with no dates (hidden)</span> : null}
      </div>
    </div>
  );
}
