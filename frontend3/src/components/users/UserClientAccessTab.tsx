import { useEffect, useMemo, useState } from 'react';
import { Briefcase, Check, ChevronRight, Folder, Loader2, Minus, Pencil, Plus, Trash2 } from 'lucide-react';

import { Button, Empty, Modal, TonePill } from '@/components/ui';
import { useAllProjects, useAllTasks, useAssignableUsers, useClients, useClientTeam, useDeleteProject, useDeleteTask, useUpdateUser, useUserClients } from '@/hooks/useAdmin';
import { cn } from '@/lib/cn';
import type { ClientTeamMember, FullProject, FullTask, ManagedUser } from '@/types/admin';
import { ProjectModal } from '@/pages/ClientsPage';
import { TaskFormModal } from '@/components/clients/TaskFormModal';
import type { Tone } from '@/components/ui';

// The /projects + /tasks endpoints return the rich shape at runtime even though
// the slim Project/Task types under-declare it (same cast ClientsPage uses).
const PROJ_TONE: Record<string, Tone> = {
  planning: 'info', in_progress: 'brand', on_hold: 'warning', completed: 'success',
};
const TASK_TONE: Record<string, Tone> = {
  to_do: 'info', in_progress: 'brand', done: 'success',
};
const fmtStatus = (s?: string) => (s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '');

