import { useMemo, useState } from 'react';
import { Briefcase, ChevronRight, Folder, Pencil, Plus, Trash2 } from 'lucide-react';

import { Button, Empty, Modal, TonePill } from '@/components/ui';
import { useAllProjects, useAllTasks, useClients, useDeleteProject, useDeleteTask } from '@/hooks/useAdmin';
import { cn } from '@/lib/cn';
import type { FullProject, FullTask, ManagedUser } from '@/types/admin';
import { ProjectFormModal } from '@/components/clients/ProjectFormModal';
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
// (their project access + task access), with full CRUD for admins (mirrors
// Client Management). Managers get the read-only view + a link out.
export function UserClientAccessTab({ user, isAdmin, onFlash }: {
  user: ManagedUser; isAdmin: boolean; onFlash: (tone: 'ok' | 'err', text: string) => void;
}) {
  const clientsQ = useClients();
  const projectsQ = useAllProjects();
  const tasksQ = useAllTasks();
  const delProject = useDeleteProject();
  const delTask = useDeleteTask();

  const [expClient, setExpClient] = useState<Record<number, boolean>>({});
  const [expProject, setExpProject] = useState<Record<number, boolean>>({});
  const [projModal, setProjModal] = useState<{ clientId: number; project: FullProject | null } | null>(null);
  const [taskModal, setTaskModal] = useState<{ projectId: number; task: FullTask | null } | null>(null);
  // Tab-level "Add client": pick a client, then create a project on it (which
  // is how a user gets assigned to a new client).
  const [addClientOpen, setAddClientOpen] = useState(false);

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

  const byClient = useMemo(() => {
    const m = new Map<number, FullProject[]>();
    userProjects.forEach((p) => { if (!m.has(p.client_id)) m.set(p.client_id, []); m.get(p.client_id)!.push(p); });
    return m;
  }, [userProjects]);

  const clientById = useMemo(() => {
    const m = new Map<number, { name: string; type: string }>();
    (clientsQ.data ?? []).forEach((c) => m.set(c.id, { name: c.name, type: c.client_type }));
    return m;
  }, [clientsQ.data]);

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
        {isAdmin ? (
          <div className="mt-3">
            <Button onClick={() => setAddClientOpen(true)}>
              <Plus className="h-4 w-4" /> Add client
            </Button>
          </div>
        ) : (
          <div className="mt-3">
            <Button variant="secondary" onClick={() => (window.location.href = '/client-management')}>
              <Briefcase className="h-4 w-4" /> Manage assignments in Client Management
            </Button>
          </div>
        )}
        <AddClientPicker
          open={addClientOpen} clients={clientsQ.data ?? []} existingClientIds={new Set(byClient.keys())}
          onClose={() => setAddClientOpen(false)}
          onPick={(cid) => { setAddClientOpen(false); setProjModal({ clientId: cid, project: null }); }}
        />
        {projModal ? (
          <ProjectFormModal open clientId={projModal.clientId} project={projModal.project}
            onClose={() => setProjModal(null)}
            onSaved={() => { onFlash('ok', 'Project created.'); setProjModal(null); }} />
        ) : null}
      </>
    );
  }

  return (
    <div className="space-y-2.5">
      {isAdmin ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAddClientOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Add client
          </Button>
        </div>
      ) : null}
      {[...byClient.entries()].map(([cid, projs]) => {
        const c = clientById.get(cid);
        const open = expClient[cid] ?? true;
        return (
          <div key={cid} className="overflow-hidden rounded-xl border border-border bg-card">
            <button type="button" onClick={() => setExpClient((s) => ({ ...s, [cid]: !open }))}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-primary/[0.04]">
              <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
              <span className="flex-1 truncate text-sm font-semibold">
                {c?.name ?? `Client #${cid}`}{' '}
                <TonePill tone={c?.type === 'internal' ? 'success' : 'neutral'} className="ml-1.5">{c?.type === 'internal' ? 'Internal' : 'External'}</TonePill>
              </span>
              <span className="shrink-0 text-[11.5px] text-muted-foreground">{projs.length} {projs.length === 1 ? 'project' : 'projects'}</span>
            </button>
            {open ? (
              <div className="border-t border-border bg-background px-3 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Projects</span>
                  {isAdmin ? (
                    <Button size="sm" variant="secondary" onClick={() => setProjModal({ clientId: cid, project: null })}>
                      <Plus className="h-3.5 w-3.5" /> Add project
                    </Button>
                  ) : null}
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

      {/* Reuse the Client Management project/task modals for structural CRUD. */}
      {projModal ? (
        <ProjectFormModal
          open
          clientId={projModal.clientId}
          project={projModal.project}
          onClose={() => setProjModal(null)}
          onSaved={() => { onFlash('ok', projModal.project ? 'Project updated.' : 'Project created.'); setProjModal(null); }}
        />
      ) : null}
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
        onPick={(cid) => { setAddClientOpen(false); setProjModal({ clientId: cid, project: null }); }}
      />
    </div>
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
    <Modal open={open} onClose={onClose} title="Add the user to a client" className="max-w-md">
      <div className="space-y-3">
        <p className="text-[12.5px] text-muted-foreground">
          Pick a client, then create a project to assign this user to it.
        </p>
        <input
          autoFocus value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search clients…"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        />
        <div className="max-h-[320px] overflow-y-auto rounded-lg border border-border">
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
