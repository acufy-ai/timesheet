import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Download, Loader2, Plus, Search, Send, Trash2, Upload, UserX, X } from 'lucide-react';

import {
  Button,
  Card,
  Empty,
  Input,
  RoleBadge,
  StatusBadge,
  TonePill,
  WorkspaceHeader,
} from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import {
  useBulkDeleteUsers,
  useDeleteUser,
  useSendInvite,
  useUnlockTimesheet,
  useUpdateUser,
  useUsers,
} from '@/hooks/useAdmin';
import { UserEditModal } from '@/components/users/UserEditModal';
import { ResetPasswordModal } from '@/components/users/ResetPasswordModal';
import { ImportUsersModal } from '@/components/users/ImportUsersModal';
import { ExportModal } from '@/components/users/ExportModal';
import { UserDetailsModal } from '@/components/users/UserDetailsModal';
import { OrgChart } from '@/components/users/OrgChart';
import { NoProjectAccessModal } from '@/components/users/NoProjectAccessModal';
import { UserActionMenu } from '@/components/users/UserActionMenu';
import { ApprovedTimesheetsTab } from '@/components/users/ApprovedTimesheetsTab';
import { WorkforceSetupTab } from '@/components/users/WorkforceSetupTab';
import { useClients } from '@/hooks/useAdmin';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import type { ManagedUser } from '@/types/admin';

type AdminTab = 'users' | 'timesheets' | 'workforce';

