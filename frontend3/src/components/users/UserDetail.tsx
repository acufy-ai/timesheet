import { useEffect, useMemo, useState } from 'react';
import {
  AtSign, Briefcase, Check, Globe, IdCard, Mail,
  Pencil, ShieldCheck, User as UserIcon,
} from 'lucide-react';

import { Button, Card, FieldError, RequiredMark, RoleBadge, TonePill, errorBorder } from '@/components/ui';
import { useDepartments, useAssignableUsers, useUpdateUser, useAllProjects, useAllTasks, useUserClients } from '@/hooks/useAdmin';
import type { FullProject, FullTask } from '@/types/admin';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import type { ManagedUser } from '@/types/admin';
import { UserActionMenu } from './UserActionMenu';
import { UserClientAccessTab } from './UserClientAccessTab';
import { ReportingTree } from './ReportingTree';

const ROLE_LABEL: Record<string, string> = {
  EMPLOYEE: 'Employee', MANAGER: 'Manager', VIEWER: 'Viewer', ADMIN: 'Admin', PLATFORM_ADMIN: 'Platform Admin',
};

type DetailTab = 'details' | 'clients';

type Props = {
  user: ManagedUser;
  isAdmin: boolean;
  nameById: Map<number, string>;
  clientNameById: Map<number, string>;
  onEdit: (u: ManagedUser) => void;
  onResetPassword: (u: ManagedUser) => void;
  onSendInvite: (u: ManagedUser) => void;
  onToggleActive: (u: ManagedUser) => void;
  onDelete: (u: ManagedUser) => void;
  onUnlock: (u: ManagedUser) => void;
  onViewTimesheets: (u: ManagedUser) => void;
  onFlash: (tone: 'ok' | 'err', text: string) => void;
  // Jump the detail pane to another user (used by the reporting tree to walk
  // up/down the chain). Optional so other callers don't have to wire it.
  onSelectUser?: (id: number) => void;
};

