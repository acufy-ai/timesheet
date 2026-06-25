import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Download, Plus, Search, Upload, Users as UsersIcon } from 'lucide-react';

import { Button, Card, Empty, Input, WorkspaceHeader } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import {
  useAssignableUsers,
  useBulkDeleteUsers, useClients, useDeleteUser, useSendInvite, useUnlockTimesheet,
  useUpdateUser, useUsers, useUsersPaged,
} from '@/hooks/useAdmin';
import { UserEditModal } from '@/components/users/UserEditModal';
import { ResetPasswordModal } from '@/components/users/ResetPasswordModal';
import { ImportUsersModal } from '@/components/users/ImportUsersModal';
import { ExportModal } from '@/components/users/ExportModal';
import { OrgChart } from '@/components/users/OrgChart';
import { NoProjectAccessModal } from '@/components/users/NoProjectAccessModal';
import { ApprovedTimesheetsTab } from '@/components/users/ApprovedTimesheetsTab';
import { WorkforceSetupTab } from '@/components/users/WorkforceSetupTab';
import { UserRail } from '@/components/users/UserRail';
import { UserDetail } from '@/components/users/UserDetail';
import { cn } from '@/lib/cn';
import type { ManagedUser, UserListParams } from '@/types/admin';

type AdminTab = 'users' | 'timesheets' | 'workforce';
const PAGE_SIZE = 15;
const ROLE_FILTERS = ['all', 'EMPLOYEE', 'MANAGER', 'ADMIN', 'VIEWER'];

