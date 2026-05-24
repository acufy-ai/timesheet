import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { format } from 'date-fns';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  PlusCircle, Pencil, X, Building2, CheckCircle, XCircle,
  PauseCircle, ShieldAlert, Trash2, UserCog, ChevronDown, ChevronRight, Bot, KeyRound,
  MoreVertical, MailCheck, ExternalLink,
} from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { tenantsAPI } from '@/api';
import { useUsers, useCreateUser, useUpdateUser, useDeleteUser, useResetUserPassword, useResendVerification, usePlatformTenantsUsersCount } from '@/hooks';
import { Tenant, TenantStatus, User, UserRole } from '@/types';
import { TenantFeatureFlags } from '@/components/TenantFeatureFlags';

// ─── Helpers ───────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<TenantStatus, { label: string; classes: string; icon: React.ReactNode }> = {
  active:    { label: 'Active',    classes: 'bg-emerald-100 text-emerald-800', icon: <CheckCircle className="w-3 h-3" /> },
  inactive:  { label: 'Inactive',  classes: 'bg-slate-100 text-slate-700',    icon: <XCircle className="w-3 h-3" /> },
  suspended: { label: 'Suspended', classes: 'bg-red-100 text-red-700',        icon: <PauseCircle className="w-3 h-3" /> },
};

