import { useState } from 'react';
import { Check, Loader2, PauseCircle, Pencil, Plus, RefreshCw, RotateCcw, Sparkles, Trash2, Undo2, X } from 'lucide-react';

import { Button, Modal, StatusBadge } from '@/components/ui';
import {
  useAddLineItem,
  useApproveIngestion,
  useClients,
  useDeleteLineItem,
  useDraftComment,
  useHoldIngestion,
  useIngestionDetail,
  useRejectIngestion,
  useRejectLineItem,
  useReprocessIngestionEmail,
  useRevertIngestionRejection,
  useUnrejectLineItem,
  useUpdateIngestionData,
  useUpdateLineItem,
  useUsers,
} from '@/hooks/useAdmin';
import type { IngestionLineItem } from '@/types/admin';

const num = (v: string | number | null | undefined) =>
  v == null || v === '' ? 0 : typeof v === 'string' ? parseFloat(v) : v;

function errText(err: unknown, fallback: string): string {
  const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof d === 'string' ? d : fallback;
}

// Review panel for one ingested timesheet. Shows employee/client/period, the
// LLM summary, the extracted line items (editable: add / edit / delete), and
// approve (creates time entries, warns on overlap) / reject-with-reason.
export function ReviewPanel({
  timesheetId,
  onClose,
  onDone,
}: {
  timesheetId: number | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const detailQ = useIngestionDetail(timesheetId);
  const approve = useApproveIngestion();
  const reject = useRejectIngestion();
  const hold = useHoldIngestion();
  const updateData = useUpdateIngestionData();
  const reprocess = useReprocessIngestionEmail();
  const updateItem = useUpdateLineItem();
  const addItem = useAddLineItem();
  const delItem = useDeleteLineItem();
  const revert = useRevertIngestionRejection();
  const draftComment = useDraftComment();
  const rejectItem = useRejectLineItem();
  const unrejectItem = useUnrejectLineItem();
  // Rosters for the assignment dropdowns (only needed while the panel is open).
  const usersQ = useUsers(timesheetId != null);
  const clientsQ = useClients(timesheetId != null);

  const [editId, setEditId] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ work_date: string; hours: string; description: string; project_code: string }>({ work_date: '', hours: '', description: '', project_code: '' });
  const [adding, setAdding] = useState(false);
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const d = detailQ.data;
  const decided = d ? d.status === 'approved' || d.status === 'rejected' : false;

  async function assign(field: 'employee_id' | 'client_id', value: number | null) {
    if (!timesheetId) return;
    setError(null);
    try { await updateData.mutateAsync({ id: timesheetId, data: { [field]: value } }); }
    catch (err) { setError(errText(err, 'Could not update assignment.')); }
  }
  async function doHold() {
    if (!timesheetId) return;
    setError(null);
    try { await hold.mutateAsync({ id: timesheetId }); onDone('Timesheet placed on hold.'); onClose(); }
    catch (err) { setError(errText(err, 'Could not hold.')); }
  }
  async function doReprocess() {
    if (!d?.email?.id) return;
    setError(null);
    try { await reprocess.mutateAsync(d.email.id); onDone('Re-processing the source email.'); }
    catch (err) { setError(errText(err, 'Could not reprocess.')); }
  }
  async function doRevert() {
    if (!timesheetId) return;
    setError(null);
    try { await revert.mutateAsync(timesheetId); onDone('Rejection reverted; back to pending review.'); }
    catch (err) { setError(errText(err, 'Could not revert.')); }
  }
  async function doDraftComment() {
    if (!timesheetId) return;
    setError(null);
    try {
      // Seed the AI draft with whatever the reviewer has already typed.
      const res = await draftComment.mutateAsync({ id: timesheetId, seedText: rejectReason.trim() });
      if (res?.comment) { setRejectMode(true); setRejectReason(res.comment); }
    } catch (err) { setError(errText(err, 'Could not draft a comment.')); }
  }
  function toggleLineItemReject(it: IngestionLineItem) {
    if (!timesheetId) return;
    setError(null);
    const m = it.is_rejected ? unrejectItem : rejectItem;
    m.mutateAsync({ tid: timesheetId, itemId: it.id }).catch((err) => setError(errText(err, 'Could not update the line item.')));
  }

  function startEdit(it: IngestionLineItem) {
    setEditId(it.id);
    setDraft({
      work_date: it.work_date,
      hours: String(num(it.hours)),
      description: it.description ?? '',
      project_code: it.project_code ?? '',
    });
    setAdding(false);
  }
  function startAdd() {
    setAdding(true);
    setEditId(null);
    setDraft({ work_date: d?.period_start ?? '', hours: '', description: '', project_code: '' });
  }

  async function saveItem() {
    if (!timesheetId) return;
    setError(null);
    const hours = Number(draft.hours);
    if (!draft.work_date || !Number.isFinite(hours) || hours <= 0) { setError('A date and positive hours are required.'); return; }
    try {
      if (adding) {
        await addItem.mutateAsync({ tid: timesheetId, data: { work_date: draft.work_date, hours, description: draft.description || undefined, project_code: draft.project_code || undefined } });
      } else if (editId != null) {
        await updateItem.mutateAsync({ tid: timesheetId, itemId: editId, data: { work_date: draft.work_date, hours, description: draft.description, project_code: draft.project_code } });
      }
      setEditId(null); setAdding(false);
    } catch (err) { setError(errText(err, 'Could not save the line item.')); }
  }
  async function removeItem(itemId: number) {
    if (!timesheetId || !window.confirm('Delete this line item?')) return;
    try { await delItem.mutateAsync({ tid: timesheetId, itemId }); }
    catch (err) { setError(errText(err, 'Could not delete the line item.')); }
  }

  async function doApprove() {
    if (!timesheetId) return;
    setError(null);
    try {
      const res = await approve.mutateAsync({ id: timesheetId });
      const overlap = res.overlapping_entries_count > 0 ? ` (${res.overlapping_entries_count} overlapping dates skipped)` : '';
      onDone(`Approved. ${res.time_entries_created} time ${res.time_entries_created === 1 ? 'entry' : 'entries'} created${overlap}.`);
      onClose();
    } catch (err) { setError(errText(err, 'Could not approve.')); }
  }
  async function doReject() {
    if (!timesheetId || !rejectReason.trim()) return;
    setError(null);
    try {
      await reject.mutateAsync({ id: timesheetId, reason: rejectReason.trim() });
      onDone('Timesheet rejected.');
      onClose();
    } catch (err) { setError(errText(err, 'Could not reject.')); }
  }

  const fieldClass = 'h-8 w-full rounded-md border border-border bg-background px-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

  return (
    <Modal open={timesheetId != null} onClose={onClose} title="Review timesheet" className="max-w-3xl">
      {detailQ.isLoading || !d ? (
        <div className="grid place-items-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>
      ) : (
        <div className="space-y-4">
          {/* Header summary */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-foreground">
                {d.employee_name ?? d.extracted_employee_name ?? 'Unassigned employee'}
                {d.client_name ? <span className="font-normal text-muted-foreground"> · {d.client_name}</span> : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {d.period_start && d.period_end ? `${d.period_start} → ${d.period_end}` : 'No period'} · {num(d.total_hours).toFixed(2)}h total
              </p>
            </div>
            <StatusBadge status={(d.status || '').toLowerCase().replace(/\s+/g, '_')} variant="ingestion" />
          </div>

          {d.llm_summary ? (
            <p className="rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">{d.llm_summary}</p>
          ) : null}

          {/* Assignment: fix the matched employee/client before approving.
              Shown while the timesheet is still open for review. */}
          {!decided ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Employee {d.employee_id ? '' : '(unmatched)'}</label>
                <select
                  value={d.employee_id ?? ''}
                  onChange={(e) => void assign('employee_id', e.target.value ? Number(e.target.value) : null)}
                  disabled={updateData.isPending}
                  className={'h-8 w-full rounded-md border bg-background px-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 ' + (d.employee_id ? 'border-border' : 'border-amber-500/50')}
                >
                  <option value="">{d.extracted_employee_name ? `Unmatched: "${d.extracted_employee_name}"` : 'Select employee…'}</option>
                  {(usersQ.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Client</label>
                <select
                  value={d.client_id ?? ''}
                  onChange={(e) => void assign('client_id', e.target.value ? Number(e.target.value) : null)}
                  disabled={updateData.isPending}
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">No client</option>
                  {(clientsQ.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            </div>
          ) : null}

          {d.status === 'rejected' ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
              <span>Rejected{d.rejection_reason ? `: ${d.rejection_reason}` : '.'}</span>
              <Button variant="ghost" size="sm" onClick={() => void doRevert()} disabled={revert.isPending} className="shrink-0 text-rose-700 hover:bg-rose-500/15 dark:text-rose-200">
                {revert.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Revert
              </Button>
            </div>
          ) : null}

          {/* Line items */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Line items ({d.line_items.length})</p>
              {!decided ? (
                <button type="button" onClick={startAdd} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  <Plus className="h-3 w-3" /> Add
                </button>
              ) : null}
            </div>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-2 py-1.5">Date</th>
                    <th className="px-2 py-1.5 text-right">Hours</th>
                    <th className="px-2 py-1.5">Project</th>
                    <th className="px-2 py-1.5">Description</th>
                    {!decided ? <th className="px-2 py-1.5 text-right">Action</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {d.line_items.map((it) =>
                    editId === it.id ? (
                      <tr key={it.id} className="border-b border-border bg-muted/10 last:border-0">
                        <td className="px-2 py-1.5"><input type="date" value={draft.work_date} onChange={(e) => setDraft({ ...draft, work_date: e.target.value })} className={fieldClass} /></td>
                        <td className="px-2 py-1.5"><input type="number" step="0.25" min="0" value={draft.hours} onChange={(e) => setDraft({ ...draft, hours: e.target.value })} className={fieldClass + ' text-right'} /></td>
                        <td className="px-2 py-1.5"><input value={draft.project_code} onChange={(e) => setDraft({ ...draft, project_code: e.target.value })} className={fieldClass} placeholder="code" /></td>
                        <td className="px-2 py-1.5"><input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={fieldClass} /></td>
                        <td className="px-2 py-1.5 text-right">
                          <div className="inline-flex gap-0.5">
                            <button type="button" onClick={() => void saveItem()} title="Save" className="grid h-7 w-7 place-items-center rounded bg-primary text-primary-foreground hover:brightness-110"><Check className="h-3.5 w-3.5" /></button>
                            <button type="button" onClick={() => setEditId(null)} title="Cancel" className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-muted"><X className="h-3.5 w-3.5" /></button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr key={it.id} className={'border-b border-border last:border-0 ' + (it.is_rejected ? 'opacity-50' : '')}>
                        <td className="px-2 py-1.5 tabular-nums">{it.work_date}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{num(it.hours).toFixed(2)}</td>
                        <td className="px-2 py-1.5 text-muted-foreground">{it.project_code ?? '—'}</td>
                        <td className="px-2 py-1.5">{it.description ?? '—'}{it.is_corrected ? <span className="ml-1 rounded-full bg-amber-500/15 px-1 text-[9px] text-amber-600 dark:text-amber-300">edited</span> : null}</td>
                        {!decided ? (
                          <td className="px-2 py-1.5 text-right">
                            <div className="inline-flex gap-0.5">
                              <button type="button" onClick={() => toggleLineItemReject(it)} aria-label={it.is_rejected ? 'Restore line item' : 'Reject line item'} title={it.is_rejected ? 'Restore' : 'Reject this day'} className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-300">{it.is_rejected ? <Undo2 className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}</button>
                              <button type="button" onClick={() => startEdit(it)} aria-label="Edit" className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil className="h-3.5 w-3.5" /></button>
                              <button type="button" onClick={() => removeItem(it.id)} aria-label="Delete" className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"><Trash2 className="h-3.5 w-3.5" /></button>
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    ),
                  )}
                  {adding ? (
                    <tr className="border-b border-border bg-muted/10 last:border-0">
                      <td className="px-2 py-1.5"><input type="date" value={draft.work_date} onChange={(e) => setDraft({ ...draft, work_date: e.target.value })} className={fieldClass} /></td>
                      <td className="px-2 py-1.5"><input type="number" step="0.25" min="0" value={draft.hours} onChange={(e) => setDraft({ ...draft, hours: e.target.value })} className={fieldClass + ' text-right'} /></td>
                      <td className="px-2 py-1.5"><input value={draft.project_code} onChange={(e) => setDraft({ ...draft, project_code: e.target.value })} className={fieldClass} placeholder="code" /></td>
                      <td className="px-2 py-1.5"><input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={fieldClass} /></td>
                      <td className="px-2 py-1.5 text-right">
                        <div className="inline-flex gap-0.5">
                          <button type="button" onClick={() => void saveItem()} title="Save" className="grid h-7 w-7 place-items-center rounded bg-primary text-primary-foreground hover:brightness-110"><Check className="h-3.5 w-3.5" /></button>
                          <button type="button" onClick={() => setAdding(false)} title="Cancel" className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-muted"><X className="h-3.5 w-3.5" /></button>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {d.line_items.length === 0 && !adding ? (
                    <tr><td colSpan={5} className="px-2 py-4 text-center text-xs text-muted-foreground">No line items extracted.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}

          {/* Actions */}
          {!decided ? (
            rejectMode ? (
              <div className="space-y-2 rounded-xl border border-rose-500/30 bg-rose-500/5 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">Why is this being rejected? The sender will see this reason.</p>
                  <button type="button" onClick={() => void doDraftComment()} disabled={draftComment.isPending} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:opacity-60">
                    {draftComment.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Draft with AI
                  </button>
                </div>
                <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={2} autoFocus placeholder="e.g. Missing Thursday's hours." className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setRejectMode(false)}>Back</Button>
                  <Button variant="destructive" size="sm" onClick={() => void doReject()} disabled={!rejectReason.trim() || reject.isPending}>
                    {reject.isPending ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Rejecting…</>) : 'Confirm reject'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                <div className="flex gap-2">
                  {d.email?.id ? (
                    <Button variant="ghost" size="sm" onClick={() => void doReprocess()} disabled={reprocess.isPending} title="Re-run the LLM on the source email">
                      {reprocess.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Reprocess
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={() => void doHold()} disabled={hold.isPending} title="Set aside for later without rejecting">
                    {hold.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PauseCircle className="h-3.5 w-3.5" />} Hold
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" className="border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-500/30 dark:hover:bg-rose-500/10" onClick={() => setRejectMode(true)}>Reject</Button>
                  <Button onClick={() => void doApprove()} disabled={approve.isPending || !d.employee_id}>
                    {approve.isPending ? (<><Loader2 className="h-4 w-4 animate-spin" /> Approving…</>) : 'Approve & sync'}
                  </Button>
                </div>
              </div>
            )
          ) : (
            <p className="border-t border-border pt-3 text-xs text-muted-foreground">
              This timesheet has been {d.status}. {d.time_entries_created ? 'Time entries were created.' : ''}
            </p>
          )}
          {!decided && !d.employee_id ? (
            <p className="text-xs text-amber-600 dark:text-amber-300">Assign an employee above before approving (no employee was matched).</p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