export function UserDetail(props: Props) {
  const { user, isAdmin, clientNameById } = props;
  const [tab, setTab] = useState<DetailTab>('details');
  const [editCard, setEditCard] = useState<null | 'identity' | 'access'>(null);

  // Reset tab + edit state when the selected user changes.
  useEffect(() => { setTab('details'); setEditCard(null); }, [user.id]);

  // Distinct count of clients the user is assigned to, for the tab badge. Must
  // match what the Assigned-clients tab actually lists: the clients owning the
  // user's accessible projects (project access OR a task in that project), plus
  // any client they're directly assigned to (PM/member). These hooks share the
  // tab's query keys, so TanStack Query dedupes — no extra requests.
  const projectsForCount = useAllProjects();
  const tasksForCount = useAllTasks();
  const userClientsForCount = useUserClients(user.id);
  const assignedClientCount = useMemo(() => {
    const projIds = new Set(user.project_ids ?? []);
    const taskIds = new Set(user.task_ids ?? []);
    const all = (projectsForCount.data ?? []) as unknown as FullProject[];
    // Project ids that own at least one task the user can access.
    const projWithUserTask = new Set<number>();
    ((tasksForCount.data ?? []) as unknown as FullTask[]).forEach((t) => {
      if (taskIds.has(t.id)) projWithUserTask.add(t.project_id);
    });
    const clientIds = new Set<number>();
    for (const p of all) {
      if (projIds.has(p.id) || projWithUserTask.has(p.id)) clientIds.add(p.client_id);
    }
    ((userClientsForCount.data ?? []) as { client_id: number }[]).forEach((a) => clientIds.add(a.client_id));
    return clientIds.size;
  }, [projectsForCount.data, tasksForCount.data, userClientsForCount.data, user.project_ids, user.task_ids]);

  const defClientName = user.default_client_id ? clientNameById.get(user.default_client_id) : undefined;
  const meta = [user.title, user.department, defClientName].filter(Boolean).join('  ·  ');

  return (
    <div className="min-w-0">
      {/* ── Hero (soft theme-blended) ── */}
      {/* No overflow-hidden: the actions dropdown opens below the hero and must
          not be clipped by the card edge. */}
      <div className="rounded-2xl border border-border bg-primary/[0.05]">
        <div className="flex items-start gap-4 px-6 py-5">
          <span className={cn('grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-lg font-semibold ring-2 ring-primary/15', avatarTone(user.full_name))}>
            {initials(user.full_name)}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="flex flex-wrap items-center gap-2.5 font-display text-[22px] font-bold tracking-tight">
              {user.full_name}
              <RoleBadge role={user.role} />
            </h1>
            {meta ? <div className="mt-1 text-[13px] text-muted-foreground">{meta}</div> : null}
            <div className="mt-3 flex flex-wrap gap-4 text-[13px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><Mail className="h-3.5 w-3.5 text-primary" /> {user.email}</span>
              {user.username ? <span className="inline-flex items-center gap-1.5"><AtSign className="h-3.5 w-3.5 text-primary" /> {user.username}</span> : null}
              {user.timezone ? <span className="inline-flex items-center gap-1.5"><Globe className="h-3.5 w-3.5 text-primary" /> {user.timezone}</span> : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {isAdmin ? (
              <>
                <Button variant="secondary" size="sm" aria-label="Edit user" title="Edit user" onClick={() => props.onEdit(user)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <UserActionMenu
                  user={user}
                  onResetPassword={() => props.onResetPassword(user)}
                  onSendInvite={() => props.onSendInvite(user)}
                  onToggleActive={() => props.onToggleActive(user)}
                  onDelete={() => props.onDelete(user)}
                  onUnlock={user.timesheet_locked ? () => props.onUnlock(user) : undefined}
                  onViewTimesheets={() => props.onViewTimesheets(user)}
                />
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="mb-4 mt-5 flex gap-1 border-b border-border">
        {([['details', 'User details', IdCard], ['clients', 'Assigned clients', Briefcase]] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              'inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-sm font-semibold transition-colors -mb-px',
              tab === key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" /> {label}
            {key === 'clients' && assignedClientCount > 0 ? (
              <span className="ml-0.5 rounded-full bg-primary/12 px-1.5 text-[11px] font-bold text-primary">
                {assignedClientCount}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'details' ? (
        // Tiles stack in the left column; the reporting tree fills the right.
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <IdentityCard {...props} editing={editCard === 'identity'} onEdit={() => setEditCard('identity')} onClose={() => setEditCard(null)} />
            <AccessCard {...props} editing={editCard === 'access'} onEdit={() => setEditCard('access')} onClose={() => setEditCard(null)} />
          </div>
          <ReportingTree user={user} onSelectUser={props.onSelectUser} />
        </div>
      ) : (
        <UserClientAccessTab user={user} isAdmin={isAdmin} onFlash={props.onFlash} />
      )}
    </div>
  );
}

// ── Card shell ──
function CardShell({ title, Icon, readonly, editing, onEdit, onSave, onCancel, children }: {
  title: string; Icon: typeof UserIcon; readonly: boolean; editing: boolean;
  onEdit: () => void; onSave?: () => void; onCancel?: () => void; children: React.ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-sm font-bold text-primary">
          <Icon className="h-4 w-4" /> {title}
        </span>
        {!readonly ? (
          editing ? (
            <span className="flex items-center gap-1.5">
              <button type="button" className="rounded-lg border border-transparent px-2.5 py-1 text-xs font-semibold text-muted-foreground hover:text-foreground" onClick={onCancel}>Cancel</button>
              <button type="button" className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground hover:brightness-110" onClick={onSave}>
                <Check className="h-3.5 w-3.5" /> Save
              </button>
            </span>
          ) : (
            <button type="button" className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold transition hover:border-primary/30 hover:bg-primary/[0.08] hover:text-primary" onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
          )
        ) : null}
      </div>
      {children}
    </Card>
  );
}

const DT = ({ children }: { children: React.ReactNode }) => <div className="text-[12.5px] font-semibold text-muted-foreground">{children}</div>;
const DD = ({ children }: { children: React.ReactNode }) => <div className="text-[13.5px]">{children}</div>;
const Muted = ({ children }: { children: React.ReactNode }) => <span className="text-muted-foreground">{children}</span>;

function inputCls() { return 'h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13.5px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20'; }

// ── Identity card ──
function IdentityCard({ user, isAdmin, onFlash, editing, onEdit, onClose }: Props & { editing: boolean; onEdit: () => void; onClose: () => void }) {
  const readonly = !isAdmin;
  const deptsQ = useDepartments(isAdmin);
  const update = useUpdateUser();
  const [fullName, setFullName] = useState(user.full_name);
  const [title, setTitle] = useState(user.title ?? '');
  const [department, setDepartment] = useState(user.department ?? '');
  const [timezone, setTimezone] = useState(user.timezone ?? '');
  const [username, setUsername] = useState(user.username ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setFullName(user.full_name); setTitle(user.title ?? ''); setDepartment(user.department ?? '');
    setTimezone(user.timezone ?? ''); setUsername(user.username ?? ''); setErrors({});
  }, [user.id, editing]);

  async function save() {
    if (!fullName.trim()) { setErrors({ fullName: 'This field is required.' }); return; }
    setErrors({});
    try {
      await update.mutateAsync({ id: user.id, data: {
        full_name: fullName.trim(), title: title.trim() || null, department: department || null,
        timezone: timezone.trim() || null, username: username.trim() || undefined,
      } });
      onFlash('ok', 'Identity updated.'); onClose();
    } catch { onFlash('err', 'Could not update identity.'); }
  }

  if (editing) {
    return (
      <CardShell title="Identity" Icon={UserIcon} readonly={readonly} editing onEdit={onEdit} onSave={save} onCancel={onClose}>
        <div className="flex flex-col gap-3">
          <label className="block"><DT>Full name<RequiredMark /></DT><input className={cn(inputCls(), errorBorder(!!errors.fullName))} value={fullName} onChange={(e) => { setFullName(e.target.value); if (errors.fullName) setErrors((s) => ({ ...s, fullName: '' })); }} /><FieldError error={errors.fullName} /></label>
          <label className="block"><DT>Title</DT><input className={inputCls()} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="block"><DT>Department</DT>
            <select className={inputCls()} value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">— None —</option>
              {(deptsQ.data ?? []).map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
            </select>
          </label>
          <label className="block"><DT>Username</DT><input className={inputCls()} value={username} onChange={(e) => setUsername(e.target.value)} /></label>
          <label className="block"><DT>Timezone</DT><input className={inputCls()} value={timezone} onChange={(e) => setTimezone(e.target.value)} /></label>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell title="Identity" Icon={UserIcon} readonly={readonly} editing={false} onEdit={onEdit}>
      <div className="grid grid-cols-[140px_1fr] gap-x-3.5 gap-y-3">
        <DT>Full name</DT><DD>{user.full_name}</DD>
        <DT>Title</DT><DD>{user.title || <Muted>—</Muted>}</DD>
        <DT>Department</DT><DD>{user.department || <Muted>—</Muted>}</DD>
        <DT>Email</DT><DD>{user.email}{' '}{user.email_verified ? <TonePill tone="success" className="ml-1.5">Verified</TonePill> : <TonePill tone="warning" className="ml-1.5">Unverified</TonePill>}</DD>
        <DT>Username</DT><DD>{user.username || <Muted>—</Muted>}</DD>
        <DT>Phones</DT><DD>{user.phones?.length ? user.phones.join(', ') : <Muted>None</Muted>}</DD>
        <DT>Timezone</DT><DD>{user.timezone || <Muted>—</Muted>}</DD>
        <DT>Created</DT><DD>{user.created_at ? new Date(user.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : <Muted>—</Muted>}</DD>
      </div>
    </CardShell>
  );
}

// ── Access & permissions card ──
function AccessCard({ user, isAdmin, nameById, onFlash, editing, onEdit, onClose }: Props & { editing: boolean; onEdit: () => void; onClose: () => void }) {
  const readonly = !isAdmin;
  const managersQ = useAssignableUsers(isAdmin);
  const update = useUpdateUser();
  const [role, setRole] = useState(user.role);
  const [extraPortals, setExtraPortals] = useState<string[]>((user.roles ?? []).filter((r) => r !== user.role));
  // A user can report to MULTIPLE managers (employee_manager_assignments is
  // many-to-many). Seed from manager_ids; fall back to the single manager_id for
  // older payloads. The first id is treated as primary (org-chart parent).
  const seedManagerIds = (u: ManagedUser) =>
    (u.manager_ids && u.manager_ids.length ? u.manager_ids
      : u.manager_id != null ? [u.manager_id] : []);
  const [managerIds, setManagerIds] = useState<number[]>(seedManagerIds(user));
  const [canReview, setCanReview] = useState(!!user.can_review);
  const [active, setActive] = useState(user.is_active);

  useEffect(() => {
    setRole(user.role); setExtraPortals((user.roles ?? []).filter((r) => r !== user.role));
    setManagerIds(seedManagerIds(user)); setCanReview(!!user.can_review); setActive(user.is_active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id, editing]);

  const toggleManager = (id: number) =>
    setManagerIds((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);

  const togglePortal = (p: string) => setExtraPortals((s) => s.includes(p) ? s.filter((x) => x !== p) : [...s, p]);

  async function save() {
    try {
      await update.mutateAsync({ id: user.id, data: {
        role, roles: [role, ...extraPortals.filter((p) => p !== role)],
        // Multi-manager: send the full set + the primary (first selected).
        // Empty list clears all managers.
        manager_ids: managerIds,
        primary_manager_id: managerIds.length ? managerIds[0] : null,
        can_review: canReview, is_active: active,
      } });
      onFlash('ok', 'Access updated.'); onClose();
    } catch { onFlash('err', 'Could not update access.'); }
  }

  const extra = (user.roles ?? []).filter((r) => r !== user.role);

  if (editing) {
    return (
      <CardShell title="Access & permissions" Icon={ShieldCheck} readonly={readonly} editing onEdit={onEdit} onSave={save} onCancel={onClose}>
        <div className="flex flex-col gap-3">
          <label className="block"><DT>Role</DT>
            <select className={inputCls()} value={role} onChange={(e) => setRole(e.target.value)}>
              {['EMPLOYEE', 'MANAGER', 'VIEWER', 'ADMIN'].map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <div><DT>Additional portals</DT>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {['MANAGER', 'VIEWER', 'ADMIN'].filter((p) => p !== role).map((p) => (
                <button key={p} type="button" onClick={() => togglePortal(p)}
                  className={cn('rounded-full border px-3 py-1 text-xs font-semibold', extraPortals.includes(p) ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground')}>
                  {ROLE_LABEL[p]}
                </button>
              ))}
              <button type="button" onClick={() => setCanReview((v) => !v)}
                className={cn('rounded-full border px-3 py-1 text-xs font-semibold', canReview ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground')}>
                Email Review
              </button>
            </div>
          </div>
          <div className="block">
            <DT>Managers</DT>
            <div className="mt-1 flex max-h-44 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-1.5">
              {(managersQ.data ?? []).filter((m) => m.role === 'MANAGER' || m.role === 'ADMIN').filter((m) => m.id !== user.id).length === 0 ? (
                <p className="px-1.5 py-1 text-[12px] text-muted-foreground">No managers available.</p>
              ) : (
                (managersQ.data ?? [])
                  .filter((m) => (m.role === 'MANAGER' || m.role === 'ADMIN') && m.id !== user.id)
                  .map((m) => {
                    const checked = managerIds.includes(m.id);
                    const isPrimary = checked && managerIds[0] === m.id;
                    return (
                      <button key={m.id} type="button" onClick={() => toggleManager(m.id)}
                        className={cn('flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-primary/5',
                          checked && 'bg-primary/[0.06]')}>
                        <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded border',
                          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
                          {checked ? <Check className="h-3 w-3" /> : null}
                        </span>
                        <span className="flex-1 truncate">{m.full_name}</span>
                        {isPrimary ? <span className="rounded-full bg-muted px-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Primary</span> : null}
                      </button>
                    );
                  })
              )}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">Pick one or more. The first selected is the primary manager (shown in lists + the org chart).</p>
          </div>
          <label className="flex items-center gap-2.5 text-[13px]"><input type="checkbox" className="h-4 w-4" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active (can sign in)</label>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell title="Access & permissions" Icon={ShieldCheck} readonly={readonly} editing={false} onEdit={onEdit}>
      <div className="grid grid-cols-[140px_1fr] gap-x-3.5 gap-y-3">
        <DT>Role</DT><DD><RoleBadge role={user.role} /></DD>
        <DT>Additional portals</DT><DD>{extra.length ? <span className="flex flex-wrap gap-1.5">{extra.map((r) => <RoleBadge key={r} role={r} />)}</span> : <Muted>None</Muted>}</DD>
        <DT>{(user.manager_ids?.length ?? 0) > 1 ? 'Managers' : 'Manager'}</DT>
        <DD>{
          (user.manager_ids && user.manager_ids.length)
            ? <span className="flex flex-wrap gap-1.5">{user.manager_ids.map((id, i) => (
                <span key={id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[12px]">
                  {nameById.get(id) ?? `#${id}`}{i === 0 && user.manager_ids!.length > 1 ? <span className="text-[9px] uppercase tracking-wide text-muted-foreground">primary</span> : null}
                </span>
              ))}</span>
            : user.manager_id ? (nameById.get(user.manager_id) ?? `#${user.manager_id}`)
            : <Muted>No manager</Muted>
        }</DD>
        <DT>Reviewer access</DT><DD>{user.can_review ? <TonePill tone="info">Can review ingestion queue</TonePill> : <Muted>No</Muted>}</DD>
        <DT>Project access</DT><DD>{(user.project_ids?.length ?? 0) > 0 ? <TonePill tone="info">{user.project_ids!.length} {user.project_ids!.length === 1 ? 'project' : 'projects'}</TonePill> : <Muted>No access</Muted>}</DD>
        <DT>Email</DT><DD>{user.email_verified ? <TonePill tone="success">Verified</TonePill> : <TonePill tone="warning">Unverified</TonePill>}</DD>
        <DT>Active</DT><DD>{user.is_active ? <TonePill tone="success">Can sign in</TonePill> : <TonePill tone="neutral">Disabled</TonePill>}</DD>
      </div>
    </CardShell>
  );
}