// The Client Access tab: shows the client > project > task tree the user is on
// (their project access + task access). Admins get full structural CRUD
// (create/edit/delete projects + tasks); both admins and managers can grant a
// report access to a client's existing projects/tasks via the grant modal.
export function UserClientAccessTab({ user, isAdmin, onFlash }: {
  user: ManagedUser; isAdmin: boolean; onFlash: (tone: 'ok' | 'err', text: string) => void;
}) {
  const clientsQ = useClients();
  const projectsQ = useAllProjects();
  const tasksQ = useAllTasks();
  // Clients this user is directly assigned to (e.g. a manager set as a client's
  // Project Manager via the Edit-client team picker) — distinct from being on a
  // specific project/task. Surfaced so a PM-on-a-client doesn't read as "no
  // assignments" just because they have no per-project access yet.
  const userClientsQ = useUserClients(user.id);
  const delProject = useDeleteProject();
  const delTask = useDeleteTask();
  // Data for the reused Client-Management ProjectModal (PM/team rostering).
  const usersDirQ = useAssignableUsers();

  const [expClient, setExpClient] = useState<Record<number, boolean>>({});
  const [expProject, setExpProject] = useState<Record<number, boolean>>({});
  const [projModal, setProjModal] = useState<{ clientId: number; project: FullProject | null } | null>(null);
  const [taskModal, setTaskModal] = useState<{ projectId: number; task: FullTask | null } | null>(null);
  // Tab-level "Add client": pick a client, then grant access to its existing
  // projects/tasks (or create a new project). grantClientId holds the chosen
  // client while the grant modal is open.
  const [addClientOpen, setAddClientOpen] = useState(false);
  const [grantClientId, setGrantClientId] = useState<number | null>(null);

  const projectIds = new Set(user.project_ids ?? []);
  const taskIds = new Set(user.task_ids ?? []);
  const allProjects = (projectsQ.data ?? []) as unknown as FullProject[];
  const allTasks = (tasksQ.data ?? []) as unknown as FullTask[];
  const tasksByProject = useMemo(() => {
    const m = new Map<number, FullTask[]>();
    allTasks.forEach((t) => { if (!m.has(t.project_id)) m.set(t.project_id, []); m.get(t.project_id)!.push(t); });
    return m;
  }, [allTasks]);

  // Projects the user can see = project access OR a task in that project.
  const userProjects = useMemo(() => {
    return allProjects.filter((p) => {
      if (projectIds.has(p.id)) return true;
      return (tasksByProject.get(p.id) ?? []).some((t) => taskIds.has(t.id));
    });
  }, [allProjects, tasksByProject, user.project_ids, user.task_ids]);

  // Clients the user is directly assigned to (PM/member rows). Their ids ensure
  // the client shows even with zero projects/tasks.
  const assignedClientIds = useMemo(
    () => new Set(((userClientsQ.data ?? []) as { client_id: number }[]).map((a) => a.client_id)),
    [userClientsQ.data],
  );

  const byClient = useMemo(() => {
    const m = new Map<number, FullProject[]>();
    userProjects.forEach((p) => { if (!m.has(p.client_id)) m.set(p.client_id, []); m.get(p.client_id)!.push(p); });
    // Ensure directly-assigned clients appear even with no project/task access.
    assignedClientIds.forEach((cid) => { if (!m.has(cid)) m.set(cid, []); });
    return m;
  }, [userProjects, assignedClientIds]);

  const clientById = useMemo(() => {
    const m = new Map<number, { name: string; type: string }>();
    (clientsQ.data ?? []).forEach((c) => m.set(c.id, { name: c.name, type: c.client_type }));
    return m;
  }, [clientsQ.data]);

  // Directory + nameOf for the reused ProjectModal.
  const usersDir = (usersDirQ.data ?? []) as ManagedUser[];
  const userById = useMemo(() => {
    const m = new Map<number, ManagedUser>();
    usersDir.forEach((u) => m.set(u.id, u));
    return m;
  }, [usersDir]);
  const nameOf = (uid: number): string => userById.get(uid)?.full_name ?? `#${uid}`;

  async function removeProject(p: FullProject) {
    if (!window.confirm(`Delete project "${p.name}" and its tasks?`)) return;
    try { await delProject.mutateAsync(p.id); onFlash('ok', 'Project deleted.'); }
    catch { onFlash('err', 'Could not delete project.'); }
  }
  async function removeTask(t: FullTask) {
    if (!window.confirm(`Delete task "${t.name}"?`)) return;
    try { await delTask.mutateAsync(t.id); onFlash('ok', 'Task deleted.'); }
    catch { onFlash('err', 'Could not delete task.'); }
  }

  if (byClient.size === 0) {
    return (
      <>
        <Empty
          Icon={Briefcase}
          title="No client assignments yet"
          description={isAdmin ? 'This user is not on any project or task.' : 'Not assigned to any client, project, or task yet.'}
        />
        {/* Both admins and managers can add a client. The client list and the
            grant tree are server-scoped to a manager's own PM clients/projects;
            both can grant whole-project or per-task access. */}
        <div className="mt-3">
          <Button onClick={() => setAddClientOpen(true)}>
            <Plus className="h-4 w-4" /> Add client
          </Button>
        </div>
        <AddClientPicker
          open={addClientOpen} clients={clientsQ.data ?? []} existingClientIds={new Set(byClient.keys())}
          onClose={() => setAddClientOpen(false)}
          onPick={(cid) => { setAddClientOpen(false); setGrantClientId(cid); }}
        />
        {grantClientId != null ? (
          <GrantClientAccessModal key={grantClientId}
            user={user} clientId={grantClientId}
            clientName={clientById.get(grantClientId)?.name ?? `Client #${grantClientId}`}
            onClose={() => setGrantClientId(null)}
            onSaved={(msg) => { onFlash('ok', msg); setGrantClientId(null); }}
            onAddProject={() => setProjModal({ clientId: grantClientId, project: null })}
          />
        ) : null}
        {projModal ? (
          <ProjectModalForClient
            clientId={projModal.clientId} project={projModal.project}
            clients={clientsQ.data ?? []} users={usersDir} nameOf={nameOf}
            tasksByProject={tasksByProject}
            onClose={() => setProjModal(null)}
            onSaved={(m) => { onFlash('ok', m); setProjModal(null); }} />
        ) : null}
      </>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAddClientOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> Add client
        </Button>
      </div>
      {[...byClient.entries()].map(([cid, projs]) => {
        const c = clientById.get(cid);
        const open = expClient[cid] ?? false;
        return (
          <div key={cid} className="overflow-hidden rounded-xl border border-border bg-card">
            <button type="button" onClick={() => setExpClient((s) => ({ ...s, [cid]: !open }))}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-primary/[0.04]">
              <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
              <span className="flex-1 truncate text-sm font-semibold">
                {c?.name ?? `Client #${cid}`}{' '}
                <TonePill tone={c?.type === 'internal' ? 'success' : 'neutral'} className="ml-1.5">{c?.type === 'internal' ? 'Internal' : 'External'}</TonePill>
                {projs.length === 0 && assignedClientIds.has(cid) ? (
                  <TonePill tone="info" className="ml-1.5">Assigned</TonePill>
                ) : null}
              </span>
              <span className="shrink-0 text-[11.5px] text-muted-foreground">{projs.length} {projs.length === 1 ? 'project' : 'projects'}</span>
            </button>
            {open ? (
              <div className="border-t border-border bg-background px-3 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Projects</span>
                  {/* Manage access (grant/revoke this client's existing projects
                      + tasks for the user) is available to admins and managers.
                      Structural "Add project" (creating a new one) stays admin. */}
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => setGrantClientId(cid)}>
                      <Plus className="h-3.5 w-3.5" /> Manage access
                    </Button>
                    {isAdmin ? (
                      <Button size="sm" variant="ghost" onClick={() => setProjModal({ clientId: cid, project: null })}>
                        New project
                      </Button>
                    ) : null}
                  </div>
                </div>
                {projs.map((p) => {
                  const pOpen = expProject[p.id] ?? false;
                  const tasks = (tasksByProject.get(p.id) ?? []);
                  return (
                    <div key={p.id} className="mb-2 overflow-hidden rounded-lg border border-border bg-card">
                      <div className="flex items-center gap-2.5 px-3 py-2.5">
                        <button type="button" onClick={() => setExpProject((s) => ({ ...s, [p.id]: !pOpen }))} className="flex flex-1 items-center gap-2.5 text-left">
                          <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', pOpen && 'rotate-90')} />
                          <Folder className="h-4 w-4 shrink-0 text-primary" />
                          <span className="truncate text-[13.5px] font-semibold">{p.name}</span>
                          {p.code ? <span className="rounded-full bg-muted px-2 text-[10px] font-semibold text-muted-foreground">{p.code}</span> : null}
                          {p.status ? <TonePill tone={PROJ_TONE[p.status] ?? 'neutral'}>{fmtStatus(p.status)}</TonePill> : null}
                          <span className="ml-auto shrink-0 text-[11.5px] text-muted-foreground">{tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}</span>
                        </button>
                        {isAdmin ? (
                          <span className="flex shrink-0 gap-1">
                            <button type="button" className="icon-btn-sm" title="Edit project" onClick={() => setProjModal({ clientId: cid, project: p })}><Pencil className="h-3.5 w-3.5" /></button>
                            <button type="button" className="icon-btn-sm icon-btn-danger" title="Delete project" onClick={() => removeProject(p)}><Trash2 className="h-3.5 w-3.5" /></button>
                          </span>
                        ) : null}
                      </div>
                      {pOpen ? (
                        <div className="border-t border-border bg-background px-3 py-2.5">
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Tasks</span>
                            {isAdmin ? (
                              <Button size="sm" variant="secondary" onClick={() => setTaskModal({ projectId: p.id, task: null })}>
                                <Plus className="h-3.5 w-3.5" /> Add task
                              </Button>
                            ) : null}
                          </div>
                          {tasks.length === 0 ? (
                            <div className="px-2 py-3 text-center text-[12.5px] text-muted-foreground">No tasks on this project.</div>
                          ) : tasks.map((t) => (
                            <div key={t.id} className="mb-1.5 flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2">
                              <span className="flex-1 truncate text-[13px] font-semibold">{t.name}</span>
                              <span className="shrink-0 text-[11px] text-muted-foreground">{t.assignee_ids?.length ?? 0} assignee{(t.assignee_ids?.length ?? 0) === 1 ? '' : 's'}</span>
                              {t.status ? <TonePill tone={TASK_TONE[t.status] ?? 'neutral'}>{fmtStatus(t.status)}</TonePill> : null}
                              {isAdmin ? (
                                <span className="flex shrink-0 gap-1">
                                  <button type="button" className="icon-btn-sm" title="Edit task" onClick={() => setTaskModal({ projectId: p.id, task: t })}><Pencil className="h-3.5 w-3.5" /></button>
                                  <button type="button" className="icon-btn-sm icon-btn-danger" title="Delete task" onClick={() => removeTask(t)}><Trash2 className="h-3.5 w-3.5" /></button>
                                </span>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}

      {taskModal ? (
        <TaskFormModal
          open
          projectId={taskModal.projectId}
          task={taskModal.task}
          onClose={() => setTaskModal(null)}
          onSaved={() => { onFlash('ok', taskModal.task ? 'Task updated.' : 'Task created.'); setTaskModal(null); }}
        />
      ) : null}
      <AddClientPicker
        open={addClientOpen} clients={clientsQ.data ?? []} existingClientIds={new Set(byClient.keys())}
        onClose={() => setAddClientOpen(false)}
        onPick={(cid) => { setAddClientOpen(false); setGrantClientId(cid); }}
      />
      {grantClientId != null ? (
        <GrantClientAccessModal key={grantClientId}
          user={user} clientId={grantClientId}
          clientName={clientById.get(grantClientId)?.name ?? `Client #${grantClientId}`}
          onClose={() => setGrantClientId(null)}
          onSaved={(msg) => { onFlash('ok', msg); setGrantClientId(null); }}
          onAddProject={() => setProjModal({ clientId: grantClientId, project: null })}
        />
      ) : null}
      {/* Project create/edit reuses the Client-Management ProjectModal. Rendered
          LAST so it stacks ON TOP of the grant modal when opened from it. */}
      {projModal ? (
        <ProjectModalForClient
          clientId={projModal.clientId} project={projModal.project}
          clients={clientsQ.data ?? []} users={usersDir} nameOf={nameOf}
          tasksByProject={tasksByProject}
          onClose={() => setProjModal(null)}
          onSaved={(m) => { onFlash('ok', m); setProjModal(null); }}
        />
      ) : null}
    </div>
  );
}

// Thin wrapper that fetches the client's team (PMs) and renders the rich
// Client-Management ProjectModal, so creating a project from the grant flow is
// identical to creating one in Client Management.
function ProjectModalForClient({
  clientId, project, clients, users, nameOf, tasksByProject, onClose, onSaved,
}: {
  clientId: number;
  project: FullProject | null;
  clients: { id: number; name: string; client_type: string }[];
  users: ManagedUser[];
  nameOf: (uid: number) => string;
  tasksByProject: Map<number, FullTask[]>;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const teamQ = useClientTeam(clientId);
  const pms = ((teamQ.data ?? []) as ClientTeamMember[]).filter((m) => m.assignment_role === 'pm');
  return (
    <ProjectModal
      open
      clientId={clientId}
      clients={clients as never}
      project={project}
      pms={pms}
      users={users}
      tasks={project ? tasksByProject.get(project.id) ?? [] : []}
      nameOf={nameOf}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

// Tab-level "Add client": pick a client (one the user isn't already on) to add
// the user to via a new project. Reuses the project modal afterward.
function AddClientPicker({
  open, clients, existingClientIds, onClose, onPick,
}: {
  open: boolean;
  clients: { id: number; name: string; client_type: string }[];
  existingClientIds: Set<number>;
  onClose: () => void;
  onPick: (clientId: number) => void;
}) {
  const [q, setQ] = useState('');
  const candidates = clients
    .filter((c) => !existingClientIds.has(c.id))
    .filter((c) => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Modal open={open} onClose={onClose} title="Add the user to a client" className="max-w-xl">
      <div className="space-y-3 pb-4">
        <p className="text-[12.5px] text-muted-foreground">
          Pick a client to grant this user access to its projects and tasks.
        </p>
        <input
          autoFocus value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search clients…"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        />
        <div className="max-h-[320px] overflow-y-auto rounded-lg border border-border py-1.5">
          {candidates.length === 0 ? (
            <p className="px-3 py-4 text-center text-[12.5px] text-muted-foreground">
              {clients.length === existingClientIds.size ? 'The user is already on every client.' : 'No clients match.'}
            </p>
          ) : candidates.map((c) => (
            <button key={c.id} type="button" onClick={() => onPick(c.id)}
              className="flex w-full items-center justify-between border-b border-border/40 px-3 py-2.5 text-left last:border-0 hover:bg-primary/[0.05]">
              <span className="truncate text-[13.5px] font-medium">{c.name}</span>
              <TonePill tone={c.client_type === 'internal' ? 'success' : 'neutral'}>
                {c.client_type === 'internal' ? 'Internal' : 'External'}
              </TonePill>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// After picking a client, grant the user access to that client's EXISTING
// projects and tasks (or jump to creating a new project). Tri-state per project
// (whole project = on; some tasks = partial). Admins can grant individual tasks;
// managers grant whole projects only (the backend restricts managers to
// project_ids). On save we merge this client's selection into the user's full
// access set across all clients and PATCH project_ids/task_ids.
function GrantClientAccessModal({
  user, clientId, clientName, onClose, onSaved, onAddProject,
}: {
  user: ManagedUser;
  clientId: number;
  clientName: string;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onAddProject: () => void;
}) {
  const projectsQ = useAllProjects();
  const tasksQ = useAllTasks();
  const update = useUpdateUser();

  // Working selection, seeded from the user's current access. We mutate only
  // the ids that belong to THIS client; everything else passes through on save.
  const [projSel, setProjSel] = useState<Set<number>>(() => new Set(user.project_ids ?? []));
  const [taskSel, setTaskSel] = useState<Set<number>>(() => new Set(user.task_ids ?? []));
  const [error, setError] = useState<string | null>(null);
  const [expProj, setExpProj] = useState<Record<number, boolean>>({});

  // Reseed when the target user changes (modal is keyed by clientId in practice).
  useEffect(() => {
    setProjSel(new Set(user.project_ids ?? []));
    setTaskSel(new Set(user.task_ids ?? []));
    setError(null);
  }, [user.id, user.project_ids, user.task_ids]);

  const allProjects = (projectsQ.data ?? []) as unknown as FullProject[];
  const allTasks = (tasksQ.data ?? []) as unknown as FullTask[];
  const clientProjects = useMemo(
    () => allProjects.filter((p) => p.client_id === clientId),
    [allProjects, clientId],
  );
  const tasksByProject = useMemo(() => {
    const m = new Map<number, FullTask[]>();
    allTasks.forEach((t) => { if (!m.has(t.project_id)) m.set(t.project_id, []); m.get(t.project_id)!.push(t); });
    return m;
  }, [allTasks]);

  const projState = (p: FullProject): 'on' | 'partial' | 'off' => {
    if (projSel.has(p.id)) return 'on';
    const tasks = tasksByProject.get(p.id) ?? [];
    const sel = tasks.filter((t) => taskSel.has(t.id)).length;
    if (tasks.length && sel === tasks.length) return 'on';
    return sel > 0 ? 'partial' : 'off';
  };

  function toggleProject(p: FullProject, on: boolean) {
    const tasks = tasksByProject.get(p.id) ?? [];
    setProjSel((prev) => { const n = new Set(prev); if (on) n.add(p.id); else n.delete(p.id); return n; });
    setTaskSel((prev) => {
      const n = new Set(prev);
      // Whole-project grant also marks every task (so the user shows as each
      // task's assignee in Client Management); clearing removes them all.
      tasks.forEach((t) => (on ? n.add(t.id) : n.delete(t.id)));
      return n;
    });
  }
  function toggleTask(t: FullTask) {
    setTaskSel((prev) => { const n = new Set(prev); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; });
    // A per-task change means the project is no longer a "whole project" grant.
    setProjSel((prev) => { if (!prev.has(t.project_id)) return prev; const n = new Set(prev); n.delete(t.project_id); return n; });
  }

  async function save() {
    setError(null);
    // Admins and managers can both grant project + task access for their reports.
    const data = { project_ids: [...projSel], task_ids: [...taskSel] };
    try {
      await update.mutateAsync({ id: user.id, data });
      onSaved('Client access updated.');
    } catch (err) {
      const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof d === 'string' ? d : 'Could not update client access.');
    }
  }

  const Box = ({ state }: { state: 'on' | 'partial' | 'off' }) => (
    <span className={cn('grid h-[18px] w-[18px] shrink-0 place-items-center rounded border',
      state === 'on' ? 'border-primary bg-primary text-white'
        : state === 'partial' ? 'border-primary bg-primary/20 text-primary' : 'border-border text-transparent')}>
      {state === 'partial' ? <Minus className="h-3 w-3" /> : <Check className="h-3 w-3" />}
    </span>
  );

  const loading = projectsQ.isLoading || tasksQ.isLoading;

  return (
    <Modal open onClose={onClose} title={`Grant access · ${clientName}`} className="max-w-2xl">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-[12.5px] text-muted-foreground">
            Select the projects and tasks this user can access.
          </p>
          {/* Both admins and managers (PMs on this client) can create a new
              project here; the backend authorizes managers by client access. */}
          <Button size="sm" variant="secondary" onClick={onAddProject}>
            <Plus className="h-3.5 w-3.5" /> Add project
          </Button>
        </div>

        {loading ? (
          <div className="grid place-items-center py-12 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
          </div>
        ) : clientProjects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
            <Folder className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
            <p className="text-[13px] font-semibold text-foreground">No projects available for this client</p>
            <p className="mt-1 text-[12px] text-muted-foreground">Add a project to assign this user to it.</p>
            <Button size="sm" className="mt-3" onClick={onAddProject}>
              <Plus className="h-3.5 w-3.5" /> Add project
            </Button>
          </div>
        ) : (
          <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
            {clientProjects.map((p) => {
              const tasks = tasksByProject.get(p.id) ?? [];
              const st = projState(p);
              const open = expProj[p.id] ?? false;
              return (
                <div key={p.id} className="overflow-hidden rounded-lg border border-border bg-card">
                  <div className="flex items-center gap-2.5 px-3 py-2.5">
                    <span onClick={() => toggleProject(p, st !== 'on')} className="cursor-pointer"><Box state={st} /></span>
                    <button type="button" onClick={() => setExpProj((s) => ({ ...s, [p.id]: !open }))}
                      className="flex flex-1 items-center gap-2.5 text-left">
                      <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
                      <Folder className="h-4 w-4 shrink-0 text-primary" />
                      <span className="truncate text-[13.5px] font-semibold">{p.name}</span>
                      <span className="ml-auto shrink-0 text-[11.5px] text-muted-foreground">{tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}</span>
                    </button>
                  </div>
                  {/* Per-task selection — available to admins and managers alike
                      (the backend validates task access to the tenant). */}
                  {open ? (
                    <div className="border-t border-border bg-background px-3 py-2">
                      {tasks.length === 0 ? (
                        <p className="px-1 py-2 text-center text-[12px] text-muted-foreground">No tasks on this project.</p>
                      ) : tasks.map((t) => {
                        const on = taskSel.has(t.id) || projSel.has(p.id);
                        return (
                          <label key={t.id} className="flex cursor-pointer items-center gap-2.5 py-1.5">
                            <span onClick={(e) => { e.preventDefault(); toggleTask(t); }}><Box state={on ? 'on' : 'off'} /></span>
                            <span className="text-[13px]">{t.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}

        <div className="sticky bottom-0 -mx-4 mt-2 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => void save()} disabled={update.isPending || loading}>
            {update.isPending ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</> : 'Save access'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
