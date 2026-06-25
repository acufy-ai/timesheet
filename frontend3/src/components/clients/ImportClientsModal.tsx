import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, X } from 'lucide-react';

import { Button, Modal } from '@/components/ui';
import { clientsApi } from '@/api/client';
import { cn } from '@/lib/cn';
import type { ClientImportPreview, ClientImportResult, ClientImportRowIssue } from '@/types/admin';

// Bulk-import clients + projects + tasks + assignments from an XLSX (4 tabs:
// Clients, Projects, Tasks, Assignments) or a CSV (treated as the Projects
// sheet). Flow: download template → upload → preview/validate → confirm.
type Step = 'upload' | 'preview' | 'done';
type Sheet = 'clients' | 'projects' | 'tasks' | 'assignments';

// Column order per sheet — must match the backend SHEETS definition so the row
// preview reads each record's fields in the right order.
const SHEET_COLUMNS: Record<Sheet, string[]> = {
  clients: ['name', 'company', 'type', 'status', 'contact_name', 'contact_email', 'contact_phone', 'since'],
  projects: ['client', 'name', 'code', 'billable_rate', 'budget', 'currency', 'status', 'start_date', 'end_date', 'managers'],
  tasks: ['client', 'project', 'name', 'priority', 'status', 'description'],
  assignments: ['client', 'project', 'task', 'user_email'],
};