// Master-detail User Management (admin) / My Team (manager). Server-paged rail
// + a detail pane with inline-edit cards and a client/project/task access tree.
export function UsersPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'PLATFORM_ADMIN';

  const [adminTab, setAdminTab] = useState<AdminTab>('users');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [audienceFilter, setAudienceFilter] = useState<'all' | 'internal' | 'external' | 'client'>('all');
  const [attentionFilter, setAttentionFilter] = useState<'all' | 'no_manager' | 'unverified'>('all');
  const [page, setPage] = useState(1);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);

  // Modals / overlays
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<ManagedUser | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [noAccessOpen, setNoAccessOpen] = useState(false);
  // Org chart trigger hidden for now; keep the value as a const so the (dormant)
  // OrgChart render block still compiles and re-enabling is a one-line change.
  const orgChartOpen = false;
  const [bulkBusy, setBulkBusy] = useState(false);

  const flashAndFade = (tone: 'ok' | 'err', text: string) => {
    setFlash({ tone, text });
    window.setTimeout(() => setFlash(null), 5000);
  };

  // Debounce the search box → server query.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);
  // Any filter change resets to page 1.
  useEffect(() => { setPage(1); }, [debouncedSearch, roleFilter, statusFilter, audienceFilter, attentionFilter]);

  // Seed filters from the URL (dashboard action-queue + deep links).
  useEffect(() => {
    const a = searchParams.get('attention');
    if (a === 'no_manager' || a === 'unverified') setAttentionFilter(a);
    const q = searchParams.get('q');
    if (q) setSearch(q);
  }, [searchParams]);

  const params: UserListParams = useMemo(() => ({
    skip: (page - 1) * PAGE_SIZE,
    limit: PAGE_SIZE,
    q: debouncedSearch || undefined,
    role: roleFilter === 'all' ? undefined : roleFilter,
    status: statusFilter === 'all' ? undefined : statusFilter,
    audience: audienceFilter === 'all' ? undefined : audienceFilter,
    no_manager: attentionFilter === 'no_manager' || undefined,
    unverified: attentionFilter === 'unverified' || undefined,
  }), [page, debouncedSearch, roleFilter, statusFilter, audienceFilter, attentionFilter]);

  const pagedQ = useUsersPaged(params, !!user);
  const pageUsers = pagedQ.data?.items ?? [];
  const total = pagedQ.data?.total ?? 0;

  // Full roster (unpaged) — used for org chart, no-project-access, and name/client maps.
  const allQ = useUsers(isAdmin);
  const all = allQ.data ?? [];
  const scoped = useMemo(
    () => (isAdmin ? all : all.filter((u) => u.manager_id === user?.id)),
    [all, isAdmin, user?.id],
  );

  const clientsQ = useClients(isAdmin);
  const clientNameById = useMemo(() => {
    const m = new Map<number, string>();
    (clientsQ.data ?? []).forEach((c) => m.set(c.id, c.name));
    return m;
  }, [clientsQ.data]);
  // Full tenant directory for resolving names (e.g. a report's manager).
  // /users/assignable is available to managers too — unlike the admin-only
  // unpaged roster (`all`) — so a manager's My Team can still show their own
  // name as the "Manager" of each report instead of "None"/"#5".
  const assignableQ = useAssignableUsers();
  const nameById = useMemo(() => {
    const m = new Map<number, string>();
    (assignableQ.data ?? []).forEach((u) => m.set(u.id, u.full_name));
    all.forEach((u) => m.set(u.id, u.full_name));
    pageUsers.forEach((u) => m.set(u.id, u.full_name));
    if (user) m.set(user.id, user.full_name);
    return m;
  }, [assignableQ.data, all, pageUsers, user]);

  const update = useUpdateUser();
  const del = useDeleteUser();
  const bulkDel = useBulkDeleteUsers();
  const invite = useSendInvite();
  const unlock = useUnlockTimesheet();

  // Role breakdown + filter counts + attention chips below are ADMIN-only:
  // the full unpaged roster (`useUsers`) is fetched only for admins, and every
  // consumer of these values is gated behind `isAdmin` in the JSX. Managers
  // drive their header count from the server-paged `total` instead (the paged
  // query is already scoped to their reports).
  const counts = useMemo(() => {
    const c = { admin: 0, manager: 0, employee: 0 };
    scoped.forEach((u) => {
      if (u.role === 'ADMIN') c.admin++;
      else if (u.role === 'MANAGER') c.manager++;
      else if (u.role === 'EMPLOYEE') c.employee++;
    });
    return c;
  }, [scoped]);
  const roleCounts = useMemo(() => {
    const m: Record<string, number> = { all: scoped.length, EMPLOYEE: 0, MANAGER: 0, ADMIN: 0, VIEWER: 0 };
    scoped.forEach((u) => { if (u.role in m) m[u.role]++; });
    return m;
  }, [scoped]);
  const attentionCounts = useMemo(() => ({
    noManager: scoped.filter((u) => !u.manager_id && u.role !== 'ADMIN' && u.role !== 'PLATFORM_ADMIN').length,
    unverified: scoped.filter((u) => !u.email_verified && !u.is_external).length,
  }), [scoped]);

  // Selected user object for the detail pane. SECURITY: a non-admin must only
  // ever open someone in their OWN scope (their paged team), never an arbitrary
  // user from the tenant directory — resolving from `assignableQ.data` here
  // would let a manager click a co-manager in the reporting tree and view that
  // person's full detail + org. Admins may resolve from the full roster.
  const activeUser = useMemo(
    () =>
      pageUsers.find((u) => u.id === activeId)
      ?? (isAdmin ? (all.find((u) => u.id === activeId)
        ?? (assignableQ.data ?? []).find((u) => u.id === activeId)) : undefined)
      ?? null,
    [pageUsers, all, assignableQ.data, activeId, isAdmin],
  );
  // Auto-select the first user when nothing is selected.
  useEffect(() => {
    if (activeId == null && pageUsers.length) setActiveId(pageUsers[0].id);
  }, [pageUsers, activeId]);
  // ?userId deep link.
  useEffect(() => {
    const uid = searchParams.get('userId');
    if (uid) setActiveId(Number(uid));
  }, [searchParams]);

  // ── Actions ──
  async function toggleActive(u: ManagedUser) {
    try { await update.mutateAsync({ id: u.id, data: { is_active: !u.is_active } }); flashAndFade('ok', `${u.full_name} ${u.is_active ? 'deactivated' : 'activated'}.`); }
    catch { flashAndFade('err', 'Could not update the user.'); }
  }
  async function deleteUser(u: ManagedUser) {
    if (!window.confirm(`Delete ${u.full_name}? This cannot be undone.`)) return;
    try {
      await del.mutateAsync(u.id);
      setSelected((s) => { const n = new Set(s); n.delete(u.id); return n; });
      if (activeId === u.id) setActiveId(null);
      flashAndFade('ok', `${u.full_name} deleted.`);
    } catch { flashAndFade('err', 'Could not delete the user.'); }
  }
  async function unlockTimesheet(u: ManagedUser) {
    try { await unlock.mutateAsync(u.id); flashAndFade('ok', `${u.full_name}'s timesheet unlocked.`); }
    catch { flashAndFade('err', 'Could not unlock the timesheet.'); }
  }
  async function sendInvite(u: ManagedUser) {
    try { await invite.mutateAsync(u.id); flashAndFade('ok', `Invite sent to ${u.full_name}.`); }
    catch (e) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      flashAndFade('err', typeof d === 'string' ? d : 'Could not send the invite.');
    }
  }
  async function bulkDelete() {
    const ids = [...selected];
    if (!ids.length) return;
    if (!window.confirm(`Delete ${ids.length} selected user${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    try { await bulkDel.mutateAsync(ids); setSelected(new Set()); flashAndFade('ok', `${ids.length} user${ids.length === 1 ? '' : 's'} deleted.`); }
    catch { flashAndFade('err', 'Bulk delete failed.'); }
  }
  async function bulkSendInvite() {
    const targets = pageUsers.filter((u) => selected.has(u.id) && !u.is_external);
    if (!targets.length) { flashAndFade('err', 'No invitable (internal) users selected.'); return; }
    setBulkBusy(true); let ok = 0;
    await Promise.all(targets.map((u) => invite.mutateAsync(u.id).then(() => { ok++; }).catch(() => {})));
    setBulkBusy(false); flashAndFade('ok', `Sent ${ok} invite${ok === 1 ? '' : 's'}.`);
  }
  async function bulkDeactivate() {
    const targets = pageUsers.filter((u) => selected.has(u.id) && u.is_active);
    if (!targets.length) { flashAndFade('err', 'No active users selected.'); return; }
    if (!window.confirm(`Deactivate ${targets.length} user${targets.length === 1 ? '' : 's'}?`)) return;
    setBulkBusy(true); let ok = 0;
    await Promise.all(targets.map((u) => update.mutateAsync({ id: u.id, data: { is_active: false } }).then(() => { ok++; }).catch(() => {})));
    setBulkBusy(false); setSelected(new Set()); flashAndFade('ok', `Deactivated ${ok} user${ok === 1 ? '' : 's'}.`);
  }

  const FilterSelect = ({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="h-[30px] rounded-full border border-transparent bg-primary/10 px-3 pr-7 text-xs font-semibold text-primary outline-none hover:bg-primary/[0.16] focus:ring-2 focus:ring-primary/20">
      {children}
    </select>
  );
  const Chip = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button type="button" onClick={onClick}
      className={cn('inline-flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition', active ? 'border-primary bg-primary text-primary-foreground' : 'border-transparent bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary')}>
      {children}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <WorkspaceHeader
        title={isAdmin ? 'User Management' : 'My Team'}
        description={isAdmin
          ? `${scoped.length} users · ${counts.admin} admins · ${counts.manager} managers · ${counts.employee} employees`
          // Managers don't load the full unpaged roster (useUsers is admin-only),
          // so use the server-paged total, which is already scoped to the
          // manager's direct reports.
          : `${total} direct ${total === 1 ? 'report' : 'reports'}`}
        primary={isAdmin && adminTab === 'users' ? (
          <>
            <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Add user</Button>
            <Button variant="secondary" onClick={() => setExportOpen(true)}><Upload className="h-4 w-4" /> Export</Button>
            <Button variant="secondary" onClick={() => setImporting(true)}><Download className="h-4 w-4" /> Import</Button>
          </>
        ) : undefined}
      />

      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border pb-3">
          <div className="flex items-center gap-1.5">
            {([['users', 'Users'], ['timesheets', 'Approved Timesheets'], ['workforce', 'Workforce Setup']] as const).map(([key, label]) => (
              <button key={key} type="button" onClick={() => setAdminTab(key)}
                className={cn('pill text-sm', adminTab === key ? 'pill-active' : 'pill-idle')}>{label}</button>
            ))}
          </div>
          {/* Filters live here (right of the tabs) on the Users tab, so the list
              view doesn't need a separate full-width filter row. */}
          {adminTab === 'users' ? (
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <FilterSelect value={roleFilter} onChange={setRoleFilter}>
                <option value="all">All</option>
                {ROLE_FILTERS.filter((r) => r !== 'all').map((r) => (
                  <option key={r} value={r}>{r.charAt(0) + r.slice(1).toLowerCase()} ({roleCounts[r] ?? 0})</option>
                ))}
              </FilterSelect>
              <FilterSelect value={statusFilter} onChange={(v) => setStatusFilter(v as typeof statusFilter)}>
                <option value="all">Any status</option><option value="active">Active</option><option value="inactive">Inactive</option>
              </FilterSelect>
              <FilterSelect value={audienceFilter} onChange={(v) => setAudienceFilter(v as typeof audienceFilter)}>
                <option value="all">Any type</option><option value="internal">Internal</option><option value="external">External</option><option value="client">Clients</option>
              </FilterSelect>
              <Chip active={attentionFilter === 'no_manager'} onClick={() => setAttentionFilter(attentionFilter === 'no_manager' ? 'all' : 'no_manager')}>
                No manager{attentionCounts.noManager ? <span className="rounded-full bg-primary/15 px-1.5 text-[10.5px]">{attentionCounts.noManager}</span> : null}
              </Chip>
              <Chip active={attentionFilter === 'unverified'} onClick={() => setAttentionFilter(attentionFilter === 'unverified' ? 'all' : 'unverified')}>
                Unverified{attentionCounts.unverified ? <span className="rounded-full bg-primary/15 px-1.5 text-[10.5px]">{attentionCounts.unverified}</span> : null}
              </Chip>
            </div>
          ) : null}
        </div>
      ) : null}

      {isAdmin && adminTab === 'timesheets' ? <ApprovedTimesheetsTab /> : null}
      {isAdmin && adminTab === 'workforce' ? <WorkforceSetupTab /> : null}

      {!isAdmin || adminTab === 'users' ? (
        <>
          {flash ? (
            <div role="alert" className={cn('rounded-xl border px-3 py-2 text-sm',
              flash.tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300')}>
              {flash.text}
            </div>
          ) : null}

          {isAdmin && orgChartOpen ? (
            <Card className="p-4"><OrgChart users={scoped} currentUserId={user?.id} /></Card>
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-[340px_1fr] gap-5">
              {/* Left rail */}
              <Card className="flex min-h-0 flex-col overflow-hidden p-0">
                <div className="space-y-2.5 px-4 pb-2.5 pt-4">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[15px] font-bold uppercase tracking-wide text-muted-foreground">{isAdmin ? 'Users' : 'My Team'}</h2>
                    <span className="rounded-full bg-primary/12 px-2 text-[11px] font-bold text-primary">{total.toLocaleString()}</span>
                  </div>
                  {/* Search lives inside the list header now. */}
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input className="h-[32px] rounded-full pl-9" placeholder="Search people..." value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      onFocus={() => setSearchFocused(true)}
                      onBlur={() => window.setTimeout(() => setSearchFocused(false), 150)} />
                    {/* Typeahead: live matches from the current page; click to jump. */}
                    {searchFocused && search.trim() && pageUsers.length ? (
                      <div className="absolute left-0 right-0 top-[36px] z-20 max-h-[280px] overflow-y-auto rounded-xl border border-border bg-card shadow-lg">
                        {pageUsers.slice(0, 8).map((u) => (
                          <button key={u.id} type="button"
                            onMouseDown={(e) => { e.preventDefault(); setActiveId(u.id); setSearchFocused(false); }}
                            className="flex w-full items-center gap-2 border-b border-border/40 px-3 py-2 text-left last:border-0 hover:bg-primary/[0.05]">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-medium">{u.full_name}</span>
                              <span className="block truncate text-[11.5px] text-muted-foreground">{u.email}</span>
                            </span>
                            <span className="shrink-0 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">{u.role}</span>
                          </button>
                        ))}
                        {total > pageUsers.slice(0, 8).length ? (
                          <div className="px-3 py-1.5 text-[11px] text-muted-foreground">Showing top matches — refine to narrow.</div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
                <UserRail
                  users={pageUsers}
                  total={total}
                  page={page}
                  pageSize={PAGE_SIZE}
                  onPage={setPage}
                  loading={pagedQ.isFetching}
                  activeId={activeId}
                  onSelectUser={(u) => setActiveId(u.id)}
                  currentUserId={user?.id}
                  bulk={isAdmin ? {
                    selected,
                    onToggle: (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }),
                    onSelectAllPage: () => setSelected((s) => pageUsers.every((u) => s.has(u.id)) ? new Set() : new Set(pageUsers.map((u) => u.id))),
                    onClear: () => setSelected(new Set()),
                    onSendInvite: bulkSendInvite,
                    onDeactivate: bulkDeactivate,
                    onDelete: bulkDelete,
                    busy: bulkBusy,
                  } : undefined}
                />
              </Card>

              {/* Detail pane */}
              <div className="min-h-0 overflow-y-auto">
                {activeUser ? (
                  <UserDetail
                    user={activeUser}
                    isAdmin={isAdmin}
                    nameById={nameById}
                    clientNameById={clientNameById}
                    onEdit={(u) => setEditing(u)}
                    onResetPassword={(u) => setResetting(u)}
                    onSendInvite={sendInvite}
                    onToggleActive={toggleActive}
                    onDelete={deleteUser}
                    onUnlock={unlockTimesheet}
                    onViewTimesheets={(u) => navigate(`/user-management/${u.id}/timesheets`)}
                    onFlash={flashAndFade}
                    onSelectUser={(id) => setActiveId(id)}
                    // Admins can open anyone in the reporting tree; a manager
                    // may only open people in their own scope (their team), so
                    // clicking a co-manager/superior is a no-op (no data leak).
                    openableIds={isAdmin ? null : new Set(pageUsers.map((u) => u.id))}
                  />
                ) : (
                  <Empty Icon={UsersIcon} title="No user selected" description="Pick someone from the list to view their profile, access, and clients." />
                )}
              </div>
            </div>
          )}

          {/* Modals */}
          <UserEditModal open={creating} user={null} onClose={() => setCreating(false)} onSaved={(msg) => flashAndFade('ok', msg)} />
          <UserEditModal open={!!editing} user={editing} onClose={() => setEditing(null)} onSaved={(msg) => flashAndFade('ok', msg)} />
          <ResetPasswordModal open={!!resetting} user={resetting} onClose={() => setResetting(null)} onDone={(msg) => flashAndFade('ok', msg)} />
          <ImportUsersModal open={importing} onClose={() => setImporting(false)} onDone={(msg) => flashAndFade('ok', msg)} />
          <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
          <NoProjectAccessModal open={noAccessOpen} users={scoped} onClose={() => setNoAccessOpen(false)} onAssign={(u) => { setNoAccessOpen(false); setEditing(u); }} />
        </>
      ) : null}
    </div>
  );
}
