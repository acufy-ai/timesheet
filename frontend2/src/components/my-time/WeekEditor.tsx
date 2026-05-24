import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  addDays,
  endOfWeek,
  format,
  isSameDay,
  parseISO,
  startOfWeek,
  subDays,
} from 'date-fns';
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Pencil,
  Plus,
  Save,
  Send,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';

import { useQueryClient } from '@tanstack/react-query';

import { timeentriesAPI } from '@/api';
import { ExpandableDescription } from '@/components';
import {
  useProjects,
  useRecallTimeEntries,
  useSubmitTimeEntries,
  useTasks,
  useTimeEntries,
  useWeekStartsOn,
  useWeeklySubmitStatus,
} from '@/hooks';
import type { Project, Task, TimeEntry, TimeEntryStatus } from '@/types';
import { formatTime12h } from '@/utils/timeFormat';

// ── WeekEditor ────────────────────────────────────────────────────
//
// Replaces the legacy weekly-grid body inside the Enter tab. Layout:
// left sidebar (one button per day with totals + billable bar), centre
// editor (entries for the selected day), right sidebar (read-only
// day / week / by-project summaries). All three regions read from the
// same in-memory entries array so totals update live without refetches.
//
// Mounted as <WeekEditor /> in MyTimePage when the Enter tab is active.
// Routing: ?day=YYYY-MM-DD is the new contract; the legacy
// ?date=YYYY-MM-DD&entryId=N&mode=edit lock continues to resolve so
// notification deep-links keep working.

const TIME_OFF_PREFIX_REGEX = /^\[(SICK_DAY|PTO|HOLIDAY|HALF_DAY|BEREAVEMENT|JURY_DUTY|UNPAID|OTHER)\]/;

interface EntryDraft {
  // Synthetic key for not-yet-saved rows. Negative numbers so they can't
  // collide with backend ids.
  tempId: number;
  // Set once the row has been saved.
  entryId?: number;
  project_id: number;
  task_id: number | null;
  hours: string;
  is_billable: boolean;
  description: string;
  // Local-state strings for the optional time block. Empty string means
  // "no time entered" (we serialise that to null on save). Stored as
  // strings here so the inputs are uncontrolled-friendly and we don't
  // round-trip through Date objects for every keystroke.
  start_time: string;
  end_time: string;
  // True when the user has manually edited the Hours input. Once set,
  // Start/End changes stop overwriting the field so a deliberate value
  // (e.g. "1.75h actually worked of a 2h block") doesn't get clobbered.
  // Reset to false when both Start and End are cleared.
  hours_dirty: boolean;
}

