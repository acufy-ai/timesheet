import { useMemo, useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';

import { Button, Modal } from '@/components/ui';
import { usersApi } from '@/api/client';
import { useAllProjects, useAssignableUsers, useClients } from '@/hooks/useAdmin';
import type { ImportPreview, ImportValidateResult, ImportCommitResult } from '@/types/admin';
import type { Project } from '@/types/time';

// Target fields a CSV column can map to. full_name is required; the rest are
// optional and fall back to batch defaults / blank. Extended to match
// frontend2 (extra emails/phones, client, project, manager, active).
const TARGET_FIELDS: { key: string; label: string }[] = [
  { key: '', label: '— ignore —' },
  { key: 'full_name', label: 'Full name *' },
  { key: 'email', label: 'Primary email' },
  { key: 'email_2', label: 'Extra email 1' },
  { key: 'email_3', label: 'Extra email 2' },
  { key: 'username', label: 'Username' },
  { key: 'title', label: 'Title' },
  { key: 'department', label: 'Department' },
  { key: 'role', label: 'Role' },
  { key: 'phone', label: 'Primary phone' },
  { key: 'phone_2', label: 'Extra phone 1' },
  { key: 'phone_3', label: 'Extra phone 2' },
  { key: 'client', label: 'Client' },
  { key: 'project', label: 'Project' },
  { key: 'manager', label: 'Manager' },
  { key: 'is_active', label: 'Active' },
];

const STATUS_TONE: Record<string, string> = {
  new: 'text-emerald-600 dark:text-emerald-300',
  exact_match: 'text-sky-600 dark:text-sky-300',
  conflict: 'text-amber-600 dark:text-amber-300',
  duplicate_in_file: 'text-amber-600 dark:text-amber-300',
  error: 'text-rose-600 dark:text-rose-300',
};

function err(e: unknown, fb: string) {
  const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof d === 'string' ? d : fb;
}

type Step = 'upload' | 'map' | 'defaults' | 'validate' | 'conflicts' | 'done';

// Multi-step bulk user import mirroring frontend2:
// upload -> map columns -> batch defaults -> validate -> resolve conflicts
// -> commit -> result summary.
export function ImportUsersModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [step, setStep] = useState<Step>('upload');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [validation, setValidation] = useState<ImportValidateResult | null>(null);
  const [result, setResult] = useState<ImportCommitResult | null>(null);

  // Batch defaults (applied to every row unless that row's mapped column wins).
  const [userType, setUserType] = useState<'external' | 'internal'>('external');
  const [defaultClientId, setDefaultClientId] = useState<number | null>(null);
  const [defaultProjectId, setDefaultProjectId] = useState<number | null>(null);
  const [defaultManagerId, setDefaultManagerId] = useState<number | null>(null);

  // Per-row conflict resolutions keyed by row_index string -> overwrite | skip.
  const [resolutions, setResolutions] = useState<Record<string, 'overwrite' | 'skip'>>({});

  const clientsQ = useClients();
  const projectsQ = useAllProjects();
  const assignableQ = useAssignableUsers();

  const clients = clientsQ.data ?? [];
  const projects = useMemo(
    () => (projectsQ.data ?? []).filter((p: Project) => defaultClientId == null || p.client_id === defaultClientId),
    [projectsQ.data, defaultClientId],
  );
  const managers = (assignableQ.data ?? []).filter((u) => u.role === 'MANAGER' || u.role === 'ADMIN');

  const conflictRows = useMemo(
    () => (validation?.rows ?? []).filter((r) => r.status === 'conflict'),
    [validation],
  );

  function reset() {
    setStep('upload'); setBusy(false); setError(null); setPreview(null);
    setMapping({}); setValidation(null); setResult(null);
    setUserType('external'); setDefaultClientId(null); setDefaultProjectId(null); setDefaultManagerId(null);
    setResolutions({});
  }
  function close() { reset(); onClose(); }

  async function onFile(file: File) {
    setError(null); setBusy(true);
    try {
      const res = await usersApi.importPreview(file);
      setPreview(res.data);
      const auto: Record<string, string> = {};
      res.data.headers.forEach((h) => {
        const norm = h.toLowerCase().replace(/[^a-z]/g, '');
        const hit = TARGET_FIELDS.find((f) => f.key && (norm === f.key.replace(/_/g, '') || norm.includes(f.key.replace(/_/g, ''))));
        if (hit) auto[h] = hit.key;
      });
      setMapping(auto);
      setStep('map');
    } catch (e) { setError(err(e, 'Could not read that file.')); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  }

  async function runValidate() {
    if (!preview) return;
    setError(null); setBusy(true);
    try {
      const res = await usersApi.importValidate({ mapping, rows: preview.all_rows, headers: preview.headers });
      setValidation(res.data);
      // Seed conflict resolutions to "skip" (the backend default) so the UI is explicit.
      const seed: Record<string, 'overwrite' | 'skip'> = {};
      res.data.rows.filter((r) => r.status === 'conflict').forEach((r) => { seed[String(r.row_index)] = 'skip'; });
      setResolutions(seed);
      setStep('validate');
    } catch (e) { setError(err(e, 'Couldn\'t validate the import. Try again.')); }
    finally { setBusy(false); }
  }

  async function runCommit() {
    if (!preview) return;
    setError(null); setBusy(true);
    try {
      const res = await usersApi.importCommit({
        mapping,
        rows: preview.all_rows,
        headers: preview.headers,
        user_type: userType,
        default_client_id: defaultClientId,
        default_project_id: defaultProjectId,
        default_manager_id: defaultManagerId,
        conflict_resolutions: resolutions,
      });
      setResult(res.data);
      setStep('done');
      const r = res.data;
      onDone(`Imported ${r.created} user${r.created === 1 ? '' : 's'}${r.updated ? `, updated ${r.updated}` : ''}${r.skipped ? `, skipped ${r.skipped}` : ''}.`);
    } catch (e) { setError(err(e, 'Import failed.')); }
    finally { setBusy(false); }
  }

  const mappedToFullName = Object.values(mapping).includes('full_name');
  const newCount = validation?.counts.new ?? 0;
  const conflictCount = validation?.counts.conflict ?? 0;
  const overwriteCount = Object.values(resolutions).filter((v) => v === 'overwrite').length;

  return (
    <Modal open={open} onClose={close} title="Import users" className="max-w-3xl" flushBottom>
      {/* ── Upload ── */}
      {step === 'upload' ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">Upload a CSV or XLSX file. You'll map its columns, set defaults, and review before anything is created.</p>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border py-12 text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Upload className="h-6 w-6" />}
            <span className="text-sm font-medium">Choose a CSV / XLSX file</span>
          </button>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,text/csv" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
          {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
        </div>
      ) : null}

      {/* ── Map columns ── */}
      {step === 'map' && preview ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{preview.total_rows} rows. Map each column to a field.</p>
            <button type="button" onClick={reset} className="text-xs text-primary hover:underline">Start over</button>
          </div>
          <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-xl border border-border p-2">
            {preview.headers.map((h) => (
              <div key={h} className="flex items-center gap-2">
                <span className="w-1/2 truncate text-sm text-foreground" title={h}>{h}</span>
                <span className="text-muted-foreground">→</span>
                <select value={mapping[h] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))} className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20">
                  {TARGET_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              </div>
            ))}
          </div>
          {/* Preview of first rows (mapped) */}
          {preview.preview_rows.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    {preview.headers.map((h) => <th key={h} className="px-2 py-1.5 font-medium">{mapping[h] ? (TARGET_FIELDS.find((f) => f.key === mapping[h])?.label ?? h) : h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {preview.preview_rows.slice(0, 4).map((row, i) => (
                    <tr key={i} className="border-b border-border/50 last:border-0">
                      {preview.headers.map((h) => <td key={h} className="max-w-[140px] truncate px-2 py-1 text-foreground">{row[h] ?? ''}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.total_rows > 4 ? <p className="px-2 py-1 text-[11px] text-muted-foreground">+{preview.total_rows - 4} more rows</p> : null}
            </div>
          ) : null}
          {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
          <div className="sticky bottom-0 -mx-4 mt-2 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
            <Button onClick={() => setStep('defaults')} disabled={!mappedToFullName} title={mappedToFullName ? '' : 'Map a column to Full name first'}>Next: Defaults</Button>
          </div>
        </div>
      ) : null}

      {/* ── Batch defaults ── */}
      {step === 'defaults' ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">These apply to every row unless that row's mapped column provides a value.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">User type</span>
              <div className="inline-flex w-full rounded-md border border-border p-0.5 text-sm">
                <button type="button" onClick={() => setUserType('external')} className={'flex-1 rounded px-3 py-1 ' + (userType === 'external' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>External</button>
                <button type="button" onClick={() => setUserType('internal')} className={'flex-1 rounded px-3 py-1 ' + (userType === 'internal' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>Internal</button>
              </div>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Default client</span>
              <select value={defaultClientId ?? ''} onChange={(e) => { setDefaultClientId(e.target.value ? Number(e.target.value) : null); setDefaultProjectId(null); }} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm">
                <option value="">— none —</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Default project</span>
              <select value={defaultProjectId ?? ''} onChange={(e) => setDefaultProjectId(e.target.value ? Number(e.target.value) : null)} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm">
                <option value="">— none —</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Default manager</span>
              <select value={defaultManagerId ?? ''} onChange={(e) => setDefaultManagerId(e.target.value ? Number(e.target.value) : null)} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm">
                <option value="">— none —</option>
                {managers.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
              </select>
            </label>
          </div>
          {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
          <div className="flex justify-between gap-2 border-t border-border pt-3">
            <Button variant="ghost" onClick={() => setStep('map')}>Back</Button>
            <Button onClick={() => void runValidate()} disabled={busy}>
              {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Validating…</> : 'Next: Validate'}
            </Button>
          </div>
        </div>
      ) : null}

      {/* ── Validation breakdown ── */}
      {step === 'validate' && validation ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-border p-3">
            <div className="flex flex-wrap gap-3 text-sm">
              {Object.entries(validation.counts).filter(([, n]) => n > 0).map(([k, n]) => (
                <span key={k} className={STATUS_TONE[k] ?? 'text-foreground'}>{n} {k.replace(/_/g, ' ')}</span>
              ))}
            </div>
            {validation.counts.error ? <p className="mt-2 text-xs text-rose-600 dark:text-rose-300">Rows with errors will be skipped.</p> : null}
            {conflictCount ? <p className="mt-2 text-xs text-amber-600 dark:text-amber-300">{conflictCount} row{conflictCount === 1 ? '' : 's'} match an existing email with different data — resolve them next.</p> : null}
          </div>
          {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
          <div className="flex justify-between gap-2 border-t border-border pt-3">
            <Button variant="ghost" onClick={() => setStep('defaults')}>Back</Button>
            {conflictCount > 0 ? (
              <Button onClick={() => setStep('conflicts')}>Next: Resolve conflicts</Button>
            ) : (
              <Button onClick={() => void runCommit()} disabled={busy || newCount === 0}>
                {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Importing…</> : `Import ${newCount} user${newCount === 1 ? '' : 's'}`}
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {/* ── Conflict resolution ── */}
      {step === 'conflicts' ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{conflictRows.length} email{conflictRows.length === 1 ? '' : 's'} already exist. Keep the existing record or overwrite it.</p>
            <div className="flex gap-2 text-xs">
              <button type="button" className="text-primary hover:underline" onClick={() => setResolutions(Object.fromEntries(conflictRows.map((r) => [String(r.row_index), 'skip'])))}>Skip all</button>
              <button type="button" className="text-primary hover:underline" onClick={() => setResolutions(Object.fromEntries(conflictRows.map((r) => [String(r.row_index), 'overwrite'])))}>Overwrite all</button>
            </div>
          </div>
          <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-xl border border-border p-2">
            {conflictRows.map((r) => {
              const key = String(r.row_index);
              const res = resolutions[key] ?? 'skip';
              return (
                <div key={key} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-2.5 py-1.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">{r.full_name ?? '(no name)'}</p>
                    <p className="truncate text-xs text-muted-foreground">{r.email}</p>
                  </div>
                  <div className="inline-flex shrink-0 rounded-md border border-border p-0.5 text-xs">
                    <button type="button" onClick={() => setResolutions((m) => ({ ...m, [key]: 'skip' }))} className={'rounded px-2 py-0.5 ' + (res === 'skip' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>Keep existing</button>
                    <button type="button" onClick={() => setResolutions((m) => ({ ...m, [key]: 'overwrite' }))} className={'rounded px-2 py-0.5 ' + (res === 'overwrite' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>Overwrite</button>
                  </div>
                </div>
              );
            })}
          </div>
          {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
          <div className="flex justify-between gap-2 border-t border-border pt-3">
            <Button variant="ghost" onClick={() => setStep('validate')}>Back</Button>
            <Button onClick={() => void runCommit()} disabled={busy}>
              {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Importing…</> : `Import ${newCount} new + ${overwriteCount} overwrite`}
            </Button>
          </div>
        </div>
      ) : null}

      {/* ── Result summary ── */}
      {step === 'done' && result ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="text-emerald-600 dark:text-emerald-300">{result.created} created</span>
            {result.updated ? <span className="text-sky-600 dark:text-sky-300">{result.updated} updated</span> : null}
            {result.skipped ? <span className="text-amber-600 dark:text-amber-300">{result.skipped} skipped</span> : null}
          </div>
          {Array.isArray((result as { new_clients?: string[] }).new_clients) && (result as { new_clients?: string[] }).new_clients!.length > 0 ? (
            <div className="rounded-xl border border-border p-3 text-sm">
              <p className="font-medium text-foreground">New clients created</p>
              <p className="mt-1 text-muted-foreground">{(result as { new_clients?: string[] }).new_clients!.join(', ')}</p>
            </div>
          ) : null}
          {result.errors && result.errors.length > 0 ? (
            <div className="max-h-40 overflow-y-auto rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-600 dark:text-rose-300">
              {result.errors.map((e, i) => <p key={i}>Row {e.row_index ?? '?'}: {e.message}</p>)}
            </div>
          ) : null}
          <div className="sticky bottom-0 -mx-4 mt-2 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
