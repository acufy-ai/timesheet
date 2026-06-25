import { useMemo, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';

import { Button, Modal } from '@/components/ui';
import { usersApi } from '@/api/client';
import { useClients, useUsers } from '@/hooks/useAdmin';
import { useProjects } from '@/hooks/useTime';
import { cn } from '@/lib/cn';
import type { Client, ManagedUser } from '@/types/admin';
import type { Project } from '@/types/time';

// Standalone export modal for the User Management surface. Ports frontend2's
// ExportModal: the admin picks what to export (users / clients / approved
// timesheets), a file format (CSV / XLSX), and a type-specific filter set, then
// we hit the matching usersApi.export* endpoint and download the returned blob.
//
// Param names match the backend exactly (status_filter for users; period_start
// / period_end for timesheets). Filters that are left at "any/all" are simply
// omitted from the request so the server applies no constraint.

type ExportType = 'users' | 'clients' | 'timesheets';
type Fmt = 'csv' | 'xlsx';
type UserType = 'all' | 'internal' | 'external';
type StatusFilter = 'all' | 'active' | 'inactive';
type Preset = 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'custom';

// ── Date helpers (all return a YYYY-MM-DD string in local time) ──────
function iso(d: Date): string {
  // Avoid UTC drift from toISOString() by formatting the local date parts.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
// Monday as the first day of the week, matching the rest of the app.
function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - dow);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function lastOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function presetRange(p: Exclude<Preset, 'custom'>, today: Date): { start: string; end: string } {
  if (p === 'this_week') {
    const s = startOfWeek(today);
    return { start: iso(s), end: iso(addDays(s, 6)) };
  }
  if (p === 'last_week') {
    const s = addDays(startOfWeek(today), -7);
    return { start: iso(s), end: iso(addDays(s, 6)) };
  }
  if (p === 'this_month') {
    return { start: iso(firstOfMonth(today)), end: iso(lastOfMonth(today)) };
  }
  // last_month
  const lm = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return { start: iso(firstOfMonth(lm)), end: iso(lastOfMonth(lm)) };
}

const PRESET_LABEL: Record<Exclude<Preset, 'custom'>, string> = {
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  last_month: 'Last month',
};

function extractError(err: unknown): string {
  const e = err as { response?: { data?: { detail?: string } }; message?: string };
  const d = e?.response?.data?.detail;
  return (typeof d === 'string' ? d : undefined) ?? e?.message ?? 'Export failed. Please try again.';
}

// Turn the blob response into a browser download.
function downloadBlob(data: Blob, filename: string) {
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ExportModalProps {
  open: boolean;
  onClose: () => void;
}

export function ExportModal({ open, onClose }: ExportModalProps) {
  const [exportType, setExportType] = useState<ExportType>('users');
  const [fmt, setFmt] = useState<Fmt>('csv');

  // Users export filters
  const [usersUserType, setUsersUserType] = useState<UserType>('all');
  const [usersStatus, setUsersStatus] = useState<StatusFilter>('all');
  const [usersRole, setUsersRole] = useState<string>('');
  const [usersClientId, setUsersClientId] = useState<string>('');

  // Timesheets export filters
  const today = useMemo(() => new Date(), []);
  const [preset, setPreset] = useState<Preset>('this_month');
  const initial = useMemo(() => presetRange('this_month', today), [today]);
  const [periodStart, setPeriodStart] = useState<string>(initial.start);
  const [periodEnd, setPeriodEnd] = useState<string>(initial.end);
  const [tsUserType, setTsUserType] = useState<UserType>('all');
  const [tsUserId, setTsUserId] = useState<string>('');
  const [tsClientId, setTsClientId] = useState<string>('');
  const [tsProjectId, setTsProjectId] = useState<string>('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usersQ = useUsers(open);
  const clientsQ = useClients(open);
  const projectsQ = useProjects();

  const users = usersQ.data ?? [];
  const clients = clientsQ.data ?? [];
  const projects = projectsQ.data ?? [];

  // Project dropdown narrows to the selected client (matches frontend2).
  const filteredProjects = useMemo<Project[]>(() => {
    if (!tsClientId) return projects;
    return projects.filter((p) => String(p.client_id) === tsClientId);
  }, [projects, tsClientId]);

  function applyPreset(p: Preset) {
    setPreset(p);
    if (p === 'custom') return;
    const r = presetRange(p, today);
    setPeriodStart(r.start);
    setPeriodEnd(r.end);
  }

  async function handleExport() {
    setError(null);
    setBusy(true);
    try {
      let res;
      let name: string;
      if (exportType === 'users') {
        res = await usersApi.exportUsers({
          fmt,
          user_type: usersUserType,
          status_filter: usersStatus,
          ...(usersRole ? { role: usersRole } : {}),
          ...(usersClientId ? { client_id: Number(usersClientId) } : {}),
        });
        name = `users.${fmt}`;
      } else if (exportType === 'clients') {
        res = await usersApi.exportClients({ fmt });
        name = `clients.${fmt}`;
      } else {
        if (!periodStart || !periodEnd) {
          setError('Period start and end are required.');
          setBusy(false);
          return;
        }
        res = await usersApi.exportTimesheets({
          fmt,
          period_start: periodStart,
          period_end: periodEnd,
          user_type: tsUserType,
          ...(tsUserId ? { user_id: Number(tsUserId) } : {}),
          ...(tsClientId ? { client_id: Number(tsClientId) } : {}),
          ...(tsProjectId ? { project_id: Number(tsProjectId) } : {}),
        });
        name = `timesheets.${fmt}`;
      }
      downloadBlob(res.data as Blob, name);
      onClose();
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusy(false);
    }
  }

  const labelClass = 'mb-1 block text-xs font-medium text-muted-foreground';
  const selectClass =
    'h-9 w-full rounded-full border border-border bg-transparent px-4 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';
  const dateClass =
    'h-9 w-full rounded-full border border-border bg-transparent px-4 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

  return (
    <Modal open={open} onClose={onClose} title="Export data" className="max-w-3xl">
      <div className="space-y-5">
        <div className="space-y-5">
          {/* What to export */}
          <div>
            <span className={labelClass}>What to export</span>
            <div className="grid grid-cols-3 gap-2">
              {(['users', 'clients', 'timesheets'] as const).map((t) => {
                const on = exportType === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setExportType(t)}
                    aria-pressed={on}
                    className={cn(
                      'rounded-xl border px-3 py-2 text-sm font-medium transition',
                      on
                        ? 'border-primary bg-primary/10 text-primary ring-1 ring-primary/40'
                        : 'border-border text-muted-foreground hover:bg-muted/40',
                    )}
                  >
                    {t === 'users' ? 'Users' : t === 'clients' ? 'Clients' : 'Approved timesheets'}
                  </button>
                );
              })}
            </div>
          </div>

          {/* File format */}
          <div>
            <span className={labelClass}>File format</span>
            <div className="flex gap-2">
              {(['csv', 'xlsx'] as const).map((f) => {
                const on = fmt === f;
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFmt(f)}
                    aria-pressed={on}
                    className={cn(
                      'rounded-full border px-4 py-1.5 text-sm font-medium transition',
                      on
                        ? 'border-primary bg-primary/10 text-primary ring-1 ring-primary/40'
                        : 'border-border text-muted-foreground hover:bg-muted/40',
                    )}
                  >
                    {f.toUpperCase()}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Users filters ── */}
          {exportType === 'users' && (
            <div className="space-y-3 border-t border-border pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                User filters
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>User type</label>
                  <select
                    value={usersUserType}
                    onChange={(e) => setUsersUserType(e.target.value as UserType)}
                    className={selectClass}
                  >
                    <option value="all">All</option>
                    <option value="internal">Internal only</option>
                    <option value="external">External only</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Status</label>
                  <select
                    value={usersStatus}
                    onChange={(e) => setUsersStatus(e.target.value as StatusFilter)}
                    className={selectClass}
                  >
                    <option value="all">All</option>
                    <option value="active">Active only</option>
                    <option value="inactive">Inactive only</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Role</label>
                  <select
                    value={usersRole}
                    onChange={(e) => setUsersRole(e.target.value)}
                    className={selectClass}
                  >
                    <option value="">All roles</option>
                    <option value="EMPLOYEE">Employee</option>
                    <option value="MANAGER">Manager</option>
                    <option value="ADMIN">Admin</option>
                    <option value="VIEWER">Viewer</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Default client</label>
                  <select
                    value={usersClientId}
                    onChange={(e) => setUsersClientId(e.target.value)}
                    className={selectClass}
                  >
                    <option value="">Any</option>
                    {clients.map((c: Client) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* ── Timesheet filters ── */}
          {exportType === 'timesheets' && (
            <div className="space-y-3 border-t border-border pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Timesheet filters
              </p>

              <div>
                <label className={labelClass}>Period</label>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {(['this_week', 'last_week', 'this_month', 'last_month'] as const).map((p) => {
                    const on = preset === p;
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => applyPreset(p)}
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-xs font-medium transition',
                          on
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:bg-muted/40',
                        )}
                      >
                        {PRESET_LABEL[p]}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => applyPreset('custom')}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-xs font-medium transition',
                      preset === 'custom'
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted/40',
                    )}
                  >
                    Custom
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="date"
                    value={periodStart}
                    onChange={(e) => {
                      setPreset('custom');
                      setPeriodStart(e.target.value);
                    }}
                    className={dateClass}
                  />
                  <input
                    type="date"
                    value={periodEnd}
                    onChange={(e) => {
                      setPreset('custom');
                      setPeriodEnd(e.target.value);
                    }}
                    className={dateClass}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>User type</label>
                  <select
                    value={tsUserType}
                    onChange={(e) => setTsUserType(e.target.value as UserType)}
                    className={selectClass}
                  >
                    <option value="all">All</option>
                    <option value="internal">Internal only</option>
                    <option value="external">External only</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Specific employee</label>
                  <select
                    value={tsUserId}
                    onChange={(e) => setTsUserId(e.target.value)}
                    className={selectClass}
                  >
                    <option value="">All</option>
                    {users.map((u: ManagedUser) => (
                      <option key={u.id} value={u.id}>
                        {u.full_name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Client</label>
                  <select
                    value={tsClientId}
                    onChange={(e) => {
                      setTsClientId(e.target.value);
                      setTsProjectId('');
                    }}
                    className={selectClass}
                  >
                    <option value="">All</option>
                    {clients.map((c: Client) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Project</label>
                  <select
                    value={tsProjectId}
                    onChange={(e) => setTsProjectId(e.target.value)}
                    className={selectClass}
                  >
                    <option value="">All</option>
                    {filteredProjects.map((p: Project) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* ── Clients (no filters) ── */}
          {exportType === 'clients' && (
            <div className="border-t border-border pt-4 text-sm text-muted-foreground">
              All clients are exported with their contacts and project counts. Pick a format above.
            </div>
          )}

          {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleExport} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Exporting…
              </>
            ) : (
              <>
                <Download className="h-3.5 w-3.5" /> Export {fmt.toUpperCase()}
              </>
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