const toNum = (v: string | number | null | undefined): number => {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const fmtHours = (n: number): string => {
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
};

const fmtIso = (d: Date): string => format(d, 'yyyy-MM-dd');

/**
 * Truncate ``HH:MM:SS`` (the wire shape) to ``HH:MM`` (what
 * <input type="time"> uses). Returns '' for nullish input so the
 * input renders as empty rather than NaN.
 */
const trimSeconds = (value: string | null | undefined): string => {
  if (!value) return '';
  return value.length >= 5 ? value.slice(0, 5) : value;
};

/**
 * Coerce a UI time string ('HH:MM' or 'HH:MM:SS') to the wire shape
 * the backend's ``time`` Pydantic field expects.
 */
const toApiTime = (value: string): string => {
  if (!value) return value;
  // <input type="time"> gives us 'HH:MM'; backend's time field
  // accepts both, but be explicit.
  return value.length === 5 ? `${value}:00` : value;
};

/**
 * Compute the hour difference for an end time that's after a start
 * time. Both ``HH:MM`` strings. Wraps past midnight is NOT supported
 * here — overnight entries belong to two days and the user should
 * log them separately. Returns 0 on any bad input.
 */
const diffHours = (start: string, end: string): number => {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if (
    !Number.isFinite(sh) || !Number.isFinite(sm) ||
    !Number.isFinite(eh) || !Number.isFinite(em)
  ) return 0;
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (endMin <= startMin) return 0;
  return Math.round(((endMin - startMin) / 60) * 100) / 100;
};

// 12-hour formatter shared with ApprovalsPage so both surfaces render
// time blocks identically. Returns 'N/A' when no value, matching the
// previous local helper's display contract.
const fmt12h = (value: string | null | undefined): string =>
  formatTime12h(value) ?? 'N/A';

// Friendly DOW header label.
const DOW_LABELS_BASE: Array<{ short: string; long: string }> = [
  { short: 'Sun', long: 'Sunday' },
  { short: 'Mon', long: 'Monday' },
  { short: 'Tue', long: 'Tuesday' },
  { short: 'Wed', long: 'Wednesday' },
  { short: 'Thu', long: 'Thursday' },
  { short: 'Fri', long: 'Friday' },
  { short: 'Sat', long: 'Saturday' },
];

const isWeekend = (d: Date): boolean => {
  const day = d.getDay();
  return day === 0 || day === 6;
};

/**
 * Extract the editable status set. SUBMITTED rows render read-only;
 * APPROVED entries shouldn't normally land in this week's editable
 * window but we treat them as locked too just in case.
 */
const isEditable = (status: TimeEntryStatus): boolean =>
  status === 'DRAFT' || status === 'REJECTED';

// ── Component ────────────────────────────────────────────────────

interface Props {
  /**
   * Source-of-truth date that anchors the visible week. The parent owns it
   * because the legacy MyTimePage header still uses the same anchor for the
   * History / Rework tabs (e.g. the natural-language input writes into the
   * same week). Changing the day picker here can update this anchor too via
   * ``onAnchorChange`` so the parent's other surfaces stay in sync.
   */
  weekAnchorDate: Date;
  onAnchorChange: (d: Date) => void;
}

export const WeekEditor: React.FC<Props> = ({ weekAnchorDate, onAnchorChange }) => {
  const weekStartsOn = useWeekStartsOn();
  const [searchParams, setSearchParams] = useSearchParams();

  const weekStart = startOfWeek(weekAnchorDate, { weekStartsOn });
  const weekEnd = endOfWeek(weekAnchorDate, { weekStartsOn });
  const weekDates = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const weekStartKey = fmtIso(weekStart);
  const weekEndKey = fmtIso(weekEnd);

  // ── Selected day from URL ──────────────────────────────────────
  // Supports both ``?day=YYYY-MM-DD`` (new) and the legacy
  // ``?date=YYYY-MM-DD`` shape so notification deep-links keep working.
  const urlDay = searchParams.get('day') || searchParams.get('date');
  const legacyEntryId = searchParams.get('entryId');
  const legacyMode = searchParams.get('mode');

  // Memoize the "today" date once per render cycle so the dependency
  // array below doesn't churn on every keystroke (a fresh Date() on
  // every render would break useMemo's identity check).
  const today = useMemo(() => new Date(), []);
  const defaultSelected = useMemo(() => {
    // If today is inside the visible week, default to today; else pick the
    // first day of the week.
    return weekDates.find((d) => isSameDay(d, today)) ?? weekStart;
  }, [weekDates, weekStart, today]);

  const [selectedDate, setSelectedDate] = useState<Date>(() => {
    if (urlDay) {
      const parsed = parseISO(urlDay);
      if (!Number.isNaN(parsed.getTime())) {
        // Snap the visible week to the deep-link date.
        return parsed;
      }
    }
    return defaultSelected;
  });

  // Sync selectedDate when the anchor (parent week) moves: if the
  // currently-selected day falls outside the new week, jump to that
  // week's today/first day.
  useEffect(() => {
    if (selectedDate < weekStart || selectedDate > weekEnd) {
      setSelectedDate(defaultSelected);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStartKey, weekEndKey]);

  // Push selection back into the URL so refresh + deep links round-trip.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    next.set('day', fmtIso(selectedDate));
    // Strip the legacy ?date= param the first time we render so the URL
    // converges on the new shape, but keep ?entryId= so the inline-edit
    // intent survives.
    next.delete('date');
    if (next.get('tab') === 'enter') next.delete('tab');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  // ── Data fetching ─────────────────────────────────────────────
  // One query for the whole visible week. Day editor and side rails
  // derive from this single source so totals never drift between
  // surfaces.
  const { data: weekEntries, isLoading: entriesLoading } = useTimeEntries({
    sort_by: 'entry_date',
    sort_order: 'asc',
    start_date: weekStartKey,
    end_date: weekEndKey,
    limit: 1000,
  });

  // Previous week (for Copy last week + the row-level / dropdown shortcuts).
  const prevStartKey = fmtIso(addDays(weekStart, -7));
  const prevEndKey = fmtIso(addDays(weekEnd, -7));
  const { data: prevWeekEntries } = useTimeEntries({
    sort_by: 'entry_date', sort_order: 'asc',
    start_date: prevStartKey, end_date: prevEndKey, limit: 1000,
  });

  const { data: projects } = useProjects({ active_only: true });
  const { data: allTasks } = useTasks({ active_only: true, limit: 1000 });

  const { data: weeklyStatus } = useWeeklySubmitStatus();

  // Strip time-off entries from the editor view; they live on a
  // dedicated Time Off surface and shouldn't be hand-edited here.
  const visibleEntries = useMemo(
    () => (weekEntries ?? []).filter(
      (e: TimeEntry) => !TIME_OFF_PREFIX_REGEX.test(e.description),
    ),
    [weekEntries],
  );

  // ── Mutations ────────────────────────────────────────────────
  // Per-row updates/deletes call the API directly so we don't need a
  // separate ``useUpdateTimeEntry(id)`` hook per row. We manually
  // invalidate the timeentries cache below so the matrix + summaries
  // re-render after each save.
  const submitMutation = useSubmitTimeEntries();
  const recallMutation = useRecallTimeEntries();
  const queryClient = useQueryClient();
  const invalidateEntries = () => {
    queryClient.invalidateQueries({ queryKey: ['timeentries'] });
    queryClient.invalidateQueries({ queryKey: ['timeentries', 'weekly-submit-status'] });
  };

  // ── Local edit/create state ───────────────────────────────────
  // Drafts for rows the user is currently editing or creating. Keyed by
  // entryId for saved rows, by tempId for new rows.
  const [editing, setEditing] = useState<Record<string, EntryDraft>>({});
  // Banner / toast messages.
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const setFlashAndFade = (tone: 'ok' | 'err', text: string) => {
    setFlash({ tone, text });
    window.setTimeout(() => setFlash(null), 4000);
  };

  // Resolve the legacy ?entryId= deep-link: open it inline as soon as
  // the row is present in the fetched data.
  useEffect(() => {
    if (!legacyEntryId || legacyMode !== 'edit') return;
    const target = visibleEntries.find(
      (e: TimeEntry) => String(e.id) === legacyEntryId,
    );
    if (!target) return;
    setSelectedDate(parseISO(target.entry_date));
    startEdit(target);
    // Clear the legacy params once we've honoured them.
    const next = new URLSearchParams(searchParams);
    next.delete('entryId');
    next.delete('mode');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacyEntryId, legacyMode, visibleEntries.length]);

  // ── Derived data ──────────────────────────────────────────────
  const selectedKey = fmtIso(selectedDate);
  const dayEntries = useMemo(
    () => visibleEntries.filter((e: TimeEntry) => e.entry_date === selectedKey),
    [visibleEntries, selectedKey],
  );

  const dayHoursByKey: Record<string, { total: number; billable: number; nonBillable: number }> = useMemo(() => {
    const map: Record<string, { total: number; billable: number; nonBillable: number }> = {};
    weekDates.forEach((d) => {
      map[fmtIso(d)] = { total: 0, billable: 0, nonBillable: 0 };
    });
    visibleEntries.forEach((e: TimeEntry) => {
      const slot = map[e.entry_date];
      if (!slot) return;
      const h = toNum(e.hours);
      slot.total += h;
      if (e.is_billable) slot.billable += h; else slot.nonBillable += h;
    });
    return map;
  }, [visibleEntries, weekDates]);

  const weekTotals = useMemo(() => {
    let total = 0, billable = 0, nonBillable = 0;
    Object.values(dayHoursByKey).forEach((d) => {
      total += d.total; billable += d.billable; nonBillable += d.nonBillable;
    });
    return { total, billable, nonBillable };
  }, [dayHoursByKey]);

  const projectsById = useMemo(() => {
    const map: Record<number, Project> = {};
    (projects ?? []).forEach((p: Project) => { map[p.id] = p; });
    return map;
  }, [projects]);

  const tasksById = useMemo(() => {
    const map: Record<number, Task> = {};
    (allTasks ?? []).forEach((t: Task) => { map[t.id] = t; });
    return map;
  }, [allTasks]);

  const byProjectWeek = useMemo(() => {
    const acc: Record<string, { project: string; task: string; hours: number }> = {};
    visibleEntries.forEach((e: TimeEntry) => {
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

  // Are any entries in the visible week SUBMITTED? If so, the whole
  // week is locked and the recall banner applies.
  const submittedIds = useMemo(
    () => visibleEntries.filter((e: TimeEntry) => e.status === 'SUBMITTED').map((e: TimeEntry) => e.id),
    [visibleEntries],
  );
  const isLocked = submittedIds.length > 0;
  const submittedAt = useMemo(() => {
    const entry = visibleEntries.find((e: TimeEntry) => e.status === 'SUBMITTED' && e.submitted_at);
    return entry?.submitted_at ?? null;
  }, [visibleEntries]);

  // Draft entry IDs for Submit-for-Approval.
  const draftIds = useMemo(
    () => visibleEntries.filter((e: TimeEntry) => e.status === 'DRAFT').map((e: TimeEntry) => e.id),
    [visibleEntries],
  );

  // ── Mutations: row-level helpers ─────────────────────────────
  const startEdit = (entry: TimeEntry) => {
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
        // Hydrate from the saved row. ``HH:MM:SS`` from the wire is
        // truncated to ``HH:MM`` for the <input type="time"> control.
        start_time: trimSeconds(entry.start_time),
        end_time: trimSeconds(entry.end_time),
        // A saved entry already has a chosen hours value; treat that as
        // intentional so editing Start/End doesn't silently overwrite it.
        hours_dirty: true,
      },
    }));
  };

  const startNew = (date?: Date) => {
    const tempId = -1 * (Object.keys(editing).length + 1) - Date.now();
    const key = `t${tempId}`;
    setEditing((prev) => ({
      ...prev,
      [key]: {
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
    if (date) setSelectedDate(date);
  };

  const cancelEdit = (key: string) => {
    setEditing((prev) => {
      const rest = { ...prev };
      delete rest[key];
      return rest;
    });
  };

  const patchDraft = (key: string, patch: Partial<EntryDraft>) => {
    setEditing((prev) => {
      const current = prev[key];
      if (!current) return prev;
      return { ...prev, [key]: { ...current, ...patch } };
    });
  };

  const saveRow = async (key: string) => {
    const draft = editing[key];
    if (!draft) return;
    if (!draft.project_id) {
      setFlashAndFade('err', 'Pick a project before saving.');
      return;
    }
    // If the user typed a start/end pair, derive hours from the span
    // unless they also explicitly typed hours — that lets the picker
    // be the source of truth for time-block entries while still
    // allowing hours-only entries when the block fields are blank.
    const startStr = draft.start_time.trim();
    const endStr = draft.end_time.trim();
    let hours = toNum(draft.hours);
    if (startStr && endStr && hours <= 0) {
      const derived = diffHours(startStr, endStr);
      if (derived > 0) hours = derived;
    }
    if (hours <= 0) {
      setFlashAndFade('err', 'Hours must be greater than zero.');
      return;
    }

    const startToSend = startStr ? toApiTime(startStr) : null;
    const endToSend = endStr ? toApiTime(endStr) : null;

    try {
      if (draft.entryId) {
        await timeentriesAPI.update(draft.entryId, {
          project_id: draft.project_id,
          task_id: draft.task_id ?? null,
          entry_date: selectedKey,
          start_time: startToSend,
          end_time: endToSend,
          hours,
          description: draft.description,
          is_billable: draft.is_billable,
          // Backend's update gate requires both fields. For the inline
          // editor we don't ask the user; "Edit via My Time" is sufficient
          // detail for the audit trail.
          edit_reason: 'Edited via My Time',
          history_summary: 'Inline edit from week editor',
        });
      } else {
        await timeentriesAPI.create({
          project_id: draft.project_id,
          task_id: draft.task_id ?? null,
          entry_date: selectedKey,
          start_time: startToSend,
          end_time: endToSend,
          hours,
          description: draft.description,
          is_billable: draft.is_billable,
        });
      }
      cancelEdit(key);
      invalidateEntries();
      setFlashAndFade('ok', 'Saved.');
    } catch (err) {
      setFlashAndFade('err', extractErrorMessage(err));
    }
  };

  const removeRow = async (entryId: number) => {
    if (!window.confirm('Delete this entry?')) return;
    try {
      await timeentriesAPI.delete(entryId);
      invalidateEntries();
      setFlashAndFade('ok', 'Deleted.');
    } catch (err) {
      setFlashAndFade('err', extractErrorMessage(err));
    }
  };

  // ── Week-level actions ────────────────────────────────────────
  const handleSubmitWeek = async () => {
    if (draftIds.length === 0) {
      setFlashAndFade('err', weeklyStatus?.reason ?? 'Nothing to submit.');
      return;
    }
    try {
      await submitMutation.mutateAsync(draftIds);
      setFlashAndFade('ok', 'Submitted for approval.');
    } catch (err) {
      setFlashAndFade('err', extractErrorMessage(err));
    }
  };

  const handleRecall = async () => {
    if (submittedIds.length === 0) return;
    try {
      await recallMutation.mutateAsync(submittedIds);
      setFlashAndFade('ok', 'Submission recalled. Edit and resubmit when ready.');
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        setFlashAndFade('err', 'Your manager has already approved or rejected one or more entries. Refreshing.');
      } else {
        setFlashAndFade('err', extractErrorMessage(err));
      }
    }
  };

  const copyFromDay = async (sourceKey: string) => {
    // Pick the right entry list based on where the source date lives.
    // We pre-fetch the visible week and the prior week. A "pick a date"
    // option in the menu can ask for any day, so we union both lists,
    // then fall back to a one-shot fetch for arbitrary dates outside
    // those windows. The previous version preferred ``prevWeekEntries``
    // whenever it was defined, which broke "Yesterday" when yesterday
    // was inside the current week (the prior-week list correctly
    // returned no rows for it, but the function gave up instead of
    // looking in this week).
    const pool: TimeEntry[] = [
      ...(visibleEntries as TimeEntry[]),
      ...((prevWeekEntries ?? []) as TimeEntry[]),
    ];
    let source = pool.filter(
      (e: TimeEntry) =>
        e.entry_date === sourceKey && !TIME_OFF_PREFIX_REGEX.test(e.description),
    );

    // Last-resort lookup for "pick a specific date" choices outside
    // the two pre-fetched windows. Keeps the user from being stuck
    // when last quarter's timesheet is what they want to clone.
    if (source.length === 0) {
      const inPool = pool.some((e: TimeEntry) => e.entry_date === sourceKey);
      if (!inPool) {
        try {
          const res = await timeentriesAPI.list({
            start_date: sourceKey,
            end_date: sourceKey,
            limit: 100,
          });
          const fetched = (res.data as TimeEntry[]).filter(
            (e) => !TIME_OFF_PREFIX_REGEX.test(e.description),
          );
          source = fetched;
        } catch {
          /* fall through to the empty-source error below */
        }
      }
    }

    if (source.length === 0) {
      setFlashAndFade('err', 'No entries to copy from that day.');
      return;
    }
    try {
      await Promise.all(source.map((e: TimeEntry) =>
        timeentriesAPI.create({
          project_id: e.project_id,
          task_id: e.task_id ?? null,
          entry_date: selectedKey,
          start_time: e.start_time ?? null,
          end_time: e.end_time ?? null,
          hours: toNum(e.hours),
          description: e.description,
          is_billable: e.is_billable,
        })
      ));
      invalidateEntries();
      setFlashAndFade('ok', `Copied ${source.length} entr${source.length === 1 ? 'y' : 'ies'}.`);
    } catch (err) {
      setFlashAndFade('err', extractErrorMessage(err));
    }
  };

  const copyLastWeek = async (includeHours: boolean) => {
    if (!prevWeekEntries || prevWeekEntries.length === 0) {
      setFlashAndFade('err', 'Last week is empty.');
      return;
    }
    try {
      await Promise.all(
        prevWeekEntries
          .filter((e: TimeEntry) => !TIME_OFF_PREFIX_REGEX.test(e.description))
          .map((e: TimeEntry) => {
            const newDate = addDays(parseISO(e.entry_date), 7);
            return timeentriesAPI.create({
              project_id: e.project_id,
              task_id: e.task_id ?? null,
              entry_date: fmtIso(newDate),
              start_time: includeHours ? e.start_time ?? null : null,
              end_time: includeHours ? e.end_time ?? null : null,
              hours: includeHours ? toNum(e.hours) : 0.01,
              description: e.description,
              is_billable: e.is_billable,
            });
          })
      );
      invalidateEntries();
      setFlashAndFade('ok', `Copied last week${includeHours ? ' with hours' : ' (structure only)'}.`);
    } catch (err) {
      setFlashAndFade('err', extractErrorMessage(err));
    }
  };

  // Copy-from dropdown state
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [pickCopyDate, setPickCopyDate] = useState('');

  // ── Render ───────────────────────────────────────────────────
  const selectedDow = DOW_LABELS_BASE[selectedDate.getDay()];
  const selectedDayMetrics = dayHoursByKey[selectedKey] ?? { total: 0, billable: 0, nonBillable: 0 };

  return (
    <section className="space-y-4">
      {/* Header row: week nav + Today + week total */}
      <div className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-xl p-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onAnchorChange(subDays(weekAnchorDate, 7))}
            className="inline-flex items-center justify-center h-9 w-9 rounded-md border border-border bg-background hover:bg-muted"
            title="Previous week"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="inline-flex items-center gap-2 h-9 px-3 rounded-md border border-border bg-background text-sm">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            {format(weekStart, 'MMM d')} – {format(weekEnd, 'MMM d, yyyy')}
          </div>
          <button
            type="button"
            onClick={() => onAnchorChange(addDays(weekAnchorDate, 7))}
            className="inline-flex items-center justify-center h-9 w-9 rounded-md border border-border bg-background hover:bg-muted"
            title="Next week"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => { onAnchorChange(new Date()); setSelectedDate(new Date()); }}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border bg-background hover:bg-muted text-sm font-medium"
            title="Jump to this week"
          >
            <Clock className="h-3.5 w-3.5" />
            Today
          </button>
        </div>
        <div className="flex-1" />
        <div className="inline-flex items-center gap-2 h-9 px-3 rounded-md border border-border bg-background text-sm">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Week</span>
          <span className="font-semibold tabular-nums">{fmtHours(weekTotals.total)}h</span>
        </div>
      </div>

      {/* Submitted banner */}
      {isLocked && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="inline-flex items-center rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30 px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase">
              Submitted
            </span>
            <span className="text-sm text-foreground">
              {submittedAt
                ? <>Submitted <strong className="text-amber-700 dark:text-amber-300">{new Date(submittedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</strong>. Awaiting approval.</>
                : 'Awaiting approval. Recall to edit before it is reviewed.'}
            </span>
          </div>
          <button
            type="button"
            onClick={handleRecall}
            disabled={recallMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            <Undo2 className="h-3.5 w-3.5" />
            {recallMutation.isPending ? 'Recalling…' : 'Recall submission'}
          </button>
        </div>
      )}

      {/* Flash */}
      {flash && (
        <div
          role="alert"
          className={`rounded-lg border px-3 py-2 text-sm ${
            flash.tone === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
          }`}
        >
          {flash.text}
        </div>
      )}

      {/* Three-column body */}
      <div className="grid gap-4 lg:grid-cols-[200px_minmax(0,1fr)_280px]">

        {/* ── Day list sidebar ───────────────────────────────── */}
        <div className="rounded-xl border border-border bg-card p-2 flex flex-col gap-1 self-start">
          {weekDates.map((d) => {
            const key = fmtIso(d);
            const dow = DOW_LABELS_BASE[d.getDay()];
            const metrics = dayHoursByKey[key];
            const total = metrics?.total ?? 0;
            const billPct = total > 0 ? (metrics.billable / total) * 100 : 0;
            const isSelected = isSameDay(d, selectedDate);
            const isToday = isSameDay(d, today);
            const dim = isWeekend(d) && total === 0;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelectedDate(d)}
                className={`relative text-left rounded-lg border px-3 py-2.5 transition ${
                  isSelected
                    ? 'border-primary/40 bg-primary/10'
                    : 'border-transparent hover:bg-muted/40'
                }`}
              >
                {isToday && (
                  <span className="absolute top-1.5 right-1.5 text-[8px] font-bold tracking-wider text-primary bg-primary/10 border border-primary/30 px-1 py-0.5 rounded">
                    TODAY
                  </span>
                )}
                <div className={`text-[13px] font-semibold ${isSelected ? 'text-primary' : dim ? 'text-muted-foreground' : 'text-foreground'}`}>
                  {dow.short}
                </div>
                <div className="text-[11px] text-muted-foreground">{format(d, 'MMM d')}</div>
                <div className={`mt-1 text-sm font-semibold tabular-nums ${total > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {fmtHours(total)}h
                </div>
                <div className="mt-1 h-[3px] rounded-full bg-muted/60 overflow-hidden flex">
                  {total > 0 && (
                    <>
                      <div className="h-full bg-emerald-500" style={{ width: `${billPct}%` }} />
                      <div className="h-full bg-muted-foreground/60" style={{ width: `${100 - billPct}%` }} />
                    </>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* ── Day editor centre column ──────────────────────── */}
        <div className="rounded-xl border border-border bg-card p-4 min-w-0">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div>
              <h3 className="text-base font-semibold">{selectedDow.long}, {format(selectedDate, 'MMM d')}</h3>
              <p className="text-xs text-muted-foreground">All times in your local time zone.</p>
            </div>
            <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tabular-nums ${
              selectedDayMetrics.total > 0
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-border bg-muted/40 text-muted-foreground'
            }`}>
              {fmtHours(selectedDayMetrics.total)} hours
            </span>
            <div className="flex-1" />
            {/* Copy from dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setCopyMenuOpen((v) => !v)}
                disabled={isLocked}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border bg-background hover:bg-muted text-sm disabled:opacity-50"
              >
                <Copy className="h-3.5 w-3.5" />
                Copy from
                <ChevronDown className="h-3 w-3" />
              </button>
              {copyMenuOpen && (
                <div
                  className="absolute right-0 z-30 mt-1 w-64 rounded-lg border border-border bg-card shadow-xl p-1"
                  onMouseLeave={() => setCopyMenuOpen(false)}
                >
                  <button
                    type="button"
                    onClick={() => { setCopyMenuOpen(false); copyFromDay(fmtIso(subDays(selectedDate, 7))); }}
                    className="w-full text-left px-3 py-2 rounded text-sm hover:bg-muted"
                  >
                    Last week ({format(subDays(selectedDate, 7), 'EEE MMM d')})
                  </button>
                  <button
                    type="button"
                    onClick={() => { setCopyMenuOpen(false); copyFromDay(fmtIso(subDays(selectedDate, 1))); }}
                    className="w-full text-left px-3 py-2 rounded text-sm hover:bg-muted"
                  >
                    Yesterday ({format(subDays(selectedDate, 1), 'EEE MMM d')})
                  </button>
                  <div className="border-t border-border my-1" />
                  <div className="px-3 py-2 space-y-2">
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
              )}
            </div>
            <button
              type="button"
              onClick={() => startNew(selectedDate)}
              disabled={isLocked}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-semibold disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              Add entry
            </button>
          </div>

          {/* Table */}
          {entriesLoading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
          ) : dayEntries.length === 0 && Object.values(editing).length === 0 ? (
            <EmptyDay
              dayLabel={selectedDow.long}
              disabled={isLocked}
              onAdd={() => startNew(selectedDate)}
              onCopyLastWeek={() => copyFromDay(fmtIso(subDays(selectedDate, 7)))}
            />
          ) : (
            <table className="w-full text-sm table-fixed">
              <colgroup>
                <col style={{ width: '120px' }} />
                <col style={{ width: '120px' }} />
                <col />
                <col />
                <col style={{ width: '64px' }} />
                <col style={{ width: '56px' }} />
                <col />
                <col style={{ width: '70px' }} />
              </colgroup>
              <thead>
                <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground border-b border-border">
                  <th className="py-2 px-1.5">Start</th>
                  <th className="py-2 px-1.5">End</th>
                  <th className="py-2 px-1.5">Project</th>
                  <th className="py-2 px-1.5">Task</th>
                  <th className="py-2 px-1.5 text-right">Hours</th>
                  <th className="py-2 px-1.5 text-center">Bill.</th>
                  <th className="py-2 px-1.5">Description</th>
                  <th className="py-2 px-1.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {dayEntries.map((entry: TimeEntry) => {
                  const key = `e${entry.id}`;
                  const draft = editing[key];
                  return draft ? (
                    <EditRow
                      key={key}
                      draft={draft}
                      projects={projects ?? []}
                      allTasks={allTasks ?? []}
                      onPatch={(p) => patchDraft(key, p)}
                      onSave={() => saveRow(key)}
                      onCancel={() => cancelEdit(key)}
                    />
                  ) : (
                    <ViewRow
                      key={key}
                      entry={entry}
                      projectName={projectsById[entry.project_id]?.name ?? entry.project?.name ?? 'N/A'}
                      taskName={entry.task_id ? (tasksById[entry.task_id]?.name ?? 'N/A') : 'No task'}
                      onEdit={() => startEdit(entry)}
                      onDelete={() => removeRow(entry.id)}
                      locked={isLocked || !isEditable(entry.status)}
                    />
                  );
                })}
                {Object.entries(editing)
                  .filter(([k]) => k.startsWith('t'))
                  .map(([key, draft]) => (
                    <EditRow
                      key={key}
                      draft={draft}
                      projects={projects ?? []}
                      allTasks={allTasks ?? []}
                      onPatch={(p) => patchDraft(key, p)}
                      onSave={() => saveRow(key)}
                      onCancel={() => cancelEdit(key)}
                    />
                  ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Right sidebar: summary cards ───────────────────── */}
        <div className="space-y-3 self-start">
          <SummaryCard title="Day summary">
            <KV k="Billable" v={`${fmtHours(selectedDayMetrics.billable)}h`} />
            <KV k="Non-billable" v={`${fmtHours(selectedDayMetrics.nonBillable)}h`} muted={selectedDayMetrics.nonBillable === 0} />
            <KV k="Total" v={`${fmtHours(selectedDayMetrics.total)}h`} />
          </SummaryCard>
          <SummaryCard title="Week summary">
            <KV k="Total hours" v={`${fmtHours(weekTotals.total)}h`} />
            <KV k="Billable" v={`${fmtHours(weekTotals.billable)}h`} />
            <KV k="Non-billable" v={`${fmtHours(weekTotals.nonBillable)}h`} muted={weekTotals.nonBillable === 0} />
          </SummaryCard>
          <SummaryCard title="By project (week)">
            {byProjectWeek.length === 0 ? (
              <div className="text-xs text-muted-foreground py-2">No entries yet this week.</div>
            ) : (
              <ul className="space-y-2.5">
                {byProjectWeek.map((row) => (
                  <li key={`${row.project}|${row.task}`} className="flex items-center justify-between text-sm">
                    <div className="min-w-0">
                      <div className="truncate text-foreground">{row.project}</div>
                      <div className="text-[11px] text-muted-foreground">{row.task}</div>
                    </div>
                    <div className="font-semibold tabular-nums ml-2">{fmtHours(row.hours)}h</div>
                  </li>
                ))}
              </ul>
            )}
          </SummaryCard>
        </div>
      </div>

      {/* Bottom action bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-card border border-border rounded-xl p-3 mt-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isLocked}
            onClick={() => copyLastWeek(false)}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border bg-background hover:bg-muted text-sm disabled:opacity-50"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy last week
          </button>
          <button
            type="button"
            disabled={isLocked}
            onClick={() => copyLastWeek(true)}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border bg-background hover:bg-muted text-sm disabled:opacity-50"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy last week with hours
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border bg-background opacity-60 text-sm font-semibold"
            title="Changes save as you go"
          >
            <Save className="h-3.5 w-3.5" />
            Auto-saved
          </button>
          <button
            type="button"
            onClick={handleSubmitWeek}
            disabled={isLocked || draftIds.length === 0 || submitMutation.isPending}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-semibold disabled:opacity-50"
            title={
              isLocked
                ? 'Week is already submitted'
                : draftIds.length === 0
                  ? (weeklyStatus?.reason ?? 'No drafts to submit')
                  : 'Submit drafts for approval'
            }
          >
            <Send className="h-3.5 w-3.5" />
            {submitMutation.isPending ? 'Submitting…' : 'Submit for approval'}
          </button>
        </div>
      </div>
    </section>
  );
};

// ─── Sub-components ───────────────────────────────────────────────

const SummaryCard: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="rounded-xl border border-border bg-card p-4">
    <h4 className="text-sm font-semibold mb-2.5">{title}</h4>
    {children}
  </div>
);

const KV: React.FC<{ k: string; v: string; muted?: boolean }> = ({ k, v, muted }) => (
  <div className="flex items-center justify-between text-sm py-1.5 border-b border-border last:border-b-0">
    <span className="text-muted-foreground">{k}</span>
    <span className={`font-semibold tabular-nums ${muted ? 'text-muted-foreground' : 'text-foreground'}`}>{v}</span>
  </div>
);

const EmptyDay: React.FC<{
  dayLabel: string;
  disabled: boolean;
  onAdd: () => void;
  onCopyLastWeek: () => void;
}> = ({ dayLabel, disabled, onAdd, onCopyLastWeek }) => (
  <div className="py-14 flex flex-col items-center text-center gap-2.5">
    <div className="h-12 w-12 rounded-xl border border-dashed border-border bg-muted/40 inline-flex items-center justify-center text-muted-foreground">
      <Clock className="h-5 w-5" />
    </div>
    <div className="text-sm font-medium">Nothing logged for {dayLabel} yet</div>
    <div className="text-xs text-muted-foreground max-w-sm">
      Click <strong>Add entry</strong> to log a block of time, or copy this day from last week.
    </div>
    <div className="flex gap-2 mt-2">
      <button
        type="button"
        disabled={disabled}
        onClick={onAdd}
        className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-semibold disabled:opacity-50"
      >
        <Plus className="h-3.5 w-3.5" /> Add entry
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onCopyLastWeek}
        className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border bg-background hover:bg-muted text-sm disabled:opacity-50"
      >
        <Copy className="h-3.5 w-3.5" /> Copy from last week
      </button>
    </div>
  </div>
);

const ViewRow: React.FC<{
  entry: TimeEntry;
  projectName: string;
  taskName: string;
  locked: boolean;
  onEdit: () => void;
  onDelete: () => void;
}> = ({ entry, projectName, taskName, locked, onEdit, onDelete }) => {
  return (
    <tr className="border-b border-border last:border-b-0 align-top">
      <td className="py-2 px-1.5 text-muted-foreground whitespace-nowrap">{fmt12h(entry.start_time)}</td>
      <td className="py-2 px-1.5 text-muted-foreground whitespace-nowrap">{fmt12h(entry.end_time)}</td>
      <td className="py-2 px-1.5 truncate" title={projectName}>{projectName}</td>
      <td className="py-2 px-1.5 truncate" title={taskName}>{taskName}</td>
      <td className="py-2 px-1.5 text-right tabular-nums">{fmtHours(toNum(entry.hours))}</td>
      <td className="py-2 px-1.5 text-center">
        {entry.is_billable ? (
          <span className="inline-flex items-center justify-center h-5 w-5 rounded bg-primary text-primary-foreground"><Check className="h-3 w-3" /></span>
        ) : (
          <span className="inline-flex items-center justify-center h-5 w-5 rounded border border-border text-muted-foreground"><X className="h-3 w-3" /></span>
        )}
      </td>
      <td className="py-2 px-1.5 whitespace-pre-wrap break-words">
        <ExpandableDescription text={entry.description} />
      </td>
      <td className="py-2 px-1.5 text-right">
        <div className="inline-flex items-center gap-0.5">
          <button
            type="button"
            onClick={onEdit}
            disabled={locked}
            className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
            title={locked ? 'Locked. Recall to edit.' : 'Edit'}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={locked}
            className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-rose-500 hover:bg-rose-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
            title={locked ? 'Locked. Recall to delete.' : 'Delete'}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
};


const EditRow: React.FC<{
  draft: EntryDraft;
  projects: Project[];
  allTasks: Task[];
  onPatch: (p: Partial<EntryDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
}> = ({ draft, projects, allTasks, onPatch, onSave, onCancel }) => {
  const projectTasks = useMemo(
    () => (draft.project_id ? allTasks.filter((t) => t.project_id === draft.project_id) : []),
    [allTasks, draft.project_id],
  );

  // Inlined SVG chevron so the native <select>'s arrow can be hidden
  // (appearance-none) without losing the visual cue. Lets the cell stay
  // narrow while keeping the dropdown's selected text fully visible.
  const chevronBg = {
    backgroundImage:
      "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239a9a9a' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>\")",
  } as const;
  const selectClass =
    "w-full rounded border border-border bg-background pl-1.5 pr-5 py-1 text-sm appearance-none bg-no-repeat bg-[right_0.35rem_center] bg-[length:0.7em_0.7em] truncate";

  // When the time block changes, auto-derive Hours unless the user has
  // already typed an explicit value. Clearing both sides resets the
  // dirty flag so the next valid block populates again.
  const onTimeChange = (field: 'start_time' | 'end_time', value: string) => {
    const next = { ...draft, [field]: value };
    const patch: Partial<EntryDraft> = { [field]: value };
    if (!next.start_time && !next.end_time) {
      // Both cleared → forget any prior manual override + zero out hours
      // so the row looks fresh.
      patch.hours_dirty = false;
      if (!draft.hours_dirty) patch.hours = '';
    } else if (!draft.hours_dirty && next.start_time && next.end_time) {
      const derived = diffHours(next.start_time, next.end_time);
      if (derived > 0) patch.hours = String(derived);
    }
    onPatch(patch);
  };

  return (
    <tr className="border-b border-border last:border-b-0 bg-muted/10 align-top">
      <td className="py-2 px-1.5">
        <input
          type="time"
          value={draft.start_time}
          onChange={(e) => onTimeChange('start_time', e.target.value)}
          className="w-full rounded border border-border bg-background pl-2 pr-1 py-1 text-sm tabular-nums"
        />
      </td>
      <td className="py-2 px-1.5">
        <input
          type="time"
          value={draft.end_time}
          onChange={(e) => onTimeChange('end_time', e.target.value)}
          className="w-full rounded border border-border bg-background pl-2 pr-1 py-1 text-sm tabular-nums"
        />
      </td>
      <td className="py-2 px-1.5">
        <select
          value={draft.project_id}
          onChange={(e) => onPatch({ project_id: parseInt(e.target.value, 10) || 0, task_id: null })}
          className={selectClass}
          style={chevronBg}
        >
          <option value={0}>Select project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </td>
      <td className="py-2 px-1.5">
        <select
          value={draft.task_id ?? 0}
          onChange={(e) => onPatch({ task_id: parseInt(e.target.value, 10) || null })}
          className={selectClass}
          style={chevronBg}
          disabled={!draft.project_id}
        >
          <option value={0}>No task</option>
          {projectTasks.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </td>
      <td className="py-2 px-1.5 text-right">
        <input
          type="number"
          step="0.25"
          min={0}
          value={draft.hours}
          onChange={(e) => onPatch({ hours: e.target.value, hours_dirty: true })}
          className="w-full rounded border border-border bg-background px-1.5 py-1 text-sm text-right tabular-nums"
          title="Auto-fills from Start/End when both are set. Edit to override."
        />
      </td>
      <td className="py-2 px-1.5 text-center">
        <input
          type="checkbox"
          checked={draft.is_billable}
          onChange={(e) => onPatch({ is_billable: e.target.checked })}
          className="h-4 w-4 rounded border-border accent-primary"
        />
      </td>
      <td className="py-2 px-1.5">
        <textarea
          value={draft.description}
          onChange={(e) => onPatch({ description: e.target.value })}
          placeholder="What were you working on?"
          rows={2}
          className="w-full min-h-[36px] resize-y rounded border border-border bg-background px-1.5 py-1 text-sm leading-snug"
        />
      </td>
      <td className="py-2 px-1.5 text-right">
        <div className="inline-flex items-center gap-0.5">
          <button
            type="button"
            onClick={onSave}
            className="h-7 w-7 inline-flex items-center justify-center rounded bg-primary text-primary-foreground hover:bg-primary/90"
            title="Save"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted"
            title="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
};

function extractErrorMessage(err: unknown): string {
  const e = err as { response?: { data?: { detail?: string } }; message?: string };
  return e?.response?.data?.detail ?? e?.message ?? 'Something went wrong.';
}
