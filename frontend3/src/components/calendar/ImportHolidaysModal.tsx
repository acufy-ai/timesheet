import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button, Input, Modal } from '@/components/ui';
import { useBulkCreateHolidays, useHolidaySuggestions } from '@/hooks/useAdmin';

// Import public holidays for a country/year: preview the suggestions (powered
// by python-holidays on the backend), pick which to add, then bulk-create.
export function ImportHolidaysModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const [country, setCountry] = useState('US');
  const [year, setYear] = useState(new Date().getFullYear());
  const [queried, setQueried] = useState<{ country: string; year: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const suggestQ = useHolidaySuggestions(queried?.country ?? null, queried?.year ?? null);
  const bulk = useBulkCreateHolidays();
  const holidays = suggestQ.data?.holidays ?? [];

  function preview() {
    setQueried({ country: country.trim().toUpperCase(), year });
    setSelected(new Set());
  }
  function toggle(date: string) {
    setSelected((s) => { const n = new Set(s); n.has(date) ? n.delete(date) : n.add(date); return n; });
  }
  function selectAll() {
    setSelected(new Set(holidays.map((h) => h.date)));
  }

  async function doImport() {
    const chosen = holidays.filter((h) => selected.has(h.date));
    if (chosen.length === 0) return;
    try {
      const created = await bulk.mutateAsync(chosen.map((h) => ({ date: h.date, name: h.name, holiday_type: 'PUBLIC' as const, country: h.country })));
      onDone(`Imported ${created.length} ${created.length === 1 ? 'holiday' : 'holidays'}.`);
      setQueried(null); setSelected(new Set());
      onClose();
    } catch (e) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      onDone(typeof d === 'string' ? d : 'Could not import holidays.');
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Import public holidays" className="max-w-2xl">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Country (ISO 2-letter)</label>
            <Input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))} placeholder="US" className="w-24" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Year</label>
            <Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-28" />
          </div>
          <Button variant="secondary" onClick={preview} disabled={country.trim().length !== 2}>Preview</Button>
        </div>

        {queried ? (
          suggestQ.isLoading ? (
            <div className="grid place-items-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" /></div>
          ) : suggestQ.isError ? (
            <p className="text-sm text-rose-600 dark:text-rose-300">Couldn't load holidays for {queried.country} {queried.year}. Check the country code.</p>
          ) : holidays.length === 0 ? (
            <p className="text-sm text-muted-foreground">No public holidays found for {queried.country} {queried.year}.</p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{holidays.length} holidays · {selected.size} selected</p>
                <button type="button" onClick={selectAll} className="text-xs text-primary hover:underline">Select all</button>
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-border p-2">
                {holidays.map((h) => (
                  <label key={h.date} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-foreground/5">
                    <input type="checkbox" checked={selected.has(h.date)} onChange={() => toggle(h.date)} className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]" />
                    <span className="w-24 shrink-0 tabular-nums text-muted-foreground">{h.date}</span>
                    <span className="min-w-0 flex-1 truncate text-foreground">{h.name}</span>
                  </label>
                ))}
              </div>
              <div className="flex justify-end gap-2 border-t border-border pt-3">
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button onClick={() => void doImport()} disabled={selected.size === 0 || bulk.isPending}>
                  {bulk.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Importing…</> : `Import ${selected.size}`}
                </Button>
              </div>
            </>
          )
        ) : (
          <p className="text-sm text-muted-foreground">Choose a country and year, then preview the public holidays to import.</p>
        )}
      </div>
    </Modal>
  );
}
