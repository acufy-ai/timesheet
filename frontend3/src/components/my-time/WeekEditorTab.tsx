import { useEffect, useMemo, useState } from 'react';
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Loader2,
  Pencil,
  Plus,
  Save,
  Send,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';

import { Button, Card } from '@/components/ui';
import { timeApi } from '@/api/client';
import {
  useCreateEntry,
  useDeleteEntry,
  useMyEntries,
  useProjects,
  useRecallEntries,
  useSubmitEntries,
  useTasks,
  useUpdateEntry,
  useWeeklySubmitStatus,
} from '@/hooks/useTime';
import {
  addDays,
  diffHours,
  formatTime12h,
  isSameDay,
  startOfWeek,
  toApiTime,
  toISODate,
  trimSeconds,
  weekDays,
} from '@/lib/date';
import type { Project, Task, TimeEntry } from '@/types/time';

// My Time — full functional parity with frontend2's WeekEditor:
//   - inline editable table (Start / End / Project / Task / Hours / Billable /
//     Description) with edit-in-place and delete
//   - auto-derive hours from a start/end block unless hours is hand-typed
//   - submit week for approval; recall a submitted week back to draft
//   - copy a day from yesterday / last week / a picked date; copy the whole
//     last week (with or without hours)
// Only the visual styling differs from frontend2; fields, validation, and the
// API payloads are identical.

// Time-off entries live on their own surface; keep them out of the editor.
const TIME_OFF_PREFIX_REGEX = /^\[(SICK_DAY|PTO|HOLIDAY|HALF_DAY|BEREAVEMENT|JURY_DUTY|UNPAID|OTHER)\]/;

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const toNum = (v: string | number | null | undefined): number => {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const fmtH = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '0.00');
const fmt12h = (v: string | null | undefined): string => formatTime12h(v) ?? 'N/A';
const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;
const isEditableStatus = (s: TimeEntry['status']) => s === 'DRAFT' || s === 'REJECTED';

function extractError(err: unknown): string {
  const e = err as { response?: { data?: { detail?: string } }; message?: string };
  return e?.response?.data?.detail ?? e?.message ?? 'Something went wrong.';
}

// Draft row state. Negative tempId for not-yet-saved rows; entryId set once it
// maps to a saved entry. Time fields are local "HH:MM" strings ('' = none).
interface EntryDraft {
  tempId: number;
  entryId?: number;
  project_id: number;
  task_id: number | null;
  hours: string;
  is_billable: boolean;
  description: string;
  start_time: string;
  end_time: string;
  hours_dirty: boolean; // user typed Hours → stop auto-deriving from start/end
}

