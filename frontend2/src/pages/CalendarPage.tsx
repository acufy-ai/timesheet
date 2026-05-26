import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  parseISO,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { Loading, Error, EmptyState } from '@/components';
import {
  useDeleteHoliday,
  useHolidays,
  useIsAdmin,
  useMyPreferences,
  useTimeEntries,
  useTimeOffRequests,
  useUpdateTimeEntry,
  useUpdateTimeOffRequest,
  useWeekStartsOn,
} from '@/hooks';
import {
  AddHolidayModal,
  HolidayBadge,
  HolidayCountryFilter,
  HolidayDetailRow,
  HOLIDAY_COUNTRY_PREFERENCE_KEY,
} from '@/components/holidays';
import type { Holiday, TimeEntry, TimeOffRequest } from '@/types';

type CalendarEntryStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
type CalendarEntryType = 'TIMESHEET' | 'TIME_OFF';

type CalendarEntry = {
  id: number;
  date: string;
  hours: string | number;
  status: CalendarEntryStatus;
  description: string;
  entryType: CalendarEntryType;
};

type DaySummary = {
  date: Date;
  entries: CalendarEntry[];
  holidays: Holiday[];
  workHours: number;
  timeOffHours: number;
};

const getHours = (value: string | number) => (typeof value === 'string' ? parseFloat(value) : value);

