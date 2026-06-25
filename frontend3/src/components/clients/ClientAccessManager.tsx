import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check, CheckSquare, ChevronDown, Folder, Info, Loader2, Mail, Pencil, Plus,
  Trash2, UserPlus, UserRound,
} from 'lucide-react';

import { Button, Empty, FieldError, Input, Modal, RequiredMark, TonePill } from '@/components/ui';
import { clientPortalApi } from '@/api/client';
import { useAllProjects, useAllTasks } from '@/hooks/useAdmin';
import { cn } from '@/lib/cn';
import type { ClientCapability, ClientGrant, ClientGrantSpec, FullProject, FullTask } from '@/types/admin';

const CAPS: ClientCapability[] = ['create', 'read', 'update', 'delete'];
const CAP_LABEL: Record<ClientCapability, string> = { create: 'Create', read: 'Read', update: 'Update', delete: 'Delete' };
const CAP_DESC: Record<ClientCapability, string> = { create: 'Add', read: 'View', update: 'Edit', delete: 'Remove' };
// Column order in the task table (matches the prototype): Read, Update, Create, Delete.
const TABLE_CAPS: ClientCapability[] = ['read', 'update', 'create', 'delete'];

// Deterministic avatar tint + initials, mirroring the portal's tone()/initials().
function initials(s: string): string {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}
function tone(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 45%)`;
}

// Selection map: key -> caps. key = "p:<id>" (whole project) | "t:<pid>:<tid>" (task).
type SelMap = Record<string, ClientCapability[]>;
type Mode = 'none' | 'whole' | 'tasks';
const NEW_CAPS: ClientCapability[] = ['read']; // a freshly-granted scope starts as Read

// Per-client portal access management (PM/admin surface), shown as a tab on the
// Clients page. Lists ONLY the client-side people with a grant on this client's
// projects, lets you invite new ones, and manage their per-project grants.
export function ClientAccessManager({
  clientId, clientName, onFlash,
}: {
  clientId: number;
  clientName: string;
  onFlash: (tone: 'ok' | 'err', text: string) => void;
}) {
  const qc = useQueryClient();
  const projectsQ = useAllProjects();
  const tasksQ = useAllTasks();
  // Client-side people scoped to THIS client (server-filtered to grants on its
  // projects) — not every CLIENT user in the tenant.
  const portalUsersQ = useQuery({
    queryKey: ['client-portal-users', clientId],
    queryFn: () => clientPortalApi.clientUsers(clientId).then((r) => r.data),
  });

  const clientProjects = useMemo(
    () => ((projectsQ.data ?? []) as unknown as FullProject[]).filter((p) => p.client_id === clientId),
    [projectsQ.data, clientId],
  );
  // Tasks grouped by project (for the "Specific tasks" table).
  const tasksByProject = useMemo(() => {
    const map = new Map<number, FullTask[]>();
    ((tasksQ.data ?? []) as unknown as FullTask[]).forEach((t) => {
      const arr = map.get(t.project_id) ?? [];
      arr.push(t);
      map.set(t.project_id, arr);
    });
    return map;
  }, [tasksQ.data]);
  // Full project list for resolving a grant's project name.
  const allProjects = (projectsQ.data ?? []) as unknown as FullProject[];
  const portalUsers = portalUsersQ.data ?? [];

  const [inviteOpen, setInviteOpen] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['client-portal-users', clientId] });

  return (
    <div className="space-y-5">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold">Client accounts</h3>
          <Button size="sm" onClick={() => setInviteOpen(true)}>
            <UserPlus className="h-4 w-4" /> Invite client
          </Button>
        </div>
        {portalUsers.length === 0 ? (
          <Empty Icon={UserPlus} title="No client accounts" description="Invite someone on the client side to give them scoped access to this client's projects." />
        ) : (
          <div className="space-y-2.5">
            {portalUsers.map((u) => (
              <ClientGrantCard key={u.user_id} portalUser={u}
                clientProjects={clientProjects} tasksByProject={tasksByProject}
                allProjects={allProjects} onFlash={onFlash} onChanged={refresh} />
            ))}
          </div>
        )}
      </section>

      <InviteClientModal
        open={inviteOpen}
        clientName={clientName}
        projects={clientProjects}
        tasksByProject={tasksByProject}
        onClose={() => setInviteOpen(false)}
        onDone={(msg) => { onFlash('ok', msg); refresh(); qc.invalidateQueries({ queryKey: ['users'] }); setInviteOpen(false); }}
        onError={(msg) => onFlash('err', msg)}
      />
    </div>
  );
}

// ── A labeled, clearly-clickable CRUD permission pill row ─────────────────────
function CapPills({
  caps, onToggle, size = 'md',
}: {
  caps: ClientCapability[];
  onToggle: (cap: ClientCapability) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {CAPS.map((c) => {
        const on = caps.includes(c);
        return (
          <button key={c} type="button" onClick={() => onToggle(c)}
            title={`${CAP_LABEL[c]} (${CAP_DESC[c]})`}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border font-semibold transition-colors',
              size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs',
              on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/40',
            )}>
            {on ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
            {CAP_LABEL[c]}
            <span className="font-normal opacity-60">{CAP_DESC[c]}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Shared scope picker: per-project No access / Whole project / Specific tasks
// with a per-task CRUD table. Drives a SelMap + per-project mode map, used by
// both the invite modal and the edit-access modal. ──────────────────────────
function ScopePicker({
  projects, tasksByProject, selected, setSelected, modes, setModes,
}: {
  projects: FullProject[];
  tasksByProject: Map<number, FullTask[]>;
  selected: SelMap;
  setSelected: React.Dispatch<React.SetStateAction<SelMap>>;
  modes: Record<number, Mode>;
  setModes: React.Dispatch<React.SetStateAction<Record<number, Mode>>>;
}) {
  function setMode(p: FullProject, mode: Mode) {
    const pkey = `p:${p.id}`;
    setSelected((prev) => {
      const next = { ...prev };
      delete next[pkey];
      Object.keys(next).forEach((k) => { if (k.startsWith(`t:${p.id}:`)) delete next[k]; });
      if (mode === 'whole') next[pkey] = NEW_CAPS.slice();
      return next;
    });
    setModes((m) => ({ ...m, [p.id]: mode }));
  }

  function toggleTaskShare(pid: number, tid: number) {
    const tkey = `t:${pid}:${tid}`;
    setSelected((prev) => {
      const next = { ...prev };
      if (next[tkey]) delete next[tkey];
      else next[tkey] = NEW_CAPS.slice();
      return next;
    });
  }

  // Toggle one cap on a scope's caps, IMMUTABLY (always writes a new array via
  // setSelected). In-place mutation was the bug: the edit modal seeds `selected`
  // from the same array objects it diffs against to detect changes, so a splice/
  // push mutated the "original" too and the diff saw no change (the new
  // capability was silently dropped on save). Keeps at least one cap.
  function toggleCap(key: string, cap: ClientCapability) {
    setSelected((prev) => {
      const cur = prev[key] ?? [];
      const has = cur.includes(cap);
      let nextCaps: ClientCapability[];
      if (has) {
        if (cur.length <= 1) return prev; // keep at least one
        nextCaps = cur.filter((c) => c !== cap);
      } else {
        nextCaps = [...cur, cap];
      }
      return { ...prev, [key]: nextCaps };
    });
  }

  if (projects.length === 0) {
    return <p className="text-[12.5px] text-muted-foreground">This client has no projects yet.</p>;
  }

  return (
    <div className="max-h-[44vh] space-y-2.5 overflow-y-auto pr-1">
      {projects.map((p) => {
        const mode = modes[p.id] ?? 'none';
        const pkey = `p:${p.id}`;
        const tasks = tasksByProject.get(p.id) ?? [];
        return (
          <div key={p.id} className="rounded-xl border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[13.5px] font-semibold">
                  <Folder className="h-4 w-4 text-primary" /> {p.name}
                </div>
              </div>
              {/* 3-way mode segmented control */}
              <div className="flex shrink-0 overflow-hidden rounded-lg border border-border text-[11.5px]">
                {(['none', 'whole', 'tasks'] as Mode[]).map((m) => (
                  <button key={m} type="button" onClick={() => setMode(p, m)}
                    className={cn('px-2.5 py-1 font-medium transition-colors',
                      mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
                    {m === 'none' ? 'No access' : m === 'whole' ? 'Whole project' : 'Specific tasks'}
                  </button>
                ))}
              </div>
            </div>

            {/* Whole project: one permission row */}
            {mode === 'whole' ? (
              <div className="mt-2.5 flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Permissions</span>
                <CapPills caps={selected[pkey] ?? []} onToggle={(c) => toggleCap(pkey, c)} />
              </div>
            ) : null}

            {/* Specific tasks: a per-task share + caps table */}
            {mode === 'tasks' ? (
              <div className="mt-2.5">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Task access</div>
                {tasks.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">This project has no tasks yet.</p>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-border">
                    <table className="w-full text-[12px]">
                      <thead className="bg-muted/50 text-[10.5px] uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-2 py-1.5 text-left font-semibold">Task</th>
                          <th className="px-1 py-1.5 text-center font-semibold">Status</th>
                          {TABLE_CAPS.map((c) => <th key={c} className="px-1 py-1.5 text-center font-semibold">{CAP_LABEL[c]}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {tasks.map((t) => {
                          const tkey = `t:${p.id}:${t.id}`;
                          const shared = !!selected[tkey];
                          const caps = selected[tkey] ?? [];
                          return (
                            <tr key={t.id} className={cn('border-t border-border', shared ? 'bg-primary/[0.04]' : '')}>
                              <td className="px-2 py-1.5">
                                <div className="flex items-center gap-2">
                                  <button type="button" onClick={() => toggleTaskShare(p.id, t.id)}
                                    title={shared ? 'Unshare task' : 'Share task'}
                                    className={cn('grid h-4 w-4 shrink-0 place-items-center rounded border text-white',
                                      shared ? 'border-primary bg-primary' : 'border-border')}>
                                    {shared ? <Check className="h-3 w-3" /> : null}
                                  </button>
                                  <span className="truncate">{t.name}</span>
                                </div>
                              </td>
                              <td className="px-1 py-1.5 text-center">
                                <span className={cn('rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold',
                                  shared ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground')}>
                                  {shared ? 'Shared' : 'Hidden'}
                                </span>
                              </td>
                              {TABLE_CAPS.map((c) => (
                                <td key={c} className="px-1 py-1.5 text-center">
                                  {!shared ? (
                                    <span className="text-muted-foreground/40">—</span>
                                  ) : (
                                    <button type="button" onClick={() => toggleCap(tkey, c)} title={CAP_LABEL[c]}
                                      className={cn('grid h-5 w-5 place-items-center rounded border mx-auto',
                                        caps.includes(c) ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
                                      {caps.includes(c) ? <Check className="h-3 w-3" /> : null}
                                    </button>
                                  )}
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <Info className="h-3.5 w-3.5" />
                  <span>Only shared tasks are visible to the client. Hidden tasks remain private.</span>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function InviteClientModal({
  open, clientName, projects, tasksByProject, onClose, onDone,
}: {
  open: boolean;
  clientName: string;
  projects: FullProject[];
  tasksByProject: Map<number, FullTask[]>;
  onClose: () => void;
  onDone: (msg: string) => void;
  // Errors now render inside the modal; onError kept optional for the caller.
  onError?: (msg: string) => void;
}) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState('Project Sponsor');
  const [selected, setSelected] = useState<SelMap>({});
  const [modes, setModes] = useState<Record<number, Mode>>({});
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Form-level error shown INSIDE the modal (not a page flash hidden behind it).
  const [formError, setFormError] = useState<string | null>(null);

  function reset() {
    setFullName(''); setEmail(''); setLabel('Project Sponsor');
    setSelected({}); setModes({}); setErrors({}); setFormError(null);
  }

  async function submit() {
    const next: Record<string, string> = {};
    if (!fullName.trim()) next.fullName = 'This field is required.';
    if (!email.trim()) next.email = 'This field is required.';
    else if (!email.includes('@')) next.email = 'Enter a valid email address.';
    if (Object.keys(next).length) { setErrors(next); return; }
    setErrors({}); setFormError(null);
    const grants: ClientGrantSpec[] = Object.entries(selected).map(([k, caps]) => {
      if (k.startsWith('p:')) return { scope: 'project', project_id: Number(k.slice(2)), capabilities: caps };
      const [, , tid] = k.split(':');
      return { scope: 'task', task_id: Number(tid), capabilities: caps };
    });
    if (!grants.length) { setFormError('Select at least one project or task to share.'); return; }
    setBusy(true);
    try {
      const res = await clientPortalApi.invite({
        full_name: fullName.trim(), email: email.trim(), label: label.trim() || null,
        grants,
      });
      reset();
      onDone(res.data.message || `Invite sent to ${email}.`);
    } catch (e) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setFormError(typeof d === 'string' ? d : 'Could not invite the client.');
    } finally { setBusy(false); }
  }

  const sumName = fullName.trim() || 'New client';
  const sumEmail = email.trim() || 'email@client.com';

  return (
    <Modal open={open} onClose={onClose} title={`Invite client · ${clientName}`} className="max-w-4xl">
      <div className="flex flex-col gap-4 md:flex-row">
        {/* Left rail — live summary that mirrors the right-side inputs. */}
        <div className="shrink-0 space-y-4 md:w-56">
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Client summary</div>
            <div className="flex items-center gap-2.5 rounded-xl border border-border bg-muted/30 p-2.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[13px] font-bold text-white"
                style={{ background: tone(sumName) }}>{initials(sumName)}</span>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">{sumName}</div>
                <div className="truncate text-[11.5px] text-muted-foreground">{sumEmail}</div>
              </div>
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Client-side role</div>
            <div className="flex items-center gap-1.5 text-[13px]">
              <UserRound className="h-4 w-4 text-muted-foreground" /> {label.trim() || 'Not set'}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Invite status</div>
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-2.5">
              <Mail className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div>
                <div className="text-[12.5px] font-medium">Invite link not yet sent</div>
                <div className="text-[11.5px] text-muted-foreground">On save, an invite link will be emailed.</div>
              </div>
            </div>
          </div>
        </div>

        {/* Right — client details + scope picker. */}
        <div className="min-w-0 flex-1 space-y-4">
          <div className="space-y-2.5">
            <div className="text-[13px] font-bold">Client details</div>
            <div>
              <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Full name<RequiredMark /></label>
              <Input value={fullName} error={!!errors.fullName} onChange={(e) => { setFullName(e.target.value); setErrors((p) => ({ ...p, fullName: '' })); }} placeholder="Dana Whitfield" />
              <FieldError error={errors.fullName} />
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Email<RequiredMark /> <span className="font-normal">(an invite link is sent here)</span></label>
              <Input type="email" value={email} error={!!errors.email} onChange={(e) => { setEmail(e.target.value); setErrors((p) => ({ ...p, email: '' })); }} placeholder="dana@client.com" />
              <FieldError error={errors.email} />
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Title <span className="font-normal">(label, e.g. Project Sponsor)</span></label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Project Sponsor" />
            </div>
          </div>

          <div>
            <div className="mb-2 text-[13px] font-bold">
              Projects &amp; tasks <span className="text-xs font-normal text-muted-foreground">(choose how much of each project to share)</span>
            </div>
            <ScopePicker
              projects={projects} tasksByProject={tasksByProject}
              selected={selected} setSelected={(v) => { setSelected(v); setFormError(null); }}
              modes={modes} setModes={setModes}
            />
          </div>
        </div>
      </div>

      {formError ? (
        <div className="mt-4 flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-700 dark:text-rose-300">
          <Info className="h-4 w-4 shrink-0" /> {formError}
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
        <Info className="h-4 w-4 shrink-0" />
        <span>On save, an invite link is emailed. The client sets a password and signs in as a <b>CLIENT</b> user limited to exactly these scopes and permissions.</span>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Send invite
        </Button>
      </div>
    </Modal>
  );
}

// Edit an existing client user's access: same per-project/per-task picker as
// invite, pre-loaded from their current grants. On save we DIFF the new
// selection against the originals and issue the minimal create/update/delete.
function EditAccessModal({
  open, userName, userEmail, userTitle, userId, grants, projects, tasksByProject, onClose, onDone, onError,
}: {
  open: boolean;
  userName: string;
  userEmail: string;
  userTitle: string;
  userId: number;
  grants: ClientGrant[];
  projects: FullProject[];
  tasksByProject: Map<number, FullTask[]>;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  // Editable client-profile fields (name, email, title), seeded from the row.
  const [fullName, setFullName] = useState(userName);
  const [email, setEmail] = useState(userEmail);
  const [title, setTitle] = useState(userTitle);
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  // Re-seed the profile fields whenever the modal (re)opens for this user.
  const [detailSeededFor, setDetailSeededFor] = useState<string | null>(null);
  const detailSig = `${userId}|${userName}|${userEmail}|${userTitle}`;
  if (open && detailSeededFor !== detailSig) {
    setFullName(userName); setEmail(userEmail); setTitle(userTitle);
    setDetailErrors({}); setDetailSeededFor(detailSig);
  }
  if (!open && detailSeededFor !== null) setDetailSeededFor(null);
  // Seed selection + modes from existing grants. Task grants carry their own
  // project id (resolved from tasksByProject) so the picker keys correctly.
  const taskProjectOf = useMemo(() => {
    const m = new Map<number, number>();
    tasksByProject.forEach((arr, pid) => arr.forEach((t) => m.set(t.id, pid)));
    return m;
  }, [tasksByProject]);

  const seed = useMemo(() => {
    const sel: SelMap = {};
    const modes: Record<number, Mode> = {};
    // Existing grant ids keyed the same way, so the diff can find the grant id.
    const grantIdByKey: Record<string, number> = {};
    grants.forEach((g) => {
      if (g.project_id) {
        const k = `p:${g.project_id}`;
        sel[k] = [...g.capabilities];
        modes[g.project_id] = 'whole';
        grantIdByKey[k] = g.id;
      } else if (g.task_id) {
        const pid = taskProjectOf.get(g.task_id);
        if (pid == null) return; // task not under this client's projects
        const k = `t:${pid}:${g.task_id}`;
        sel[k] = [...g.capabilities];
        modes[pid] = 'tasks';
        grantIdByKey[k] = g.id;
      }
    });
    return { sel, modes, grantIdByKey };
  }, [grants, taskProjectOf]);

  // Deep-copy the seed into the working selection so `selected` never aliases
  // the per-scope arrays in `seed.sel` (those are the pristine originals the
  // save() diff compares against). cloneSel is used both for the initial state
  // and on every re-seed.
  const cloneSel = (s: SelMap): SelMap =>
    Object.fromEntries(Object.entries(s).map(([k, caps]) => [k, [...caps]]));
  const [selected, setSelected] = useState<SelMap>(() => cloneSel(seed.sel));
  const [modes, setModes] = useState<Record<number, Mode>>(seed.modes);
  const [busy, setBusy] = useState(false);
  // Re-seed when the modal (re)opens for a user, OR when the seeded scope set
  // changes while open (e.g. task grants resolved after tasks finished loading,
  // so a task scope that was initially unresolvable now appears). The signature
  // depends only on the grant data — never on the user's in-progress edits — so
  // editing the picker can't trigger a re-seed that would discard those edits.
  const seedSig = `${userId}|${Object.keys(seed.grantIdByKey).sort().join(',')}`;
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (open && seededFor !== seedSig) {
    setSelected(cloneSel(seed.sel)); setModes(seed.modes); setSeededFor(seedSig);
  }
  if (!open && seededFor !== null) setSeededFor(null);

  async function save() {
    const origKeys = new Set(Object.keys(seed.grantIdByKey));
    const nextKeys = new Set(Object.keys(selected));
    const creates: ClientGrantSpec[] = [];
    const updates: { grantId: number; caps: ClientCapability[] }[] = [];
    const deletes: number[] = [];

    // Creates + updates from the new selection.
    Object.entries(selected).forEach(([k, caps]) => {
      const capsWithRead = Array.from(new Set([...caps, 'read'])) as ClientCapability[];
      if (origKeys.has(k)) {
        // Existing scope — update caps if they changed.
        const orig = seed.sel[k] ?? [];
        const same = orig.length === capsWithRead.length && orig.every((c) => capsWithRead.includes(c));
        if (!same) updates.push({ grantId: seed.grantIdByKey[k], caps: capsWithRead });
      } else if (k.startsWith('p:')) {
        creates.push({ scope: 'project', project_id: Number(k.slice(2)), capabilities: capsWithRead });
      } else {
        const [, , tid] = k.split(':');
        creates.push({ scope: 'task', task_id: Number(tid), capabilities: capsWithRead });
      }
    });
    // Deletes for scopes that were removed.
    origKeys.forEach((k) => { if (!nextKeys.has(k)) deletes.push(seed.grantIdByKey[k]); });

    // Profile-detail diff (name / email / title).
    const detailPatch: { full_name?: string; email?: string; title?: string | null } = {};
    const nextName = fullName.trim();
    const nextEmail = email.trim();
    const nextTitle = title.trim();
    if (nextName !== userName.trim()) detailPatch.full_name = nextName;
    if (nextEmail.toLowerCase() !== userEmail.trim().toLowerCase()) detailPatch.email = nextEmail;
    if (nextTitle !== userTitle.trim()) detailPatch.title = nextTitle || null;

    // Validate edited details up-front (inline, like the invite form).
    const de: Record<string, string> = {};
    if ('full_name' in detailPatch && !nextName) de.fullName = 'This field is required.';
    if ('email' in detailPatch) {
      if (!nextEmail) de.email = 'This field is required.';
      else if (!nextEmail.includes('@')) de.email = 'Enter a valid email address.';
    }
    if (Object.keys(de).length) { setDetailErrors(de); return; }
    setDetailErrors({});

    const hasDetail = Object.keys(detailPatch).length > 0;
    if (!creates.length && !updates.length && !deletes.length && !hasDetail) { onClose(); return; }

    setBusy(true);
    try {
      if (hasDetail) await clientPortalApi.updateClientUser(userId, detailPatch);
      await Promise.all([
        ...creates.map((g) => clientPortalApi.createGrant({
          user_id: userId,
          project_id: g.scope === 'project' ? g.project_id ?? undefined : undefined,
          task_id: g.scope === 'task' ? g.task_id ?? undefined : undefined,
          capabilities: g.capabilities,
        })),
        ...updates.map((u) => clientPortalApi.updateGrant(u.grantId, u.caps)),
        ...deletes.map((id) => clientPortalApi.revokeGrant(id)),
      ]);
      onDone(hasDetail && !creates.length && !updates.length && !deletes.length ? 'Client updated.' : 'Access updated.');
    } catch (e) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      onError(typeof d === 'string' ? d : 'Could not update access.');
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Edit client · ${userName}`} className="max-w-4xl">
      {/* Client details — name, email, title — editable inline. */}
      <div className="mb-3 text-[13px] font-bold">Client details</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Full name<RequiredMark /></label>
          <Input value={fullName} error={!!detailErrors.fullName} onChange={(e) => { setFullName(e.target.value); setDetailErrors((p) => ({ ...p, fullName: '' })); }} placeholder="Dana Whitfield" />
          <FieldError error={detailErrors.fullName} />
        </div>
        <div>
          <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Email<RequiredMark /></label>
          <Input type="email" value={email} error={!!detailErrors.email} onChange={(e) => { setEmail(e.target.value); setDetailErrors((p) => ({ ...p, email: '' })); }} placeholder="dana@client.com" />
          <FieldError error={detailErrors.email} />
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Title <span className="font-normal">(label, e.g. Project Sponsor)</span></label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Project Sponsor" />
        </div>
      </div>

      <div className="mb-2 mt-5 text-[13px] font-bold">
        Projects &amp; tasks <span className="text-xs font-normal text-muted-foreground">(choose how much of each project to share)</span>
      </div>
      <ScopePicker
        projects={projects} tasksByProject={tasksByProject}
        selected={selected} setSelected={setSelected}
        modes={modes} setModes={setModes}
      />
      <div className="mt-4 flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
        <Info className="h-4 w-4 shrink-0" />
        <span>Changes take effect immediately. The client sees exactly the projects and tasks shared here, with these permissions.</span>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" disabled={busy} onClick={save}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save changes
        </Button>
      </div>
    </Modal>
  );
}

