import React, { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { X, Plus, Download, Loader2 } from 'lucide-react';

import {
  useCreateHoliday,
  useBulkCreateHolidays,
  useHolidaySuggestions,
} from '@/hooks';
import type { HolidayType } from '@/types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  prefillDate?: string;
}

type Tab = 'manual' | 'import';

const COUNTRIES = [
  { code: 'US', label: 'United States' },
  { code: 'IN', label: 'India' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'CA', label: 'Canada' },
  { code: 'AU', label: 'Australia' },
  { code: 'DE', label: 'Germany' },
  { code: 'FR', label: 'France' },
  { code: 'BR', label: 'Brazil' },
  { code: 'JP', label: 'Japan' },
  { code: 'MX', label: 'Mexico' },
];

/** Admin-only modal for adding a single holiday OR importing the
 *  public-holiday calendar for a country/year. */
export const AddHolidayModal: React.FC<Props> = ({ isOpen, onClose, prefillDate }) => {
  const [tab, setTab] = useState<Tab>('manual');

  // Manual-tab state
  const [name, setName] = useState('');
  const [date, setDate] = useState(prefillDate || format(new Date(), 'yyyy-MM-dd'));
  const [type, setType] = useState<HolidayType>('COMPANY');

  // Import-tab state
  const [country, setCountry] = useState('US');
  const [year, setYear] = useState(new Date().getFullYear());
  const [importEnabled, setImportEnabled] = useState(false);
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());

  const createMutation = useCreateHoliday();
  const bulkMutation = useBulkCreateHolidays();
  const suggestions = useHolidaySuggestions(country, year, importEnabled);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setDate(prefillDate || format(new Date(), 'yyyy-MM-dd'));
      setType('COMPANY');
      setTab('manual');
      setImportEnabled(false);
      setSelectedDates(new Set());
    }
  }, [isOpen, prefillDate]);

  // When suggestions arrive, default-select all of them.
  useEffect(() => {
    const list = Array.isArray(suggestions.data?.holidays) ? suggestions.data!.holidays : [];
    if (list.length > 0) {
      setSelectedDates(new Set(list.map((h) => h.date)));
    }
  }, [suggestions.data]);

  const selectedCount = selectedDates.size;
  const sortedSuggestions = useMemo(
    () => (Array.isArray(suggestions.data?.holidays) ? suggestions.data!.holidays : []),
    [suggestions.data],
  );

  if (!isOpen) return null;

  const handleSaveSingle = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !date) return;
    try {
      await createMutation.mutateAsync({ date, name: name.trim(), holiday_type: type });
      onClose();
    } catch (err) {
      // mutation surfaces error via createMutation.error below
    }
  };

  const handleImport = async () => {
    const list = Array.isArray(suggestions.data?.holidays) ? suggestions.data!.holidays : [];
    const picks = list.filter((h) => selectedDates.has(h.date));
    if (picks.length === 0) return;
    try {
      await bulkMutation.mutateAsync(
        picks.map((p) => ({
          date: p.date,
          name: p.name,
          holiday_type: 'PUBLIC' as HolidayType,
          country: p.country,
        })),
      );
      onClose();
    } catch (err) {
      // surfaced via bulkMutation.error
    }
  };

  const toggleDate = (d: string) => {
    setSelectedDates((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-border bg-card shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-bold">Add Holiday</h2>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 flex items-center justify-center rounded-lg hover:bg-muted text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab strip */}
        <div className="flex border-b border-border">
          <button
            type="button"
            className={`flex-1 py-3 text-sm font-medium border-b-2 transition ${
              tab === 'manual'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setTab('manual')}
          >
            <Plus className="inline h-3.5 w-3.5 mr-1" /> Single holiday
          </button>
          <button
            type="button"
            className={`flex-1 py-3 text-sm font-medium border-b-2 transition ${
              tab === 'import'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setTab('import')}
          >
            <Download className="inline h-3.5 w-3.5 mr-1" /> Import public holidays
          </button>
        </div>

        {tab === 'manual' && (
          <form onSubmit={handleSaveSingle} className="p-6 space-y-5">
            <div>
              <label className="block text-sm font-medium mb-1.5">Holiday Name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Founders Day"
                required
                className="w-full px-4 py-2.5 rounded-xl border border-border bg-card text-sm focus:ring-1 focus:ring-primary focus:border-primary transition"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Date *</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                className="w-full px-4 py-2.5 rounded-xl border border-border bg-card text-sm focus:ring-1 focus:ring-primary focus:border-primary transition"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Type</label>
              <div className="flex gap-2">
                {(['PUBLIC', 'COMPANY'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    className={`flex-1 py-2 rounded-xl text-xs font-semibold uppercase tracking-wider border transition-all ${
                      type === t
                        ? t === 'PUBLIC'
                          ? 'bg-rose-500/15 text-rose-400 border-rose-500/40'
                          : 'bg-violet-500/15 text-violet-400 border-violet-500/40'
                        : 'border-border text-muted-foreground hover:bg-muted/50'
                    }`}
                  >
                    {t === 'PUBLIC' ? 'Public' : 'Company'}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Both types excuse a working day for the manager dashboard late signal.
              </p>
            </div>
            {createMutation.isError && (
              <p className="text-sm text-destructive">
                Failed to save. {(createMutation.error as Error | undefined)?.message ?? ''}
              </p>
            )}
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-muted transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!name.trim() || createMutation.isPending}
                className="flex-1 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition disabled:opacity-40 flex items-center justify-center gap-2"
              >
                {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Save Holiday
              </button>
            </div>
          </form>
        )}

        {tab === 'import' && (
          <div className="p-6 space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1.5">Country</label>
                <select
                  value={country}
                  onChange={(e) => {
                    setCountry(e.target.value);
                    setImportEnabled(false);
                  }}
                  className="w-full px-4 py-2.5 rounded-xl border border-border bg-card text-sm focus:ring-1 focus:ring-primary focus:border-primary"
                >
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Year</label>
                <input
                  type="number"
                  min={1970}
                  max={2100}
                  value={year}
                  onChange={(e) => {
                    setYear(Number(e.target.value));
                    setImportEnabled(false);
                  }}
                  className="w-full px-4 py-2.5 rounded-xl border border-border bg-card text-sm focus:ring-1 focus:ring-primary focus:border-primary"
                />
              </div>
            </div>

            {!importEnabled && (
              <button
                type="button"
                onClick={() => setImportEnabled(true)}
                className="w-full py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-muted transition"
              >
                Preview holidays for {country} {year}
              </button>
            )}

            {importEnabled && suggestions.isLoading && (
              <div className="py-8 text-center text-muted-foreground text-sm">
                <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
                Loading…
              </div>
            )}

            {importEnabled && suggestions.isError && (
              <p className="text-sm text-destructive">
                Could not load holidays for {country} {year}. The country code may not be supported.
              </p>
            )}

            {importEnabled && suggestions.data && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-muted-foreground">
                    {sortedSuggestions.length} holidays · {selectedCount} selected
                  </span>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      className="text-xs px-2 py-1 rounded border border-border hover:bg-muted"
                      onClick={() => setSelectedDates(new Set(sortedSuggestions.map((h) => h.date)))}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="text-xs px-2 py-1 rounded border border-border hover:bg-muted"
                      onClick={() => setSelectedDates(new Set())}
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div className="max-h-64 overflow-y-auto rounded-xl border border-border divide-y divide-border">
                  {sortedSuggestions.map((h) => {
                    const checked = selectedDates.has(h.date);
                    return (
                      <label
                        key={h.date}
                        className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 cursor-pointer text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleDate(h.date)}
                        />
                        <span className="text-muted-foreground tabular-nums text-xs w-24">{h.date}</span>
                        <span>{h.name}</span>
                      </label>
                    );
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground mt-2">
                  Dates already on the calendar are skipped on import.
                </p>
              </div>
            )}

            {bulkMutation.isError && (
              <p className="text-sm text-destructive">
                Failed to import. {(bulkMutation.error as Error | undefined)?.message ?? ''}
              </p>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-muted transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleImport}
                disabled={selectedCount === 0 || bulkMutation.isPending || !suggestions.data}
                className="flex-1 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition disabled:opacity-40 flex items-center justify-center gap-2"
              >
                {bulkMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Import {selectedCount > 0 ? `${selectedCount} holiday${selectedCount === 1 ? '' : 's'}` : 'holidays'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
