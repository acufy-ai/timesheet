import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, MessageSquarePlus, Plus, Trash2 } from 'lucide-react';

import { Button, Card, Input, Modal, WorkspaceHeader } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { useMyEntries, useUpdateEntry } from '@/hooks/useTime';
import { useCreateHoliday, useDeleteHoliday, useHolidays, useMyTimeOff } from '@/hooks/useAdmin';
import { ImportHolidaysModal } from '@/components/calendar/ImportHolidaysModal';
import { addDays, fromISODate, startOfWeek, toISODate } from '@/lib/date';
import { cn } from '@/lib/cn';

const num = (v: string | number) => (typeof v === 'string' ? parseFloat(v) : v) || 0;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Month calendar overlaying the user's logged hours, time-off, and workspace
// holidays. Admins can add/remove holidays. Clicking a day opens a detail
// popover with that day's hours, PTO, and holidays.
export function CalendarPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'PLATFORM_ADMIN';

  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [holidayModal, setHolidayModal] = useState(false);
  const [hName, setHName] = useState('');
  const [hDate, setHDate] = useState('');
  const [hType, setHType] = useState<'PUBLIC' | 'COMPANY'>('COMPANY');
  const [flash, setFlash] = useState<string | null>(null);
  const [country, setCountry] = useState<string>('all');

  const gridStart = useMemo(() => startOfWeek(cursor), [cursor]);
  const gridDays = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)), [gridStart]);
  const rangeStart = toISODate(gridDays[0]);
  const rangeEnd = toISODate(gridDays[41]);

  const entriesQ = useMyEntries(rangeStart, rangeEnd);
  const timeOffQ = useMyTimeOff();
  const holidaysQ = useHolidays({ start_date: rangeStart, end_date: rangeEnd, country: country === 'all' ? undefined : country });
  // Distinct countries seen in the loaded holidays, for the filter dropdown.
  const countries = useMemo(() => {
    const set = new Set<string>();
    (holidaysQ.data ?? []).forEach((h) => { if (h.country) set.add(h.country); });
    return [...set].sort();
  }, [holidaysQ.data]);

  const createHoliday = useCreateHoliday();
  const deleteHoliday = useDeleteHoliday();
  const updateEntry = useUpdateEntry();

  // Draft entries on the selected day (notes can only be appended to drafts).
  // Notes can be appended to editable entries (the backend allows updates only
  // on DRAFT or REJECTED; SUBMITTED/APPROVED are locked).
  const dayNotableEntries = useMemo(
    () => (entriesQ.data ?? []).filter((e) => {
      const s = (e.status ?? '').toUpperCase();
      return e.entry_date === selectedDay && (s === 'DRAFT' || s === 'REJECTED');
    }),
    [entriesQ.data, selectedDay],
  );
  const [noteFor, setNoteFor] = useState<number | null>(null);
  const [noteText, setNoteText] = useState('');
  const [importOpen, setImportOpen] = useState(false);

  async function saveNote(entry: { id: number; description?: string | null }) {
    const note = noteText.trim();
    if (!note) return;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const desc = `${entry.description ?? ''}${entry.description ? '\n' : ''}[NOTE ${stamp}] ${note}`;
    try {
      // The backend requires edit_reason + history_summary on every update
      // (crud/time_entry.py) — omitting them 400s.
      await updateEntry.mutateAsync({
        id: entry.id,
        data: { description: desc, edit_reason: 'Added calendar note', history_summary: `Added note on ${stamp}` } as never,
      });
      setNoteFor(null); setNoteText('');
      setFlash('Note added.'); window.setTimeout(() => setFlash(null), 3000);
    } catch (e) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setFlash(typeof d === 'string' ? d : 'Could not add the note.'); window.setTimeout(() => setFlash(null), 4000);
    }
  }

  const hoursByDay = useMemo(() => {
    const m = new Map<string, number>();
    (entriesQ.data ?? []).forEach((e) => m.set(e.entry_date, (m.get(e.entry_date) ?? 0) + num(e.hours)));
    return m;
  }, [entriesQ.data]);

  // Dominant status per day (least-settled wins) so each cell can show a small
  // status pill alongside the hours. Same rank order as the History tab.
  const STATUS_RANK: Record<string, number> = { REJECTED: 0, DRAFT: 1, SUBMITTED: 2, APPROVED: 3 };
  const STATUS_PILL: Record<string, { label: string; cls: string }> = {
    APPROVED: { label: 'Approved', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300' },
    SUBMITTED: { label: 'Submitted', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-300' },
    DRAFT: { label: 'Draft', cls: 'bg-muted text-muted-foreground' },
    REJECTED: { label: 'Sent back', cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-300' },
  };
  const statusByDay = useMemo(() => {
    const m = new Map<string, string>();
    (entriesQ.data ?? []).forEach((e) => {
      const s = (e.status ?? '').toUpperCase();
      const cur = m.get(e.entry_date);
      if (!cur || (STATUS_RANK[s] ?? 9) < (STATUS_RANK[cur] ?? 9)) m.set(e.entry_date, s);
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entriesQ.data]);

  const ptoByDay = useMemo(() => {
    const m = new Map<string, { hours: number; type: string }[]>();
    (timeOffQ.data ?? [])
      .filter((r) => r.status === 'APPROVED' || r.status === 'SUBMITTED')
      .forEach((r) => {
        const l = m.get(r.request_date) ?? [];
        l.push({ hours: num(r.hours), type: r.leave_type });
        m.set(r.request_date, l);
      });
    return m;
  }, [timeOffQ.data]);

  const holidaysByDay = useMemo(() => {
    const m = new Map<string, { id: number; name: string; type: string }[]>();
    (holidaysQ.data ?? []).forEach((h) => {
      const l = m.get(h.date) ?? [];
      l.push({ id: h.id, name: h.name, type: h.holiday_type });
      m.set(h.date, l);
    });
    return m;
  }, [holidaysQ.data]);

  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const monthIdx = cursor.getMonth();
  const monthYear = cursor.getFullYear();

  // Holidays that fall in the displayed month (for the count badge + popup).
  const monthHolidays = useMemo(
    () => (holidaysQ.data ?? [])
      .filter((h) => { const d = fromISODate(h.date); return d.getMonth() === monthIdx && d.getFullYear() === monthYear; })
      .sort((a, b) => a.date.localeCompare(b.date)),
    [holidaysQ.data, monthIdx, monthYear],
  );
  // Logged hours that fall in the displayed month (strip total).
  const monthHours = useMemo(() => {
    let sum = 0;
    hoursByDay.forEach((h, iso) => { const d = fromISODate(iso); if (d.getMonth() === monthIdx && d.getFullYear() === monthYear) sum += h; });
    return sum;
  }, [hoursByDay, monthIdx, monthYear]);
  const [holidaysPopupOpen, setHolidaysPopupOpen] = useState(false);

  function goMonth(delta: number) {
    setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1));
    setSelectedDay(null);
  }
  function openAddHoliday(date?: string) {
    setHName(''); setHDate(date ?? toISODate(today)); setHType('COMPANY'); setHolidayModal(true);
  }
  async function submitHoliday(e: React.FormEvent) {
    e.preventDefault();
    if (!hName.trim() || !hDate) return;
    try {
      await createHoliday.mutateAsync({ date: hDate, name: hName.trim(), holiday_type: hType });
      setHolidayModal(false);
    } catch { setFlash('Could not add the holiday.'); window.setTimeout(() => setFlash(null), 4000); }
  }
  async function removeHoliday(id: number) {
    if (!window.confirm('Remove this holiday?')) return;
    try { await deleteHoliday.mutateAsync(id); } catch { setFlash('Could not remove the holiday.'); window.setTimeout(() => setFlash(null), 4000); }
  }

  const loading = entriesQ.isLoading || holidaysQ.isLoading;
  const selDetail = selectedDay
    ? {
        hours: hoursByDay.get(selectedDay) ?? 0,
        pto: ptoByDay.get(selectedDay) ?? [],
        holidays: holidaysByDay.get(selectedDay) ?? [],
      }
    : null;

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        title="Calendar"
        description="Logged hours, time off, and holidays."
        primary={
          <div className="flex items-center gap-2">
            {countries.length > 0 || country !== 'all' ? (
              <select value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Holiday country" className="h-9 rounded-full border border-border bg-card px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20">
                <option value="all">All countries</option>
                {countries.map((c) => <option key={c} value={c}>{c}</option>)}
                {country !== 'all' && !countries.includes(country) ? <option value={country}>{country}</option> : null}
              </select>
            ) : null}
            <Button variant="secondary" onClick={() => setHolidaysPopupOpen(true)} disabled={monthHolidays.length === 0}>
              Holidays ({monthHolidays.length})
            </Button>
            {isAdmin ? (
              <>
                <Button variant="secondary" onClick={() => setImportOpen(true)}>Import holidays</Button>
                <Button variant="secondary" onClick={() => openAddHoliday()}>
                  <Plus className="h-4 w-4" /> Add holiday
                </Button>
              </>
            ) : null}
            <div className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-card px-3 text-sm">
              <button type="button" onClick={() => goMonth(-1)} aria-label="Previous month" className="text-muted-foreground transition-colors hover:text-primary">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-[120px] text-center font-medium text-foreground">{monthLabel}</span>
              <button type="button" onClick={() => goMonth(1)} aria-label="Next month" className="text-muted-foreground transition-colors hover:text-primary">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        }
      />

      {flash ? <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">{flash}</div> : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <Card className="p-3">
          {loading ? (
            <div className="grid place-items-center py-20 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>
          ) : (
            <>
              {/* Month-total strip + status legend. */}
              <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-border bg-muted/30 px-3 py-2">
                <p className="text-sm text-foreground">
                  <span className="font-semibold tabular-nums">{monthHours.toFixed(monthHours % 1 === 0 ? 0 : 1)}h</span>
                  <span className="text-muted-foreground"> logged in {monthLabel}</span>
                </p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                  {(['APPROVED', 'SUBMITTED', 'DRAFT', 'REJECTED'] as const).map((s) => (
                    <span key={s} className="inline-flex items-center gap-1">
                      <span className={cn('h-2 w-2 rounded-full', STATUS_PILL[s].cls.split(' ')[0])} />
                      {STATUS_PILL[s].label}
                    </span>
                  ))}
                  <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-sky-500" />Time off</span>
                  <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-rose-500" />Holiday</span>
                </div>
              </div>
              <div className="grid grid-cols-7 gap-1.5 pb-2">
                {WEEKDAYS.map((d) => (
                  <div key={d} className="text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{d}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1.5">
                {gridDays.map((d) => {
                  const iso = toISODate(d);
                  const hours = hoursByDay.get(iso) ?? 0;
                  const dayStatus = statusByDay.get(iso);
                  const pto = ptoByDay.get(iso) ?? [];
                  const hols = holidaysByDay.get(iso) ?? [];
                  const inMonth = d.getMonth() === monthIdx;
                  const isToday = iso === toISODate(today);
                  const isSel = iso === selectedDay;
                  return (
                    <button
                      key={iso}
                      type="button"
                      onClick={() => setSelectedDay(iso)}
                      className={cn(
                        'flex min-h-[76px] flex-col rounded-xl border p-2 text-left transition-colors',
                        inMonth ? 'border-border bg-card hover:border-primary/30' : 'border-transparent bg-muted/30',
                        isToday ? 'ring-2 ring-primary/40' : '',
                        isSel ? 'border-primary/50 bg-primary/5' : '',
                      )}
                    >
                      <span className="flex items-center justify-between">
                        <span className={cn('text-xs', inMonth ? 'text-foreground' : 'text-muted-foreground/50', isToday ? 'font-semibold text-primary' : '')}>
                          {d.getDate()}
                        </span>
                        {/* Holidays now show as a small rose dot; the full list
                            is in the "Holidays (N)" popup, not on every cell. */}
                        {hols.length > 0 ? (
                          <span className="h-1.5 w-1.5 rounded-full bg-rose-500" title={hols.map((h) => h.name).join(', ')} aria-label={`Holiday: ${hols.map((h) => h.name).join(', ')}`} />
                        ) : null}
                      </span>
                      <div className="mt-auto flex flex-col gap-0.5">
                        {pto.length > 0 ? (
                          <span className="inline-flex w-fit items-center rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-sky-600 dark:text-sky-300">
                            Time off
                          </span>
                        ) : null}
                        {hours > 0 ? (
                          <span className={cn('inline-flex w-fit items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums', dayStatus ? STATUS_PILL[dayStatus].cls : 'bg-primary/10 text-primary')}>
                            {hours.toFixed(hours % 1 === 0 ? 0 : 1)}h
                            {dayStatus ? <span className="font-medium opacity-90">· {STATUS_PILL[dayStatus].label}</span> : null}
                          </span>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </Card>

        {/* Day detail */}
        <Card className="self-start p-4">
          {selectedDay && selDetail ? (
            <>
              <p className="text-sm font-semibold text-foreground">
                {new Date(`${selectedDay}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
              </p>
              <div className="mt-3 space-y-3 text-sm">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Logged</p>
                  <p className="text-foreground">{selDetail.hours.toFixed(2)} hours</p>
                </div>

                {/* Editable entries (draft/rejected) — append a quick note. */}
                {dayNotableEntries.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Editable entries</p>
                    {dayNotableEntries.map((e) => (
                      <div key={e.id} className="rounded-lg border border-border p-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="min-w-0 truncate text-foreground">{e.project?.name ?? `#${e.project_id}`} · {num(e.hours).toFixed(2)}h</p>
                          <button type="button" aria-label="Add note" onClick={() => { setNoteFor(noteFor === e.id ? null : e.id); setNoteText(''); }} className="shrink-0 text-muted-foreground hover:text-primary"><MessageSquarePlus className="h-3.5 w-3.5" /></button>
                        </div>
                        {noteFor === e.id ? (
                          <div className="mt-2 space-y-1.5">
                            <textarea value={noteText} onChange={(ev) => setNoteText(ev.target.value)} rows={2} autoFocus placeholder="Add a note…" className="w-full rounded-lg border border-border bg-transparent px-2 py-1 text-xs focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" />
                            <div className="flex justify-end gap-1.5">
                              <Button size="sm" variant="ghost" onClick={() => setNoteFor(null)}>Cancel</Button>
                              <Button size="sm" onClick={() => void saveNote(e)} disabled={!noteText.trim() || updateEntry.isPending}>{updateEntry.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}</Button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                {selDetail.pto.length > 0 ? (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Time off</p>
                    {selDetail.pto.map((p, i) => (
                      <p key={i} className="text-foreground">{p.type} · {p.hours.toFixed(1)}h</p>
                    ))}
                  </div>
                ) : null}
                {selDetail.holidays.length > 0 ? (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Holidays</p>
                    {selDetail.holidays.map((h) => (
                      <div key={h.id} className="flex items-center justify-between">
                        <p className="text-foreground">{h.name} <span className="text-xs text-muted-foreground">({h.type.toLowerCase()})</span></p>
                        {isAdmin ? (
                          <button type="button" aria-label="Remove holiday" onClick={() => removeHoliday(h.id)} className="text-muted-foreground hover:text-rose-500">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                {selDetail.hours === 0 && selDetail.pto.length === 0 && selDetail.holidays.length === 0 ? (
                  <p className="text-muted-foreground">Nothing on this day.</p>
                ) : null}
                {isAdmin ? (
                  <Button size="sm" variant="secondary" onClick={() => openAddHoliday(selectedDay)}>
                    <Plus className="h-3.5 w-3.5" /> Add holiday here
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Select a day to see its details.</p>
          )}
        </Card>
      </div>

      {/* Holidays popup — the month's holidays, moved off the calendar cells. */}
      <Modal open={holidaysPopupOpen} onClose={() => setHolidaysPopupOpen(false)} title={`Holidays — ${monthLabel}`}>
        {monthHolidays.length === 0 ? (
          <p className="text-sm text-muted-foreground">No holidays this month.</p>
        ) : (
          <ul className="space-y-1.5">
            {monthHolidays.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{h.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {fromISODate(h.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                    {' · '}{h.holiday_type.toLowerCase()}{h.country ? ` · ${h.country}` : ''}
                  </p>
                </div>
                {isAdmin ? (
                  <button type="button" aria-label="Remove holiday" onClick={() => removeHoliday(h.id)} className="shrink-0 text-muted-foreground hover:text-rose-500">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {isAdmin ? (
          <div className="mt-3 flex justify-end">
            <Button size="sm" variant="secondary" onClick={() => { setHolidaysPopupOpen(false); openAddHoliday(); }}>
              <Plus className="h-3.5 w-3.5" /> Add holiday
            </Button>
          </div>
        ) : null}
      </Modal>

      <ImportHolidaysModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={(msg) => { setFlash(msg); window.setTimeout(() => setFlash(null), 4000); }}
      />

      {/* Add holiday modal */}
      <Modal open={holidayModal} onClose={() => setHolidayModal(false)} title="Add holiday">
        <form onSubmit={submitHoliday} className="space-y-3">
          <div>
            <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Name</label>
            <Input value={hName} onChange={(e) => setHName(e.target.value)} placeholder="e.g. Independence Day" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Date</label>
              <Input type="date" value={hDate} onChange={(e) => setHDate(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Type</label>
              <select value={hType} onChange={(e) => setHType(e.target.value as 'PUBLIC' | 'COMPANY')} className="h-10 w-full rounded-full border border-border bg-transparent px-4 text-[15px] text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20">
                <option value="COMPANY">Company</option>
                <option value="PUBLIC">Public</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setHolidayModal(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={createHoliday.isPending || !hName.trim() || !hDate}>
              {createHoliday.isPending ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding…</>) : 'Add holiday'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