// One client user's card: collapsible summary of their grants on THIS client's
// projects, an Edit-access button (full per-project/per-task editor), and a
// revoke-all control. Collapsed by default so many users stay scannable.
function ClientGrantCard({
  portalUser, clientProjects, tasksByProject, allProjects, onFlash, onChanged,
}: {
  portalUser: import('@/types/admin').ClientPortalUser;
  clientProjects: FullProject[];
  tasksByProject: Map<number, FullTask[]>;
  allProjects: FullProject[];
  onFlash: (t: 'ok' | 'err', m: string) => void;
  onChanged: () => void;
}) {
  const { user_id: userId, full_name: name, email, label, grants } = portalUser;
  const accepted = portalUser.email_verified === true;
  const [expanded, setExpanded] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [resending, setResending] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const resendInvite = async () => {
    setResending(true);
    try {
      await clientPortalApi.resendInvite(userId);
      onFlash('ok', `Invite re-sent to ${email}.`);
    } catch {
      onFlash('err', 'Could not resend the invite.');
    } finally {
      setResending(false);
    }
  };

  const revokeAll = async () => {
    if (!grants.length) return;
    if (!window.confirm(`Revoke all access for ${name}? Their grants will be removed; the account itself is kept.`)) return;
    setRevoking(true);
    try {
      await Promise.all(grants.map((g) => clientPortalApi.revokeGrant(g.id)));
      onFlash('ok', `Revoked all access for ${name}.`);
      onChanged();
    } catch {
      onFlash('err', 'Could not revoke access.');
    } finally {
      setRevoking(false);
    }
  };

  const projName = (id?: number | null) => allProjects.find((p) => p.id === id)?.name ?? (id ? `Project #${id}` : '');
  const taskName = (id?: number | null) => {
    for (const arr of tasksByProject.values()) {
      const t = arr.find((x) => x.id === id);
      if (t) return t.name;
    }
    return id ? `Task #${id}` : '';
  };
  const taskProjectName = (taskId?: number | null) => {
    for (const [pid, arr] of tasksByProject.entries()) {
      if (arr.some((x) => x.id === taskId)) return projName(pid);
    }
    return '';
  };

  return (
    <div className="rounded-xl border border-border bg-card">
      {/* Header row — click to expand/collapse. */}
      <div className="flex items-center gap-2.5 p-3">
        <button type="button" onClick={() => setExpanded((v) => !v)}
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted"
          aria-label={expanded ? 'Collapse' : 'Expand'}>
          <ChevronDown className={cn('h-4 w-4 transition-transform', expanded ? '' : '-rotate-90')} />
        </button>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[12px] font-bold text-white"
          style={{ background: tone(name || '?') }}>{initials(name || '?')}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold">{name}</span>
            {label ? <TonePill tone="neutral">{label}</TonePill> : null}
            <TonePill tone={accepted ? 'success' : 'warning'}>{accepted ? 'Active' : 'Invited'}</TonePill>
          </div>
          <div className="truncate text-[12px] text-muted-foreground">{email}</div>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {grants.length} {grants.length === 1 ? 'scope' : 'scopes'}
        </span>
        {!accepted ? (
          <Button size="sm" variant="ghost" onClick={resendInvite} disabled={resending}
            title="Re-send the set-password invite link">
            {resending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />} Resend
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)} title="Edit client">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" onClick={revokeAll} disabled={revoking || grants.length === 0}
          title="Revoke all of this client's access">
          {revoking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {/* Body — the grant scopes, only when expanded. */}
      {expanded ? (
        <div className="space-y-1.5 border-t border-border p-3">
          {grants.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No grants on this client yet. Use the edit (pencil) button to share projects or tasks.</p>
          ) : grants.map((g) => {
            const isProject = !!g.project_id;
            const scopeLabel = isProject
              ? `${projName(g.project_id)} (whole project)`
              : `${taskProjectName(g.task_id)} › ${taskName(g.task_id)}`;
            return (
              <div key={g.id} className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2">
                {isProject ? <Folder className="h-4 w-4 shrink-0 text-primary" /> : <CheckSquare className="h-4 w-4 shrink-0 text-primary" />}
                <span className="flex-1 truncate text-[13px]">{scopeLabel}</span>
                <span className="flex gap-1">
                  {CAPS.map((c) => {
                    const on = g.capabilities.includes(c);
                    return (
                      <span key={c} title={`${CAP_LABEL[c]} (${CAP_DESC[c]})`}
                        className={cn('grid h-6 w-6 place-items-center rounded text-[11px] font-bold',
                          on ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground/50')}>
                        {c[0].toUpperCase()}
                      </span>
                    );
                  })}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      <EditAccessModal
        open={editOpen}
        userName={name}
        userEmail={email}
        userTitle={label ?? ''}
        userId={userId}
        grants={grants}
        projects={clientProjects}
        tasksByProject={tasksByProject}
        onClose={() => setEditOpen(false)}
        onDone={(msg) => { onFlash('ok', msg); onChanged(); setEditOpen(false); }}
        onError={(msg) => onFlash('err', msg)}
      />
    </div>
  );
}
