import { useMemo, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';

import { Button, Card, Empty, Modal, StatusBadge, Toast } from '@/components/ui';
import {
  useApproveTimeOff,
  useLeaveTypes,
  usePendingTimeOff,
  useRejectTimeOff,
  useTimeOffApprovalHistory,
} from '@/hooks/useAdmin';
import { formatDayLong, fromISODate } from '@/lib/date';
import { timesheetStatusKey } from '@/types/time';

const num = (v: string | number) => (typeof v === 'string' ? parseFloat(v) : v) || 0;
function errText(err: unknown, fb: string): string {
  const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof d === 'string' ? d : fb;
}

// Manager time-off approvals: pending requests with approve / reject-with-reason
// + recent decisions. Self-contained (fetches its own leave types) so it can be
// embedded as the Approvals page's "Time Off" tab AND the Time Off page's
// manager tab. `enabled` gates the queries so they don't fire on hidden tabs.
export function TimeOffApprovals({ enabled = true }: { enabled?: boolean }) {
  const leaveTypesQ = useLeaveTypes();
  const labelFor = (code: string) => leaveTypesQ.data?.find((t) => t.code === code)?.label ?? code;

  const pending = usePendingTimeOff(enabled);
  const history = useTimeOffApprovalHistory(enabled);
  const approve = useApproveTimeOff();
  const reject = useRejectTimeOff();

  const [rejectId, setRejectId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const flashAndFade = (tone: 'ok' | 'err', text: string) => {
    setFlash({ tone, text });
    window.setTimeout(() => setFlash(null), 4000);
  };

  const rows = pending.data ?? [];
  const [histFilter, setHistFilter] = useState<'all' | 'APPROVED' | 'REJECTED'>('all');
  const historyRows = useMemo(() => {
    const all = history.data ?? [];
    return histFilter === 'all' ? all : all.filter((r) => String(r.status).toUpperCase() === histFilter);
  }, [history.data, histFilter]);

  async function doApprove(id: number) {
    try { await approve.mutateAsync(id); flashAndFade('ok', 'Approved.'); }
    catch (err) { flashAndFade('err', errText(err, 'Could not approve.')); }
  }
  async function doReject() {
    if (rejectId == null || !rejectReason.trim()) return;
    try {
      await reject.mutateAsync({ id: rejectId, reason: rejectReason.trim() });
      setRejectId(null); setRejectReason(''); flashAndFade('ok', 'Rejected.');
    } catch (err) { flashAndFade('err', errText(err, 'Could not reject.')); }
  }

  return (
    <div className="space-y-4">
      {flash ? (
        <Toast tone={flash.tone} message={flash.text} onDismiss={() => setFlash(null)} />
      ) : null}

      <Card>
        <div className="border-b border-border px-4 py-3"><p className="text-sm font-semibold text-foreground">Pending requests</p></div>
        {pending.isLoading ? (
          <div className="grid place-items-center py-12 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" /></div>
        ) : rows.length === 0 ? (
          <Empty Icon={Check} title="No pending requests" description="Time-off requests from your reports will appear here." className="border-0" />
        ) : (
          <div className="divide-y divide-border">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{r.user?.full_name ?? `User #${r.user_id}`}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDayLong(fromISODate(r.request_date))} · {labelFor(r.leave_type)} · {num(r.hours).toFixed(1)}h{r.reason ? ` · ${r.reason}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" onClick={() => void doApprove(r.id)} disabled={approve.isPending}><Check className="h-3.5 w-3.5" /> Approve</Button>
                  <Button size="sm" variant="secondary" className="border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-500/30 dark:hover:bg-rose-500/10" onClick={() => { setRejectId(r.id); setRejectReason(''); }}>Reject</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {(history.data ?? []).length > 0 ? (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold text-foreground">Decision history</p>
            <div className="flex gap-1">
              {(['all', 'APPROVED', 'REJECTED'] as const).map((f) => (
                <button key={f} type="button" onClick={() => setHistFilter(f)} className={'rounded-full px-2.5 py-1 text-xs font-medium ' + (histFilter === f ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/60')}>
                  {f === 'all' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          </div>
          {historyRows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">No {histFilter === 'all' ? '' : histFilter.toLowerCase() + ' '}decisions.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-2 font-semibold">Employee</th>
                    <th className="px-4 py-2 font-semibold">Type</th>
                    <th className="px-4 py-2 font-semibold">Date</th>
                    <th className="px-4 py-2 font-semibold text-right">Hours</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                    <th className="px-4 py-2 font-semibold">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {historyRows.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2 font-medium text-foreground">{r.user?.full_name ?? `User #${r.user_id}`}</td>
                      <td className="px-4 py-2 text-muted-foreground">{labelFor(r.leave_type)}</td>
                      <td className="px-4 py-2 tabular-nums text-muted-foreground">{formatDayLong(fromISODate(r.request_date))}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{num(r.hours).toFixed(1)}h</td>
                      <td className="px-4 py-2"><StatusBadge status={timesheetStatusKey(r.status)} variant="timesheet" showIcon={false} /></td>
                      <td className="max-w-[220px] truncate px-4 py-2 text-xs text-rose-600 dark:text-rose-300" title={r.rejection_reason ?? ''}>{r.rejection_reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      <Modal open={rejectId != null} onClose={() => setRejectId(null)} title="Reject time-off request">
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Give a reason so the employee knows why.</p>
          <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} autoFocus placeholder="e.g. Coverage conflict that week." className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRejectId(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void doReject()} disabled={!rejectReason.trim() || reject.isPending}>
              {reject.isPending ? (<><Loader2 className="h-4 w-4 animate-spin" /> Rejecting…</>) : 'Reject'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
