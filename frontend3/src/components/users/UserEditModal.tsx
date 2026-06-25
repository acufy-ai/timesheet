import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Folder, Loader2, Minus, Plus, Search, Star, X } from 'lucide-react';

import { Button, Input, Modal } from '@/components/ui';
import { useCreateUser, useUpdateUser, useAddAlias, useAssignableUsers, useAllProjects, useAllTasks, useClients, useCreateClient, useUserClients, useAddUserClient, useRemoveUserClient, useDepartments, useApprovalByAssignedManager } from '@/hooks/useAdmin';
import { UserExtrasPanel } from './UserExtrasPanel';
import { cn } from '@/lib/cn';
import type { Client, CreateUserBody, FullProject, FullTask, ManagedUser, UpdateUserBody } from '@/types/admin';

// Create / edit a workspace user. One form for both: when `user` is provided we
// PUT a partial update; otherwise we POST a create. Fields mirror the backend
// UserCreate / UserUpdate schemas exactly (only styling differs from frontend2):
//   user type (internal/external), full name, email, username, role,
//   additional portals (multi-role), manager, title, department, can_review,
//   phones, project access, default client, active status.

// Roles an admin can assign. PLATFORM_ADMIN is never assignable here.
const ROLES = ['EMPLOYEE', 'MANAGER', 'VIEWER', 'ADMIN'] as const;
const ROLE_LABEL: Record<string, string> = {
  EMPLOYEE: 'Employee',
  MANAGER: 'Manager',
  VIEWER: 'Viewer',
  ADMIN: 'Admin',
};
// Additional portals a user may also act as (beyond their primary role).
const EXTRA_PORTAL_ROLES = ['MANAGER', 'VIEWER', 'ADMIN'] as const;

interface FormState {
  is_external: boolean;
  full_name: string;
  email: string;
  username: string;
  role: string;
  extraRoles: string[];
  manager_id: number | '';
  // Multi-manager (when approval_by_assigned_manager is on): all managers this
  // user reports to, and which is primary. manager_id mirrors the primary.
  manager_ids: number[];
  primary_manager_id: number | null;
  title: string;
  department: string;
  timezone: string;
  can_review: boolean;
  phones: string[];
  project_ids: number[];
  task_ids: number[];
  default_client_id: number | '';
  is_active: boolean;
}

function blankForm(): FormState {
  return {
    is_external: false,
    full_name: '',
    email: '',
    username: '',
    role: 'EMPLOYEE',
    extraRoles: [],
    manager_id: '',
    manager_ids: [],
    primary_manager_id: null,
    title: '',
    department: '',
    timezone: 'UTC',
    can_review: false,
    phones: [],
    project_ids: [],
    task_ids: [],
    default_client_id: '',
    is_active: true,
  };
}

function fromUser(u: ManagedUser): FormState {
  const all = (u.roles ?? []).map(String);
  return {
    is_external: !!u.is_external,
    full_name: u.full_name ?? '',
    email: u.email?.endsWith('@local.invalid') ? '' : (u.email ?? ''),
    username: u.username ?? '',
    role: u.role,
    extraRoles: all.filter((r) => r !== u.role && (EXTRA_PORTAL_ROLES as readonly string[]).includes(r)),
    manager_id: u.manager_id ?? '',
    manager_ids: u.manager_ids ?? (u.manager_id != null ? [u.manager_id] : []),
    primary_manager_id: u.primary_manager_id ?? u.manager_id ?? null,
    title: u.title ?? '',
    department: u.department ?? '',
    timezone: u.timezone ?? 'UTC',
    can_review: !!u.can_review,
    phones: u.phones ?? [],
    project_ids: u.project_ids ?? [],
    task_ids: u.task_ids ?? [],
    default_client_id: u.default_client_id ?? '',
    is_active: u.is_active,
  };
}

function extractError(err: unknown): string {
  const e = err as { response?: { data?: { detail?: string } }; message?: string };
  const d = e?.response?.data?.detail;
  return (typeof d === 'string' ? d : undefined) ?? e?.message ?? 'Could not save the user.';
}

