import { useMemo, useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';

import {
  Button,
  Card,
  Empty,
  Input,
  Modal,
  StatusBadge,
  WorkspaceHeader,
} from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import {
  useCreateTimeOff,
  useDeleteTimeOff,
  useLeaveTypes,
  useMyTimeOff,
  usePendingTimeOff,
  useSubmitTimeOff,
  useTimeOffUsage,
  useUpdateTimeOff,
} from '@/hooks/useAdmin';
import { TimeOffApprovals } from '@/components/time-off/TimeOffApprovals';
import { addDays, formatDayLong, fromISODate, toISODate } from '@/lib/date';
import { cn } from '@/lib/cn';
import { timesheetStatusKey } from '@/types/time';
import type { LeaveType, TimeOffRequest } from '@/types/admin';

type Tab = 'mine' | 'approvals';

const num = (v: string | number) => (typeof v === 'string' ? parseFloat(v) : v) || 0;

// Fallback list when /leave-types is empty (e.g. a fresh tenant).
const FALLBACK_LEAVE_TYPES: LeaveType[] = [
  { id: -1, code: 'PTO', label: 'PTO / Vacation', color: '#6366f1', is_active: true },
  { id: -2, code: 'SICK', label: 'Sick', color: '#f59e0b', is_active: true },
  { id: -3, code: 'HALF_DAY', label: 'Half day', color: '#10b981', is_active: true },
  { id: -4, code: 'UNPAID', label: 'Unpaid', color: '#94a3b8', is_active: true },
  { id: -5, code: 'OTHER', label: 'Other', color: '#64748b', is_active: true },
];

const STATUS_ORDER: Array<{ key: TimeOffRequest['status']; label: string }> = [
  { key: 'DRAFT', label: 'Drafts' },
  { key: 'SUBMITTED', label: 'Submitted' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
];

function extractError(err: unknown, fallback: string): string {
  const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof d === 'string' ? d : fallback;
}

export function TimeOffPage() {
  const { user } = useAuth();
  const isManager = user?.role === 'MANAGER' || user?.role === 'ADMIN';
  const [tab, setTab] = useState<Tab>('mine');

  const leaveTypesQ = useLeaveTypes();
  const leaveTypes = useMemo(() => {
    const live = (leaveTypesQ.data ?? []).filter((t) => t.is_active);
    return live.length > 0 ? live : FALLBACK_LEAVE_TYPES;
  }, [leaveTypesQ.data]);
  const labelFor = (code: string) => leaveTypes.find((t) => t.code === code)?.label ?? code;

  const pendingApprovals = usePendingTimeOff(isManager && tab === 'approvals');

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        title="Time Off"
        description={isManager ? 'Request leave and review your team\'s requests.' : 'Request PTO, sick days, and other leave.'}
      />

      {isManager ? (
        <div className="flex items-center gap-1.5 border-b border-border pb-3">
          <TabPill active={tab === 'mine'} onClick={() => setTab('mine')}>My time off</TabPill>
          <TabPill active={tab === 'approvals'} onClick={() => setTab('approvals')}>
            Approvals
            {(pendingApprovals.data?.length ?? 0) > 0 ? (
              <span className={cn('ml-1 rounded-full px-1.5 text-[10px]', tab === 'approvals' ? 'bg-white/20' : 'bg-muted')}>
                {pendingApprovals.data?.length}
              </span>
            ) : null}
          </TabPill>
        </div>
      ) : null}

      {tab === 'approvals' && isManager ? (
        <TimeOffApprovals enabled={tab === 'approvals'} />
      ) : (
        <MyTimeOff leaveTypes={leaveTypes} labelFor={labelFor} />
      )}
    </div>
  );
}

// ─── Employee self-service ──────────────────────────────────────────

function MyTimeOff({ leaveTypes, labelFor }: { leaveTypes: LeaveType[]; labelFor: (c: string) => string }) {
  const usage = useTimeOffUsage();
  const requests = useMyTimeOff();
  const create = useCreateTimeOff();
  const update = useUpdateTimeOff();
  const submit = useSubmitTimeOff();
  const del = useDeleteTimeOff();

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [startDate, setStartDate] = useState(() => toISODate(new Date()));
  const [endDate, setEndDate] = useState(() => toISODate(new Date()));
  const [hours, setHours] = useState('8');
  const [leaveType, setLeaveType] = useState(leaveTypes[0]?.code ?? 'PTO');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const rows = requests.data ?? [];
  const drafts = rows.filter((r) => r.status === 'DRAFT').map((r) => r.id);

  function openCreate() {
    setEditingId(null);
    const today = toISODate(new Date());
    setStartDate(today); setEndDate(today);
    setHours('8'); setLeaveType(leaveTypes[0]?.code ?? 'PTO'); setReason(''); setError(null);
    setOpen(true);
  }
  function openEdit(r: TimeOffRequest) {
    setEditingId(r.id);
    setStartDate(r.request_date); setEndDate(r.request_date);
    setHours(String(num(r.hours))); setLeaveType(r.leave_type); setReason(r.reason ?? ''); setError(null);
    setOpen(true);
  }

  async function handleSave() {
    setError(null);
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) { setError('Enter a valid number of hours.'); return; }
    if (endDate < startDate) { setError('End date cannot be before the start date.'); return; }
    try {
      if (editingId) {
        // Edit applies to the single existing request (date range is create-only).
        await update.mutateAsync({
          id: editingId,
          data: { request_date: startDate, hours: h, leave_type: leaveType, reason: reason.trim() },
        });
      } else {
        // One request per day in the inclusive range (backend is single-day).
        const dates: string[] = [];
        let d = fromISODate(startDate);
        const end = fromISODate(endDate);
        while (toISODate(d) <= toISODate(end)) { dates.push(toISODate(d)); d = addDays(d, 1); }
        await Promise.all(dates.map((rd) =>
          create.mutateAsync({ request_date: rd, hours: h, leave_type: leaveType, reason: reason.trim() }),
        ));
      }
      setOpen(false); setReason('');
    } catch (err) {
      setError(extractError(err, 'Could not save the request.'));
    }
  }

  const grouped = useMemo(() => {
    const m: Record<string, TimeOffRequest[]> = { DRAFT: [], SUBMITTED: [], APPROVED: [], REJECTED: [] };
    rows.forEach((r) => { (m[r.status] ??= []).push(r); });
    Object.values(m).forEach((list) => list.sort((a, b) => b.request_date.localeCompare(a.request_date)));
    return m;
  }, [rows]);

  const saving = create.isPending || update.isPending;

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" />
          New request
        </Button>
      </div>

      {/* Balance cards */}
      {usage.isLoading ? (
        <div className="grid place-items-center rounded-2xl border border-border bg-card py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" />
        </div>
      ) : (usage.data ?? []).length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {(usage.data ?? []).map((u) => (
            <Card key={u.leave_type} className="p-4">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: u.color }} />
              <p className="mt-2 text-2xl font-semibold leading-none tabular-nums text-foreground">{u.days_taken}</p>
              <p className="mt-1 text-xs font-medium text-foreground">{u.label}</p>
              <p className="text-[11px] text-muted-foreground">{num(u.hours_taken).toFixed(1)}h taken</p>
            </Card>
          ))}
        </div>
      ) : null}

      {/* Requests, grouped by status */}
      <Card>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-semibold text-foreground">My requests</p>
          {drafts.length > 0 ? (
            <Button size="sm" variant="secondary" onClick={() => submit.mutate(drafts)} disabled={submit.isPending}>
              Submit {drafts.length} draft{drafts.length === 1 ? '' : 's'}
            </Button>
          ) : null}
        </div>

        {requests.isLoading ? (
          <div className="grid place-items-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" />
          </div>
        ) : rows.length === 0 ? (
          <Empty
            Icon={Plus}
            title="No time-off requests yet"
            description="Request PTO, a sick day, or other leave to get started."
            action={<Button size="sm" onClick={openCreate}>New request</Button>}
            className="border-0"
          />
        ) : (
          <div className="divide-y divide-border">
            {STATUS_ORDER.map(({ key, label }) => {
              const list = grouped[key] ?? [];
              if (list.length === 0) return null;
              return (
                <div key={key} className="py-1">
                  <p className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {label} · {list.length}
                  </p>
                  {list.map((r) => (
                    <div key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-foreground">{formatDayLong(fromISODate(r.request_date))}</p>
                          <StatusBadge status={timesheetStatusKey(r.status)} variant="timesheet" />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {labelFor(r.leave_type)} · {num(r.hours).toFixed(1)}h{r.reason ? ` · ${r.reason}` : ''}
                        </p>
                        {r.status === 'APPROVED' && r.approved_at ? (
                          <p className="mt-0.5 text-[11px] text-emerald-600 dark:text-emerald-300">
                            Approved {new Date(r.approved_at).toLocaleDateString()}
                          </p>
                        ) : null}
                        {r.rejection_reason ? (
                          <p className="mt-0.5 text-xs text-rose-600 dark:text-rose-300">Rejected: {r.rejection_reason}</p>
                        ) : null}
                      </div>
                      {r.status === 'DRAFT' ? (
                        <div className="flex items-center gap-1">
                          <button type="button" onClick={() => openEdit(r)} aria-label="Edit request" className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button type="button" onClick={() => del.mutate(r.id)} aria-label="Delete request" className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Create / edit modal */}
      <Modal open={open} onClose={() => setOpen(false)} title={editingId ? 'Edit time-off request' : 'New time-off request'}>
        <div className="space-y-3">
          {editingId ? (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Date</label>
              <Input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setEndDate(e.target.value); }} />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Start date</label>
                <Input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); if (endDate < e.target.value) setEndDate(e.target.value); }} />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">End date</label>
                <Input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Hours{!editingId ? ' / day' : ''}</label>
              <Input type="number" step="0.5" min="0" value={hours} onChange={(e) => setHours(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Leave type</label>
              <select
                value={leaveType}
                onChange={(e) => setLeaveType(e.target.value)}
                className="h-9 w-full rounded-full border border-border bg-transparent px-4 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                {leaveTypes.map((t) => (
                  <option key={t.code} value={t.code} className="bg-popover text-popover-foreground">{t.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Reason (optional)</label>
            <Input type="text" placeholder="e.g. Family vacation" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? (<><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>) : editingId ? 'Save changes' : 'Create request'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}


function TabPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn('pill text-sm', active ? 'pill-active' : 'pill-idle')}>
      {children}
    </button>
  );
}
