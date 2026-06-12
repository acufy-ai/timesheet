import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';

import { Button, Input, Modal } from '@/components/ui';
import { useCreateUser, useUpdateUser, useAssignableUsers, useAdminProjects, useClients, useCreateClient, useUserClients, useAddUserClient, useRemoveUserClient } from '@/hooks/useAdmin';
import { UserExtrasPanel } from './UserExtrasPanel';
import type { Client, CreateUserBody, ManagedUser, UpdateUserBody } from '@/types/admin';

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
  title: string;
  department: string;
  timezone: string;
  can_review: boolean;
  phones: string[];
  project_ids: number[];
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
    title: '',
    department: '',
    timezone: 'UTC',
    can_review: false,
    phones: [],
    project_ids: [],
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
    title: u.title ?? '',
    department: u.department ?? '',
    timezone: u.timezone ?? 'UTC',
    can_review: !!u.can_review,
    phones: u.phones ?? [],
    project_ids: u.project_ids ?? [],
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

  const create = useCreateUser();
  const update = useUpdateUser();
  const assignableQ = useAssignableUsers(open);
  const projectsQ = useAdminProjects(open);
  const clientsQ = useClients(open);

  // Reset the form whenever the modal opens or the target user changes.
  useEffect(() => {
    if (!open) return;
    setForm(user ? fromUser(user) : blankForm());
    setError(null);
  }, [open, user]);

  const managers = useMemo(
    () => (assignableQ.data ?? []).filter((u) => u.id !== user?.id),
    [assignableQ.data, user?.id],
  );
  const projects = projectsQ.data ?? [];
  const clients = clientsQ.data ?? [];
  const isEmployee = form.role === 'EMPLOYEE';
  const saving = create.isPending || update.isPending;

  function patch(p: Partial<FormState>) {
    setForm((f) => ({ ...f, ...p }));
  }
  function toggleProject(id: number) {
    setForm((f) => ({
      ...f,
      project_ids: f.project_ids.includes(id)
        ? f.project_ids.filter((x) => x !== id)
        : [...f.project_ids, id],
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
          manager_id: form.is_external ? null : (form.manager_id === '' ? null : Number(form.manager_id)),
          project_ids: form.is_external ? [] : form.project_ids,
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
          manager_id: form.is_external ? null : (form.manager_id === '' ? null : Number(form.manager_id)),
          project_ids: form.is_external ? [] : form.project_ids,
          default_client_id: form.default_client_id === '' ? null : Number(form.default_client_id),
          phones,
        };
        const res = await create.mutateAsync(body);
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
      title={isEdit ? `Edit user · ${user?.full_name}` : 'New user'}
      className="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {restrictedToProjectAccess ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-primary/20 bg-primary/[0.04] px-3 py-2.5 text-xs text-muted-foreground">
              You can update this team member's project access. Other profile fields are managed by an admin.
            </div>
            <div>
              <span className={labelClass}>Project access</span>
              <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-border bg-muted/10 p-3">
                {projects.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No active projects.</p>
                ) : (
                  projects.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.project_ids.includes(p.id)}
                        onChange={() => toggleProject(p.id)}
                        className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]"
                      />
                      <span className="text-foreground">{p.name}</span>
                    </label>
                  ))
                )}
              </div>
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
        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          {/* User type */}
          <div>
            <span className={labelClass}>User type</span>
            <div className="grid grid-cols-2 gap-2">
              {([
                ['internal', 'Internal', 'Can sign in'],
                ['external', 'External', 'No login; hours entered for them'],
              ] as const).map(([val, label, hint]) => {
                const checked = (val === 'external') === form.is_external;
                return (
                  <button
                    key={val}
                    type="button"
                    onClick={() => patch({ is_external: val === 'external' })}
                    aria-pressed={checked}
                    className={
                      'rounded-xl border px-3 py-2 text-left text-sm transition ' +
                      (checked
                        ? 'border-primary bg-primary/10 ring-1 ring-primary/40'
                        : 'border-border hover:bg-muted/40')
                    }
                  >
                    <span className="block font-semibold text-foreground">{label}</span>
                    <span className="block text-[11px] text-muted-foreground">{hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Full name */}
          <div>
            <label className={labelClass}>Full name *</label>
            <Input value={form.full_name} onChange={(e) => patch({ full_name: e.target.value })} placeholder="Jane Smith" required />
          </div>

          {/* Email + username */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Email</label>
              <Input type="email" value={form.email} onChange={(e) => patch({ email: e.target.value })} placeholder="jane@example.com" />
            </div>
            <div>
              <label className={labelClass}>Username</label>
              <Input value={form.username} onChange={(e) => patch({ username: e.target.value })} placeholder="jsmith" />
            </div>
          </div>

          {/* Role + manager (internal only — external users have no login,
              role, or manager; they're contractors tied to a client). */}
          {!form.is_external ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Role</label>
              <select value={form.role} onChange={(e) => patch({ role: e.target.value })} className={selectClass}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Manager</label>
              <select
                value={form.manager_id}
                onChange={(e) => patch({ manager_id: e.target.value ? Number(e.target.value) : '' })}
                className={selectClass}
              >
                <option value="">No manager</option>
                {managers.map((m) => (
                  <option key={m.id} value={m.id}>{m.full_name}</option>
                ))}
              </select>
            </div>
          </div>
          ) : null}

          {/* Additional portals (multi-role) — internal only */}
          {!form.is_external ? (
          <div>
            <span className={labelClass}>Additional portals (optional)</span>
            <div className="flex flex-wrap gap-1.5">
              {EXTRA_PORTAL_ROLES.filter((r) => r !== form.role).map((r) => {
                const on = form.extraRoles.includes(r);
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => toggleExtraRole(r)}
                    className={
                      'rounded-full border px-3 py-1 text-xs font-medium transition ' +
                      (on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/40')
                    }
                  >
                    {ROLE_LABEL[r]}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Lets this person switch into other role portals with one login.
            </p>
          </div>
          ) : null}

          {/* Title (shared) + Department (internal only). Title required for
              EMPLOYEE/MANAGER; department required for MANAGER. */}
          <div className={form.is_external ? '' : 'grid grid-cols-1 gap-3 sm:grid-cols-2'}>
            <div>
              <label className={labelClass}>
                Title{!form.is_external && (form.role === 'EMPLOYEE' || form.role === 'MANAGER') ? ' *' : ''}
              </label>
              <Input value={form.title} onChange={(e) => patch({ title: e.target.value })} placeholder="Senior Consultant" />
            </div>
            {!form.is_external ? (
              <div>
                <label className={labelClass}>
                  Department{form.role === 'MANAGER' ? ' *' : ''}
                </label>
                <Input value={form.department} onChange={(e) => patch({ department: e.target.value })} placeholder="Engineering" />
              </div>
            ) : null}
          </div>

          {/* External: primary client (+ inline add) + linked clients. */}
          {form.is_external ? (
            <ExternalClientFields
              defaultClientId={form.default_client_id}
              onSetDefault={(id) => patch({ default_client_id: id })}
              clients={clients}
              userId={isEdit && user ? user.id : null}
            />
          ) : null}

          {/* Reviewer access. Shown for any INTERNAL user (matches frontend2);
              the backend require_can_review only excludes ADMIN, so an
              employee/manager/viewer can all be granted it. External users have
              no login, so the option is hidden for them. */}
          {!form.is_external ? (
            <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={form.can_review}
                onChange={(e) => patch({ can_review: e.target.checked })}
                className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]"
              />
              Reviewer access
            </label>
          ) : null}

          {/* Phones */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Phone numbers</span>
              <button
                type="button"
                onClick={() => patch({ phones: [...form.phones, ''] })}
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
            {form.phones.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">None.</p>
            ) : (
              <div className="space-y-1.5">
                {form.phones.map((p, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Input
                      value={p}
                      onChange={(e) => {
                        const next = [...form.phones];
                        next[idx] = e.target.value;
                        patch({ phones: next });
                      }}
                      placeholder="+1 555 123 4567"
                    />
                    <button
                      type="button"
                      aria-label="Remove phone"
                      onClick={() => patch({ phones: form.phones.filter((_, i) => i !== idx) })}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Default client — internal only (external uses ExternalClientFields above). */}
          {!form.is_external ? (
          <div>
            <label className={labelClass}>Default client</label>
            <select
              value={form.default_client_id}
              onChange={(e) => patch({ default_client_id: e.target.value ? Number(e.target.value) : '' })}
              className={selectClass}
            >
              <option value="">None</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          ) : null}

          {/* Project access (internal employees only) */}
          {!form.is_external && isEmployee ? (
            <div>
              <span className={labelClass}>Project access</span>
              <div className="max-h-44 space-y-2 overflow-y-auto rounded-xl border border-border bg-muted/10 p-3">
                {projects.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No active projects.</p>
                ) : (
                  projects.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.project_ids.includes(p.id)}
                        onChange={() => toggleProject(p.id)}
                        className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]"
                      />
                      <span className="text-foreground">{p.name}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
          ) : null}

          {/* Active */}
          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => patch({ is_active: e.target.checked })}
              className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]"
            />
            Active (can sign in)
          </label>

          {/* Aliases + client assignments — only for an existing user. */}
          {isEdit && user ? <UserExtrasPanel userId={user.id} hideClients={form.is_external} /> : null}

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
}: {
  defaultClientId: number | '';
  onSetDefault: (id: number | '') => void;
  clients: Client[];
  userId: number | null;
}) {
  const createClient = useCreateClient();
  const assignmentsQ = useUserClients(userId);
  const addClient = useAddUserClient();
  const removeClient = useRemoveUserClient();

  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');

  const assigned = assignmentsQ.data ?? [];
  const assignedIds = new Set(assigned.map((a) => a.client_id));

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

      {/* Other clients (existing users only) */}
      {userId != null ? (
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Other clients</label>
          <div className="mb-2 flex flex-wrap gap-2">
            {assigned.length === 0 ? (
              <p className="text-[11px] italic text-muted-foreground">No clients added yet.</p>
            ) : (
              assigned.map((a) => (
                <span key={a.client_id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs">
                  <span className="font-medium text-foreground">{a.client_name}</span>
                  {a.client_type === 'internal' ? <span className="text-[9px] font-semibold uppercase text-blue-600 dark:text-blue-400">Internal</span> : null}
                  <button type="button" aria-label={`Remove ${a.client_name}`} onClick={() => removeClient.mutate({ userId, clientId: a.client_id })} className="text-muted-foreground hover:text-rose-500"><X className="h-3 w-3" /></button>
                </span>
              ))
            )}
          </div>
          <select
            value=""
            onChange={(e) => { const id = Number(e.target.value); if (id) addClient.mutate({ userId, clientId: id }); }}
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">+ Add another client</option>
            {clients.filter((c) => c.id !== defaultClientId && !assignedIds.has(c.id)).map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.client_type === 'internal' ? ' (Internal)' : ''}</option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}