export function UserEditModal({
  open,
  user,
  onClose,
  onSaved,
  restrictedToProjectAccess = false,
}: {
  open: boolean;
  user: ManagedUser | null; // null = create
  onClose: () => void;
  onSaved: (msg: string) => void;
  // Manager editing a direct report: collapse the form to the project-access
  // checklist only; save patches just project_ids (the backend allows managers
  // to patch only that field for their reports).
  restrictedToProjectAccess?: boolean;
}) {
  const isEdit = !!user;
  const [form, setForm] = useState<FormState>(blankForm);
  const [error, setError] = useState<string | null>(null);
  // Aliases collected at CREATE time (existing users edit them live in the
  // UserExtrasPanel). Posted to the new user id right after it's created.
  const [newAliases, setNewAliases] = useState<string[]>([]);
  const [aliasDraft, setAliasDraft] = useState('');
  // Extra client assignments collected at CREATE time for an external user
  // (existing users manage these live via the assignments endpoint). Posted to
  // the new user id right after it's created. Mirrors `newAliases`.
  const [newClientIds, setNewClientIds] = useState<number[]>([]);
  // True when the admin picked "Other" in the department dropdown to type a new
  // department name (distinct from a legacy free-text value already on the user).
  const [deptOtherMode, setDeptOtherMode] = useState(false);

  const create = useCreateUser();
  const update = useUpdateUser();
  const addAlias = useAddAlias();
  const addUserClient = useAddUserClient();
  const assignableQ = useAssignableUsers(open);
  const clientsQ = useClients(open);
  const departmentsQ = useDepartments(open);
  const multiManager = useApprovalByAssignedManager();

  // Reset the form whenever the modal opens or the target user changes.
  useEffect(() => {
    if (!open) return;
    setForm(user ? fromUser(user) : blankForm());
    setNewAliases([]);
    setAliasDraft('');
    setNewClientIds([]);
    setDeptOtherMode(false);
    setError(null);
  }, [open, user]);

  // Only actual managers can supervise: a user whose active role OR any of their
  // roles is MANAGER/ADMIN. (assignable users include everyone; the manager
  // picker must not list plain employees.) Excludes the user being edited.
  const managers = useMemo(() => {
    const canManage = (u: ManagedUser) => {
      const roles = [u.role, ...((u.roles ?? []) as string[])];
      return roles.some((r) => r === 'MANAGER' || r === 'ADMIN');
    };
    return (assignableQ.data ?? []).filter((u) => u.id !== user?.id && canManage(u));
  }, [assignableQ.data, user?.id]);
  const clients = clientsQ.data ?? [];
  const departments = departmentsQ.data ?? [];
  // The user's current department may be a legacy free-text value not in the
  // managed list. Treat any value that isn't a known department name as
  // "Other" so the dropdown can still represent it (with a free-text box).
  const knownDeptNames = useMemo(
    () => new Set(departments.map((d) => d.name)),
    [departments],
  );
  // Show the free-text box when the admin explicitly chose "Other", or when the
  // user already carries a legacy department name not in the managed list.
  const deptIsCustom = deptOtherMode || (!!form.department && !knownDeptNames.has(form.department));
  const isEmployee = form.role === 'EMPLOYEE';
  const saving = create.isPending || update.isPending;

  function patch(p: Partial<FormState>) {
    setForm((f) => ({ ...f, ...p }));
  }
  // Access-tree setters: select/clear a whole project (+ its tasks) or one task.
  function setProjectAccess(projectId: number, taskIds: number[], on: boolean) {
    setForm((f) => {
      const proj = new Set(f.project_ids);
      const tasks = new Set(f.task_ids);
      if (on) { proj.add(projectId); taskIds.forEach((t) => tasks.add(t)); }
      else { proj.delete(projectId); taskIds.forEach((t) => tasks.delete(t)); }
      return { ...f, project_ids: [...proj], task_ids: [...tasks] };
    });
  }
  function toggleTaskAccess(taskId: number) {
    setForm((f) => ({
      ...f,
      task_ids: f.task_ids.includes(taskId) ? f.task_ids.filter((x) => x !== taskId) : [...f.task_ids, taskId],
    }));
  }
  function toggleExtraRole(role: string) {
    setForm((f) => ({
      ...f,
      extraRoles: f.extraRoles.includes(role)
        ? f.extraRoles.filter((r) => r !== role)
        : [...f.extraRoles, role],
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Manager mode: only project access is editable; patch just project_ids.
    if (restrictedToProjectAccess && isEdit && user) {
      try {
        await update.mutateAsync({ id: user.id, data: { project_ids: form.project_ids } });
        onSaved('Project access updated.');
      } catch (err) {
        setError(extractError(err));
      }
      return;
    }
    if (!form.full_name.trim()) {
      setError('Full name is required.');
      return;
    }
    // Role-conditional required fields, mirroring the backend's create_user
    // validation: MANAGER needs title + department; EMPLOYEE needs title.
    // These apply to internal users only — external users have no role/
    // department surface.
    if (!form.is_external && (form.role === 'MANAGER' || form.role === 'EMPLOYEE')) {
      if (!form.title.trim()) {
        setError(`A title is required for ${form.role === 'MANAGER' ? 'managers' : 'employees'}.`);
        return;
      }
    }
    if (!form.is_external && form.role === 'MANAGER' && !form.department.trim()) {
      setError('A department is required for managers.');
      return;
    }
    const phones = form.phones.map((p) => p.trim()).filter(Boolean);
    // The combined roles list: primary role plus any selected extra portals.
    const roles = Array.from(new Set([form.role, ...form.extraRoles]));

    // Manager payload. External users have no manager. With multi-manager on,
    // send the full set + primary; otherwise the single manager_id (legacy).
    const managerFields: Pick<UpdateUserBody, 'manager_id' | 'manager_ids' | 'primary_manager_id'> =
      form.is_external
        ? { manager_id: null, manager_ids: [], primary_manager_id: null }
        : multiManager
          ? {
              manager_ids: form.manager_ids,
              primary_manager_id: form.primary_manager_id,
              manager_id: form.primary_manager_id, // keep legacy field in sync
            }
          : { manager_id: form.manager_id === '' ? null : Number(form.manager_id) };

    try {
      if (isEdit && user) {
        const body: UpdateUserBody = {
          full_name: form.full_name.trim(),
          email: form.email.trim() || null,
          username: form.username.trim() || null,
          role: form.role,
          roles,
          is_external: form.is_external,
          title: form.title.trim() || null,
          department: form.department.trim() || null,
          timezone: form.timezone || null,
          can_review: form.is_external ? false : form.can_review,
          ...managerFields,
          project_ids: form.is_external ? [] : form.project_ids,
          task_ids: form.is_external ? [] : form.task_ids,
          default_client_id: form.default_client_id === '' ? null : Number(form.default_client_id),
          phones,
          is_active: form.is_active,
        };
        await update.mutateAsync({ id: user.id, data: body });
        onSaved('User updated.');
      } else {
        const body: CreateUserBody = {
          full_name: form.full_name.trim(),
          is_external: form.is_external,
          email: form.email.trim() || null,
          username: form.username.trim() || null,
          role: form.role,
          is_active: form.is_active,
          title: form.title.trim() || null,
          department: form.department.trim() || null,
          timezone: form.timezone || null,
          can_review: form.is_external ? false : form.can_review,
          ...managerFields,
          project_ids: form.is_external ? [] : form.project_ids,
          task_ids: form.is_external ? [] : form.task_ids,
          default_client_id: form.default_client_id === '' ? null : Number(form.default_client_id),
          phones,
        };
        const res = await create.mutateAsync(body);
        // Attach any aliases collected in the form to the freshly-created user.
        const newId = res.user?.id;
        if (newId != null && newAliases.length) {
          for (const email of newAliases) {
            try { await addAlias.mutateAsync({ userId: newId, email }); } catch { /* skip a bad alias, don't fail the create */ }
          }
        }
        // Attach any extra client assignments staged in the form (internal or
        // external; the primary/default client is already on the create body).
        // Mirrors the alias flush: swallow a single failure, don't fail create.
        if (newId != null && newClientIds.length) {
          for (const clientId of newClientIds) {
            try { await addUserClient.mutateAsync({ userId: newId, clientId }); } catch { /* skip a bad assignment */ }
          }
        }
        const temp = res.temporary_password;
        onSaved(
          temp
            ? `User created. Temporary password: ${temp}`
            : res.verification_email_sent
              ? 'User created. An invitation email was sent.'
              : 'User created.',
        );
      }
      onClose();
    } catch (err) {
      setError(extractError(err));
    }
  }

  const labelClass = 'mb-1 block text-xs font-medium text-muted-foreground';
  const selectClass =
    'h-9 w-full rounded-full border border-border bg-transparent px-4 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={restrictedToProjectAccess
        ? `Edit access · ${user?.full_name}`
        : `${isEdit ? 'Edit' : 'Add'} ${form.is_external ? 'external' : 'internal'} user`}
      className="max-w-3xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {restrictedToProjectAccess ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-primary/20 bg-primary/[0.04] px-3 py-2.5 text-xs text-muted-foreground">
              You can update this team member's project access. Other profile fields are managed by an admin.
            </div>
            <div>
              <span className={labelClass}>Project &amp; task access</span>
              <ProjectTaskAccessTree
                projectIds={form.project_ids}
                taskIds={form.task_ids}
                onToggleProject={setProjectAccess}
                onToggleTask={toggleTaskAccess}
              />
            </div>
            {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={update.isPending}>
                {update.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save access
              </Button>
            </div>
          </div>
        ) : (
        <>
        <div className="space-y-4">
          {/* Top row: User type (left) + Active toggle (right) */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-foreground">User type</span>
              <div className="inline-flex rounded-full bg-muted p-0.5">
                {([['internal', 'Internal'], ['external', 'External']] as const).map(([val, label]) => {
                  const checked = (val === 'external') === form.is_external;
                  return (
                    <button key={val} type="button" onClick={() => patch({ is_external: val === 'external' })}
                      className={cn('rounded-full px-3.5 py-1.5 text-xs font-semibold transition', checked ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground')}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={form.is_active} onChange={(e) => patch({ is_active: e.target.checked })} className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]" />
              Active (can sign in)
            </label>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:items-start">
          {/* ── Section: Identity ── */}
          <FormSection title="Identity">
            <div>
              <label className={labelClass}>Full name *</label>
              <Input value={form.full_name} onChange={(e) => patch({ full_name: e.target.value })} placeholder="Jane Smith" required />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={labelClass}>Email</label>
                <Input type="email" value={form.email} onChange={(e) => patch({ email: e.target.value })} placeholder="jane@example.com" />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Phone</span>
                  <button type="button"
                    onClick={() => patch({ phones: [...(form.phones.length === 0 ? [''] : form.phones), ''] })}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
                    <Plus className="h-3 w-3" /> Add phone
                  </button>
                </div>
                {/* Always render phones as rows. Empty state = one row. Each row
                    after the first (or any row when there's more than one) gets a
                    remove button; a single empty row has nothing to remove. */}
                <div className="space-y-1.5">
                  {(form.phones.length === 0 ? [''] : form.phones).map((p, idx) => {
                    const rows = form.phones.length === 0 ? [''] : form.phones;
                    const showRemove = rows.length > 1;
                    return (
                      <div key={idx} className="flex items-center gap-2">
                        <Input
                          value={p}
                          onChange={(e) => {
                            const next = [...rows];
                            next[idx] = e.target.value;
                            patch({ phones: next });
                          }}
                          placeholder="+1 555 123 4567"
                        />
                        {showRemove ? (
                          <button type="button" aria-label="Remove phone" onClick={() => patch({ phones: rows.filter((_, i) => i !== idx) })}
                            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500">
                            <X className="h-4 w-4" />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={labelClass}>Username</label>
                <Input value={form.username} onChange={(e) => patch({ username: e.target.value })} placeholder="jsmith" />
              </div>
              <div>
                <label className={labelClass}>Title{!form.is_external && (form.role === 'EMPLOYEE' || form.role === 'MANAGER') ? ' *' : ''}</label>
                <Input value={form.title} onChange={(e) => patch({ title: e.target.value })} placeholder="Senior Consultant" />
              </div>
            </div>
            {/* Additional emails (aliases). Existing users edit them live via the
                email-aliases endpoint; new users collect them here and they're
                posted right after the user is created. */}
            {isEdit && user ? (
              <UserExtrasPanel userId={user.id} hideClients />
            ) : (
              <div>
                <label className={labelClass}>Additional emails (aliases)</label>
                <div className="flex gap-2">
                  <Input
                    value={aliasDraft}
                    onChange={(e) => setAliasDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const v = aliasDraft.trim().toLowerCase();
                        if (v && !newAliases.includes(v)) setNewAliases((s) => [...s, v]);
                        setAliasDraft('');
                      }
                    }}
                    placeholder="alias@example.com"
                  />
                  <Button type="button" variant="secondary" size="sm" onClick={() => {
                    const v = aliasDraft.trim().toLowerCase();
                    if (v && !newAliases.includes(v)) setNewAliases((s) => [...s, v]);
                    setAliasDraft('');
                  }}>Add</Button>
                </div>
                {newAliases.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {newAliases.map((a) => (
                      <span key={a} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-[12px]">
                        {a}
                        <button type="button" onClick={() => setNewAliases((s) => s.filter((x) => x !== a))}
                          className="text-muted-foreground hover:text-foreground">×</button>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </FormSection>

          {/* ── Section: Organization & access ── */}
          <FormSection title="Organization & access">
            {!form.is_external ? (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className={labelClass}>Role</label>
                    <select value={form.role} onChange={(e) => patch({ role: e.target.value })} className={selectClass}>
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>Manager{multiManager ? 's' : ''}</label>
                    {multiManager ? (
                      <ManagerMultiSelect
                        managers={managers}
                        selected={form.manager_ids}
                        primary={form.primary_manager_id}
                        onChange={(ids, primary) => patch({ manager_ids: ids, primary_manager_id: primary })}
                      />
                    ) : (
                      <select value={form.manager_id} onChange={(e) => patch({ manager_id: e.target.value ? Number(e.target.value) : '' })} className={selectClass}>
                        <option value="">No manager</option>
                        {managers.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
                      </select>
                    )}
                  </div>
                  <div>
                    <label className={labelClass}>Department{form.role === 'MANAGER' ? ' *' : ''}</label>
                    {/* Bound to the managed Department list (Workforce Setup).
                        "Other" keeps a free-text escape hatch so admins can still
                        enter a new/legacy department without pre-creating it. */}
                    <select
                      value={deptIsCustom ? '__other__' : form.department}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === '__other__') {
                          setDeptOtherMode(true);
                          patch({ department: '' });
                        } else {
                          setDeptOtherMode(false);
                          patch({ department: v });
                        }
                      }}
                      className={selectClass}
                    >
                      <option value="">No department</option>
                      {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                      <option value="__other__">Other (type a new one)…</option>
                    </select>
                    {deptIsCustom ? (
                      <Input
                        className="mt-2"
                        value={form.department}
                        onChange={(e) => patch({ department: e.target.value })}
                        placeholder="New department name"
                      />
                    ) : null}
                  </div>
                  <div>
                    <label className={labelClass}>Default client</label>
                    <select value={form.default_client_id} onChange={(e) => patch({ default_client_id: e.target.value ? Number(e.target.value) : '' })} className={selectClass}>
                      <option value="">None</option>
                      {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                </div>
                {/* Additional portals + Email Review pill (folds in can_review) */}
                <div>
                  <span className={labelClass}>Additional portals</span>
                  <div className="flex flex-wrap gap-1.5">
                    {EXTRA_PORTAL_ROLES.filter((r) => r !== form.role).map((r) => {
                      const on = form.extraRoles.includes(r);
                      return (
                        <button key={r} type="button" onClick={() => toggleExtraRole(r)}
                          className={cn('rounded-full border px-3 py-1 text-xs font-semibold transition', on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/40')}>
                          {ROLE_LABEL[r]}
                        </button>
                      );
                    })}
                    <button type="button" onClick={() => patch({ can_review: !form.can_review })}
                      className={cn('rounded-full border px-3 py-1 text-xs font-semibold transition', form.can_review ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/40')}>
                      Email Review
                    </button>
                  </div>
                </div>
                {isEmployee ? (
                  <div>
                    <span className={labelClass}>Project &amp; task access</span>
                    <ProjectTaskAccessTree projectIds={form.project_ids} taskIds={form.task_ids} onToggleProject={setProjectAccess} onToggleTask={toggleTaskAccess} />
                  </div>
                ) : null}
                {/* Internal users can also work across multiple clients. Primary
                    is the Default client above; additional ones are managed here
                    (staged on create, live on edit). */}
                <OtherClientsField
                  clients={clients}
                  userId={isEdit && user ? user.id : null}
                  excludeClientId={form.default_client_id}
                  stagedClientIds={newClientIds}
                  onStageClient={(id) => setNewClientIds((s) => (s.includes(id) ? s : [...s, id]))}
                  onUnstageClient={(id) => setNewClientIds((s) => s.filter((x) => x !== id))}
                />
              </>
            ) : (
              <>
                <div>
                  <label className={labelClass}>Title</label>
                  <Input value={form.title} onChange={(e) => patch({ title: e.target.value })} placeholder="Contractor" />
                </div>
                <ExternalClientFields
                  defaultClientId={form.default_client_id}
                  onSetDefault={(id) => patch({ default_client_id: id })}
                  clients={clients}
                  userId={isEdit && user ? user.id : null}
                  stagedClientIds={newClientIds}
                  onStageClient={(id) => setNewClientIds((s) => (s.includes(id) ? s : [...s, id]))}
                  onUnstageClient={(id) => setNewClientIds((s) => s.filter((x) => x !== id))}
                />
              </>
            )}
          </FormSection>
          </div>

          {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</>) : isEdit ? 'Save changes' : 'Create user'}
          </Button>
        </div>
        </>
        )}
      </form>
    </Modal>
  );
}

// External users are contractors tied to clients. This block (shown only for
// external users) mirrors frontend2: a Primary client select with inline
// "+ Add client" create, plus an "Other clients" multi-assignment list for
// existing users (new users get assignments after they're saved).
function ExternalClientFields({
  defaultClientId,
  onSetDefault,
  clients,
  userId,
  stagedClientIds,
  onStageClient,
  onUnstageClient,
}: {
  defaultClientId: number | '';
  onSetDefault: (id: number | '') => void;
  clients: Client[];
  userId: number | null;
  // Create-mode staging: when there's no userId yet, extra client assignments
  // are collected here and flushed by the parent after the user is created.
  stagedClientIds: number[];
  onStageClient: (id: number) => void;
  onUnstageClient: (id: number) => void;
}) {
  const createClient = useCreateClient();

  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');

  async function createAndPin() {
    const name = newName.trim();
    if (!name) return;
    const c = await createClient.mutateAsync({ name, client_type: 'external' });
    onSetDefault(c.id);
    setShowNew(false);
    setNewName('');
  }

  return (
    <div className="space-y-3">
      {/* Primary client */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="block text-xs font-medium text-muted-foreground">Primary client</label>
          <button type="button" onClick={() => { setShowNew((v) => !v); setNewName(''); }} className="text-xs text-primary hover:underline">
            {showNew ? 'Cancel' : '+ Add client'}
          </button>
        </div>
        {showNew ? (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Client name"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void createAndPin(); } }}
            />
            <Button type="button" variant="secondary" size="sm" onClick={() => void createAndPin()} disabled={!newName.trim() || createClient.isPending}>
              {createClient.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Add'}
            </Button>
          </div>
        ) : (
          <select
            value={defaultClientId}
            onChange={(e) => onSetDefault(e.target.value ? Number(e.target.value) : '')}
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            <option value="">No default</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">The client this person works with most often; used by default for their timesheets.</p>
      </div>

      <OtherClientsField
        clients={clients}
        userId={userId}
        excludeClientId={defaultClientId}
        stagedClientIds={stagedClientIds}
        onStageClient={onStageClient}
        onUnstageClient={onUnstageClient}
      />
    </div>
  );
}

// The "Other clients" multi-assignment list. Works for internal AND external
// users (anyone can work across multiple clients). For an existing user the
// rows are LIVE assignments (added/removed immediately); for a new user (no id
// yet) they're STAGED and flushed by the parent after the user is created.
function OtherClientsField({
  clients,
  userId,
  excludeClientId,
  stagedClientIds,
  onStageClient,
  onUnstageClient,
}: {
  clients: Client[];
  userId: number | null;
  excludeClientId: number | '';
  stagedClientIds: number[];
  onStageClient: (id: number) => void;
  onUnstageClient: (id: number) => void;
}) {
  const assignmentsQ = useUserClients(userId);
  const addClient = useAddUserClient();
  const removeClient = useRemoveUserClient();
  const assigned = assignmentsQ.data ?? [];
  const assignedIds = new Set(assigned.map((a) => a.client_id));

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">Other clients</label>
      <div className="mb-2 flex flex-wrap gap-2">
        {userId != null ? (
          assigned.length === 0 ? (
            <p className="text-[11px] italic text-muted-foreground">No clients added yet.</p>
          ) : (
            assigned.map((a) => (
              <span key={a.client_id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs">
                <span className="font-medium text-foreground">{a.client_name}</span>
                {a.client_type === 'internal' ? <span className="text-[9px] font-semibold uppercase text-blue-600 dark:text-blue-400">Internal</span> : null}
                <button type="button" aria-label={`Remove ${a.client_name}`} onClick={() => removeClient.mutate({ userId, clientId: a.client_id })} className="text-muted-foreground hover:text-rose-500"><X className="h-3 w-3" /></button>
              </span>
            ))
          )
        ) : (
          stagedClientIds.length === 0 ? (
            <p className="text-[11px] italic text-muted-foreground">No clients added yet.</p>
          ) : (
            stagedClientIds.map((id) => {
              const c = clients.find((x) => x.id === id);
              return (
                <span key={id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs">
                  <span className="font-medium text-foreground">{c?.name ?? `Client #${id}`}</span>
                  {c?.client_type === 'internal' ? <span className="text-[9px] font-semibold uppercase text-blue-600 dark:text-blue-400">Internal</span> : null}
                  <button type="button" aria-label={`Remove ${c?.name ?? id}`} onClick={() => onUnstageClient(id)} className="text-muted-foreground hover:text-rose-500"><X className="h-3 w-3" /></button>
                </span>
              );
            })
          )
        )}
      </div>
      <select
        value=""
        onChange={(e) => {
          const id = Number(e.target.value);
          if (!id) return;
          if (userId != null) addClient.mutate({ userId, clientId: id });
          else onStageClient(id);
        }}
        className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
      >
        <option value="">+ Add another client</option>
        {clients
          .filter((c) => c.id !== excludeClientId)
          .filter((c) => (userId != null ? !assignedIds.has(c.id) : !stagedClientIds.includes(c.id)))
          .map((c) => (
            <option key={c.id} value={c.id}>{c.name}{c.client_type === 'internal' ? ' (Internal)' : ''}</option>
          ))}
      </select>
    </div>
  );
}

// Multi-manager picker: select the managers a user reports to and star one as
// primary. Shown only when approval_by_assigned_manager is on. Adding the first
// manager makes them primary; removing the primary promotes another.
function ManagerMultiSelect({
  managers,
  selected,
  primary,
  onChange,
}: {
  managers: ManagedUser[];
  selected: number[];
  primary: number | null;
  onChange: (ids: number[], primary: number | null) => void;
}) {
  const nameById = useMemo(() => {
    const m = new Map<number, string>();
    managers.forEach((u) => m.set(u.id, u.full_name));
    return m;
  }, [managers]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [q, setQ] = useState('');
  const boxRef = useRef<HTMLDivElement | null>(null);

  const available = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return managers
      .filter((m) => !selected.includes(m.id))
      .filter((m) => !ql || m.full_name.toLowerCase().includes(ql));
  }, [managers, selected, q]);

  // Close the popover on an outside click.
  useEffect(() => {
    if (!pickerOpen) return;
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [pickerOpen]);

  function add(id: number) {
    const ids = [...selected, id];
    onChange(ids, primary ?? id); // first one becomes primary
    setQ('');
    setPickerOpen(false);
  }
  function remove(id: number) {
    const ids = selected.filter((x) => x !== id);
    const nextPrimary = primary === id ? (ids[0] ?? null) : primary;
    onChange(ids, nextPrimary);
  }

  return (
    <div className="space-y-2">
      {/* Picker button FIRST so its top aligns with the Role select beside it.
          Custom contained popover (not a native <select>, which overflowed the
          modal with a long manager list). Capped height + internal scroll. */}
      <div className="relative" ref={boxRef}>
        {/* Mimic the native <select> exactly: same h-9/rounded-full/px-4/border,
            value in foreground tone, chevron at the same right inset and color. */}
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="relative h-9 w-full rounded-full border border-border bg-transparent pl-4 pr-9 text-left text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <span className="block truncate">+ Add a manager</span>
          <ChevronDown className={cn('pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/70 transition-transform', pickerOpen && 'rotate-180')} />
        </button>
        {pickerOpen ? (
          <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-border bg-card shadow-lg">
            <div className="flex items-center gap-2 border-b border-border px-3" style={{ height: 38 }}>
              <Search className="h-[15px] w-[15px] text-muted-foreground" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search managers…"
                className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="max-h-56 overflow-y-auto py-1">
              {available.length === 0 ? (
                <div className="px-3 py-3 text-center text-[12.5px] text-muted-foreground">
                  {managers.length === 0 ? 'No managers available.' : 'No matches.'}
                </div>
              ) : (
                available.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => add(m.id)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] hover:bg-primary/[0.06]"
                  >
                    <span className="font-medium text-foreground">{m.full_name}</span>
                    <span className="text-[11px] text-muted-foreground">{m.role}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : null}
      </div>

      {/* Selected managers (chips) below the picker. */}
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((id) => {
            const isPrimary = primary === id;
            return (
              <span key={id} className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs',
                isPrimary ? 'bg-primary/10 text-primary' : 'bg-muted')}>
                <button type="button" title={isPrimary ? 'Primary manager' : 'Make primary'}
                  onClick={() => onChange(selected, id)}
                  className={cn('grid place-items-center', isPrimary ? 'text-primary' : 'text-muted-foreground hover:text-primary')}>
                  <Star className={cn('h-3.5 w-3.5', isPrimary && 'fill-current')} />
                </button>
                <span className="font-medium text-foreground">{nameById.get(id) ?? `#${id}`}</span>
                <button type="button" aria-label={`Remove ${nameById.get(id) ?? id}`} onClick={() => remove(id)}
                  className="text-muted-foreground hover:text-rose-500"><X className="h-3 w-3" /></button>
              </span>
            );
          })}
        </div>
      ) : null}

      {selected.length > 1 ? (
        <p className="text-[11px] text-muted-foreground">The starred manager is primary. Time entries can be submitted to any of these managers for approval.</p>
      ) : null}
    </div>
  );
}

// Collapsible titled section card for the user form (icon + chevron header).
function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-primary/[0.03]">
        <span className="text-[15px] font-bold text-foreground">{title}</span>
        <ChevronRight className={cn('ml-auto h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </button>
      {open ? <div className="flex flex-col gap-4 border-t border-border px-4 py-4">{children}</div> : null}
    </div>
  );
}

// Cascading client → project → task access picker. Checking a project grants it
// (and all its tasks); checking a task grants just that task and shows its
// project as partial. Searchable; rows expand/collapse on click.
function ProjectTaskAccessTree({
  projectIds, taskIds, onToggleProject, onToggleTask,
}: {
  projectIds: number[];
  taskIds: number[];
  onToggleProject: (projectId: number, taskIds: number[], on: boolean) => void;
  onToggleTask: (taskId: number) => void;
}) {
  const projectsQ = useAllProjects();
  const tasksQ = useAllTasks();
  const clientsQ = useClients();
  const [q, setQ] = useState('');
  const [openC, setOpenC] = useState<Record<number, boolean>>({});
  const [openP, setOpenP] = useState<Record<number, boolean>>({});

  const allProjects = (projectsQ.data ?? []) as unknown as FullProject[];
  const allTasks = (tasksQ.data ?? []) as unknown as FullTask[];
  const pSet = new Set(projectIds);
  const tSet = new Set(taskIds);

  const tasksByProject = useMemo(() => {
    const m = new Map<number, FullTask[]>();
    allTasks.forEach((t) => { if (!m.has(t.project_id)) m.set(t.project_id, []); m.get(t.project_id)!.push(t); });
    return m;
  }, [allTasks]);
  const clientName = useMemo(() => {
    const m = new Map<number, string>();
    (clientsQ.data ?? []).forEach((c) => m.set(c.id, c.name));
    return m;
  }, [clientsQ.data]);

  const ql = q.trim().toLowerCase();
  const byClient = useMemo(() => {
    const m = new Map<number, FullProject[]>();
    allProjects.forEach((p) => {
      const tasks = tasksByProject.get(p.id) ?? [];
      const match = !ql || p.name.toLowerCase().includes(ql)
        || (clientName.get(p.client_id) ?? '').toLowerCase().includes(ql)
        || tasks.some((t) => t.name.toLowerCase().includes(ql));
      if (!match) return;
      if (!m.has(p.client_id)) m.set(p.client_id, []);
      m.get(p.client_id)!.push(p);
    });
    return m;
  }, [allProjects, tasksByProject, clientName, ql]);

  const projState = (p: FullProject): 'on' | 'partial' | 'off' => {
    const tasks = tasksByProject.get(p.id) ?? [];
    if (pSet.has(p.id)) return 'on';
    const sel = tasks.filter((t) => tSet.has(t.id)).length;
    if (tasks.length && sel === tasks.length) return 'on';
    return sel > 0 ? 'partial' : 'off';
  };
  const Box = ({ state }: { state: 'on' | 'partial' | 'off' }) => (
    <span className={cn('grid h-[18px] w-[18px] shrink-0 place-items-center rounded border',
      state === 'on' ? 'border-primary bg-primary text-white'
        : state === 'partial' ? 'border-primary bg-primary/20 text-primary' : 'border-border text-transparent')}>
      {state === 'partial' ? <Minus className="h-3 w-3" /> : <Check className="h-3 w-3" />}
    </span>
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-border bg-card px-3" style={{ height: 40 }}>
        <Search className="h-[15px] w-[15px] text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client, project, or task..."
          className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground" />
      </div>
      <div className="max-h-[260px] overflow-y-auto py-1">
        {byClient.size === 0 ? (
          <div className="px-3 py-3 text-center text-[12.5px] text-muted-foreground">No matches.</div>
        ) : [...byClient.entries()].map(([cid, projs]) => {
          // Clients start COLLAPSED (a search query force-expands to reveal hits).
          const cOpen = (openC[cid] ?? false) || !!ql;
          return (
            <div key={cid}>
              <div className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-primary/5" onClick={() => setOpenC((s) => ({ ...s, [cid]: !(s[cid] ?? false) }))}>
                <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform', cOpen && 'rotate-90')} />
                <span className="text-[11.5px] font-bold uppercase tracking-wide text-primary">{clientName.get(cid) ?? `Client #${cid}`}</span>
                <span className="ml-auto text-[11px] text-muted-foreground">{projs.length} {projs.length === 1 ? 'project' : 'projects'}</span>
              </div>
              {cOpen ? projs.map((p) => {
                const tasks = tasksByProject.get(p.id) ?? [];
                const pOpen = (openP[p.id] ?? false) || !!ql;
                const st = projState(p);
                return (
                  <div key={p.id}>
                    <div className="flex items-center gap-2 py-1.5 pl-7 pr-3">
                      <span onClick={(e) => { e.stopPropagation(); onToggleProject(p.id, tasks.map((t) => t.id), st !== 'on'); }} className="cursor-pointer"><Box state={st} /></span>
                      <button type="button" onClick={() => setOpenP((s) => ({ ...s, [p.id]: !(s[p.id] ?? false) }))} className="flex flex-1 items-center gap-2 text-left">
                        <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', pOpen && 'rotate-90')} />
                        <Folder className="h-3.5 w-3.5 text-primary" />
                        <span className="text-[13px] font-medium">{p.name}</span>
                        <span className="ml-auto text-[11px] text-muted-foreground">{tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}</span>
                      </button>
                    </div>
                    {pOpen ? tasks.map((t) => (
                      <label key={t.id} className="flex cursor-pointer items-center gap-2 py-1.5 pl-[68px] pr-3 hover:bg-primary/5">
                        <span onClick={(e) => { e.preventDefault(); onToggleTask(t.id); }}><Box state={tSet.has(t.id) || pSet.has(p.id) ? 'on' : 'off'} /></span>
                        <span className="text-[12.5px]">{t.name}</span>
                      </label>
                    )) : null}
                  </div>
                );
              }) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
