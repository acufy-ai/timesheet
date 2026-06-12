import { useState } from 'react';
import { Check, Loader2, Sparkles, X } from 'lucide-react';

import { Button, Card, Input } from '@/components/ui';
import { timeApi } from '@/api/client';
import { useCreateEntry } from '@/hooks/useTime';
import type { ParsedEntry } from '@/types/time';

// Natural-language quick entry: type a sentence ("8h on Acme redesign Monday
// debugging login"), the backend parses it into draft rows, the user reviews/
// edits, then saves. Mirrors frontend2's NL parser + editable preview flow.
export function NaturalLanguageEntry({ onSaved }: { onSaved: (msg: string) => void }) {
  const create = useCreateEntry();
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [rows, setRows] = useState<ParsedEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function parse() {
    if (!text.trim()) return;
    setParsing(true);
    setError(null);
    try {
      const res = await timeApi.parseNatural(text.trim()).then((r) => r.data);
      if (res.error) { setError(res.error); setRows(null); }
      else setRows(res.entries ?? []);
    } catch (err) {
      const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof d === 'string' ? d : 'Could not parse that. Try rephrasing.');
    } finally {
      setParsing(false);
    }
  }

  function patchRow(i: number, patch: Partial<ParsedEntry>) {
    setRows((rs) => (rs ? rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) : rs));
  }
  function dropRow(i: number) {
    setRows((rs) => (rs ? rs.filter((_, idx) => idx !== i) : rs));
  }

  async function saveAll() {
    if (!rows) return;
    const valid = rows.filter((r) => r.project_id && r.hours && r.hours > 0 && !r.error);
    if (valid.length === 0) { setError('No saveable rows (each needs a project and hours).'); return; }
    setSaving(true);
    try {
      await Promise.all(valid.map((r) =>
        create.mutateAsync({
          project_id: r.project_id as number,
          task_id: r.task_id ?? null,
          entry_date: r.entry_date,
          hours: r.hours as number,
          // Carry the parsed time block + notes through (backend accepts them
          // optional); previously dropped them silently.
          start_time: r.start_time || null,
          end_time: r.end_time || null,
          description: r.description?.trim() || 'Worked on project tasks',
          notes: r.notes?.trim() || null,
          is_billable: r.is_billable,
        }),
      ));
      onSaved(`Logged ${valid.length} ${valid.length === 1 ? 'entry' : 'entries'} from your note.`);
      setRows(null); setText('');
    } catch (err) {
      const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof d === 'string' ? d : 'Could not save the entries.');
    } finally {
      setSaving(false);
    }
  }

  const fieldClass = 'h-8 w-full rounded-md border border-border bg-background px-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <p className="text-sm font-semibold text-foreground">Quick entry</p>
        <span className="text-xs text-muted-foreground">Describe your time in plain language.</span>
      </div>
      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void parse(); }}
          placeholder='e.g. "8h on Acme redesign yesterday, debugging the login flow"'
        />
        <Button onClick={() => void parse()} disabled={parsing || !text.trim()}>
          {parsing ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Parse'}
        </Button>
      </div>

      {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}

      {rows && rows.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Review and edit before saving:</p>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-2 py-1.5">Date</th>
                  <th className="px-2 py-1.5 text-right">Hours</th>
                  <th className="px-2 py-1.5">Project</th>
                  <th className="px-2 py-1.5">Description</th>
                  <th className="px-2 py-1.5">Notes</th>
                  <th className="px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={'border-b border-border last:border-0 ' + (r.error ? 'bg-rose-500/5' : '')}>
                    <td className="px-2 py-1.5"><input type="date" value={r.entry_date} onChange={(e) => patchRow(i, { entry_date: e.target.value })} className={fieldClass} /></td>
                    <td className="px-2 py-1.5"><input type="number" step="0.25" min="0" value={r.hours ?? ''} onChange={(e) => patchRow(i, { hours: e.target.value === '' ? null : Number(e.target.value) })} className={fieldClass + ' text-right'} /></td>
                    <td className="px-2 py-1.5">
                      <span className={r.project_id ? 'text-foreground' : 'text-rose-600 dark:text-rose-300'}>
                        {r.project_name || 'Unmatched'}{r.task_name ? ` · ${r.task_name}` : ''}
                      </span>
                      {r.error ? <span className="block text-[11px] text-rose-600 dark:text-rose-300">{r.error}</span> : null}
                      {/* Ambiguous match: "Did you mean" quick-pick alternatives. */}
                      {r.alternatives && r.alternatives.length > 0 ? (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <span className="text-[10px] text-muted-foreground">Did you mean:</span>
                          {r.alternatives.map((alt, ai) => (
                            <button
                              key={ai}
                              type="button"
                              onClick={() => patchRow(i, { project_id: alt.project_id, project_name: alt.project_name, task_id: alt.task_id, task_name: alt.task_name, error: null, alternatives: [] })}
                              className="rounded-full border border-primary/40 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10"
                            >
                              {alt.project_name}{alt.task_name ? ` · ${alt.task_name}` : ''}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5"><input value={r.description} onChange={(e) => patchRow(i, { description: e.target.value })} className={fieldClass} /></td>
                    <td className="px-2 py-1.5"><input value={r.notes ?? ''} onChange={(e) => patchRow(i, { notes: e.target.value })} placeholder="Private notes" className={fieldClass} /></td>
                    <td className="px-2 py-1.5 text-right">
                      <button type="button" onClick={() => dropRow(i)} aria-label="Remove row" className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"><X className="h-3.5 w-3.5" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setRows(null); setText(''); }}>Discard</Button>
            <Button size="sm" onClick={() => void saveAll()} disabled={saving}>
              {saving ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</>) : (<><Check className="h-3.5 w-3.5" /> Save all</>)}
            </Button>
          </div>
        </div>
      ) : rows && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Couldn't pull any entries out of that. Try naming a project and hours.</p>
      ) : null}
    </Card>
  );
}