export const CalendarPage: React.FC = () => {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedEntryKey, setSelectedEntryKey] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [holidayModalOpen, setHolidayModalOpen] = useState(false);
  const [holidayPrefillDate, setHolidayPrefillDate] = useState<string | undefined>(undefined);
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  const canManageHolidays = isAdmin;

  const { data: timeEntries, isLoading: isLoadingTimeEntries, error: timeEntriesError } = useTimeEntries({ limit: 500 });
  const { data: timeOffEntries, isLoading: isLoadingTimeOff, error: timeOffError } = useTimeOffRequests({ limit: 500 });
  const { data: preferences } = useMyPreferences();
  const holidayCountry = (preferences?.[HOLIDAY_COUNTRY_PREFERENCE_KEY] as string | undefined) || undefined;
  const { data: holidays } = useHolidays(holidayCountry ? { country: holidayCountry } : undefined);
  const deleteHolidayMutation = useDeleteHoliday();
  const selectedEntryId = selectedEntryKey ? Number(selectedEntryKey.split('-')[1]) : 0;
  const updateTimeEntryMutation = useUpdateTimeEntry(selectedEntryId || 0);
  const updateTimeOffMutation = useUpdateTimeOffRequest(selectedEntryId || 0);

  const weekStartsOn = useWeekStartsOn();
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const gridStart = startOfWeek(monthStart, { weekStartsOn });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn });

  const calendarDays = eachDayOfInterval({ start: gridStart, end: gridEnd });

  const normalizedEntries: CalendarEntry[] = useMemo(() => {
    const safeTimeEntries = Array.isArray(timeEntries) ? timeEntries : [];
    const safeTimeOff = Array.isArray(timeOffEntries) ? timeOffEntries : [];
    const normalizedTimeEntries: CalendarEntry[] = safeTimeEntries.map((entry: TimeEntry) => ({
      id: entry.id,
      date: entry.entry_date,
      hours: entry.hours,
      status: entry.status,
      description: entry.description,
      entryType: 'TIMESHEET',
    }));

    const normalizedTimeOffEntries: CalendarEntry[] = safeTimeOff.map((entry: TimeOffRequest) => ({
      id: entry.id,
      date: entry.request_date,
      hours: entry.hours,
      status: entry.status,
      description: entry.reason,
      entryType: 'TIME_OFF',
    }));

    return [...normalizedTimeEntries, ...normalizedTimeOffEntries];
  }, [timeEntries, timeOffEntries]);

  const dailySummaries = useMemo(() => {
    const safeHolidays = Array.isArray(holidays) ? holidays : [];
    return calendarDays.map((day): DaySummary => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const dayEntries = normalizedEntries.filter((entry: CalendarEntry) => isSameDay(parseISO(entry.date), day));
      const dayHolidays = safeHolidays.filter((h) => h.date === dateStr);
      const workHours = dayEntries
        .filter((entry: CalendarEntry) => entry.entryType === 'TIMESHEET')
        .reduce((sum: number, entry: CalendarEntry) => sum + getHours(entry.hours), 0);
      const timeOffHours = dayEntries
        .filter((entry: CalendarEntry) => entry.entryType === 'TIME_OFF')
        .reduce((sum: number, entry: CalendarEntry) => sum + getHours(entry.hours), 0);

      return { date: day, entries: dayEntries, holidays: dayHolidays, workHours, timeOffHours };
    });
  }, [normalizedEntries, calendarDays, holidays]);

  if ((isLoadingTimeEntries && !timeEntries) || (isLoadingTimeOff && !timeOffEntries)) return <Loading />;
  if (timeEntriesError || timeOffError) return <Error message="Something went wrong loading calendar data. Please refresh." />;

  const selectedSummary = selectedDate
    ? dailySummaries.find((summary) => isSameDay(summary.date, selectedDate))
    : null;

  const selectedEntry =
    selectedSummary?.entries.find(
      (entry: CalendarEntry) => `${entry.entryType}-${entry.id}` === selectedEntryKey
    ) || null;

  const handleOpenEntryContext = (entry: CalendarEntry) => {
    const baseRoute = entry.entryType === 'TIME_OFF' ? '/time-off' : '/my-time';
    navigate(`${baseRoute}?date=${entry.date}&entryId=${entry.id}`);
  };

  const handleAddNote = async () => {
    if (!selectedEntry) return;
    if (selectedEntry.status !== 'DRAFT') {
      setStatusMessage({ type: 'error', text: 'Only DRAFT entries can be updated with notes.' });
      return;
    }

    const trimmedNote = noteText.trim();
    if (!trimmedNote) {
      setStatusMessage({ type: 'error', text: 'Please enter a note first.' });
      return;
    }

    const noteStamp = format(new Date(), 'yyyy-MM-dd HH:mm');

    try {
      if (selectedEntry.entryType === 'TIME_OFF') {
        const updatedReason = `${selectedEntry.description}\n[NOTE ${noteStamp}] ${trimmedNote}`;
        await updateTimeOffMutation.mutateAsync({ reason: updatedReason });
      } else {
        const updatedDescription = `${selectedEntry.description}\n[NOTE ${noteStamp}] ${trimmedNote}`;
        await updateTimeEntryMutation.mutateAsync({
          description: updatedDescription,
          edit_reason: 'Added calendar note',
          history_summary: `Added note on ${noteStamp}`,
        });
      }
      setNoteText('');
      setStatusMessage({ type: 'success', text: 'Note added successfully.' });
    } catch (updateError) {
      console.error('Failed to add note', updateError);
      setStatusMessage({ type: 'error', text: 'Failed to add note.' });
    }
  };

  return (
    <div>
      <div>
        <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
          <h1 className="text-3xl font-bold">Calendar</h1>
          <div className="flex items-center gap-2 flex-wrap">
            {canManageHolidays && (
              <button
                type="button"
                onClick={() => { setHolidayPrefillDate(undefined); setHolidayModalOpen(true); }}
                className="h-9 px-4 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors flex items-center gap-1.5"
              >
                <Plus className="h-4 w-4" /> Add Holiday
              </button>
            )}
            <HolidayCountryFilter />
            <button
              onClick={() => setCurrentMonth((prev) => subMonths(prev, 1))}
              className="p-2 border rounded hover:bg-muted"
              aria-label="Previous month"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <p className="min-w-[180px] text-center font-medium">{format(currentMonth, 'MMMM yyyy')}</p>
            <button
              onClick={() => setCurrentMonth((prev) => addMonths(prev, 1))}
              className="p-2 border rounded hover:bg-muted"
              aria-label="Next month"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-2 mb-2 text-sm font-medium text-muted-foreground">
          {(weekStartsOn === 1
            ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
            : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
          ).map((label) => (
            <div key={label} className="px-2 py-1 text-center">
              {label}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-2">
          {dailySummaries.map((summary) => {
            const inCurrentMonth = isSameMonth(summary.date, currentMonth);
            const selected = selectedDate ? isSameDay(summary.date, selectedDate) : false;

            return (
              <button
                key={summary.date.toISOString()}
                onClick={() => {
                  setSelectedDate(summary.date);
                  setSelectedEntryKey(null);
                  setNoteText('');
                }}
                className={`min-h-[96px] text-left border rounded p-2 transition ${
                  selected ? 'ring-2 ring-primary border-primary' : 'hover:bg-muted/50'
                } ${inCurrentMonth ? 'bg-card' : 'bg-muted/30 text-muted-foreground'}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-sm ${isToday(summary.date) ? 'font-bold text-primary' : ''}`}>
                    {format(summary.date, 'd')}
                  </span>
                  {summary.entries.length > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-primary/10 rounded">{summary.entries.length}</span>
                  )}
                </div>

                {summary.holidays.map((h) => (
                  <HolidayBadge key={h.id} holiday={h} />
                ))}

                <div className="space-y-1">
                  {summary.workHours > 0 && (
                    <div className="text-[11px] px-1 py-0.5 rounded bg-slate-200 text-slate-600">Work: {summary.workHours}h</div>
                  )}
                  {summary.timeOffHours > 0 && (
                    <div className="text-[11px] px-1 py-0.5 rounded bg-slate-100 text-slate-500">Off: {summary.timeOffHours}h</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-8 bg-card border rounded-lg p-5">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="text-xl font-bold">
              {selectedDate ? `Details for ${format(selectedDate, 'PPP')}` : 'Select a day'}
            </h2>
            {canManageHolidays && selectedDate && (
              <button
                type="button"
                onClick={() => {
                  setHolidayPrefillDate(format(selectedDate, 'yyyy-MM-dd'));
                  setHolidayModalOpen(true);
                }}
                className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-muted font-medium transition flex items-center gap-1"
              >
                <Plus className="h-3 w-3" /> Holiday
              </button>
            )}
          </div>

          {selectedSummary && selectedSummary.holidays.length > 0 && (
            <div className="mb-4 space-y-2">
              {selectedSummary.holidays.map((h) => (
                <HolidayDetailRow
                  key={h.id}
                  holiday={h}
                  canManage={canManageHolidays}
                  onDelete={(id) => deleteHolidayMutation.mutate(id)}
                />
              ))}
            </div>
          )}

          {!selectedSummary || (selectedSummary.entries.length === 0 && selectedSummary.holidays.length === 0) ? (
            <EmptyState message="No entries for this day." />
          ) : selectedSummary.entries.length === 0 ? null : (
            <div className="space-y-3">
              {selectedSummary.entries.map((entry) => {
                const isSelectedEntry = selectedEntryKey === `${entry.entryType}-${entry.id}`;
                return (
                  <button
                    key={`${entry.entryType}-${entry.id}`}
                    onClick={() => setSelectedEntryKey(`${entry.entryType}-${entry.id}`)}
                    className={`w-full text-left border rounded p-3 transition ${
                      isSelectedEntry ? 'ring-2 ring-primary border-primary' : 'hover:bg-muted/40'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <p className="font-medium">{entry.entryType === 'TIME_OFF' ? 'Time Off' : 'Timesheet'}</p>
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                        entry.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-700' :
                        entry.status === 'SUBMITTED' ? 'bg-blue-100 text-blue-700' :
                        entry.status === 'REJECTED' ? 'bg-red-100 text-red-700' :
                        'bg-slate-100 text-slate-600'
                      }`}>{entry.status}</span>
                    </div>
                    <p className="text-sm text-muted-foreground mb-1">{entry.description}</p>
                    <p className="text-sm">{getHours(entry.hours)} hours</p>
                  </button>
                );
              })}

              {selectedEntry && (
                <div className="mt-4 border rounded-lg p-4 bg-muted/30">
                  <h3 className="font-semibold mb-3">Selected Entry Actions</h3>
                  <div className="flex flex-wrap gap-2 mb-3">
                    <button
                      onClick={() => handleOpenEntryContext(selectedEntry)}
                      className="px-3 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90"
                    >
                      Open in {selectedEntry.entryType === 'TIME_OFF' ? 'Time Off' : 'My Time'}
                    </button>
                    {selectedEntry.status !== 'DRAFT' && (
                      <span className="text-xs px-2 py-2 text-muted-foreground">
                        Entry is {selectedEntry.status}. Edit is restricted to DRAFT entries.
                      </span>
                    )}
                  </div>

                  {statusMessage && (
                    <p className={`text-sm mb-2 ${statusMessage.type === 'error' ? 'text-red-600' : 'text-emerald-600'}`}>
                      {statusMessage.text}
                    </p>
                  )}

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Add note</label>
                    <textarea
                      value={noteText}
                      onChange={(event) => setNoteText(event.target.value)}
                      placeholder="Add note for this entry"
                      className="w-full px-3 py-2 border rounded"
                      rows={3}
                    />
                    <button
                      onClick={handleAddNote}
                      disabled={updateTimeEntryMutation.isPending || updateTimeOffMutation.isPending || selectedEntry.status !== 'DRAFT'}
                      className="px-3 py-2 border rounded hover:bg-muted disabled:opacity-50"
                    >
                      {updateTimeEntryMutation.isPending || updateTimeOffMutation.isPending ? 'Saving...' : 'Save Note'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <AddHolidayModal
        isOpen={holidayModalOpen}
        onClose={() => setHolidayModalOpen(false)}
        prefillDate={holidayPrefillDate}
      />
    </div>
  );
};