// Doubles as "Users" (admin: whole workspace) and "My Team" (manager: direct
// reports only). Admins get the full management surface: create/edit/delete,
// reset password, send invite, activate/deactivate, bulk delete, export, plus
// role / status / audience filters. Managers see a read-only roster of reports.
export function UsersPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'PLATFORM_ADMIN';
  const usersQ = useUsers();

  const [adminTab, setAdminTab] = useState<AdminTab>('users');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [audienceFilter, setAudienceFilter] = useState<'all' | 'internal' | 'external'>('all');
  const [attentionFilter, setAttentionFilter] = useState<'all' | 'no_manager' | 'unverified'>('all');

  // Seed filters from the URL: ?attention= (dashboard action-queue links) and
  // ?q= (a manager clicking a roster member lands filtered to that person).
  useEffect(() => {
    const a = searchParams.get('attention');
    if (a === 'no_manager' || a === 'unverified') setAttentionFilter(a);
    const q = searchParams.get('q');
    if (q) setSearch(q);
  }, [searchParams]);

  // ?userId= opens that user's details modal (deep-link from dashboards/search).
  useEffect(() => {
    const uid = searchParams.get('userId');
    if (!uid) return;
    const target = (usersQ.data ?? []).find((u) => u.id === Number(uid));
    if (target) setViewing(target);
  }, [searchParams, usersQ.data]);

  const [editing, setEditing] = useState<ManagedUser | null>(null);
  // Manager editing a report's project access (restricted edit).
  const [editingAccess, setEditingAccess] = useState<ManagedUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<ManagedUser | null>(null);
  const [viewing, setViewing] = useState<ManagedUser | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [noAccessOpen, setNoAccessOpen] = useState(false);
  const [orgChartOpen, setOrgChartOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const clientsQ = useClients(isAdmin);
  const clientNameById = useMemo(() => {
    const m = new Map<number, string>();
    (clientsQ.data ?? []).forEach((c) => m.set(c.id, c.name));
    return m;
  }, [clientsQ.data]);

  const update = useUpdateUser();
  const del = useDeleteUser();
  const bulkDel = useBulkDeleteUsers();
  const invite = useSendInvite();
  const unlock = useUnlockTimesheet();

  const flashAndFade = (tone: 'ok' | 'err', text: string) => {
    setFlash({ tone, text });
    window.setTimeout(() => setFlash(null), 5000);
  };

  const all = usersQ.data ?? [];
  const scoped = useMemo(
    () => (isAdmin ? all : all.filter((u) => u.manager_id === user?.id)),
    [all, isAdmin, user?.id],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scoped.filter((u) => {
      const matchesSearch =
        !q ||
        u.full_name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        (u.department ?? '').toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q);
      const matchesRole = roleFilter === 'all' || u.role === roleFilter;
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'active' ? u.is_active : !u.is_active);
      const matchesAudience =
        audienceFilter === 'all' ||
        (audienceFilter === 'external' ? !!u.is_external : !u.is_external);
      const matchesAttention =
        attentionFilter === 'all' ||
        (attentionFilter === 'no_manager'
          ? !u.manager_id && u.role !== 'ADMIN' && u.role !== 'PLATFORM_ADMIN'
          : !u.email_verified && !u.is_external);
      return matchesSearch && matchesRole && matchesStatus && matchesAudience && matchesAttention;
    });
  }, [scoped, search, roleFilter, statusFilter, audienceFilter, attentionFilter]);

  // Counts for the attention chips so the admin sees how many need action.
  const attentionCounts = useMemo(() => ({
    noManager: scoped.filter((u) => !u.manager_id && u.role !== 'ADMIN' && u.role !== 'PLATFORM_ADMIN').length,
    unverified: scoped.filter((u) => !u.email_verified && !u.is_external).length,
  }), [scoped]);

  const nameById = useMemo(() => {
    const m = new Map<number, string>();
    all.forEach((u) => m.set(u.id, u.full_name));
    return m;
  }, [all]);

  const counts = useMemo(() => {
    const c = { admin: 0, manager: 0, employee: 0 };
    scoped.forEach((u) => {
      if (u.role === 'ADMIN') c.admin++;
      else if (u.role === 'MANAGER') c.manager++;
      else if (u.role === 'EMPLOYEE') c.employee++;
    });
    return c;
  }, [scoped]);

  // Live counts for the role quick-filter chips (+ inactive).
  const roleCounts = useMemo(() => {
    const m: Record<string, number> = { all: scoped.length, EMPLOYEE: 0, MANAGER: 0, ADMIN: 0, VIEWER: 0 };
    scoped.forEach((u) => { if (u.role in m) m[u.role]++; });
    return m;
  }, [scoped]);
  const inactiveCount = useMemo(() => scoped.filter((u) => !u.is_active).length, [scoped]);

  // Search autocomplete suggestions (unique names / emails / departments).
  const searchSuggestions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: { label: string; userId?: number }[] = [];
    const seen = new Set<string>();
    for (const u of scoped) {
      for (const cand of [{ v: u.full_name, id: u.id }, { v: u.email, id: u.id }, { v: u.department ?? '' }]) {
        if (cand.v && cand.v.toLowerCase().includes(q) && !seen.has(cand.v.toLowerCase())) {
          seen.add(cand.v.toLowerCase());
          out.push({ label: cand.v, userId: cand.id });
          if (out.length >= 8) return out;
        }
      }
    }
    return out;
  }, [search, scoped]);
  const [showSuggest, setShowSuggest] = useState(false);

  const ROLE_FILTERS = ['all', 'EMPLOYEE', 'MANAGER', 'ADMIN', 'VIEWER'];

  // ── Actions ──────────────────────────────────────────────────────
  async function toggleActive(u: ManagedUser) {
    try {
      await update.mutateAsync({ id: u.id, data: { is_active: !u.is_active } });
      flashAndFade('ok', `${u.full_name} ${u.is_active ? 'deactivated' : 'activated'}.`);
    } catch {
      flashAndFade('err', 'Could not update the user.');
    }
  }
  async function deleteUser(u: ManagedUser) {
    if (!window.confirm(`Delete ${u.full_name}? This cannot be undone.`)) return;
    try {
      await del.mutateAsync(u.id);
      setSelected((s) => { const n = new Set(s); n.delete(u.id); return n; });
      flashAndFade('ok', `${u.full_name} deleted.`);
    } catch {
      flashAndFade('err', 'Could not delete the user.');
    }
  }
  async function unlockTimesheet(u: ManagedUser) {
    try { await unlock.mutateAsync(u.id); flashAndFade('ok', `${u.full_name}'s timesheet unlocked.`); }
    catch { flashAndFade('err', 'Could not unlock the timesheet.'); }
  }
  async function sendInvite(u: ManagedUser) {
    try {
      await invite.mutateAsync(u.id);
      flashAndFade('ok', `Invite sent to ${u.full_name}.`);
    } catch (e) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      flashAndFade('err', typeof d === 'string' ? d : 'Could not send the invite.');
    }
  }
  async function bulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} selected user${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    try {
      await bulkDel.mutateAsync(ids);
      setSelected(new Set());
      flashAndFade('ok', `${ids.length} user${ids.length === 1 ? '' : 's'} deleted.`);
    } catch {
      flashAndFade('err', 'Bulk delete failed.');
    }
  }
  async function bulkSendInvite() {
    const targets = filtered.filter((u) => selected.has(u.id) && !u.is_external);
    if (targets.length === 0) { flashAndFade('err', 'No invitable (internal) users selected.'); return; }
    setBulkBusy(true);
    let ok = 0;
    await Promise.all(targets.map((u) => invite.mutateAsync(u.id).then(() => { ok++; }).catch(() => {})));
    setBulkBusy(false);
    flashAndFade('ok', `Sent ${ok} invite${ok === 1 ? '' : 's'}.`);
  }
  async function bulkDeactivate() {
    const targets = filtered.filter((u) => selected.has(u.id) && u.is_active);
    if (targets.length === 0) { flashAndFade('err', 'No active users selected.'); return; }
    if (!window.confirm(`Deactivate ${targets.length} user${targets.length === 1 ? '' : 's'}?`)) return;
    setBulkBusy(true);
    let ok = 0;
    await Promise.all(targets.map((u) => update.mutateAsync({ id: u.id, data: { is_active: false } }).then(() => { ok++; }).catch(() => {})));
    setBulkBusy(false);
    setSelected(new Set());
    flashAndFade('ok', `Deactivated ${ok} user${ok === 1 ? '' : 's'}.`);
  }
  // Export the SELECTED subset (or the current filtered view if none selected)
  // as CSV, client-side — the backend export endpoint dumps all users.
  function exportSelectedCsv() {
    const rows = selected.size > 0 ? filtered.filter((u) => selected.has(u.id)) : filtered;
    if (rows.length === 0) return;
    const header = ['Name', 'Email', 'Role', 'Department', 'Manager', 'Active', 'Type'];
    const esc = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((u) => [
      u.full_name, u.email, u.role, u.department ?? '', u.manager_id ? (nameById.get(u.manager_id) ?? '') : '',
      u.is_active ? 'yes' : 'no', u.is_external ? 'external' : 'internal',
    ].map(esc).join(','));
    const blob = new Blob([[header.map(esc).join(','), ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'users.csv'; a.click();
    URL.revokeObjectURL(url);
  }
  function toggleSelect(id: number) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleSelectAll() {
    setSelected((s) =>
      s.size === filtered.length ? new Set() : new Set(filtered.map((u) => u.id)),
    );
  }

  const FilterPill = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button type="button" onClick={onClick} className={cn('pill text-xs', active ? 'pill-active' : 'pill-idle bg-muted')}>
      {children}
    </button>
  );

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        title={isAdmin ? 'User Management' : 'My Team'}
        description={
          isAdmin
            ? `${scoped.length} users · ${counts.admin} admins · ${counts.manager} managers · ${counts.employee} employees`
            : `${scoped.length} direct ${scoped.length === 1 ? 'report' : 'reports'}`
        }
        primary={
          isAdmin && adminTab === 'users' ? (
            <>
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" />
                Add user
              </Button>
              <Button variant="secondary" onClick={() => setExportOpen(true)}>
                <Upload className="h-4 w-4" />
                Export
              </Button>
              <Button variant="secondary" onClick={() => setImporting(true)}>
                <Download className="h-4 w-4" />
                Import
              </Button>
            </>
          ) : undefined
        }
      />

      {/* Admin sub-tabs (Users / Approved Timesheets / Workforce Setup) */}
      {isAdmin ? (
        <div className="flex items-center gap-1.5 border-b border-border pb-3">
          {([
            ['users', 'Users'],
            ['timesheets', 'Approved Timesheets'],
            ['workforce', 'Workforce Setup'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setAdminTab(key)}
              className={cn('pill text-sm', adminTab === key ? 'pill-active' : 'pill-idle')}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {isAdmin && adminTab === 'timesheets' ? <ApprovedTimesheetsTab /> : null}
      {isAdmin && adminTab === 'workforce' ? <WorkforceSetupTab /> : null}

      {/* Users tab body — also the manager's "My Team" roster. */}
      {!isAdmin || adminTab === 'users' ? (
      <>
      {flash ? (
        <div
          role="alert"
          className={
            'rounded-xl border px-3 py-2 text-sm ' +
            (flash.tone === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300')
          }
        >
          {flash.text}
        </div>
      ) : null}

      {/* Filter bar */}
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search by name, email, role, or department..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setShowSuggest(true); }}
            onFocus={() => setShowSuggest(true)}
            onBlur={() => window.setTimeout(() => setShowSuggest(false), 150)}
          />
          {showSuggest && searchSuggestions.length > 0 ? (
            <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-border bg-card shadow-lg">
              {searchSuggestions.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    const target = s.userId ? scoped.find((u) => u.id === s.userId && (u.full_name === s.label || u.email === s.label)) : undefined;
                    if (target && isAdmin) { setViewing(target); setShowSuggest(false); }
                    else { setSearch(s.label); setShowSuggest(false); }
                  }}
                  className="block w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-primary/5"
                >
                  {s.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {ROLE_FILTERS.map((r) => (
            <FilterPill key={r} active={roleFilter === r} onClick={() => setRoleFilter(r)}>
              {r === 'all' ? `All (${roleCounts.all})` : `${r.charAt(0) + r.slice(1).toLowerCase()} (${roleCounts[r] ?? 0})`}
            </FilterPill>
          ))}
          <FilterPill active={statusFilter === 'inactive'} onClick={() => setStatusFilter(statusFilter === 'inactive' ? 'all' : 'inactive')}>
            Inactive ({inactiveCount})
          </FilterPill>
        </div>
        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">·</span>
            <FilterPill active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>Any status</FilterPill>
            <FilterPill active={statusFilter === 'active'} onClick={() => setStatusFilter('active')}>Active</FilterPill>
            <FilterPill active={statusFilter === 'inactive'} onClick={() => setStatusFilter('inactive')}>Inactive</FilterPill>
            <span className="text-[11px] text-muted-foreground">·</span>
            <FilterPill active={audienceFilter === 'all'} onClick={() => setAudienceFilter('all')}>Any type</FilterPill>
            <FilterPill active={audienceFilter === 'internal'} onClick={() => setAudienceFilter('internal')}>Internal</FilterPill>
            <FilterPill active={audienceFilter === 'external'} onClick={() => setAudienceFilter('external')}>External</FilterPill>
            <span className="text-[11px] text-muted-foreground">·</span>
            <FilterPill active={attentionFilter === 'no_manager'} onClick={() => setAttentionFilter(attentionFilter === 'no_manager' ? 'all' : 'no_manager')}>
              No manager{attentionCounts.noManager ? ` (${attentionCounts.noManager})` : ''}
            </FilterPill>
            <FilterPill active={attentionFilter === 'unverified'} onClick={() => setAttentionFilter(attentionFilter === 'unverified' ? 'all' : 'unverified')}>
              Unverified{attentionCounts.unverified ? ` (${attentionCounts.unverified})` : ''}
            </FilterPill>
          </div>
        ) : null}
      </Card>

      {/* Admin tools row: org chart + employees-without-project-access */}
      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOrgChartOpen((v) => !v)}>
            {orgChartOpen ? 'Hide org chart' : 'Show org chart'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setNoAccessOpen(true)}>
            Employees without project access
          </Button>
        </div>
      ) : null}
      {isAdmin && orgChartOpen ? (
        <Card className="p-4">
          <OrgChart users={scoped} currentUserId={user?.id} />
        </Card>
      ) : null}

      {/* Bulk select bar */}
      {isAdmin && selected.size > 0 ? (
        <div className="flex items-center justify-between rounded-xl border border-primary/30 bg-primary/5 px-4 py-2.5">
          <div className="flex items-center gap-3 text-sm">
            <button type="button" onClick={() => setSelected(new Set())} className="grid h-6 w-6 place-items-center rounded-full hover:bg-foreground/10" aria-label="Clear selection">
              <X className="h-4 w-4" />
            </button>
            <span className="font-medium text-foreground">{selected.size} selected</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void bulkSendInvite()} disabled={bulkBusy}>
              {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send invite
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void bulkDeactivate()} disabled={bulkBusy}>
              <UserX className="h-3.5 w-3.5" /> Deactivate
            </Button>
            <Button variant="secondary" size="sm" onClick={exportSelectedCsv}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            <Button variant="destructive" size="sm" onClick={bulkDelete} disabled={bulkDel.isPending}>
              {bulkDel.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Delete
            </Button>
          </div>
        </div>
      ) : null}

      {usersQ.isLoading ? (
        <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
        </div>
      ) : usersQ.isError ? (
        <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">
          Couldn't load users. Try refreshing.
        </Card>
      ) : filtered.length === 0 ? (
        <Empty Icon={Search} title="No users match" description="Try a different search or filter." />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  {isAdmin ? (
                    <th className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={selected.size === filtered.length && filtered.length > 0}
                        onChange={toggleSelectAll}
                        className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]"
                      />
                    </th>
                  ) : null}
                  <th className="px-4 py-2.5 font-semibold">User</th>
                  <th className="px-4 py-2.5 font-semibold">Role</th>
                  <th className="px-4 py-2.5 font-semibold">Manager</th>
                  <th className="px-4 py-2.5 font-semibold">Department</th>
                  <th className="px-4 py-2.5 font-semibold">Projects</th>
                  <th className="px-4 py-2.5 font-semibold">Status</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id} className="border-b border-border transition-colors last:border-0 hover:bg-primary/5">
                    {isAdmin ? (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${u.full_name}`}
                          checked={selected.has(u.id)}
                          onChange={() => toggleSelect(u.id)}
                          className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]"
                        />
                      </td>
                    ) : null}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold', avatarTone(u.email))}>
                          {initials(u.full_name)}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium text-foreground">
                            {isAdmin ? (
                              <button type="button" onClick={() => setViewing(u)} className="rounded text-left hover:text-primary hover:underline">
                                {u.full_name}
                              </button>
                            ) : (
                              u.full_name
                            )}
                            {u.id === user?.id ? <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-primary">you</span> : null}
                            {u.is_external ? <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase text-muted-foreground">External</span> : null}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3"><RoleBadge role={u.role} /></td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {u.manager_id ? nameById.get(u.manager_id) ?? '—' : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{u.department ?? '—'}</td>
                    <td className="px-4 py-3 tabular-nums text-foreground">{u.project_ids?.length ?? 0}</td>
                    <td className="px-4 py-3">
                      {isAdmin && u.id !== user?.id ? (
                        <button type="button" onClick={() => void toggleActive(u)} title={u.is_active ? 'Click to deactivate' : 'Click to activate'} className="rounded-full">
                          {u.is_active ? (
                            <StatusBadge status="approved" variant="timesheet" label="Active" />
                          ) : (
                            <TonePill tone="neutral">Inactive</TonePill>
                          )}
                        </button>
                      ) : u.is_active ? (
                        <StatusBadge status="approved" variant="timesheet" label="Active" />
                      ) : (
                        <TonePill tone="neutral">Inactive</TonePill>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {isAdmin ? (
                        <UserActionMenu
                          user={u}
                          onEdit={() => setEditing(u)}
                          onResetPassword={() => setResetting(u)}
                          onSendInvite={() => sendInvite(u)}
                          onToggleActive={() => toggleActive(u)}
                          onDelete={() => deleteUser(u)}
                          onViewTimesheets={() => navigate(`/user-management/${u.id}/timesheets`)}
                          onUnlock={() => void unlockTimesheet(u)}
                        />
                      ) : u.role === 'EMPLOYEE' ? (
                        <Button variant="ghost" size="sm" onClick={() => setEditingAccess(u)}>Edit access</Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Modals */}
      <UserEditModal
        open={creating}
        user={null}
        onClose={() => setCreating(false)}
        onSaved={(msg) => flashAndFade('ok', msg)}
      />
      <UserEditModal
        open={!!editing}
        user={editing}
        onClose={() => setEditing(null)}
        onSaved={(msg) => flashAndFade('ok', msg)}
      />
      <UserEditModal
        open={!!editingAccess}
        user={editingAccess}
        restrictedToProjectAccess
        onClose={() => setEditingAccess(null)}
        onSaved={(msg) => flashAndFade('ok', msg)}
      />
      <ResetPasswordModal
        open={!!resetting}
        user={resetting}
        onClose={() => setResetting(null)}
        onDone={(msg) => flashAndFade('ok', msg)}
      />
      <ImportUsersModal
        open={importing}
        onClose={() => setImporting(false)}
        onDone={(msg) => flashAndFade('ok', msg)}
      />
      <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
      <UserDetailsModal
        open={!!viewing}
        user={viewing}
        onClose={() => setViewing(null)}
        onEdit={(u) => { setViewing(null); setEditing(u); }}
        onViewTimesheets={(u) => { setViewing(null); navigate(`/user-management/${u.id}/timesheets`); }}
        managerName={viewing?.manager_id ? nameById.get(viewing.manager_id) : undefined}
        clientName={viewing?.default_client_id ? clientNameById.get(viewing.default_client_id) : undefined}
      />
      <NoProjectAccessModal
        open={noAccessOpen}
        users={scoped}
        onClose={() => setNoAccessOpen(false)}
        onAssign={(u) => { setNoAccessOpen(false); setEditing(u); }}
      />
      </>
      ) : null}
    </div>
  );
}