export function ImportClientsModal({
  open, onClose, onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [step, setStep] = useState<Step>('upload');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ClientImportPreview | null>(null);
  const [result, setResult] = useState<ClientImportResult | null>(null);
  const [previewTab, setPreviewTab] = useState<Sheet>('clients');
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setStep('upload'); setBusy(false); setError(null);
    setFileName(''); setPreview(null); setResult(null); setPreviewTab('clients');
  }
  function close() { reset(); onClose(); }

  async function downloadTemplate() {
    try {
      const res = await clientsApi.importTemplate();
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'client-import-template.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('Could not download the template.');
    }
  }

  async function onFile(file: File) {
    setBusy(true); setError(null); setFileName(file.name);
    try {
      const res = await clientsApi.importPreview(file);
      setPreview(res.data);
      setStep('preview');
    } catch (e) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof d === 'string' ? d : 'Could not read that file. Use the XLSX template or a CSV.');
    } finally { setBusy(false); }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const res = await clientsApi.importCommit(preview.data);
      setResult(res.data);
      setStep('done');
      const c = res.data.created;
      onDone(`Imported ${c.clients} clients, ${c.projects} projects, ${c.tasks} tasks.`);
    } catch (e) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof d === 'string' ? d : 'Import failed.');
    } finally { setBusy(false); }
  }

  const c = preview?.counts;
  const hasBlockingErrors = (preview?.errors.length ?? 0) > 0;

  return (
    <Modal open={open} onClose={close} title="Import clients" className="max-w-3xl">
      <div className="space-y-4">
        {/* ── Upload ── */}
        {step === 'upload' ? (
          <>
            <p className="text-[13px] text-muted-foreground">
              Import clients, their projects, tasks, and who’s assigned to what from one
              Excel file — instead of entering them one by one.
            </p>
            <button type="button" onClick={downloadTemplate}
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline">
              <Download className="h-4 w-4" /> Download the XLSX template
            </button>
            <div
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void onFile(f); }}
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center transition-colors hover:border-primary/40 hover:bg-primary/[0.03]"
            >
              {busy ? <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                : <FileSpreadsheet className="h-7 w-7 text-muted-foreground" />}
              <p className="text-[13px] font-medium text-foreground">
                {busy ? 'Reading file…' : 'Drop an .xlsx or .csv here, or click to choose'}
              </p>
              <p className="text-[12px] text-muted-foreground">
                Tabs: Clients · Projects · Tasks · Assignments
              </p>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }} />
            </div>
          </>
        ) : null}

        {/* ── Preview ── */}
        {step === 'preview' && preview ? (
          <>
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <FileSpreadsheet className="h-4 w-4" /> {fileName}
              <button type="button" onClick={reset} className="ml-auto inline-flex items-center gap-1 text-primary hover:underline">
                <X className="h-3.5 w-3.5" /> Choose another
              </button>
            </div>
            {/* Counts double as tabs — click one to view its rows below. */}
            <div className="grid grid-cols-4 gap-px overflow-hidden rounded-xl border border-border bg-border">
              {([['clients', 'Clients', c?.clients], ['projects', 'Projects', c?.projects], ['tasks', 'Tasks', c?.tasks], ['assignments', 'Assignments', c?.assignments]] as const).map(([key, label, n]) => (
                <button key={key} type="button" onClick={() => setPreviewTab(key)}
                  className={cn('px-3 py-2.5 text-center transition-colors',
                    previewTab === key ? 'bg-primary/[0.08]' : 'bg-card hover:bg-primary/[0.04]')}>
                  <p className={cn('text-[18px] font-bold tabular-nums', previewTab === key ? 'text-primary' : 'text-foreground')}>{n ?? 0}</p>
                  <p className="text-[10.5px] uppercase tracking-wider text-muted-foreground">{label}</p>
                </button>
              ))}
            </div>

            {/* Row-level preview of the selected tab, with a per-row status. */}
            <DataTable
              columns={SHEET_COLUMNS[previewTab]}
              rows={preview.data[previewTab] ?? []}
              issues={preview.row_issues?.[previewTab] ?? []}
            />

            {preview.errors.length > 0 ? (
              <Notice tone="error" title={`${preview.errors.length} error${preview.errors.length === 1 ? '' : 's'} — fix these before importing`} items={preview.errors} />
            ) : null}
            {preview.warnings.length > 0 ? (
              <Notice tone="warn" title={`${preview.warnings.length} note${preview.warnings.length === 1 ? '' : 's'} — see the Status column above (rows marked “Skipped” won’t be created)`} items={preview.warnings} />
            ) : null}
            {!preview.errors.length && !preview.warnings.length ? (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[13px] text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4 shrink-0" /> Everything checks out. Ready to import.
              </div>
            ) : null}
          </>
        ) : null}

        {/* ── Done ── */}
        {step === 'done' && result ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-[13px] text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-5 w-5 shrink-0" />
              Created {result.created.clients} clients, {result.created.projects} projects,
              {' '}{result.created.tasks} tasks, {result.created.assignments} assignments.
            </div>
            {result.errors.length > 0 ? (
              <Notice tone="warn" title={`${result.errors.length} row${result.errors.length === 1 ? '' : 's'} skipped`} items={result.errors} />
            ) : null}
          </div>
        ) : null}

        {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}

        <div className="sticky bottom-0 -mx-4 mt-2 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          <Button variant="ghost" size="sm" onClick={close}>{step === 'done' ? 'Close' : 'Cancel'}</Button>
          {step === 'preview' ? (
            <Button size="sm" onClick={() => void commit()} disabled={busy || hasBlockingErrors}>
              {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Importing…</> : <><Download className="h-4 w-4" /> Import</>}
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

// Scrollable row-level preview of one sheet's parsed data, with a per-row
// status badge: Skipped (row dropped) / Note (imports with a change).
function DataTable({
  columns, rows, issues,
}: {
  columns: string[];
  rows: Array<Record<string, string>>;
  issues: ClientImportRowIssue[];
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[12.5px] text-muted-foreground">
        No rows on this tab.
      </div>
    );
  }
  // Highest-severity issue per row: error > skip > note.
  const rank = { error: 3, skip: 2, note: 1 } as const;
  const issueByRow = new Map<number, ClientImportRowIssue>();
  issues.forEach((it) => {
    const cur = issueByRow.get(it.row);
    if (!cur || rank[it.level] > rank[cur.level]) issueByRow.set(it.row, it);
  });
  const badge = (lvl: ClientImportRowIssue['level']) =>
    lvl === 'error' ? { text: 'Error', cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-300' }
    : lvl === 'skip' ? { text: 'Skipped', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-300' }
    : { text: 'Note', cls: 'bg-sky-500/15 text-sky-600 dark:text-sky-300' };

  return (
    <div className="max-h-56 overflow-auto rounded-lg border border-border">
      <table className="w-full text-[12px]">
        <thead className="sticky top-0 bg-muted/60">
          <tr className="text-left text-[10.5px] uppercase tracking-wider text-muted-foreground">
            <th className="px-2 py-1.5 font-semibold">#</th>
            {columns.map((col) => (
              <th key={col} className="whitespace-nowrap px-2 py-1.5 font-semibold">{col.replace(/_/g, ' ')}</th>
            ))}
            <th className="px-2 py-1.5 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const issue = issueByRow.get(i);
            const b = issue ? badge(issue.level) : null;
            return (
              <tr key={i} className={cn('border-t border-border/60',
                issue?.level === 'skip' ? 'bg-amber-500/[0.06]' : issue?.level === 'error' ? 'bg-rose-500/[0.06]' : '')}>
                <td className="px-2 py-1.5 text-muted-foreground tabular-nums">{i + 1}</td>
                {columns.map((col) => (
                  <td key={col} className="max-w-[180px] truncate px-2 py-1.5 text-foreground" title={row[col] ?? ''}>
                    {row[col] || <span className="text-muted-foreground/50">—</span>}
                  </td>
                ))}
                <td className="px-2 py-1.5">
                  {b ? (
                    <span className={cn('inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold', b.cls)}
                      title={issue!.message}>{b.text}</span>
                  ) : (
                    <span className="text-[11px] text-emerald-600 dark:text-emerald-400">OK</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Notice({ tone, title, items }: { tone: 'error' | 'warn'; title: string; items: string[] }) {
  return (
    <div className={cn('rounded-lg border px-3 py-2',
      tone === 'error' ? 'border-rose-500/30 bg-rose-500/10' : 'border-amber-500/30 bg-amber-500/10')}>
      <p className={cn('flex items-center gap-1.5 text-[12.5px] font-semibold',
        tone === 'error' ? 'text-rose-700 dark:text-rose-300' : 'text-amber-700 dark:text-amber-300')}>
        <AlertTriangle className="h-3.5 w-3.5" /> {title}
      </p>
      <ul className="mt-1.5 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-[12px] text-muted-foreground">
        {items.slice(0, 50).map((m, i) => <li key={i}>{m}</li>)}
        {items.length > 50 ? <li>…and {items.length - 50} more.</li> : null}
      </ul>
    </div>
  );
}