export function WeekEditorTab({ initialWeek, initialDay }: { initialWeek?: string; initialDay?: string } = {}) {
  const today = useMemo(() => new Date(), []);
  const [weekAnchor, setWeekAnchor] = useState(() =>
    initialDay ? new Date(`${initialDay}T00:00:00`) : initialWeek ? new Date(`${initialWeek}T00:00:00`) : new Date(),
  );
  const weekStart = useMemo(() => startOfWeek(weekAnchor), [weekAnchor]);
  const days = useMemo(() => weekDays(weekStart), [weekStart]);
  const weekStartIso = toISODate(days[0]);
  const weekEndIso = toISODate(days[6]);

  const [selectedDay, setSelectedDay] = useState<Date>(() => {
    // "Fix in editor" passes the exact rejected day — open it directly.
    if (initialDay) return new Date(`${initialDay}T00:00:00`);
    // Anchored to a specific (past) week with no day -> first day of that week.
    if (initialWeek) return startOfWeek(new Date(`${initialWeek}T00:00:00`));
    const inWeek = weekDays(startOfWeek(new Date())).some((d) => isSameDay(d, new Date()));
    return inWeek ? new Date() : startOfWeek(new Date());
  });
  const selectedIso = toISODate(selectedDay);

  // When the week moves, keep the selection inside it.
  useEffect(() => {
    if (selectedDay < days[0] || selectedDay > days[6]) {
      const inWeek = days.find((d) => isSameDay(d, today));
      setSelectedDay(inWeek ?? days[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStartIso, weekEndIso]);

  // ── Data ────────────────────────────────────────────────────────
  const entriesQ = useMyEntries(weekStartIso, weekEndIso);
  const prevWeekStart = toISODate(addDays(days[0], -7));
  const prevWeekEnd = toISODate(addDays(days[6], -7));
  const prevWeekQ = useMyEntries(prevWeekStart, prevWeekEnd);
  const projectsQ = useProjects();
  const tasksQ = useTasks();
  const weeklyStatusQ = useWeeklySubmitStatus();

  const create = useCreateEntry();
  const update = useUpdateEntry();
  const del = useDeleteEntry();
  const submit = useSubmitEntries();
  const recall = useRecallEntries();

  const projects = projectsQ.data ?? [];
  const allTasks = tasksQ.data ?? [];

  const visibleEntries = useMemo(
    () => (entriesQ.data ?? []).filter((e) => !TIME_OFF_PREFIX_REGEX.test(e.description)),
    [entriesQ.data],
  );

  const projectsById = useMemo(() => {
    const m: Record<number, Project> = {};
    projects.forEach((p) => { m[p.id] = p; });
    return m;
  }, [projects]);
  const tasksById = useMemo(() => {
    const m: Record<number, Task> = {};
    allTasks.forEach((t) => { m[t.id] = t; });
    return m;
  }, [allTasks]);

  // ── Local edit state + flash ──────────────────────────────────────
  const [editing, setEditing] = useState<Record<string, EntryDraft>>({});
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  // When editing an EXISTING entry the backend requires a real edit reason +
  // history summary (auditable). We prompt for it instead of fabricating one.
  const [reasonPrompt, setReasonPrompt] = useState<{ key: string; reason: string } | null>(null);
  const flashAndFade = (tone: 'ok' | 'err', text: string) => {
    setFlash({ tone, text });
    window.setTimeout(() => setFlash(null), 4000);
  };

  // ── Derived ───────────────────────────────────────────────────────
  const dayHoursByKey = useMemo(() => {
    const map: Record<string, { total: number; billable: number; nonBillable: number }> = {};
    days.forEach((d) => { map[toISODate(d)] = { total: 0, billable: 0, nonBillable: 0 }; });
    visibleEntries.forEach((e) => {
      const slot = map[e.entry_date];
      if (!slot) return;
      const h = toNum(e.hours);
      slot.total += h;
      if (e.is_billable) slot.billable += h; else slot.nonBillable += h;
    });
    return map;
  }, [visibleEntries, days]);

  const weekTotals = useMemo(() => {
    let total = 0, billable = 0, nonBillable = 0;
    Object.values(dayHoursByKey).forEach((d) => {
      total += d.total; billable += d.billable; nonBillable += d.nonBillable;
    });
    return { total, billable, nonBillable };
  }, [dayHoursByKey]);

  const dayEntries = useMemo(
    () =>
      visibleEntries
        .filter((e) => e.entry_date === selectedIso)
        .sort((a, b) => {
          const sa = a.start_time ?? '';
          const sb = b.start_time ?? '';
          if (sa && sb && sa !== sb) return sa.localeCompare(sb);
          if (sa && !sb) return -1;
          if (!sa && sb) return 1;
          return (a.id ?? 0) - (b.id ?? 0);
        }),
    [visibleEntries, selectedIso],
  );

  const byProjectWeek = useMemo(() => {
    const acc: Record<string, { project: string; task: string; hours: number }> = {};
    visibleEntries.forEach((e) => {
      const key = `${e.project_id}|${e.task_id ?? 0}`;
      if (!acc[key]) {
        acc[key] = {
          project: projectsById[e.project_id]?.name ?? e.project?.name ?? 'Unknown project',
          task: e.task_id ? (tasksById[e.task_id]?.name ?? 'Task') : 'No task',
          hours: 0,
        };
      }
      acc[key].hours += toNum(e.hours);
    });
    return Object.values(acc).sort((a, b) => b.hours - a.hours);
  }, [visibleEntries, projectsById, tasksById]);

  const submittedIds = useMemo(
    () => visibleEntries.filter((e) => e.status === 'SUBMITTED').map((e) => e.id),
    [visibleEntries],
  );
  const isLocked = submittedIds.length > 0;
  const submittedAt = useMemo(
    () => visibleEntries.find((e) => e.status === 'SUBMITTED' && e.submitted_at)?.submitted_at ?? null,
    [visibleEntries],
  );
  const draftIds = useMemo(
    () => visibleEntries.filter((e) => e.status === 'DRAFT').map((e) => e.id),
    [visibleEntries],
  );

  const selectedMetrics = dayHoursByKey[selectedIso] ?? { total: 0, billable: 0, nonBillable: 0 };

  // ── Row helpers ───────────────────────────────────────────────────
  function startEdit(entry: TimeEntry) {
    setEditing((prev) => ({
      ...prev,
      [`e${entry.id}`]: {
        tempId: -1,
        entryId: entry.id,
        project_id: entry.project_id,
        task_id: entry.task_id ?? null,
        hours: String(entry.hours),
        is_billable: !!entry.is_billable,
        description: entry.description ?? '',
        start_time: trimSeconds(entry.start_time),
        end_time: trimSeconds(entry.end_time),
        hours_dirty: true,
      },
    }));
  }
  function startNew() {
    const tempId = -1 * (Object.keys(editing).length + 1) - performance.now();
    setEditing((prev) => ({
      ...prev,
      [`t${tempId}`]: {
        tempId,
        project_id: 0,
        task_id: null,
        hours: '',
        is_billable: true,
        description: '',
        start_time: '',
        end_time: '',
        hours_dirty: false,
      },
    }));
  }
  function cancelEdit(key: string) {
    setEditing((prev) => {
      const rest = { ...prev };
      delete rest[key];
      return rest;
    });
  }
  function patchDraft(key: string, patch: Partial<EntryDraft>) {
    setEditing((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], ...patch } } : prev));
  }

  // Validate the draft; for an EXISTING entry, open the edit-reason prompt
  // (the backend requires a real reason). New entries save immediately.
  function saveRow(key: string) {
    const draft = editing[key];
    if (!draft) return;
    if (!draft.project_id) { flashAndFade('err', 'Pick a project before saving.'); return; }
    let hours = toNum(draft.hours);
    const startStr = draft.start_time.trim();
    const endStr = draft.end_time.trim();
    if (startStr && endStr && hours <= 0) {
      const derived = diffHours(startStr, endStr);
      if (derived > 0) hours = derived;
    }
    if (hours <= 0) { flashAndFade('err', 'Hours must be greater than zero.'); return; }
    if (draft.entryId) {
      setReasonPrompt({ key, reason: '' });
    } else {
      void commitSave(key);
    }
  }

  // Persist the draft. For edits, edit_reason + history_summary come from the
  // prompt (required by the backend); for creates they're omitted.
  async function commitSave(key: string, editReason?: string) {
    const draft = editing[key];
    if (!draft) return;
    let hours = toNum(draft.hours);
    const startStr = draft.start_time.trim();
    const endStr = draft.end_time.trim();
    if (startStr && endStr && hours <= 0) {
      const derived = diffHours(startStr, endStr);
      if (derived > 0) hours = derived;
    }
    const startToSend = startStr ? toApiTime(startStr) : null;
    const endToSend = endStr ? toApiTime(endStr) : null;
    try {
      if (draft.entryId) {
        const reason = (editReason ?? '').trim();
        await update.mutateAsync({
          id: draft.entryId,
          data: {
            project_id: draft.project_id,
            task_id: draft.task_id ?? null,
            entry_date: selectedIso,
            start_time: startToSend,
            end_time: endToSend,
            hours,
            description: draft.description,
            is_billable: draft.is_billable,
            edit_reason: reason,
            history_summary: reason,
          },
        });
      } else {
        await create.mutateAsync({
          project_id: draft.project_id,
          task_id: draft.task_id ?? null,
          entry_date: selectedIso,
          start_time: startToSend,
          end_time: endToSend,
          hours,
          description: draft.description,
          is_billable: draft.is_billable,
        });
      }
      setReasonPrompt(null);
      cancelEdit(key);
      flashAndFade('ok', 'Saved.');
    } catch (err) {
      flashAndFade('err', extractError(err));
    }
  }

  async function removeRow(entryId: number) {
    if (!window.confirm('Delete this entry?')) return;
    try {
      await del.mutateAsync(entryId);
      flashAndFade('ok', 'Deleted.');
    } catch (err) {
      flashAndFade('err', extractError(err));
    }
  }

  // ── Week actions ──────────────────────────────────────────────────
  async function handleSubmitWeek() {
    if (draftIds.length === 0) {
      flashAndFade('err', weeklyStatusQ.data?.reason ?? 'Nothing to submit.');
      return;
    }
    try {
      await submit.mutateAsync(draftIds);
      flashAndFade('ok', 'Submitted for approval.');
    } catch (err) {
      flashAndFade('err', extractError(err));
    }
  }
  async function handleRecall() {
    if (submittedIds.length === 0) return;
    try {
      await recall.mutateAsync(submittedIds);
      flashAndFade('ok', 'Submission recalled. Edit and resubmit when ready.');
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      flashAndFade(
        'err',
        status === 409
          ? 'Your manager already approved or rejected one or more entries. Refreshing.'
          : extractError(err),
      );
    }
  }

  async function copyFromDay(sourceIso: string) {
    const pool: TimeEntry[] = [
      ...visibleEntries,
      ...((prevWeekQ.data ?? []) as TimeEntry[]),
    ];
    let source = pool.filter(
      (e) => e.entry_date === sourceIso && !TIME_OFF_PREFIX_REGEX.test(e.description),
    );
    if (source.length === 0 && !pool.some((e) => e.entry_date === sourceIso)) {
      // Fall back to a one-shot fetch for arbitrary picked dates.
      try {
        const res = await timeApi.list({ start_date: sourceIso, end_date: sourceIso, limit: 100 });
        source = res.data.filter((e) => !TIME_OFF_PREFIX_REGEX.test(e.description));
      } catch { /* fall through */ }
    }
    if (source.length === 0) { flashAndFade('err', 'No entries to copy from that day.'); return; }
    try {
      await Promise.all(source.map((e) =>
        create.mutateAsync({
          project_id: e.project_id,
          task_id: e.task_id ?? null,
          entry_date: selectedIso,
          start_time: e.start_time ?? null,
          end_time: e.end_time ?? null,
          hours: toNum(e.hours),
          description: e.description,
          is_billable: e.is_billable,
        }),
      ));
      flashAndFade('ok', `Copied ${source.length} entr${source.length === 1 ? 'y' : 'ies'}.`);
    } catch (err) {
      flashAndFade('err', extractError(err));
    }
  }

  async function copyLastWeek(includeHours: boolean) {
    const prev = (prevWeekQ.data ?? []).filter((e) => !TIME_OFF_PREFIX_REGEX.test(e.description));
    if (prev.length === 0) { flashAndFade('err', 'Last week is empty.'); return; }
    try {
      await Promise.all(prev.map((e) => {
        const newDate = toISODate(addDays(new Date(`${e.entry_date}T00:00:00`), 7));
        return create.mutateAsync({
          project_id: e.project_id,
          task_id: e.task_id ?? null,
          entry_date: newDate,
          start_time: includeHours ? e.start_time ?? null : null,
          end_time: includeHours ? e.end_time ?? null : null,
          hours: includeHours ? toNum(e.hours) : 0.01,
          description: e.description,
          is_billable: e.is_billable,
        });
      }));
      flashAndFade('ok', `Copied last week${includeHours ? ' with hours' : ' (structure only)'}.`);
    } catch (err) {
      flashAndFade('err', extractError(err));
    }
  }

  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [pickCopyDate, setPickCopyDate] = useState('');

  const newRows = Object.entries(editing).filter(([k]) => k.startsWith('t'));
  const hasRows = dayEntries.length > 0 || newRows.length > 0;

  return (
    <div className="space-y-4">
      {/* Header: week nav + Today + week total */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card p-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setWeekAnchor((d) => addDays(d, -7))}
            aria-label="Previous week"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background hover:bg-muted"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-background px-3 text-sm">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            {days[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} –{' '}
            {days[6].toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
          </div>
          <button
            type="button"
            onClick={() => setWeekAnchor((d) => addDays(d, 7))}
            aria-label="Next week"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background hover:bg-muted"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => { setWeekAnchor(new Date()); setSelectedDay(new Date()); }}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-sm font-medium hover:bg-muted"
          >
            <Clock className="h-3.5 w-3.5" />
            Today
          </button>
        </div>
        <div className="flex-1" />
        <div className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-background px-3 text-sm">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Week</span>
          <span className="font-semibold tabular-nums">{fmtH(weekTotals.total)}h</span>
        </div>
      </div>

      {/* Submitted / recall banner */}
      {isLocked ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
              Submitted
            </span>
            <span className="text-sm text-foreground">
              {submittedAt ? (
                <>Submitted <strong className="text-amber-700 dark:text-amber-300">
                  {new Date(submittedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </strong>. Awaiting approval.</>
              ) : 'Awaiting approval. Recall to edit before it is reviewed.'}
            </span>
          </div>
          <Button variant="secondary" size="sm" onClick={handleRecall} disabled={recall.isPending}>
            <Undo2 className="h-3.5 w-3.5" />
            {recall.isPending ? 'Recalling…' : 'Recall submission'}
          </Button>
        </div>
      ) : null}

      {/* Flash */}
      {flash ? (
        <div
          role="alert"
          className={
            'rounded-xl border px-3 py-2 text-sm ' +
            (flash.tone === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300')
          }
        >
          {flash.text}
        </div>
      ) : null}

      {/* Three-column body */}
      <div className="grid gap-4 lg:grid-cols-[200px_minmax(0,1fr)_280px]">
        {/* Day rail */}
        <div className="flex flex-col gap-1 self-start rounded-2xl border border-border bg-card p-2">
          {days.map((d) => {
            const iso = toISODate(d);
            const m = dayHoursByKey[iso] ?? { total: 0, billable: 0, nonBillable: 0 };
            const billPct = m.total > 0 ? (m.billable / m.total) * 100 : 0;
            const isSel = isSameDay(d, selectedDay);
            const isToday = isSameDay(d, today);
            const dim = isWeekend(d) && m.total === 0;
            return (
              <button
                key={iso}
                type="button"
                onClick={() => { setSelectedDay(d); setCopyMenuOpen(false); }}
                className={
                  'relative rounded-xl border px-3 py-2.5 text-left transition ' +
                  (isSel ? 'border-primary/40 bg-primary/10' : 'border-transparent hover:bg-muted/40')
                }
              >
                {isToday ? (
                  <span className="absolute right-1.5 top-1.5 rounded border border-primary/30 bg-primary/10 px-1 py-0.5 text-[8px] font-bold tracking-wider text-primary">
                    TODAY
                  </span>
                ) : null}
                <div className={'text-[13px] font-semibold ' + (isSel ? 'text-primary' : dim ? 'text-muted-foreground' : 'text-foreground')}>
                  {DOW_SHORT[d.getDay()]}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </div>
                <div className={'mt-1 text-sm font-semibold tabular-nums ' + (m.total > 0 ? 'text-foreground' : 'text-muted-foreground')}>
                  {fmtH(m.total)}h
                </div>
                <div className="mt-1 flex h-[3px] overflow-hidden rounded-full bg-muted/60">
                  {m.total > 0 ? (
                    <>
                      <div className="h-full bg-emerald-500" style={{ width: `${billPct}%` }} />
                      <div className="h-full bg-muted-foreground/60" style={{ width: `${100 - billPct}%` }} />
                    </>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>

        {/* Day editor */}
        <Card className="min-w-0 p-4">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div>
              <h3 className="text-base font-semibold text-foreground">
                {DOW_LONG[selectedDay.getDay()]}, {selectedDay.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </h3>
              <p className="text-xs text-muted-foreground">All times in your local time zone.</p>
            </div>
            <span className={
              'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tabular-nums ' +
              (selectedMetrics.total > 0
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-border bg-muted/40 text-muted-foreground')
            }>
              {fmtH(selectedMetrics.total)} hours
            </span>
            <div className="flex-1" />
            {/* Copy from dropdown */}
            <div className="relative">
              <Button variant="secondary" size="md" onClick={() => setCopyMenuOpen((v) => !v)} disabled={isLocked}>
                <Copy className="h-3.5 w-3.5" />
                Copy from
                <ChevronDown className="h-3 w-3" />
              </Button>
              {copyMenuOpen ? (
                <div
                  className="absolute right-0 z-30 mt-1 w-64 rounded-xl border border-border bg-card p-1 shadow-xl"
                  onMouseLeave={() => setCopyMenuOpen(false)}
                >
                  <button
                    type="button"
                    onClick={() => { setCopyMenuOpen(false); copyFromDay(toISODate(addDays(selectedDay, -7))); }}
                    className="w-full rounded px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    Last week ({addDays(selectedDay, -7).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })})
                  </button>
                  <button
                    type="button"
                    onClick={() => { setCopyMenuOpen(false); copyFromDay(toISODate(addDays(selectedDay, -1))); }}
                    className="w-full rounded px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    Yesterday ({addDays(selectedDay, -1).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })})
                  </button>
                  <div className="my-1 border-t border-border" />
                  <div className="space-y-2 px-3 py-2">
                    <div className="text-[11px] text-muted-foreground">Pick a specific date</div>
                    <div className="flex gap-2">
                      <input
                        type="date"
                        value={pickCopyDate}
                        onChange={(e) => setPickCopyDate(e.target.value)}
                        className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
                      />
                      <button
                        type="button"
                        disabled={!pickCopyDate}
                        onClick={() => { setCopyMenuOpen(false); if (pickCopyDate) copyFromDay(pickCopyDate); }}
                        className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            <Button size="md" onClick={startNew} disabled={isLocked}>
              <Plus className="h-3.5 w-3.5" />
              Add entry
            </Button>
          </div>

          {entriesQ.isLoading ? (
            <div className="grid place-items-center py-16 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
            </div>
          ) : entriesQ.isError ? (
            <p className="py-10 text-center text-sm text-rose-600 dark:text-rose-300">
              Couldn't load your time entries. Try refreshing.
            </p>
          ) : !hasRows ? (
            <EmptyDay
              dayLabel={DOW_LONG[selectedDay.getDay()]}
              disabled={isLocked}
              onAdd={startNew}
              onCopyLastWeek={() => copyFromDay(toISODate(addDays(selectedDay, -7)))}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col style={{ width: '110px' }} />
                  <col style={{ width: '110px' }} />
                  <col />
                  <col />
                  <col style={{ width: '64px' }} />
                  <col style={{ width: '52px' }} />
                  <col />
                  <col style={{ width: '70px' }} />
                </colgroup>
                <thead>
                  <tr className="border-b border-border text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-1.5 py-2">Start</th>
                    <th className="px-1.5 py-2">End</th>
                    <th className="px-1.5 py-2">Project</th>
                    <th className="px-1.5 py-2">Task</th>
                    <th className="px-1.5 py-2 text-right">Hours</th>
                    <th className="px-1.5 py-2 text-center">Bill.</th>
                    <th className="px-1.5 py-2">Description</th>
                    <th className="px-1.5 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {dayEntries.map((entry) => {
                    const key = `e${entry.id}`;
                    const draft = editing[key];
                    return draft ? (
                      <EditRow
                        key={key}
                        draft={draft}
                        projects={projects}
                        allTasks={allTasks}
                        onPatch={(p) => patchDraft(key, p)}
                        onSave={() => saveRow(key)}
                        onCancel={() => cancelEdit(key)}
                        saving={update.isPending || create.isPending}
                      />
                    ) : (
                      <ViewRow
                        key={key}
                        entry={entry}
                        projectName={projectsById[entry.project_id]?.name ?? entry.project?.name ?? 'N/A'}
                        taskName={entry.task_id ? (tasksById[entry.task_id]?.name ?? 'N/A') : 'No task'}
                        locked={isLocked || !isEditableStatus(entry.status)}
                        onEdit={() => startEdit(entry)}
                        onDelete={() => removeRow(entry.id)}
                      />
                    );
                  })}
                  {newRows.map(([key, draft]) => (
                    <EditRow
                      key={key}
                      draft={draft}
                      projects={projects}
                      allTasks={allTasks}
                      onPatch={(p) => patchDraft(key, p)}
                      onSave={() => saveRow(key)}
                      onCancel={() => cancelEdit(key)}
                      saving={update.isPending || create.isPending}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Summaries */}
        <div className="space-y-3 self-start">
          <SummaryCard title="Day summary">
            <KV k="Billable" v={`${fmtH(selectedMetrics.billable)}h`} />
            <KV k="Non-billable" v={`${fmtH(selectedMetrics.nonBillable)}h`} muted={selectedMetrics.nonBillable === 0} />
            <KV k="Total" v={`${fmtH(selectedMetrics.total)}h`} />
          </SummaryCard>
          <SummaryCard title="Week summary">
            <KV k="Total hours" v={`${fmtH(weekTotals.total)}h`} />
            <KV k="Billable" v={`${fmtH(weekTotals.billable)}h`} />
            <KV k="Non-billable" v={`${fmtH(weekTotals.nonBillable)}h`} muted={weekTotals.nonBillable === 0} />
          </SummaryCard>
          <SummaryCard title="By project (week)">
            {byProjectWeek.length === 0 ? (
              <div className="py-2 text-xs text-muted-foreground">No entries yet this week.</div>
            ) : (
              <ul className="space-y-2.5">
                {byProjectWeek.map((row) => (
                  <li key={`${row.project}|${row.task}`} className="flex items-center justify-between text-sm">
                    <div className="min-w-0">
                      <div className="truncate text-foreground">{row.project}</div>
                      <div className="text-[11px] text-muted-foreground">{row.task}</div>
                    </div>
                    <div className="ml-2 font-semibold tabular-nums">{fmtH(row.hours)}h</div>
                  </li>
                ))}
              </ul>
            )}
          </SummaryCard>
        </div>
      </div>

      {/* Bottom action bar */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="md" disabled={isLocked} onClick={() => copyLastWeek(false)}>
            <Copy className="h-3.5 w-3.5" />
            Copy last week
          </Button>
          <Button variant="secondary" size="md" disabled={isLocked} onClick={() => copyLastWeek(true)}>
            <Copy className="h-3.5 w-3.5" />
            Copy last week with hours
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-sm font-medium text-muted-foreground" title="Changes save as you go">
            <Save className="h-3.5 w-3.5" />
            Auto-saved
          </span>
          <Button
            size="md"
            onClick={handleSubmitWeek}
            disabled={isLocked || draftIds.length === 0 || submit.isPending}
            title={
              isLocked
                ? 'Week is already submitted'
                : draftIds.length === 0
                  ? (weeklyStatusQ.data?.reason ?? 'No drafts to submit')
                  : 'Submit drafts for approval'
            }
          >
            <Send className="h-3.5 w-3.5" />
            {submit.isPending ? 'Submitting…' : 'Submit for approval'}
          </Button>
        </div>
      </div>

      {/* Edit-reason prompt: required when editing an existing entry (the
          backend records edit_reason + history_summary for the audit trail). */}
      {reasonPrompt ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setReasonPrompt(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-foreground">Reason for this edit</h3>
            <p className="mt-1 text-xs text-muted-foreground">A short note is recorded with the change so it's auditable.</p>
            <input
              autoFocus
              value={reasonPrompt.reason}
              onChange={(e) => setReasonPrompt((p) => (p ? { ...p, reason: e.target.value } : p))}
              onKeyDown={(e) => { if (e.key === 'Enter' && reasonPrompt.reason.trim()) void commitSave(reasonPrompt.key, reasonPrompt.reason); }}
              placeholder="e.g. Corrected hours, fixed project"
              className="mt-3 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setReasonPrompt(null)}>Cancel</Button>
              <Button size="sm" disabled={!reasonPrompt.reason.trim() || update.isPending} onClick={() => void commitSave(reasonPrompt.key, reasonPrompt.reason)}>
                {update.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Save edit
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function SummaryCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <h4 className="mb-2.5 text-sm font-semibold text-foreground">{title}</h4>
      {children}
    </Card>
  );
}

function KV({ k, v, muted }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-border py-1.5 text-sm last:border-b-0">
      <span className="text-muted-foreground">{k}</span>
      <span className={'font-semibold tabular-nums ' + (muted ? 'text-muted-foreground' : 'text-foreground')}>{v}</span>
    </div>
  );
}

function EmptyDay({
  dayLabel,
  disabled,
  onAdd,
  onCopyLastWeek,
}: {
  dayLabel: string;
  disabled: boolean;
  onAdd: () => void;
  onCopyLastWeek: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 py-14 text-center">
      <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-border bg-muted/40 text-muted-foreground">
        <Clock className="h-5 w-5" />
      </div>
      <div className="text-sm font-medium text-foreground">Nothing logged for {dayLabel} yet</div>
      <div className="max-w-sm text-xs text-muted-foreground">
        Click <strong>Add entry</strong> to log a block of time, or copy this day from last week.
      </div>
      <div className="mt-2 flex gap-2">
        <Button size="sm" disabled={disabled} onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" /> Add entry
        </Button>
        <Button variant="secondary" size="sm" disabled={disabled} onClick={onCopyLastWeek}>
          <Copy className="h-3.5 w-3.5" /> Copy from last week
        </Button>
      </div>
    </div>
  );
}

function ViewRow({
  entry,
  projectName,
  taskName,
  locked,
  onEdit,
  onDelete,
}: {
  entry: TimeEntry;
  projectName: string;
  taskName: string;
  locked: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <tr className="border-b border-border align-top last:border-b-0">
      <td className="whitespace-nowrap px-1.5 py-2 text-muted-foreground">{fmt12h(entry.start_time)}</td>
      <td className="whitespace-nowrap px-1.5 py-2 text-muted-foreground">{fmt12h(entry.end_time)}</td>
      <td className="truncate px-1.5 py-2" title={projectName}>{projectName}</td>
      <td className="truncate px-1.5 py-2" title={taskName}>{taskName}</td>
      <td className="px-1.5 py-2 text-right tabular-nums">{fmtH(toNum(entry.hours))}</td>
      <td className="px-1.5 py-2 text-center">
        {entry.is_billable ? (
          <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-primary text-primary-foreground"><Check className="h-3 w-3" /></span>
        ) : (
          <span className="inline-flex h-5 w-5 items-center justify-center rounded border border-border text-muted-foreground"><X className="h-3 w-3" /></span>
        )}
      </td>
      <td className="whitespace-pre-wrap break-words px-1.5 py-2">{entry.description}</td>
      <td className="px-1.5 py-2 text-right">
        <div className="inline-flex items-center gap-0.5">
          <button
            type="button"
            onClick={onEdit}
            disabled={locked}
            title={locked ? 'Locked. Recall to edit.' : 'Edit'}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={locked}
            title={locked ? 'Locked. Recall to delete.' : 'Delete'}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function EditRow({
  draft,
  projects,
  allTasks,
  onPatch,
  onSave,
  onCancel,
  saving,
}: {
  draft: EntryDraft;
  projects: Project[];
  allTasks: Task[];
  onPatch: (p: Partial<EntryDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const projectTasks = useMemo(
    () => (draft.project_id ? allTasks.filter((t) => t.project_id === draft.project_id) : []),
    [allTasks, draft.project_id],
  );

  // Auto-derive Hours from the time block unless the user typed Hours.
  function onTimeChange(field: 'start_time' | 'end_time', value: string) {
    const next = { ...draft, [field]: value };
    const patch: Partial<EntryDraft> = { [field]: value };
    if (!next.start_time && !next.end_time) {
      patch.hours_dirty = false;
      if (!draft.hours_dirty) patch.hours = '';
    } else if (!draft.hours_dirty && next.start_time && next.end_time) {
      const derived = diffHours(next.start_time, next.end_time);
      if (derived > 0) patch.hours = String(derived);
    }
    onPatch(patch);
  }

  const fieldClass =
    'w-full rounded-md border border-border bg-background px-1.5 py-1 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

  return (
    <tr className="border-b border-border bg-muted/10 align-top last:border-b-0">
      <td className="px-1.5 py-2">
        <input type="time" value={draft.start_time} onChange={(e) => onTimeChange('start_time', e.target.value)} className={fieldClass + ' tabular-nums'} />
      </td>
      <td className="px-1.5 py-2">
        <input type="time" value={draft.end_time} onChange={(e) => onTimeChange('end_time', e.target.value)} className={fieldClass + ' tabular-nums'} />
      </td>
      <td className="px-1.5 py-2">
        <select
          value={draft.project_id}
          onChange={(e) => onPatch({ project_id: parseInt(e.target.value, 10) || 0, task_id: null })}
          className={fieldClass + ' truncate'}
        >
          <option value={0}>Select project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </td>
      <td className="px-1.5 py-2">
        <select
          value={draft.task_id ?? 0}
          onChange={(e) => onPatch({ task_id: parseInt(e.target.value, 10) || null })}
          className={fieldClass + ' truncate'}
          disabled={!draft.project_id}
        >
          <option value={0}>No task</option>
          {projectTasks.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </td>
      <td className="px-1.5 py-2 text-right">
        <input
          type="number"
          step="0.25"
          min={0}
          value={draft.hours}
          onChange={(e) => onPatch({ hours: e.target.value, hours_dirty: true })}
          className={fieldClass + ' text-right tabular-nums'}
          title="Auto-fills from Start/End when both are set. Edit to override."
        />
      </td>
      <td className="px-1.5 py-2 text-center">
        <input
          type="checkbox"
          checked={draft.is_billable}
          onChange={(e) => onPatch({ is_billable: e.target.checked })}
          className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]"
        />
      </td>
      <td className="px-1.5 py-2">
        <textarea
          value={draft.description}
          onChange={(e) => onPatch({ description: e.target.value })}
          placeholder="What were you working on?"
          rows={2}
          className={fieldClass + ' min-h-[36px] resize-y leading-snug'}
        />
      </td>
      <td className="px-1.5 py-2 text-right">
        <div className="inline-flex items-center gap-0.5">
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            title="Save"
            className="inline-flex h-7 w-7 items-center justify-center rounded bg-primary text-primary-foreground hover:brightness-110 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={onCancel}
            title="Cancel"
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}