const StatusBadge: React.FC<{ status: TenantStatus }> = ({ status }) => {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.classes}`}>
      {cfg.icon}{cfg.label}
    </span>
  );
};

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const apiError = (e: unknown) =>
  (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Something went wrong';

// ─── Form types ────────────────────────────────────────────────────────────

type TenantFormState = { name: string; slug: string; status: TenantStatus; ingestion_enabled: boolean; max_mailboxes: string; timezone: string };
const emptyTenantForm = (): TenantFormState => ({ name: '', slug: '', status: 'active', ingestion_enabled: false, max_mailboxes: '1', timezone: '' });

type AdminFormState = { full_name: string; email: string; username: string; password: string };
const emptyAdminForm = (): AdminFormState => ({ full_name: '', email: '', username: '', password: 'password' });

type AdminEditFormState = { full_name: string; email: string; username: string; is_active: boolean };
const emptyAdminEditForm = (): AdminEditFormState => ({ full_name: '', email: '', username: '', is_active: true });

type AdminResetPasswordState = { userId: number; value: string; error: string } | null;

// ─── Admin row action menu (flips upward when near container bottom) ──────

type AdminActionMenuProps = {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  canResend: boolean;
  resendTooltip: string;
  adminLabel: string;
  onEdit: () => void;
  onResend: () => void;
  onResetPassword: () => void;
  onDelete: () => void;
};

const AdminActionMenu: React.FC<AdminActionMenuProps> = ({
  isOpen, onToggle, onClose, canResend, resendTooltip, adminLabel,
  onEdit, onResend, onResetPassword, onDelete,
}) => {
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  // Dropdown is rendered into document.body via a portal so parent containers
  // with overflow-hidden (e.g. the tenant panel) don't clip it. We compute
  // absolute coords from the trigger button each time the menu opens and on
  // window resize.
  const [position, setPosition] = React.useState<{ top: number; left: number; openUp: boolean } | null>(null);

  const recompute = React.useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const menuHeight = 200;
    const menuWidth = 180;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < menuHeight && rect.top > menuHeight;
    const top = openUp ? rect.top - menuHeight - 4 : rect.bottom + 4;
    // Align right edge of menu with right edge of button.
    const left = Math.max(8, rect.right - menuWidth);
    setPosition({ top, left, openUp });
  }, []);

  React.useEffect(() => {
    if (!isOpen) {
      setPosition(null);
      return;
    }
    recompute();
    const onResize = () => recompute();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [isOpen, recompute]);

  return (
    <div className="relative inline-block" data-admin-action-menu>
      <button
        ref={buttonRef}
        onClick={onToggle}
        className="p-1 rounded hover:bg-slate-100 text-slate-500"
        title="Actions"
        aria-label={`Actions for ${adminLabel}`}
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {isOpen && position && createPortal(
        <div
          data-admin-action-menu
          style={{ position: 'fixed', top: position.top, left: position.left, width: 180 }}
          className="z-50 rounded-lg border border-slate-200 bg-white shadow-lg py-1"
        >
          <button
            onClick={() => { onClose(); onEdit(); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 text-left"
          >
            <Pencil className="w-3.5 h-3.5" /> Edit
          </button>
          <button
            onClick={() => { if (!canResend) return; onClose(); onResend(); }}
            disabled={!canResend}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 text-left disabled:opacity-40 disabled:cursor-not-allowed"
            title={resendTooltip}
          >
            <MailCheck className="w-3.5 h-3.5" /> Resend verification
          </button>
          <button
            onClick={() => { onClose(); onResetPassword(); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 text-left"
          >
            <KeyRound className="w-3.5 h-3.5" /> Reset password
          </button>
          <button
            onClick={() => { onClose(); onDelete(); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 text-left"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
};

// ─── Component ─────────────────────────────────────────────────────────────

export const PlatformAdminPage: React.FC = () => {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // ── Data ─────────────────────────────────────────────────────────────────
  const { data: tenants = [], isLoading: tenantsLoading } = useQuery({
    queryKey: ['tenants'],
    queryFn: () => tenantsAPI.list().then((r) => r.data),
  });

  const { data: allUsers = [], isLoading: usersLoading } = useUsers();

  // Per-tenant user count via the platform fan-out endpoint. Tenants we
  // couldn't reach come back in failed_tenant_ids and the cell shows "—"
  // instead of a wrong zero.
  const { data: usersCountResp } = usePlatformTenantsUsersCount();
  const userCountByTenant = useMemo(() => {
    const map: Record<number, number> = {};
    if (usersCountResp?.counts) {
      for (const [k, v] of Object.entries(usersCountResp.counts)) {
        const id = Number(k);
        if (Number.isFinite(id)) map[id] = v;
      }
    }
    return map;
  }, [usersCountResp]);
  const usersCountFailedSet = useMemo(
    () => new Set(usersCountResp?.failed_tenant_ids ?? []),
    [usersCountResp],
  );

  const adminsByTenant = useMemo(() => {
    const map: Record<number, typeof allUsers> = {};
    allUsers
      .filter((u) => u.role === 'ADMIN' && u.tenant_id != null)
      .forEach((u) => {
        map[u.tenant_id!] = [...(map[u.tenant_id!] ?? []), u];
      });
    return map;
  }, [allUsers]);

  const totalAdmins = useMemo(
    () => allUsers.filter((u) => u.role === 'ADMIN' && u.tenant_id != null).length,
    [allUsers],
  );

  // ── Tenant mutations ──────────────────────────────────────────────────────
  const createTenantMutation = useMutation({
    mutationFn: (d: { name: string; slug: string }) => tenantsAPI.create(d).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tenants'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); closeTenantModal(); },
    onError: (e: unknown) => setTenantFormError(apiError(e)),
  });
  const updateTenantMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Omit<TenantFormState, 'max_mailboxes' | 'timezone'>> & { max_mailboxes?: number | null; timezone?: string | null } }) =>
      tenantsAPI.update(id, data).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tenants'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); closeTenantModal(); },
    onError: (e: unknown) => setTenantFormError(apiError(e)),
  });
  // Separate mutation for status changes (suspend / resume) from the
  // danger-zone affordance in the expanded row. Doesn't touch the
  // edit modal lifecycle - only invalidates queries so the row reflects
  // the new status. The backend's update_tenant_endpoint already writes
  // a platform-audit event for the status flip, so the Audit page picks
  // it up automatically.
  const [statusMutationError, setStatusMutationError] = useState<string | null>(null);
  const tenantStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: 'active' | 'suspended' }) =>
      tenantsAPI.update(id, { status }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      setStatusMutationError(null);
    },
    onError: (e: unknown) => setStatusMutationError(apiError(e)),
  });

  const updateUserMutation = useUpdateUser();
  const createUserMutation = useCreateUser();
  const deleteUserMutation = useDeleteUser();

  const [provisioningTenantId, setProvisioningTenantId] = useState<number | null>(null);
  const provisionSystemUserMutation = useMutation({
    mutationFn: (tenantId: number) => tenantsAPI.provisionSystemUser(tenantId).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); setProvisioningTenantId(null); },
    onError: () => setProvisioningTenantId(null),
  });

  // ── Tenant expand/edit state ──────────────────────────────────────────────
  const [expandedTenantId, setExpandedTenantId] = useState<number | null>(null);
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
  const [showCreateTenant, setShowCreateTenant] = useState(false);
  const [tenantForm, setTenantForm] = useState<TenantFormState>(emptyTenantForm());
  const [tenantFormError, setTenantFormError] = useState('');

  const toggleExpand = (id: number) =>
    setExpandedTenantId((prev) => (prev === id ? null : id));

  const openCreateTenant = () => { setTenantForm(emptyTenantForm()); setTenantFormError(''); setShowCreateTenant(true); };
  const openEditTenant = (e: React.MouseEvent, t: Tenant) => {
    e.stopPropagation();
    setTenantForm({
      name: t.name,
      slug: t.slug,
      status: t.status,
      ingestion_enabled: t.ingestion_enabled,
      max_mailboxes: t.max_mailboxes == null ? '' : String(t.max_mailboxes),
      timezone: t.timezone ?? '',
    });
    setTenantFormError('');
    setEditingTenant(t);
  };
  const closeTenantModal = () => { setShowCreateTenant(false); setEditingTenant(null); setTenantForm(emptyTenantForm()); setTenantFormError(''); };

  const handleTenantSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setTenantFormError('');
    if (!tenantForm.name.trim() || !tenantForm.slug.trim()) { setTenantFormError('Name and slug are required'); return; }
    if (!/^[a-z0-9-]+$/.test(tenantForm.slug)) { setTenantFormError('Slug must be lowercase letters, numbers, hyphens only'); return; }
    if (editingTenant) {
      const trimmed = tenantForm.max_mailboxes.trim();
      const maxMailboxes = trimmed === '' ? null : Math.max(0, parseInt(trimmed, 10) || 0);
      const tzTrimmed = tenantForm.timezone.trim();
      const timezonePayload = tzTrimmed === '' ? null : tzTrimmed;
      // Only send max_mailboxes when ingestion is on; it's meaningless otherwise.
      const { max_mailboxes: _dropMb, timezone: _dropTz, ...rest } = tenantForm;
      const base = { ...rest, timezone: timezonePayload };
      updateTenantMutation.mutate({
        id: editingTenant.id,
        data: tenantForm.ingestion_enabled ? { ...base, max_mailboxes: maxMailboxes } : base,
      });
    } else {
      createTenantMutation.mutate({ name: tenantForm.name.trim(), slug: tenantForm.slug.trim() });
    }
  };

  // ── Add admin state ───────────────────────────────────────────────────────
  const [addAdminForTenantId, setAddAdminForTenantId] = useState<number | null>(null);
  const [adminForm, setAdminForm] = useState<AdminFormState>(emptyAdminForm());
  const [adminFormError, setAdminFormError] = useState('');
  const [confirmDeleteUserId, setConfirmDeleteUserId] = useState<number | null>(null);

  // ── Edit admin state ──────────────────────────────────────────────────────
  const [editingAdmin, setEditingAdmin] = useState<User | null>(null);
  const [editAdminForm, setEditAdminForm] = useState<AdminEditFormState>(emptyAdminEditForm());
  const [editAdminError, setEditAdminError] = useState('');
  const [adminActionMenuId, setAdminActionMenuId] = useState<number | null>(null);
  const [adminResetPassword, setAdminResetPassword] = useState<AdminResetPasswordState>(null);
  const resetUserPassword = useResetUserPassword();
  const resendVerification = useResendVerification();

  const openEditAdmin = (admin: User) => {
    setEditingAdmin(admin);
    setEditAdminForm({
      full_name: admin.full_name,
      email: admin.email,
      username: admin.username ?? '',
      is_active: admin.is_active,
    });
    setEditAdminError('');
    setAdminActionMenuId(null);
  };
  const closeEditAdmin = () => {
    setEditingAdmin(null);
    setEditAdminForm(emptyAdminEditForm());
    setEditAdminError('');
  };
  const handleEditAdminSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAdmin) return;
    setEditAdminError('');
    const full_name = editAdminForm.full_name.trim();
    const email = editAdminForm.email.trim().toLowerCase();
    const username = editAdminForm.username.trim().toLowerCase();
    if (!full_name || !email || !username) {
      setEditAdminError('Name, email, and username are required.');
      return;
    }
    if (username.length < 3) {
      setEditAdminError('Username must be at least 3 characters.');
      return;
    }
    try {
      await updateUserMutation.mutateAsync({
        id: editingAdmin.id,
        data: { full_name, email, username, is_active: editAdminForm.is_active },
      });
      closeEditAdmin();
    } catch (err) {
      setEditAdminError(apiError(err));
    }
  };

  const handleResendAdminVerification = async (admin: User) => {
    setAdminActionMenuId(null);
    try {
      await resendVerification.mutateAsync(admin.id);
    } catch {
      // Toast-less page — fall back to a simple alert so it isn't silent.
      window.alert('Could not resend verification. Please try again.');
    }
  };

  const handleResetAdminPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminResetPassword) return;
    const value = adminResetPassword.value;
    if (value.length < 8) {
      setAdminResetPassword({ ...adminResetPassword, error: 'Password must be at least 8 characters.' });
      return;
    }
    try {
      await resetUserPassword.mutateAsync({ id: adminResetPassword.userId, newPassword: value });
      setAdminResetPassword(null);
    } catch (err) {
      setAdminResetPassword({ ...adminResetPassword, error: apiError(err) });
    }
  };

  // Close action menu on outside click
  React.useEffect(() => {
    if (adminActionMenuId === null) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest('[data-admin-action-menu]')) setAdminActionMenuId(null);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [adminActionMenuId]);
  const highlightedAdminUserId = useMemo(() => {
    const raw = searchParams.get('adminUserId');
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }, [searchParams]);

  const openAddAdmin = (e: React.MouseEvent, tenantId: number) => {
    e.stopPropagation();
    setAdminForm(emptyAdminForm());
    setAdminFormError('');
    setAddAdminForTenantId(tenantId);
    setExpandedTenantId(tenantId);
  };
  const closeAdminModal = () => { setAddAdminForTenantId(null); setAdminForm(emptyAdminForm()); setAdminFormError(''); };

  const handleAdminSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setAdminFormError('');
    if (!adminForm.full_name.trim() || !adminForm.email.trim() || !adminForm.username.trim()) {
      setAdminFormError('All fields are required'); return;
    }
    // Platform-admin token has no tenant claim. We pass the slug as a
    // header so the backend can route the create to the target tenant's
    // DB (see backend/app/core/deps.py: get_tenant_db).
    const targetTenant = tenants.find((t) => t.id === addAdminForTenantId);
    if (!targetTenant) {
      setAdminFormError('Could not determine target tenant.'); return;
    }
    createUserMutation.mutate(
      {
        data: {
          full_name: adminForm.full_name, email: adminForm.email, username: adminForm.username,
          role: 'ADMIN' as UserRole, tenant_id: addAdminForTenantId!, password: adminForm.password,
          // Admin contacts are internal employees, not external contractors.
          is_external: false,
        },
        tenantSlug: targetTenant.slug,
      },
      { onSuccess: closeAdminModal, onError: (e) => setAdminFormError(apiError(e)) },
    );
  };

  // Service token state + mutations removed (B.8). The /tenants/:id/service-tokens
  // backend routes remain intact for a future external integration; the UI
  // surface for issuing / revoking them was dead code (per
  // audit/design/tenants-page-audit.md). If the UI ever comes back, restore
  // from git history.

  const isTenantPending = createTenantMutation.isPending || updateTenantMutation.isPending;
  const isTenantModalOpen = showCreateTenant || !!editingTenant;

  React.useEffect(() => {
    const rawTenantId = searchParams.get('tenantId');
    const parsedTenantId = rawTenantId ? Number(rawTenantId) : NaN;
    if (!Number.isFinite(parsedTenantId)) {
      return;
    }

    setExpandedTenantId(parsedTenantId);
    requestAnimationFrame(() => {
      const tenantRow = document.getElementById(`tenant-${parsedTenantId}`);
      tenantRow?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [searchParams]);

  if (tenantsLoading || usersLoading) {
    return <div className="flex min-h-screen items-center justify-center"><p className="text-slate-500">Loading…</p></div>;
  }

  return (
    <div>
      <div className="p-1">
        <div className="max-w-5xl mx-auto">

          {/* Page header */}
          <div className="flex items-center gap-3 mb-6">
            <ShieldAlert className="w-6 h-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Platform Administration</h1>
              <p className="text-sm text-slate-500">Manage tenants and their admin contacts</p>
            </div>
          </div>

          {/* Summary cards. "Tenant Users" was removed: per-tenant user counts
              aren't reliably available from shared-DB state once a tenant is
              isolated. Add a /tenants/:id/user-count endpoint to bring it back. */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
            <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tenants</p>
              <p className="mt-1 text-2xl font-bold text-foreground">{tenants.length}</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Active</p>
              <p className="mt-1 text-2xl font-bold text-emerald-600 dark:text-emerald-400">{tenants.filter((t) => t.status === 'active').length}</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Ingestion on</p>
              <p className="mt-1 text-2xl font-bold text-foreground">{tenants.filter((t) => t.ingestion_enabled).length}</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Admin contacts</p>
              <p className="mt-1 text-2xl font-bold text-blue-600 dark:text-blue-400">{totalAdmins}</p>
            </div>
          </div>

          {/* Tenant table */}
          <div className="flex justify-end mb-4">
            <button
              onClick={openCreateTenant}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <PlusCircle className="w-4 h-4" />New Tenant
            </button>
          </div>

          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b border-border text-left">
                <tr>
                  <th className="w-8 px-3 py-3"></th>
                  <th className="px-4 py-3 font-semibold text-foreground">Name</th>
                  <th className="px-4 py-3 font-semibold text-foreground">Slug</th>
                  <th className="px-4 py-3 font-semibold text-foreground">Status</th>
                  <th className="px-4 py-3 font-semibold text-foreground">Ingestion</th>
                  <th className="px-4 py-3 font-semibold text-foreground">Admins</th>
                  <th className="px-4 py-3 font-semibold text-foreground">Users</th>
                  <th className="px-4 py-3 font-semibold text-foreground">Created</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {tenants.length === 0 && (
                  <tr><td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">No tenants yet</td></tr>
                )}
                {tenants.map((t) => {
                  const admins = adminsByTenant[t.id] ?? [];
                  const isExpanded = expandedTenantId === t.id;

                  return (
                    <React.Fragment key={t.id}>
                      {/* Tenant row. Clicking the row now navigates to the
                          dedicated detail page (B.2). The chevron column
                          on the left still toggles inline expansion for
                          operators who want the old view; eventually that
                          UI disappears once the detail page is the only
                          surface. */}
                      <tr
                        id={`tenant-${t.id}`}
                        onClick={() => navigate(`/platform/tenants/${t.slug}`)}
                        className={`border-t border-border cursor-pointer transition ${isExpanded ? 'bg-muted/40' : 'hover:bg-muted/30'}`}
                      >
                        <td
                          className="px-3 py-3 text-muted-foreground"
                          onClick={(e) => { e.stopPropagation(); toggleExpand(t.id); }}
                          title={isExpanded ? 'Collapse inline view' : 'Expand inline view'}
                        >
                          {isExpanded
                            ? <ChevronDown className="w-4 h-4" />
                            : <ChevronRight className="w-4 h-4" />}
                        </td>
                        <td className="px-4 py-3 font-medium text-foreground">{t.name}</td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{t.slug}</td>
                        <td className="px-4 py-3">
                          <StatusBadge status={t.status} />
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            t.ingestion_enabled
                              ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                              : 'bg-muted text-muted-foreground'
                          }`}>
                            {t.ingestion_enabled ? 'On' : 'Off'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1 text-sm font-medium ${admins.length === 0 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}>
                            <UserCog className="w-3.5 h-3.5" />
                            {admins.length}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm font-medium text-foreground">
                          {usersCountFailedSet.has(t.id) ? (
                            <span
                              className="text-muted-foreground"
                              title="Could not reach this tenant's DB to read the user count"
                            >
                              —
                            </span>
                          ) : userCountByTenant[t.id] !== undefined ? (
                            userCountByTenant[t.id].toLocaleString()
                          ) : (
                            <span className="text-muted-foreground">…</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{format(new Date(t.created_at), 'MMM d, yyyy')}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="inline-flex items-center gap-1">
                            <button
                              onClick={(e) => openEditTenant(e, t)}
                              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition"
                            >
                              <Pencil className="w-3 h-3" />Edit
                            </button>
                            {/* Path-B detail page link. Lives next to the
                                Edit pencil so the new route is reachable
                                without forcing the user to learn a new
                                gesture. Eventually replaces this entire
                                expanded-row UX (slice B.2). */}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                navigate(`/platform/tenants/${t.slug}`);
                              }}
                              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition"
                              title="Open tenant detail page"
                              aria-label={`Open detail page for ${t.name}`}
                            >
                              <ExternalLink className="w-3 h-3" />Open
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Expanded admin contacts panel */}
                      {isExpanded && (
                        <tr>
                          <td colSpan={9} className="bg-muted/30 border-t border-border px-0 py-0">
                            <div className="px-12 py-4">
                              {/* System service user status */}
                              {(() => {
                                const systemUserEmail = `system_ingestion_${t.id}@system.internal`;
                                const hasSystemUser = allUsers.some((u) => u.email === systemUserEmail);
                                const isProvisioning = provisioningTenantId === t.id && provisionSystemUserMutation.isPending;
                                return (
                                  <div className="flex items-center justify-between rounded-lg border bg-white px-4 py-2.5 mb-4">
                                    <div className="flex items-center gap-2 text-sm">
                                      <Bot className="w-4 h-4 text-slate-400" />
                                      <span className="font-medium text-slate-700">Ingestion System User</span>
                                      {hasSystemUser ? (
                                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                          <CheckCircle className="w-3 h-3" />Ready
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                                          <XCircle className="w-3 h-3" />Not provisioned
                                        </span>
                                      )}
                                    </div>
                                    {!hasSystemUser && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setProvisioningTenantId(t.id);
                                          provisionSystemUserMutation.mutate(t.id);
                                        }}
                                        disabled={isProvisioning}
                                        className="flex items-center gap-1 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                                      >
                                        <Bot className="w-3.5 h-3.5" />
                                        {isProvisioning ? 'Provisioning…' : 'Provision Now'}
                                      </button>
                                    )}
                                  </div>
                                );
                              })()}

                              <div className="flex items-center justify-between mb-3">
                                <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                                  <Building2 className="w-4 h-4 text-slate-400" />
                                  {t.name} — Admin Contacts
                                </div>
                                <button
                                  onClick={(e) => openAddAdmin(e, t.id)}
                                  className="flex items-center gap-1 rounded-lg border border-primary px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/5"
                                >
                                  <PlusCircle className="w-3.5 h-3.5" />Add Admin
                                </button>
                              </div>

                              {admins.length === 0 ? (
                                <p className="text-sm text-slate-400 italic py-2">No admin contacts yet.</p>
                              ) : (
                                <div className="rounded-lg border bg-white overflow-hidden">
                                  <table className="w-full text-sm">
                                    <thead className="bg-slate-50 border-b text-left">
                                      <tr>
                                        <th className="px-4 py-2 font-medium text-slate-600">Name</th>
                                        <th className="px-4 py-2 font-medium text-slate-600">Email</th>
                                        <th className="px-4 py-2 font-medium text-slate-600">Status</th>
                                        <th className="px-4 py-2 font-medium text-slate-600">Since</th>
                                        <th className="px-4 py-2"></th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100">
                                      {admins.map((admin) => (
                                        <tr key={admin.id} className={`hover:bg-slate-50 ${highlightedAdminUserId === admin.id ? 'bg-amber-50' : ''}`}>
                                          <td className="px-4 py-2.5 font-medium text-slate-900">{admin.full_name}</td>
                                          <td className="px-4 py-2.5 text-slate-500 text-xs">{admin.email}</td>
                                          <td className="px-4 py-2.5">
                                            <span
                                              className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full ${
                                                admin.is_active
                                                  ? 'bg-green-100 text-green-800'
                                                  : 'bg-gray-100 text-gray-600'
                                              }`}
                                            >
                                              {admin.is_active ? 'Active' : 'Inactive'}
                                            </span>
                                          </td>
                                          <td className="px-4 py-2.5 text-slate-400 text-xs">
                                            {format(new Date(admin.created_at), 'MMM d, yyyy')}
                                          </td>
                                          <td className="px-4 py-2.5 text-right">
                                            <AdminActionMenu
                                              isOpen={adminActionMenuId === admin.id}
                                              onToggle={() => setAdminActionMenuId(adminActionMenuId === admin.id ? null : admin.id)}
                                              onClose={() => setAdminActionMenuId(null)}
                                              canResend={!admin.email_verified && !resendVerification.isPending}
                                              resendTooltip={admin.email_verified ? 'User is already verified' : 'Send a fresh verification email'}
                                              adminLabel={admin.full_name}
                                              onEdit={() => openEditAdmin(admin)}
                                              onResend={() => handleResendAdminVerification(admin)}
                                              onResetPassword={() => setAdminResetPassword({ userId: admin.id, value: '', error: '' })}
                                              onDelete={() => setConfirmDeleteUserId(admin.id)}
                                            />
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}

                              {/* ── Feature flags ─────────────────────────── */}
                              <TenantFeatureFlags tenantId={t.id} />

                              {/* Service Tokens UI removed (B.8). Backend
                                  routes + tests remain intact — see
                                  audit/design/tenants-page-audit.md and
                                  the dead-code audit at
                                  audit/design/proposals/D-050b-tenants-path-b.html.
                                  If an external integration ever needs them
                                  back, re-add this section here. */}

                              {/* ── Advanced ─────────────────────────────────
                                  Suspend (soft delete) and Resume controls.
                                  Backend's PATCH /tenants/{id} writes a
                                  platform-audit event for the status flip,
                                  so the Audit tab will surface this action
                                  with before/after payloads automatically.
                                  Hard delete is intentionally not exposed —
                                  per the design decision, removing a tenant
                                  permanently is a manual control-plane
                                  operation, not a one-click UI affordance.
                                  Label: "Advanced" per the product-wide
                                  rule (no "Danger zone" framing). */}
                              <div className="mt-6 rounded-lg border border-rose-200/70 bg-rose-50/40 p-4 dark:border-rose-500/30 dark:bg-rose-500/[0.06]">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <h3 className="text-sm font-semibold text-rose-700 dark:text-rose-300">
                                      Advanced
                                    </h3>
                                    <p className="mt-1 max-w-xl text-xs text-rose-700/80 dark:text-rose-300/70">
                                      {t.status === 'suspended'
                                        ? 'This tenant is suspended. Users cannot sign in and ingestion is paused. Resume to restore access; tenant data is untouched while suspended.'
                                        : 'Suspending a tenant blocks all user sign-ins and pauses ingestion. Tenant data is preserved and the action is reversible from this panel.'}
                                    </p>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-2">
                                    {t.status === 'suspended' ? (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (window.confirm(`Resume tenant "${t.name}"? Users will be able to sign in again.`)) {
                                            tenantStatusMutation.mutate({ id: t.id, status: 'active' });
                                          }
                                        }}
                                        disabled={tenantStatusMutation.isPending}
                                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50"
                                      >
                                        <CheckCircle className="h-3.5 w-3.5" />
                                        {tenantStatusMutation.isPending ? 'Resuming…' : 'Resume tenant'}
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (window.confirm(
                                            `Suspend tenant "${t.name}"?\n\n`
                                            + 'Users will be blocked from signing in and ingestion will pause. '
                                            + 'No data is deleted; you can resume from this panel at any time.',
                                          )) {
                                            tenantStatusMutation.mutate({ id: t.id, status: 'suspended' });
                                          }
                                        }}
                                        disabled={tenantStatusMutation.isPending}
                                        className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-400/60 dark:bg-rose-500/10 dark:text-rose-300"
                                      >
                                        <PauseCircle className="h-3.5 w-3.5" />
                                        {tenantStatusMutation.isPending ? 'Suspending…' : 'Suspend tenant'}
                                      </button>
                                    )}
                                  </div>
                                </div>
                                {statusMutationError && (
                                  <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">
                                    {statusMutationError}
                                  </p>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Tenant Create/Edit Modal ──────────────────────────────────────── */}
      {isTenantModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="text-base font-semibold text-slate-900">
                {editingTenant ? `Edit — ${editingTenant.name}` : 'New Tenant'}
              </h2>
              <button onClick={closeTenantModal} className="rounded p-1 hover:bg-slate-100">
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>
            <form onSubmit={handleTenantSubmit} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Name</label>
                <input
                  className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                  value={tenantForm.name}
                  onChange={(e) => setTenantForm((f) => ({ ...f, name: e.target.value, slug: editingTenant ? f.slug : slugify(e.target.value) }))}
                  placeholder="Acme Corp"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Slug</label>
                <input
                  className="w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
                  value={tenantForm.slug}
                  onChange={(e) => setTenantForm((f) => ({ ...f, slug: e.target.value.toLowerCase() }))}
                  placeholder="acme-corp"
                  required
                />
                <p className="mt-1 text-xs text-slate-400">Lowercase letters, numbers, and hyphens only</p>
              </div>
              {editingTenant && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Status</label>
                    <select
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                      value={tenantForm.status}
                      onChange={(e) => setTenantForm((f) => ({ ...f, status: e.target.value as TenantStatus }))}
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                      <option value="suspended">Suspended</option>
                    </select>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={tenantForm.ingestion_enabled}
                      onChange={(e) => setTenantForm((f) => ({ ...f, ingestion_enabled: e.target.checked }))}
                    />
                    Enable email submissions for this tenant
                  </label>
                  {tenantForm.ingestion_enabled && (
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Max mailboxes</label>
                      <input
                        type="number"
                        min="0"
                        placeholder="Leave blank for unlimited"
                        className="w-full rounded-lg border px-3 py-2 text-sm"
                        value={tenantForm.max_mailboxes}
                        onChange={(e) => setTenantForm((f) => ({ ...f, max_mailboxes: e.target.value }))}
                      />
                      <p className="text-xs text-slate-500 mt-1">Cap on mailboxes this tenant can connect. Blank = unlimited.</p>
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Timezone (IANA)</label>
                    <input
                      type="text"
                      placeholder="UTC"
                      className="w-full rounded-lg border px-3 py-2 text-sm"
                      value={tenantForm.timezone}
                      onChange={(e) => setTenantForm((f) => ({ ...f, timezone: e.target.value }))}
                    />
                    <p className="text-xs text-slate-500 mt-1">
                      IANA timezone name, e.g. America/New_York, Europe/London. Leave blank for UTC.
                    </p>
                  </div>
                </div>
              )}
              {tenantFormError && <p className="text-xs text-red-600">{tenantFormError}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={closeTenantModal} className="rounded-lg border px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">Cancel</button>
                <button type="submit" disabled={isTenantPending} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  {isTenantPending ? 'Saving…' : editingTenant ? 'Save Changes' : 'Create Tenant'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Add Admin Contact Modal ───────────────────────────────────────── */}
      {addAdminForTenantId != null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="text-base font-semibold text-slate-900">Add Admin Contact</h2>
              <button onClick={closeAdminModal} className="rounded p-1 hover:bg-slate-100">
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>
            <form onSubmit={handleAdminSubmit} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Full Name</label>
                <input
                  className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                  value={adminForm.full_name}
                  onChange={(e) => setAdminForm((f) => ({ ...f, full_name: e.target.value }))}
                  placeholder="Jane Smith"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Email</label>
                <input
                  type="email"
                  className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                  value={adminForm.email}
                  onChange={(e) => setAdminForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="jane@acme.com"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Username</label>
                <input
                  className="w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
                  value={adminForm.username}
                  onChange={(e) => setAdminForm((f) => ({ ...f, username: e.target.value.toLowerCase() }))}
                  placeholder="jane.smith"
                  minLength={3}
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Initial Password</label>
                <input
                  className="w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
                  value={adminForm.password}
                  onChange={(e) => setAdminForm((f) => ({ ...f, password: e.target.value }))}
                  required
                />
              </div>
              {adminFormError && <p className="text-xs text-red-600">{adminFormError}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={closeAdminModal} className="rounded-lg border px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">Cancel</button>
                <button type="submit" disabled={createUserMutation.isPending} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  {createUserMutation.isPending ? 'Adding…' : 'Add Contact'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation ───────────────────────────────────────────── */}
      {confirmDeleteUserId != null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl p-6">
            <h2 className="text-base font-semibold text-slate-900 mb-2">Remove Admin Contact?</h2>
            <p className="text-sm text-slate-500 mb-6">
              This will permanently delete <strong>{allUsers.find((u) => u.id === confirmDeleteUserId)?.full_name}</strong>. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDeleteUserId(null)} className="rounded-lg border px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">Cancel</button>
              <button
                onClick={() => { deleteUserMutation.mutate(confirmDeleteUserId); setConfirmDeleteUserId(null); }}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Admin Modal ──────────────────────────────────────────────── */}
      {editingAdmin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="text-base font-semibold text-slate-900">Edit Admin · {editingAdmin.full_name}</h2>
              <button onClick={closeEditAdmin} className="rounded p-1 hover:bg-slate-100">
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>
            <form onSubmit={handleEditAdminSubmit} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Full Name</label>
                <input
                  value={editAdminForm.full_name}
                  onChange={(e) => setEditAdminForm((f) => ({ ...f, full_name: e.target.value }))}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Email</label>
                <input
                  type="email"
                  value={editAdminForm.email}
                  onChange={(e) => setEditAdminForm((f) => ({ ...f, email: e.target.value }))}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">Username</label>
                <input
                  value={editAdminForm.username}
                  onChange={(e) => setEditAdminForm((f) => ({ ...f, username: e.target.value }))}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  minLength={3}
                  required
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={editAdminForm.is_active}
                  onChange={(e) => setEditAdminForm((f) => ({ ...f, is_active: e.target.checked }))}
                />
                Active
              </label>
              {editAdminError && <p className="text-sm text-red-600 bg-red-50 rounded px-3 py-2">{editAdminError}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={closeEditAdmin} className="rounded-lg border px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">Cancel</button>
                <button
                  type="submit"
                  disabled={updateUserMutation.isPending}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-60"
                >
                  {updateUserMutation.isPending ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Reset Admin Password Modal ───────────────────────────────────── */}
      {adminResetPassword && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="text-base font-semibold text-slate-900">Reset Password</h2>
              <button onClick={() => setAdminResetPassword(null)} className="rounded p-1 hover:bg-slate-100">
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>
            <form onSubmit={handleResetAdminPasswordSubmit} className="p-5 space-y-4">
              <p className="text-sm text-slate-500">
                Set a new password for <strong>{allUsers.find((u) => u.id === adminResetPassword.userId)?.full_name}</strong>. They will need to use this password at next login.
              </p>
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">New Password</label>
                <input
                  type="password"
                  autoFocus
                  value={adminResetPassword.value}
                  onChange={(e) => setAdminResetPassword({ ...adminResetPassword, value: e.target.value, error: '' })}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  minLength={8}
                  required
                />
              </div>
              {adminResetPassword.error && <p className="text-sm text-red-600 bg-red-50 rounded px-3 py-2">{adminResetPassword.error}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setAdminResetPassword(null)} className="rounded-lg border px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">Cancel</button>
                <button
                  type="submit"
                  disabled={resetUserPassword.isPending}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-60"
                >
                  {resetUserPassword.isPending ? 'Saving…' : 'Reset Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Issue Service Token + Revoke modals removed (B.8). Backend
          routes /tenants/{id}/service-tokens stay intact and tested
          for a future external-integration use case. */}
    </div>
  );
};
