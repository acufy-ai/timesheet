import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import {
  Briefcase,
  Archive,
  ArchiveRestore,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Contact,
  Download,
  ExternalLink,
  FileText,
  FolderPlus,
  Info,
  Loader2,
  Mail,
  Paperclip,
  Pencil,
  Phone,
  Plus,
  Search,
  ShieldCheck,
  StickyNote,
  Tag,
  Trash2,
  UploadCloud,
  User,
  UserPlus,
  Users,
  X,
} from 'lucide-react';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { contractsApi, clientPortalApi } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { Button, Card, Empty, Input, ListSkeleton, Modal, Toast, TonePill, WorkspaceHeader, RequiredMark, FieldError } from '@/components/ui';
import type { Tone } from '@/components/ui';
import { ClientAccessManager } from '@/components/clients/ClientAccessManager';
import { ImportClientsModal } from '@/components/clients/ImportClientsModal';
import { NoteModal, type NoteTarget } from '@/components/notes/NoteModal';
import { ProjectTaskViews } from '@/components/project-views/ProjectTaskViews';
import {
  useAllProjects,
  useAssignableUsers,
  useAllTasks,
  useClientContacts,
  useClientNotes,
  useClients,
  useClientTeam,
  useContracts,
  useCreateClient,
  useCreateClientContact,
  useCreateContract,
  useCreateProject,
  useCreateRoleRate,
  useCreateTask,
  useDeleteClient,
  useDeleteClientContact,
  useDeleteClientNote,
  useDeleteContract,
  useDeleteContractDocument,
  useDeleteProject,
  useArchiveProject,
  useDeleteRoleRate,
  useDeleteTask,
  useNextProjectCode,
  useRoleRates,
  useSetClientTeam,
  useUpdateClient,
  useUpdateClientContact,
  useUpdateContract,
  useUpdateProject,
  useUpdateRoleRate,
  useUpdateTask,
  useUploadContractDocument,
  useCrossTeamStaffing,
} from '@/hooks/useAdmin';
import { useManagerProjectHealth, useSetProjectHealthOverride } from '@/hooks/useDashboard';
import { healthMeta, MANUAL_HEALTH } from '@/lib/projectHealth';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import { staffingPool } from '@/lib/staffing';
import type {
  Client,
  ClientBody,
  ClientContact,
  ClientContactBody,
  ClientNote,
  ClientCapability,
  ClientPortalUser,
  ClientRoleRate,
  ClientRoleRateBody,
  ClientStatus,
  ClientTeamMember,
  ContactChannel,
  Contract,
  ContractBody,
  ContractStatus,
  FullProject,
  FullTask,
  ManagedUser,
  ProjectBody,
  ProjectStatus,
  TaskBody,
  TaskPriority,
  TaskStatus,
} from '@/types/admin';

// Confirm-dialog payload. `danger` (default true) drives the destructive red +
// "Delete" styling; non-destructive actions (archive) pass danger:false with
// their own label/icon.
type ConfirmState = {
  title: string;
  message: string;
  onConfirm: () => void;
  danger?: boolean;
  confirmLabel?: string;
  confirmIcon?: typeof Pencil;
};

// ─────────────────────────────────────────────────────────────────────────
//  Client Management — master-detail redesign.
//
//  Left rail = searchable / filterable client list. Detail pane = client
//  header card + Projects and Team tabs. Projects are expandable cards whose
//  body holds a task accordion. Add/edit of client, project, and task happen
//  in design-system Modals. Admin-only surface (nav already gates it).
//
//  Tabs: Projects, Contacts, Contracts, Roles, Notes, Team — each backed by its
//  own API. Task "status" collapses to the only field tasks carry (is_active);
//  project/task scoping is driven by the real client team roster
//  (/clients/{id}/team).
// ─────────────────────────────────────────────────────────────────────────

const num = (v: string | number | null | undefined): number =>
  v == null || v === '' ? 0 : typeof v === 'string' ? parseFloat(v) || 0 : v;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// All managers a user reports to (multi-manager aware), falling back to the
// legacy single manager_id. Used so org-tree walks include co-managed reports,
// not just those under a person's primary manager.
function managersOfUser(u: { manager_id?: number | null; manager_ids?: number[] }): number[] {
  if (u.manager_ids && u.manager_ids.length) return u.manager_ids;
  return u.manager_id != null ? [u.manager_id] : [];
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y) return iso;
  return `${MONTHS[(m || 1) - 1]} ${d || 1}, ${y}`;
}
function fmtMoney(v: string | number | null | undefined): string {
  const n = num(v);
  if (n >= 1000 && n % 1000 === 0) return '$' + n / 1000 + 'k';
  if (n >= 10000) return '$' + Math.round(n / 1000) + 'k';
  return '$' + n.toLocaleString('en-US');
}
function fmtSize(bytes?: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function errText(err: unknown, fallback: string): string {
  const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof d === 'string' ? d : fallback;
}

const CLIENT_STATUS_LABEL: Record<ClientStatus, string> = {
  active: 'Active',
  prospect: 'Prospect',
  on_hold: 'On hold',
  churned: 'Churned',
};
const CLIENT_STATUS_TONE: Record<ClientStatus, Tone> = {
  active: 'success',
  prospect: 'info',
  on_hold: 'warning',
  churned: 'danger',
};
const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  planning: 'Planning',
  in_progress: 'In progress',
  on_hold: 'On hold',
  completed: 'Completed',
};
const PROJECT_STATUS_TONE: Record<ProjectStatus, Tone> = {
  planning: 'info',
  in_progress: 'brand',
  on_hold: 'warning',
  completed: 'success',
};
const CONTRACT_STATUS_LABEL: Record<ContractStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
  churned: 'Churned',
};
const CONTRACT_STATUS_TONE: Record<ContractStatus, Tone> = {
  draft: 'neutral',
  active: 'success',
  on_hold: 'warning',
  completed: 'info',
  churned: 'danger',
};

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  to_do: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
};
// Dot colors for the inline status select (mirror the tone palette).
const TASK_STATUS_DOT: Record<TaskStatus, string> = {
  to_do: 'bg-muted-foreground/40',
  in_progress: 'bg-primary',
  blocked: 'bg-rose-500',
  done: 'bg-emerald-500',
};
const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};
const TASK_PRIORITY_DOT: Record<TaskPriority, string> = {
  high: 'bg-rose-500',
  medium: 'bg-amber-500',
  low: 'bg-muted-foreground',
};

export function ClientsPage() {
  const { user: actingUser } = useAuth();
  const pageQc = useQueryClient();
  // Client Management is for ADMIN, MANAGER, or reviewers (mirrors the backend
  // require_client_manager gate). VIEWER/EMPLOYEE have no client surface, so
  // they're bounced to the dashboard on a direct visit — the nav already hides
  // the link, this closes the direct-URL hole. The role check drives both the
  // redirect below and whether write controls (Add client, etc.) render.
  const canManageClients =
    actingUser?.role === 'ADMIN' ||
    actingUser?.role === 'PLATFORM_ADMIN' ||
    actingUser?.role === 'MANAGER' ||
    actingUser?.can_review === true;
  const clientsQ = useClients();
  const projectsQ = useAllProjects();
  const tasksQ = useAllTasks();
  // Project health (5-tier) keyed by project_id, from the same source the
  // dashboard/portfolio use so the status reconciles. Role-gated server-side
  // (MANAGER/VIEWER/ADMIN); other roles just get no pills (hook returns empty).
  const healthQ = useManagerProjectHealth(canManageClients);
  const healthByProject = useMemo(() => {
    // health + whether it's a manual override (reason is prefixed "Manually set"
    // by the API) so the inline menu can show the active/clear state correctly.
    const m = new Map<number, { health: string; isManual: boolean }>();
    (healthQ.data?.rows ?? []).forEach((r) =>
      m.set(r.project_id, { health: r.health, isManual: (r.health_reason ?? '').startsWith('Manually set') }));
    return m;
  }, [healthQ.data]);
  // Full tenant directory (all roles), not the caller's org-chart subtree.
  // GET /users scopes a MANAGER to their reports only, which starved the
  // client/project pickers (no peer managers, unresolved PM names -> "#5").
  // /users/assignable returns every tenant user and is allowed for managers.
  const usersQ = useAssignableUsers();

  const delClient = useDeleteClient();
  const delProject = useDeleteProject();
  const archiveProjectMut = useArchiveProject();
  const delTask = useDeleteTask();

  // Selected client + tab are persisted in the URL (?client=<id>&tab=<tab>) so a
  // page refresh restores the same view instead of snapping back to the first
  // client. setActiveClientId / setActiveTab keep the same call sites; they just
  // write through to the query string now.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeClientId = searchParams.get('client') ? Number(searchParams.get('client')) : null;
  const activeTab = (searchParams.get('tab') as
    | 'projects' | 'contacts' | 'contracts' | 'roles' | 'notes' | 'access' | null) ?? 'projects';
  // Single writer for the client/tab query params. React Router's
  // setSearchParams does NOT chain functional updates the way useState does, so
  // two back-to-back calls (select client + reset tab) race and the second wins
  // with a stale base. We always derive `next` from the current searchParams and
  // apply both changes in one call to avoid that.
  const updateSelection = (patch: { client?: number | null; tab?: string }) => {
    const next = new URLSearchParams(searchParams);
    if ('client' in patch) {
      if (patch.client == null) {
        next.delete('client');
        next.delete('tab');
      } else {
        next.set('client', String(patch.client));
      }
    }
    if (patch.tab != null) next.set('tab', patch.tab);
    setSearchParams(next, { replace: true });
  };
  const setActiveClientId = (id: number | null) => updateSelection({ client: id });
  const setActiveTab = (tab: 'projects' | 'contacts' | 'contracts' | 'roles' | 'notes' | 'access') =>
    updateSelection({ tab });
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'internal' | 'external'>('all');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const [clientModal, setClientModal] = useState<{ open: boolean; client: Client | null }>({ open: false, client: null });
  const [importing, setImporting] = useState(false);
  const [projectModal, setProjectModal] = useState<{ open: boolean; project: FullProject | null }>({ open: false, project: null });
  const [taskModal, setTaskModal] = useState<{ open: boolean; project: FullProject | null; task: FullTask | null }>({ open: false, project: null, task: null });
  // Add-note launched from a project or task row (locked target).
  const [noteModal, setNoteModal] = useState<{ open: boolean; target: NoteTarget | null }>({ open: false, target: null });
  const openNoteFor = (project: FullProject, task?: FullTask) => setNoteModal({
    open: true,
    target: {
      mode: 'locked',
      projectId: project.id, projectName: project.name, projectCode: project.code,
      taskId: task?.id ?? null, taskName: task?.name ?? null, taskStatus: task?.status ?? null,
    },
  });

  const flashAndFade = (tone: 'ok' | 'err', text: string) => {
    setFlash({ tone, text });
    window.setTimeout(() => setFlash(null), 4000);
  };

  const clients = clientsQ.data ?? [];
  const projects = (projectsQ.data ?? []) as unknown as FullProject[];
  const tasks = (tasksQ.data ?? []) as unknown as FullTask[];
  const users = (usersQ.data ?? []) as ManagedUser[];

  const userById = useMemo(() => {
    const m = new Map<number, ManagedUser>();
    users.forEach((u) => m.set(u.id, u));
    return m;
  }, [users]);

  // The acting user + everyone in their org-chain subtree (transitive reports).
  // Used to staff a PM-less project from the task modal: a manager may only
  // assign themselves and the people under them (mirrors the backend check).
  const myTeam = useMemo<ManagedUser[]>(() => {
    if (!actingUser) return [];
    const meId = actingUser.id;
    const ids = new Set<number>([meId]);
    let grew = true;
    while (grew) {
      grew = false;
      users.forEach((u) => {
        // A report is in the subtree if ANY of their managers is already in it
        // (co-managed reports count under every manager, not just the primary).
        if (!ids.has(u.id) && managersOfUser(u).some((mid) => ids.has(mid))) {
          ids.add(u.id); grew = true;
        }
      });
    }
    return users.filter((u) => ids.has(u.id));
  }, [users, actingUser]);

  const projectsByClient = useMemo(() => {
    const m = new Map<number, FullProject[]>();
    projects.forEach((p) => {
      const l = m.get(p.client_id) ?? [];
      l.push(p);
      m.set(p.client_id, l);
    });
    return m;
  }, [projects]);

  const tasksByProject = useMemo(() => {
    const m = new Map<number, FullTask[]>();
    tasks.forEach((t) => {
      const l = m.get(t.project_id) ?? [];
      l.push(t);
      m.set(t.project_id, l);
    });
    return m;
  }, [tasks]);

  // Auto-select the first client once data lands and nothing valid is picked.
  // Also covers a stale URL pointing at a client that no longer exists (or that
  // this user can't see) — fall back to the first available client.
  useEffect(() => {
    if (!clients.length) return;
    const picked = activeClientId != null && clients.some((c) => c.id === activeClientId);
    if (!picked) setActiveClientId(clients[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClientId, clients]);

  // Deep link to a specific project (e.g. from the dashboard "Clients & projects"
  // widget): ?project=<id> expands that project card and scrolls it into view,
  // then drops the param so it doesn't re-fire on later interactions.
  const projectParam = searchParams.get('project');
  useEffect(() => {
    if (!projectParam) return;
    const pid = Number(projectParam);
    if (!Number.isFinite(pid)) return;
    if (!projects.some((p) => p.id === pid)) return; // wait until projects load
    setExpanded((s) => ({ ...s, [pid]: true }));
    const t = window.setTimeout(() => {
      document.getElementById(`project-${pid}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
    const next = new URLSearchParams(searchParams);
    next.delete('project');
    setSearchParams(next, { replace: true });
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectParam, projects]);

  const activeClient = clients.find((c) => c.id === activeClientId) ?? null;
  const teamQ = useClientTeam(activeClient?.id ?? null);
  const team = (teamQ.data ?? []) as ClientTeamMember[];
  const contractsQ = useContracts(activeClient?.id ?? null);
  const contracts = (contractsQ.data ?? []) as Contract[];
  const contactsQ = useClientContacts(activeClient?.id ?? null);
  const clientContacts = (contactsQ.data ?? []) as ClientContact[];
  const rolesQ = useRoleRates(activeClient?.id ?? null);
  const roleRates = (rolesQ.data ?? []) as ClientRoleRate[];
  // How many people in the tenant hold each title (case-insensitive). Lets the
  // Roles card show "Senior Engineer $180 · 4 people" so a manager sees, at a
  // glance, that the rate applies to real staff — no drilling into each user.
  const titleCounts = useMemo(() => {
    const m = new Map<string, number>();
    users.forEach((u) => {
      const t = (u.title ?? '').trim().toLowerCase();
      if (t) m.set(t, (m.get(t) ?? 0) + 1);
    });
    return m;
  }, [users]);
  const notesQ = useClientNotes(activeClient?.id ?? null);
  const clientNotes = (notesQ.data ?? []) as ClientNote[];
  // Client-access count for the tab badge. Shares the same query key as the
  // ClientAccessManager tab so it reads from cache (no duplicate fetch).
  const accessUsersQ = useQuery({
    queryKey: ['client-portal-users', activeClient?.id ?? 0],
    queryFn: () => clientPortalApi.clientUsers(activeClient!.id).then((r) => r.data),
    enabled: !!activeClient,
  });
  const accessCount = (accessUsersQ.data ?? []).length;
  const teamPms = useMemo(() => team.filter((m) => m.assignment_role === 'pm'), [team]);

  const nameOf = (uid: number): string => userById.get(uid)?.full_name ?? team.find((m) => m.user_id === uid)?.full_name ?? `#${uid}`;

  // ── Delete handlers ──────────────────────────────────────────────
  function removeClient(c: Client) {
    setConfirm({
      title: 'Delete client?',
      message: `"${c.name}" and all its projects and tasks will be removed.`,
      onConfirm: async () => {
        try {
          await delClient.mutateAsync(c.id);
          flashAndFade('ok', 'Client deleted.');
          if (activeClientId === c.id) setActiveClientId(null);
        } catch (e) {
          flashAndFade('err', errText(e, 'Could not delete the client.'));
        }
      },
    });
  }
  function removeProject(p: FullProject) {
    setConfirm({
      title: 'Delete project?',
      message: `"${p.name}" and its tasks will be removed.`,
      onConfirm: async () => {
        try {
          await delProject.mutateAsync(p.id);
          flashAndFade('ok', 'Project deleted.');
        } catch (e) {
          flashAndFade('err', errText(e, 'Could not delete the project.'));
        }
      },
    });
  }
  // Archive hides the project from active + loggable lists (no new time) but
  // keeps its history; reversible. Confirm on archive (it stops logging);
  // unarchive is immediate.
  async function archiveProject(p: FullProject) {
    const run = async () => {
      try {
        await archiveProjectMut.mutateAsync({ id: p.id, archived: p.is_active });
        flashAndFade('ok', p.is_active ? `"${p.name}" archived.` : `"${p.name}" restored.`);
      } catch (e) {
        flashAndFade('err', errText(e, 'Could not update the project.'));
      }
    };
    if (p.is_active) {
      setConfirm({
        title: 'Archive project?',
        message: `"${p.name}" will be hidden from active lists and no new time can be logged against it. Its history stays, and you can restore it anytime.`,
        onConfirm: run,
        danger: false,
        confirmLabel: 'Archive',
        confirmIcon: Archive,
      });
    } else {
      await run();
    }
  }
  function removeTask(t: FullTask) {
    setConfirm({
      title: 'Delete task?',
      message: `"${t.name}" will be removed.`,
      onConfirm: async () => {
        try {
          await delTask.mutateAsync(t.id);
          flashAndFade('ok', 'Task deleted.');
        } catch (e) {
          flashAndFade('err', errText(e, 'Could not delete the task.'));
        }
      },
    });
  }

  // ── Rail list (search + type filter) ─────────────────────────────
  // Search spans client name/contact/company, project names + codes, the task
  // names under each project, and any assignee names resolvable from the roster.
  const filtered = clients.filter((c) => {
    const q = search.trim().toLowerCase();
    const clientProjects = projectsByClient.get(c.id) ?? [];
    const matchesSearch =
      !q ||
      c.name.toLowerCase().includes(q) ||
      (c.contact_name ?? '').toLowerCase().includes(q) ||
      (c.contact_email ?? '').toLowerCase().includes(q) ||
      (c.contact_phone ?? '').toLowerCase().includes(q) ||
      (c.company ?? '').toLowerCase().includes(q) ||
      clientProjects.some(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.code ?? '').toLowerCase().includes(q) ||
          (tasksByProject.get(p.id) ?? []).some(
            (t) =>
              t.name.toLowerCase().includes(q) ||
              (t.assignee_ids ?? []).some((id) => nameOf(id).toLowerCase().includes(q)),
          ),
      );
    const matchesType = typeFilter === 'all' || c.client_type === typeFilter;
    return matchesSearch && matchesType;
  });

  const totalProjects = projects.length;

  // Bounce roles with no client surface (VIEWER/EMPLOYEE) to the dashboard,
  // so a direct /client-management URL can't render the page shell + write
  // buttons. Wait until the user is loaded to avoid a flash-redirect on mount.
  if (actingUser && !canManageClients) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        title="Client Management"
        description={`${clients.length} ${clients.length === 1 ? 'client' : 'clients'} · ${totalProjects} ${totalProjects === 1 ? 'project' : 'projects'}`}
        primary={
          canManageClients ? (
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => setImporting(true)}>
                <Download className="h-4 w-4" /> Import
              </Button>
              <Button onClick={() => setClientModal({ open: true, client: null })}>
                <Plus className="h-4 w-4" /> Add client
              </Button>
            </div>
          ) : null
        }
      />

      {flash ? (
        <Toast tone={flash.tone} message={flash.text} onDismiss={() => setFlash(null)} />
      ) : null}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[320px_1fr]">
        {/* ── Left rail: master client list ───────────────────────── */}
        <Card className="flex max-h-[78vh] flex-col overflow-hidden p-0">
          <div className="border-b border-border p-3">
            <div className="mb-2 flex items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Clients</p>
              <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[10px] font-bold text-primary">{clients.length}</span>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" placeholder="Search clients" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              {(['all', 'internal', 'external'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTypeFilter(t)}
                  className={cn('pill text-xs capitalize', typeFilter === t ? 'pill-active' : 'pill-idle bg-muted')}
                >
                  {t === 'all' ? 'All' : t}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {clientsQ.isLoading ? (
              <ListSkeleton rows={7} />
            ) : filtered.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">No clients match your search.</p>
            ) : (
              filtered.map((c) => {
                const projCount = (projectsByClient.get(c.id) ?? []).length;
                const status: ClientStatus = c.status ?? 'active';
                const active = c.id === activeClientId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => updateSelection({ client: c.id, tab: 'projects' })}
                    className={cn(
                      'mb-1 flex w-full items-center gap-3 rounded-xl border px-2.5 py-2 text-left transition-colors',
                      active ? 'border-primary/30 bg-primary/10' : 'border-transparent hover:bg-primary/5',
                    )}
                  >
                    <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl text-xs font-semibold', avatarTone(c.name))}>
                      {initials(c.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-foreground">{c.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {projCount} {projCount === 1 ? 'project' : 'projects'} · {c.client_type === 'internal' ? 'Internal' : 'External'}
                      </span>
                    </span>
                    <TonePill tone={CLIENT_STATUS_TONE[status]}>{CLIENT_STATUS_LABEL[status]}</TonePill>
                  </button>
                );
              })
            )}
          </div>
        </Card>

        {/* ── Detail pane ─────────────────────────────────────────── */}
        <div className="min-w-0">
          {!activeClient ? (
            <Empty Icon={Users} title="No client selected" description="Pick a client from the list to view its projects and team." />
          ) : (
            <div className="space-y-5">
              <ClientHeaderCard
                client={activeClient}
                onEdit={() => setClientModal({ open: true, client: activeClient })}
                onDelete={() => void removeClient(activeClient)}
              />

              {/* Tabs */}
              <div className="flex flex-wrap items-center gap-1 border-b border-border">
                <TabButton active={activeTab === 'projects'} onClick={() => setActiveTab('projects')} Icon={Briefcase} label="Projects" count={(projectsByClient.get(activeClient.id) ?? []).length} />
                <TabButton active={activeTab === 'contacts'} onClick={() => setActiveTab('contacts')} Icon={Contact} label="Contacts" count={clientContacts.length} />
                <TabButton active={activeTab === 'contracts'} onClick={() => setActiveTab('contracts')} Icon={FileText} label="Contracts" count={contracts.length} />
                <TabButton active={activeTab === 'roles'} onClick={() => setActiveTab('roles')} Icon={Tag} label="Roles" count={roleRates.length} />
                <TabButton active={activeTab === 'notes'} onClick={() => setActiveTab('notes')} Icon={StickyNote} label="Notes" count={clientNotes.length} />
                <TabButton active={activeTab === 'access'} onClick={() => setActiveTab('access')} Icon={ShieldCheck} label="Client access" count={accessCount} />
              </div>

              {activeTab === 'projects' ? (
                <ProjectsTab
                  client={activeClient}
                  projects={projectsByClient.get(activeClient.id) ?? []}
                  tasksByProject={tasksByProject}
                  healthByProject={healthByProject}
                  loading={projectsQ.isLoading}
                  expanded={expanded}
                  nameOf={nameOf}
                  onToggle={(id) => setExpanded((s) => ({ ...s, [id]: !s[id] }))}
                  onAddProject={() => setProjectModal({ open: true, project: null })}
                  onEditProject={(p) => setProjectModal({ open: true, project: p })}
                  onDeleteProject={(p) => void removeProject(p)}
                  onArchiveProject={(p) => void archiveProject(p)}
                  onAddTask={(p) => setTaskModal({ open: true, project: p, task: null })}
                  onEditTask={(p, t) => setTaskModal({ open: true, project: p, task: t })}
                  onDeleteTask={(t) => void removeTask(t)}
                  onAddNote={openNoteFor}
                />
              ) : activeTab === 'contacts' ? (
                <ContactsTab
                  clientId={activeClient.id}
                  contacts={clientContacts}
                  loading={contactsQ.isLoading}
                  onConfirm={setConfirm}
                  onSaved={(m) => flashAndFade('ok', m)}
                  onError={(m) => flashAndFade('err', m)}
                />
              ) : activeTab === 'contracts' ? (
                <ContractsTab
                  clientId={activeClient.id}
                  contracts={contracts}
                  loading={contractsQ.isLoading}
                  onConfirm={setConfirm}
                  onSaved={(m) => flashAndFade('ok', m)}
                  onError={(m) => flashAndFade('err', m)}
                />
              ) : activeTab === 'roles' ? (
                <RolesTab
                  clientId={activeClient.id}
                  roles={roleRates}
                  titleCounts={titleCounts}
                  loading={rolesQ.isLoading}
                  onConfirm={setConfirm}
                  onSaved={(m) => flashAndFade('ok', m)}
                  onError={(m) => flashAndFade('err', m)}
                />
              ) : activeTab === 'notes' ? (
                <NotesTab
                  clientId={activeClient.id}
                  notes={clientNotes}
                  projects={projectsByClient.get(activeClient.id) ?? []}
                  tasksByProject={tasksByProject}
                  loading={notesQ.isLoading}
                  onConfirm={setConfirm}
                  onSaved={(m) => flashAndFade('ok', m)}
                  onError={(m) => flashAndFade('err', m)}
                />
              ) : (
                <ClientAccessManager
                  clientId={activeClient.id}
                  clientName={activeClient.name}
                  onFlash={flashAndFade}
                />
              )}
            </div>
          )}
        </div>
      </div>

      <ClientModal
        open={clientModal.open}
        client={clientModal.client}
        users={users}
        onClose={() => setClientModal({ open: false, client: null })}
        onSaved={(m, id) => {
          flashAndFade('ok', m);
          if (id != null) setActiveClientId(id);
        }}
      />
      <ImportClientsModal
        open={importing}
        onClose={() => setImporting(false)}
        onDone={(m) => {
          flashAndFade('ok', m);
          // Refresh everything the import touched.
          ['clients', 'projects', 'tasks'].forEach((k) =>
            pageQc.invalidateQueries({ queryKey: [k] }));
        }}
      />
      {activeClient ? (
        <ProjectModal
          open={projectModal.open}
          clientId={activeClient.id}
          clients={clients}
          project={projectModal.project}
          pms={teamPms}
          users={users}
          tasks={projectModal.project ? tasksByProject.get(projectModal.project.id) ?? [] : []}
          nameOf={nameOf}
          onClose={() => setProjectModal({ open: false, project: null })}
          onSaved={(m) => flashAndFade('ok', m)}
        />
      ) : null}
      {taskModal.project ? (
        <TaskModal
          open={taskModal.open}
          project={taskModal.project}
          task={taskModal.task}
          myTeam={myTeam}
          users={users}
          clientPmIds={teamPms.map((m) => m.user_id)}
          actingUserName={actingUser?.full_name ?? 'me'}
          actingUserRole={actingUser?.role}
          nameOf={nameOf}
          onFlash={flashAndFade}
          onClose={() => setTaskModal({ open: false, project: null, task: null })}
          onSaved={(m) => {
            flashAndFade('ok', m);
            if (taskModal.project) setExpanded((s) => ({ ...s, [taskModal.project!.id]: true }));
          }}
        />
      ) : null}

      {/* Add-note launched from a project/task row (locked target). */}
      {activeClient && noteModal.target ? (
        <NoteModal
          open={noteModal.open}
          clientId={activeClient.id}
          target={noteModal.target}
          onClose={() => setNoteModal({ open: false, target: null })}
          onSaved={(m) => { flashAndFade('ok', m); }}
          onError={(m) => flashAndFade('err', m)}
        />
      ) : null}

      <ConfirmDialog
        confirm={confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          confirm?.onConfirm();
          setConfirm(null);
        }}
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
//  Detail-pane subcomponents
// ════════════════════════════════════════════════════════════════════════

function ClientHeaderCard({ client, onEdit, onDelete }: { client: Client; onEdit: () => void; onDelete: () => void }) {
  const internal = client.client_type === 'internal';
  const status: ClientStatus = client.status ?? 'active';
  return (
    <Card className="flex items-start gap-4 p-5">
      <span className={cn('grid h-12 w-12 shrink-0 place-items-center rounded-2xl text-base font-semibold', avatarTone(client.name))}>
        {initials(client.name)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate text-xl font-bold text-foreground">{client.name}</h2>
          <TonePill tone={CLIENT_STATUS_TONE[status]}>{CLIENT_STATUS_LABEL[status]}</TonePill>
          <TonePill tone={internal ? 'success' : 'neutral'}>{internal ? 'Internal' : 'External'}</TonePill>
        </div>
        {client.company ? <p className="mt-0.5 truncate text-sm text-muted-foreground">{client.company}</p> : null}
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-muted-foreground">
          {client.contact_name ? (
            <span className="inline-flex items-center gap-1.5">
              <User className="h-4 w-4" /> {client.contact_name}
            </span>
          ) : null}
          {client.contact_email ? (
            <span className="inline-flex items-center gap-1.5">
              <Mail className="h-4 w-4" /> {client.contact_email}
            </span>
          ) : null}
          {client.contact_phone ? (
            <span className="inline-flex items-center gap-1.5">
              <Phone className="h-4 w-4" /> {client.contact_phone}
            </span>
          ) : null}
          {client.since ? (
            <span className="inline-flex items-center gap-1.5">
              <Calendar className="h-4 w-4" /> Client since {fmtDate(client.since)}
            </span>
          ) : null}
          {!client.contact_name && !client.contact_email && !client.contact_phone && !client.since ? (
            <span className="inline-flex items-center gap-1.5">
              <Calendar className="h-4 w-4" /> No primary contact on file
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label="Edit client" onClick={onEdit} Icon={Pencil} />
        <IconButton label="Delete client" onClick={onDelete} Icon={Trash2} danger />
      </div>
    </Card>
  );
}

function TabButton({ active, onClick, Icon, label, count }: { active: boolean; onClick: () => void; Icon: typeof Briefcase; label: string; count?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        '-mb-px inline-flex items-center gap-2 border-b-2 px-3.5 pb-3 pt-2 text-sm font-semibold transition-colors',
        active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="h-4 w-4" /> {label}
      {count !== undefined ? (
        <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-bold', active ? 'bg-primary/12 text-primary' : 'bg-muted text-muted-foreground')}>{count}</span>
      ) : null}
    </button>
  );
}

function ProjectsTab({
  client,
  projects,
  tasksByProject,
  healthByProject,
  loading,
  expanded,
  nameOf,
  onToggle,
  onAddProject,
  onEditProject,
  onDeleteProject,
  onArchiveProject,
  onAddTask,
  onEditTask,
  onDeleteTask,
  onAddNote,
}: {
  client: Client;
  projects: FullProject[];
  tasksByProject: Map<number, FullTask[]>;
  healthByProject: Map<number, { health: string; isManual: boolean }>;
  loading: boolean;
  expanded: Record<number, boolean>;
  nameOf: (uid: number) => string;
  onToggle: (id: number) => void;
  onAddProject: () => void;
  onEditProject: (p: FullProject) => void;
  onDeleteProject: (p: FullProject) => void;
  onArchiveProject: (p: FullProject) => void;
  onAddTask: (p: FullProject) => void;
  onEditTask: (p: FullProject, t: FullTask) => void;
  onDeleteTask: (t: FullTask) => void;
  onAddNote: (p: FullProject, t?: FullTask) => void;
}) {
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  // Search any field: name, code (the PR#### id), description, status, and the
  // names of tasks under the project (so finding a task surfaces its project).
  const filtered = projects.filter((p) => {
    if (!q) return true;
    const taskNames = (tasksByProject.get(p.id) ?? []).map((t) => t.name).join(' ');
    return [
      p.name,
      p.code ?? '',
      p.description ?? '',
      p.status ? PROJECT_STATUS_LABEL[p.status] : '',
      taskNames,
    ].some((field) => field.toLowerCase().includes(q));
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search projects..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Button size="sm" className="ml-auto" onClick={onAddProject}>
          <Plus className="h-4 w-4" /> Add project
        </Button>
      </div>

      {loading ? (
        <Loader />
      ) : projects.length === 0 ? (
        <Empty
          Icon={FolderPlus}
          title="No projects yet"
          description={`Add a project so the team can log time and tasks against ${client.name}.`}
          action={
            <Button size="sm" onClick={onAddProject}>
              Add project
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <Empty Icon={FolderPlus} title="No projects match" description="Try a different search." />
      ) : (
        filtered.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            tasks={tasksByProject.get(p.id) ?? []}
            health={healthByProject.get(p.id)}
            open={!!expanded[p.id]}
            nameOf={nameOf}
            onToggle={() => onToggle(p.id)}
            onEdit={() => onEditProject(p)}
            onDelete={() => onDeleteProject(p)}
            onArchive={() => onArchiveProject(p)}
            onAddTask={() => onAddTask(p)}
            onEditTask={(t) => onEditTask(p, t)}
            onDeleteTask={onDeleteTask}
            onAddNote={(t) => onAddNote(p, t)}
          />
        ))
      )}
    </div>
  );
}

// Project health as an inline native <select>, MATCHING the task-status select
// so "set a status" is one consistent interaction across the page (no custom
// popover that clips inside the row). Options are the 4 manual tiers + "Auto"
// (clears the override). The leading dot shows the current health color; a
// pencil marks a manual override. The native option list renders in the
// browser's top layer, so it never gets clipped by the row's overflow.
function ProjectHealthSelect({ projectId, health, isManual }: { projectId: number; health: string; isManual: boolean }) {
  const meta = healthMeta(health);
  const setOverride = useSetProjectHealthOverride();
  // Value the select shows: a manual tier when overridden, else 'auto'.
  const value = isManual ? health : 'auto';

  const onChange = (next: string) => {
    if (next === value) return;
    // 'auto' clears the override; any tier sets it.
    setOverride.mutate({ projectId, health: next === 'auto' ? null : next });
  };

  return (
    <span className="relative inline-flex items-center" onClick={(e) => e.stopPropagation()}>
      <span className={cn('pointer-events-none absolute left-2 h-2 w-2 rounded-full', meta.dot)} />
      <select
        value={value}
        disabled={setOverride.isPending}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Set project health"
        title={isManual ? 'Health set manually — change or pick Auto' : 'Set project health'}
        className={cn(
          'cursor-pointer rounded-full border bg-card py-0.5 pl-6 text-[11px] font-semibold uppercase tracking-wider text-foreground transition-colors hover:border-primary/40 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60',
          isManual ? 'border-primary/40 pr-7' : 'border-border pr-6',
        )}
      >
        {/* Auto: shows the computed health so you still see the current state. */}
        <option value="auto">{`Auto · ${meta.label}`}</option>
        {MANUAL_HEALTH.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {isManual ? <Pencil className="pointer-events-none absolute right-2 h-3 w-3 text-muted-foreground" aria-hidden /> : null}
    </span>
  );
}

// Client-facing health select. Separate from ProjectHealthSelect (internal RAG)
// — this is the on_track/at_risk/off_track value the CLIENT sees in the portal.
// "Hidden" (null) means no pill in the portal. Saved via the project update.
const CLIENT_HEALTH_OPTS = [
  { value: '', label: 'Client: hidden', dot: 'bg-muted-foreground/30' },
  { value: 'on_track', label: 'Client: on track', dot: 'bg-emerald-500' },
  { value: 'at_risk', label: 'Client: at risk', dot: 'bg-amber-500' },
  { value: 'off_track', label: 'Client: off track', dot: 'bg-rose-500' },
];

function ClientHealthSelect({ project }: { project: FullProject }) {
  const update = useUpdateProject();
  const value = project.client_health ?? '';
  const dot = CLIENT_HEALTH_OPTS.find((o) => o.value === value)?.dot ?? 'bg-muted-foreground/30';
  const onChange = (next: string) => {
    if (next === value) return;
    // '' clears it (hidden); clearing also drops the note.
    update.mutate({ id: project.id, data: { client_health: next as any, ...(next ? {} : { client_health_note: null }) } });
  };
  return (
    <span className="relative inline-flex items-center" onClick={(e) => e.stopPropagation()}>
      <span className={cn('pointer-events-none absolute left-2 h-2 w-2 rounded-full', dot)} />
      <select
        value={value}
        disabled={update.isPending}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Set client-facing health"
        title="Health shown to the client in their portal (separate from internal health)"
        className="cursor-pointer rounded-full border border-border bg-card py-0.5 pl-6 pr-6 text-[11px] font-semibold uppercase tracking-wider text-foreground transition-colors hover:border-primary/40 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
      >
        {CLIENT_HEALTH_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </span>
  );
}

function ProjectCard({
  project,
  tasks,
  health,
  open,
  nameOf,
  onToggle,
  onEdit,
  onDelete,
  onArchive,
  onAddTask,
  onEditTask,
  onDeleteTask,
  onAddNote,
}: {
  project: FullProject;
  tasks: FullTask[];
  health?: { health: string; isManual: boolean };
  open: boolean;
  nameOf: (uid: number) => string;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onAddTask: () => void;
  onEditTask: (t: FullTask) => void;
  onDeleteTask: (t: FullTask) => void;
  onAddNote: (t?: FullTask) => void;
}) {
  // "Progress" = done tasks over total, driven by the 3-state task status.
  const done = tasks.filter((t) => t.status === 'done').length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  // Everyone working on any task in this project — surfaced as an avatar stack
  // on the row so you can see at a glance that people are staffed on its tasks,
  // without expanding it. De-duplicated across tasks, first-seen order.
  const taskAssignees: number[] = [];
  const seenAssignee = new Set<number>();
  tasks.forEach((t) => (t.assignee_ids ?? []).forEach((id) => {
    if (!seenAssignee.has(id)) { seenAssignee.add(id); taskAssignees.push(id); }
  }));
  const shownAssignees = taskAssignees.slice(0, 4);
  const pmIds = project.manager_ids?.length ? project.manager_ids : (project.manager_id != null ? [project.manager_id] : []);
  const pmLabel = pmIds.length === 0
    ? 'PM unassigned'
    : pmIds.length === 1
      ? `PM: ${nameOf(pmIds[0])}`
      : `PMs: ${pmIds.map(nameOf).join(', ')}`;
  const status: ProjectStatus = project.status ?? (project.is_active ? 'in_progress' : 'completed');

  const sub = [
    pmLabel,
    project.end_date ? `Due ${fmtDate(project.end_date)}` : null,
    project.budget_amount ? fmtMoney(project.budget_amount) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Card id={`project-${project.id}`} className="overflow-hidden p-0 scroll-mt-24">
      <div className={cn('flex items-center gap-3 px-4 py-3', open ? '' : 'rounded-2xl')}>
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-sm font-semibold text-foreground">{project.name}</p>
              {project.code ? <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{project.code}</span> : null}
              {!project.is_active ? <TonePill tone="neutral">Archived</TonePill> : null}
            </div>
            <p className="truncate text-xs text-muted-foreground">{sub}</p>
          </div>
        </button>
        <div className="hidden min-w-[130px] items-center gap-2 sm:flex">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="whitespace-nowrap text-[11px] text-muted-foreground">
            {done}/{tasks.length}
          </span>
        </div>
        {taskAssignees.length ? (
          <div className="hidden items-center sm:flex" title={`${taskAssignees.length} ${taskAssignees.length === 1 ? 'person' : 'people'} on this project's tasks`}>
            {shownAssignees.map((id, i) => {
              const nm = nameOf(id);
              return (
                <span key={id} title={nm}
                  className={cn('grid h-6 w-6 place-items-center rounded-full text-[9px] font-semibold ring-2 ring-card', avatarTone(nm), i > 0 && '-ml-1.5')}>
                  {initials(nm)}
                </span>
              );
            })}
            {taskAssignees.length > 4 ? (
              <span className="-ml-1.5 grid h-6 w-6 place-items-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground ring-2 ring-card">
                +{taskAssignees.length - 4}
              </span>
            ) : null}
          </div>
        ) : null}
        {/* Health (5-tier, auto/overridden) sits alongside the lifecycle status:
            health = "how is it going", status = "what stage is it in". Inline
            select (matching the task-status pattern) sets the manual override. */}
        {health ? (
          <ProjectHealthSelect projectId={project.id} health={health.health} isManual={health.isManual} />
        ) : null}
        <ClientHealthSelect project={project} />
        <TonePill tone={PROJECT_STATUS_TONE[status]}>{PROJECT_STATUS_LABEL[status]}</TonePill>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label="Add note to this project" onClick={() => onAddNote()} Icon={StickyNote} sm />
          <IconButton label="Edit project" onClick={onEdit} Icon={Pencil} sm />
          <IconButton
            label={project.is_active ? 'Archive project' : 'Unarchive project'}
            onClick={onArchive}
            Icon={project.is_active ? Archive : ArchiveRestore}
            sm
          />
          <IconButton label="Delete project" onClick={onDelete} Icon={Trash2} sm danger />
        </div>
      </div>

      {open ? (
        <div className="border-t border-border bg-background/40 px-4 py-3">
          {project.description ? (
            <div className="mb-3">
              <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Description</p>
              <p className="whitespace-pre-wrap text-sm text-foreground">{project.description}</p>
            </div>
          ) : null}
          <div className="mb-2 flex items-center">
            <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Tasks</p>
          </div>
          {/* Flexible views: List (default) / Grid / Board / Calendar / Timeline.
              The List rendering is passed through unchanged. */}
          <ProjectTaskViews
            project={project}
            tasks={tasks}
            nameOf={nameOf}
            onAddTask={onAddTask}
            onEditTask={onEditTask}
            views={['list', 'grid', 'kanban']}
            renderList={() => (
              <div className="space-y-1.5">
                {tasks.map((t) => (
                  <TaskRow key={t.id} task={t} nameOf={nameOf} onEdit={() => onEditTask(t)} onDelete={() => onDeleteTask(t)} onAddNote={() => onAddNote(t)} />
                ))}
              </div>
            )}
          />
        </div>
      ) : null}
    </Card>
  );
}

function TaskRow({ task, nameOf, onEdit, onDelete, onAddNote }: { task: FullTask; nameOf: (uid: number) => string; onEdit: () => void; onDelete: () => void; onAddNote: () => void }) {
  const update = useUpdateTask();
  const assignees = task.assignee_ids ?? [];
  const shown = assignees.slice(0, 3);
  const status: TaskStatus = task.status ?? (task.is_active ? 'to_do' : 'done');
  const priority: TaskPriority = task.priority ?? 'medium';
  const isDone = status === 'done';

  const toggleDone = () => {
    if (update.isPending) return;
    const next: TaskStatus = isDone ? 'to_do' : 'done';
    void update.mutateAsync({ id: task.id, data: { project_id: task.project_id, status: next } });
  };

  // Change status straight from the row (no edit modal). Mirrors the My Work
  // inline pattern: select fires the partial {status} update immediately.
  const setStatus = (next: TaskStatus) => {
    if (update.isPending || next === status) return;
    void update.mutateAsync({ id: task.id, data: { project_id: task.project_id, status: next } });
  };

  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2">
      <button
        type="button"
        aria-label={isDone ? 'Mark not done' : 'Mark done'}
        title="Toggle done"
        onClick={toggleDone}
        className={cn(
          'grid h-[18px] w-[18px] shrink-0 place-items-center rounded-md border-[1.5px] transition-colors',
          isDone ? 'border-primary bg-primary text-white' : 'border-border text-transparent hover:border-primary/60',
        )}
      >
        <Check className="h-3 w-3" />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className={cn('truncate text-sm', isDone ? 'text-muted-foreground line-through' : 'text-foreground')}>{task.name}</span>
        {task.description ? (
          <span className="group relative inline-flex">
            <button type="button" aria-label="Task description" className="grid h-5 w-5 place-items-center rounded-full bg-primary/10 p-0.5 text-primary hover:bg-primary/20">
              <Info className="h-3.5 w-3.5" />
            </button>
            <span className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-40 hidden w-max max-w-[280px] -translate-x-1/2 whitespace-normal rounded-xl border border-border bg-popover px-3 py-2 text-xs leading-snug text-popover-foreground shadow-xl group-hover:block">
              {task.description}
            </span>
          </span>
        ) : null}
      </div>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-muted-foreground">
        <span className={cn('h-2 w-2 rounded-full', TASK_PRIORITY_DOT[priority])} />
        {TASK_PRIORITY_LABEL[priority]}
      </span>
      {/* Inline status: edit the task's status directly on the row. The colored
          dot mirrors the status tone so it still reads as a pill at a glance. */}
      <span className="relative inline-flex items-center">
        <span className={cn('pointer-events-none absolute left-2 h-2 w-2 rounded-full', TASK_STATUS_DOT[status])} />
        <select
          value={status}
          disabled={update.isPending}
          onChange={(e) => setStatus(e.target.value as TaskStatus)}
          aria-label={`Status for ${task.name}`}
          title="Change status"
          className="cursor-pointer rounded-full border border-border bg-card py-0.5 pl-6 pr-6 text-[11px] font-semibold uppercase tracking-wider text-foreground transition-colors hover:border-primary/40 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
        >
          {(Object.keys(TASK_STATUS_LABEL) as TaskStatus[]).map((s) => (
            <option key={s} value={s}>{TASK_STATUS_LABEL[s]}</option>
          ))}
        </select>
      </span>
      {assignees.length ? (
        <div className="flex items-center">
          {shown.map((id, i) => {
            const nm = nameOf(id);
            return (
              <span
                key={id}
                title={nm}
                className={cn(
                  'grid h-6 w-6 place-items-center rounded-full text-[9px] font-semibold ring-2 ring-card',
                  avatarTone(nm),
                  i > 0 && '-ml-1.5',
                )}
              >
                {initials(nm)}
              </span>
            );
          })}
          {assignees.length > 3 ? (
            <span className="-ml-1.5 grid h-6 w-6 place-items-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground ring-2 ring-card">
              +{assignees.length - 3}
            </span>
          ) : null}
        </div>
      ) : (
        <span className="text-xs italic text-muted-foreground">Unassigned</span>
      )}
      {/* Client employees working on this task (read-only context for our side). */}
      {(task.client_assignees ?? []).length ? (
        <span
          title={`Client side: ${(task.client_assignees ?? []).map((c) => c.full_name).join(', ')}`}
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-sky-600 dark:text-sky-300"
        >
          <User className="h-3 w-3" />
          {(task.client_assignees ?? []).length === 1
            ? (task.client_assignees ?? [])[0].full_name
            : `${(task.client_assignees ?? []).length} client`}
        </span>
      ) : null}
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label="Add note to this task" onClick={onAddNote} Icon={StickyNote} sm />
        <IconButton label="Edit task" onClick={onEdit} Icon={Pencil} sm />
        <IconButton label="Delete task" onClick={onDelete} Icon={Trash2} sm danger />
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
//  Contracts tab
// ════════════════════════════════════════════════════════════════════════

function ContractsTab({
  clientId,
  contracts,
  loading,
  onConfirm,
  onSaved,
  onError,
}: {
  clientId: number;
  contracts: Contract[];
  loading: boolean;
  onConfirm: (c: { title: string; message: string; onConfirm: () => void }) => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const del = useDeleteContract();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [modal, setModal] = useState<{ open: boolean; contract: Contract | null }>({ open: false, contract: null });

  const q = search.trim().toLowerCase();
  const filtered = contracts.filter(
    (ct) =>
      !q ||
      ct.title.toLowerCase().includes(q) ||
      (ct.kind ?? '').toLowerCase().includes(q) ||
      CONTRACT_STATUS_LABEL[ct.status].toLowerCase().includes(q),
  );

  function removeContract(ct: Contract) {
    onConfirm({
      title: 'Delete contract?',
      message: `"${ct.title}" and its attached document will be removed.`,
      onConfirm: async () => {
        try {
          await del.mutateAsync({ clientId, id: ct.id });
          onSaved('Contract deleted.');
        } catch (e) {
          onError(errText(e, 'Could not delete the contract.'));
        }
      },
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search contracts..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Button size="sm" className="ml-auto" onClick={() => setModal({ open: true, contract: null })}>
          <Plus className="h-4 w-4" /> New contract
        </Button>
      </div>

      {loading ? (
        <Loader />
      ) : filtered.length === 0 ? (
        <Empty
          Icon={FileText}
          title={contracts.length === 0 ? 'No contracts yet' : 'No contracts match'}
          description={
            contracts.length === 0
              ? 'Add an agreement for this client and attach the signed document.'
              : 'Try a different search.'
          }
          action={
            contracts.length === 0 ? (
              <Button size="sm" onClick={() => setModal({ open: true, contract: null })}>
                New contract
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="grid grid-cols-[1fr_180px_90px_110px_64px] items-center gap-3 border-b border-border bg-muted/50 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
            <span>Title</span>
            <span className="hidden sm:block">Period</span>
            <span className="text-right">Value</span>
            <span className="hidden sm:block">Status</span>
            <span />
          </div>
          {filtered.map((ct) => (
            <ContractCard
              key={ct.id}
              clientId={clientId}
              contract={ct}
              open={!!expanded[ct.id]}
              onToggle={() => setExpanded((s) => ({ ...s, [ct.id]: !s[ct.id] }))}
              onEdit={() => setModal({ open: true, contract: ct })}
              onDelete={() => void removeContract(ct)}
              onSaved={onSaved}
              onError={onError}
            />
          ))}
        </Card>
      )}

      <ContractModal
        open={modal.open}
        clientId={clientId}
        contract={modal.contract}
        onClose={() => setModal({ open: false, contract: null })}
        onSaved={(m, id) => {
          onSaved(m);
          if (id != null) setExpanded((s) => ({ ...s, [id]: true }));
        }}
      />
    </div>
  );
}

function ContractCard({
  clientId,
  contract,
  open,
  onToggle,
  onEdit,
  onDelete,
  onSaved,
  onError,
}: {
  clientId: number;
  contract: Contract;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const period =
    contract.start_date || contract.end_date
      ? `${fmtDate(contract.start_date) || '—'} – ${fmtDate(contract.end_date) || '—'}`
      : '—';
  return (
    <div className="border-b border-border last:border-b-0">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className="grid cursor-pointer grid-cols-[1fr_180px_90px_110px_64px] items-center gap-3 px-4 py-3 transition-colors hover:bg-primary/5"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-primary">
              <span className="truncate">{contract.title}</span>
              {contract.has_document ? <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
            </p>
            {contract.kind ? <p className="truncate text-xs text-muted-foreground">{contract.kind}</p> : null}
          </div>
        </div>
        <span className="hidden whitespace-nowrap text-xs text-muted-foreground sm:block">{period}</span>
        <span className="text-right text-sm">
          {contract.value != null && contract.value !== '' ? (
            <strong className="font-bold text-foreground">{fmtMoney(contract.value)}</strong>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </span>
        <span className="hidden sm:block">
          <TonePill tone={CONTRACT_STATUS_TONE[contract.status]}>{CONTRACT_STATUS_LABEL[contract.status]}</TonePill>
        </span>
        <div className="flex shrink-0 items-center justify-end gap-0.5">
          <IconButton label="Edit contract" onClick={onEdit} Icon={Pencil} sm />
          <IconButton label="Delete contract" onClick={onDelete} Icon={Trash2} sm danger />
        </div>
      </div>

      {open ? (
        <div className="border-t border-border bg-background/40 px-4 py-3">
          <ContractDoc clientId={clientId} contract={contract} onSaved={onSaved} onError={onError} />
        </div>
      ) : null}
    </div>
  );
}

function ContractDoc({
  clientId,
  contract,
  onSaved,
  onError,
}: {
  clientId: number;
  contract: Contract;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const upload = useUploadContractDocument();
  const delDoc = useDeleteContractDocument();
  const [downloading, setDownloading] = useState(false);
  const [viewing, setViewing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function pick() {
    fileRef.current?.click();
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      await upload.mutateAsync({ clientId, id: contract.id, file });
      onSaved('Document attached.');
    } catch (err) {
      onError(errText(err, 'Could not upload the document.'));
    }
  }

  async function download() {
    setDownloading(true);
    try {
      const res = await contractsApi.downloadDocument(clientId, contract.id);
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = contract.document_name || `contract-${contract.id}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      onError(errText(err, 'Could not download the document.'));
    } finally {
      setDownloading(false);
    }
  }

  async function view() {
    setViewing(true);
    // Open the tab synchronously (inside the click) so the popup blocker allows
    // it; we navigate it to the blob URL once the fetch resolves.
    const tab = window.open('', '_blank');
    try {
      const res = await contractsApi.viewDocument(clientId, contract.id);
      const url = URL.createObjectURL(res.data);
      if (tab) {
        tab.location.href = url;
        // Revoke after the tab has had a chance to load the blob.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        // Popup blocked — fall back to a same-tab open.
        window.location.href = url;
      }
    } catch (err) {
      if (tab) tab.close();
      onError(errText(err, 'Could not open the document.'));
    } finally {
      setViewing(false);
    }
  }

  async function remove() {
    if (!window.confirm('Remove the attached document?')) return;
    try {
      await delDoc.mutateAsync({ clientId, id: contract.id });
      onSaved('Document removed.');
    } catch (err) {
      onError(errText(err, 'Could not remove the document.'));
    }
  }

  const busy = upload.isPending || delDoc.isPending;

  return (
    <div>
      <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Document</p>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
        className="hidden"
        onChange={(e) => void onFile(e)}
      />
      {contract.has_document ? (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <FileText className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            {/* Click the name to open the document in a new tab. */}
            <button type="button" onClick={() => void view()} title="Open in a new tab"
              className="block max-w-full truncate text-left text-sm font-semibold text-foreground hover:text-primary hover:underline">
              {contract.document_name || 'Document'}
            </button>
            {contract.document_size != null ? <p className="text-xs text-muted-foreground">{fmtSize(contract.document_size)}</p> : null}
          </div>
          <IconButton label="View" onClick={() => void view()} Icon={viewing ? Loader2 : ExternalLink} sm />
          <IconButton label="Download" onClick={() => void download()} Icon={downloading ? Loader2 : Download} sm />
          <Button size="sm" variant="secondary" onClick={pick} disabled={busy}>
            Replace
          </Button>
          <IconButton label="Remove" onClick={() => void remove()} Icon={Trash2} sm danger />
        </div>
      ) : (
        <button
          type="button"
          onClick={pick}
          disabled={busy}
          className="flex w-full flex-col items-center gap-1 rounded-2xl border border-dashed border-border bg-card px-4 py-6 text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <UploadCloud className="h-5 w-5" />}
          <span className="text-sm font-semibold text-foreground">Upload a document</span>
          <span className="text-xs">PDF, DOCX, or an image of the signed agreement</span>
        </button>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
//  Contacts tab
// ════════════════════════════════════════════════════════════════════════

function ContactsTab({
  clientId,
  contacts,
  loading,
  onConfirm,
  onSaved,
  onError,
}: {
  clientId: number;
  contacts: ClientContact[];
  loading: boolean;
  onConfirm: (c: { title: string; message: string; onConfirm: () => void }) => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const del = useDeleteClientContact();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [modal, setModal] = useState<{ open: boolean; contact: ClientContact | null }>({ open: false, contact: null });

  const q = search.trim().toLowerCase();
  // Search any field: name, role, any email address, any phone number (+ its label).
  const filtered = contacts.filter((ct) => {
    if (!q) return true;
    const channels = [...(ct.emails ?? []), ...(ct.phones ?? [])]
      .flatMap((c) => [c.address ?? '', c.number ?? '', c.label ?? '']);
    return [ct.name, ct.role ?? '', ...channels].some((f) => f.toLowerCase().includes(q));
  });

  function removeContact(ct: ClientContact) {
    onConfirm({
      title: 'Delete contact?',
      message: `"${ct.name}" will be removed.`,
      onConfirm: async () => {
        try {
          await del.mutateAsync({ clientId, id: ct.id });
          onSaved('Contact deleted.');
        } catch (e) {
          onError(errText(e, 'Could not delete the contact.'));
        }
      },
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search contacts..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Button size="sm" className="ml-auto" onClick={() => setModal({ open: true, contact: null })}>
          <Plus className="h-4 w-4" /> Add contact
        </Button>
      </div>

      {loading ? (
        <Loader />
      ) : contacts.length === 0 ? (
        <Empty
          Icon={UserPlus}
          title="No contacts yet"
          description="Add a point of contact with their emails and phone numbers."
          action={
            <Button size="sm" onClick={() => setModal({ open: true, contact: null })}>
              Add contact
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <Empty Icon={UserPlus} title="No contacts match" description="Try a different search." />
      ) : (
        filtered.map((ct) => (
          <ContactCard
            key={ct.id}
            clientId={clientId}
            contact={ct}
            open={!!expanded[ct.id]}
            onToggle={() => setExpanded((s) => ({ ...s, [ct.id]: !s[ct.id] }))}
            onEdit={() => setModal({ open: true, contact: ct })}
            onDelete={() => void removeContact(ct)}
            onSaved={onSaved}
            onError={onError}
          />
        ))
      )}

      <ContactModal
        open={modal.open}
        clientId={clientId}
        contact={modal.contact}
        onClose={() => setModal({ open: false, contact: null })}
        onSaved={(m, id) => {
          onSaved(m);
          if (id != null) setExpanded((s) => ({ ...s, [id]: true }));
        }}
      />
    </div>
  );
}

function ContactCard({
  clientId,
  contact,
  open,
  onToggle,
  onEdit,
  onDelete,
  onSaved,
  onError,
}: {
  clientId: number;
  contact: ClientContact;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const update = useUpdateClientContact();
  const [channelModal, setChannelModal] = useState<{ open: boolean; kind: 'emails' | 'phones'; index: number | null }>({
    open: false,
    kind: 'emails',
    index: null,
  });

  const emails = contact.emails ?? [];
  const phones = contact.phones ?? [];
  const sub = [
    contact.role || null,
    `${emails.length} ${emails.length === 1 ? 'email' : 'emails'}`,
    `${phones.length} ${phones.length === 1 ? 'phone' : 'phones'}`,
  ]
    .filter(Boolean)
    .join(' · ');

  // Persist the whole channel array (emails or phones) after a local mutation.
  async function persist(kind: 'emails' | 'phones', next: ContactChannel[], msg: string) {
    const data: ClientContactBody = kind === 'emails' ? { emails: next } : { phones: next };
    try {
      await update.mutateAsync({ clientId, id: contact.id, data });
      onSaved(msg);
    } catch (e) {
      onError(errText(e, 'Could not save the contact.'));
    }
  }

  function removeChannel(kind: 'emails' | 'phones', index: number) {
    const list = (kind === 'emails' ? emails : phones).filter((_, i) => i !== index);
    void persist(kind, list, kind === 'emails' ? 'Email removed.' : 'Phone removed.');
  }

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center gap-3 px-4 py-3">
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl text-xs font-semibold', avatarTone(contact.name))}>
            {initials(contact.name)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground">{contact.name}</p>
            <p className="truncate text-xs text-muted-foreground">{sub}</p>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label="Edit contact" onClick={onEdit} Icon={Pencil} sm />
          <IconButton label="Delete contact" onClick={onDelete} Icon={Trash2} sm danger />
        </div>
      </div>

      {open ? (
        <div className="space-y-4 border-t border-border bg-background/40 px-4 py-3">
          <ChannelList
            label="Emails"
            Icon={Mail}
            items={emails}
            valueOf={(ch) => ch.address ?? ''}
            onAdd={() => setChannelModal({ open: true, kind: 'emails', index: null })}
            onEdit={(i) => setChannelModal({ open: true, kind: 'emails', index: i })}
            onDelete={(i) => removeChannel('emails', i)}
          />
          <ChannelList
            label="Phones"
            Icon={Phone}
            items={phones}
            valueOf={(ch) => ch.number ?? ''}
            onAdd={() => setChannelModal({ open: true, kind: 'phones', index: null })}
            onEdit={(i) => setChannelModal({ open: true, kind: 'phones', index: i })}
            onDelete={(i) => removeChannel('phones', i)}
          />
        </div>
      ) : null}

      <ChannelModal
        open={channelModal.open}
        kind={channelModal.kind}
        channel={channelModal.index != null ? (channelModal.kind === 'emails' ? emails : phones)[channelModal.index] ?? null : null}
        saving={update.isPending}
        onClose={() => setChannelModal((s) => ({ ...s, open: false }))}
        onSubmit={(payload) => {
          const list = [...(channelModal.kind === 'emails' ? emails : phones)];
          if (channelModal.index != null) list[channelModal.index] = payload;
          else list.push(payload);
          void persist(channelModal.kind, list, channelModal.index != null ? 'Saved.' : 'Added.');
          setChannelModal((s) => ({ ...s, open: false }));
        }}
      />
    </Card>
  );
}

function ChannelList({
  label,
  Icon,
  items,
  valueOf,
  onAdd,
  onEdit,
  onDelete,
}: {
  label: string;
  Icon: typeof Mail;
  items: ContactChannel[];
  valueOf: (ch: ContactChannel) => string;
  onAdd: () => void;
  onEdit: (index: number) => void;
  onDelete: (index: number) => void;
}) {
  const single = label === 'Emails' ? 'email' : 'phone';
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
        <Button size="sm" variant="secondary" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" /> Add {single}
        </Button>
      </div>
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">No {label.toLowerCase()} yet.</p>
      ) : (
        <div className="space-y-1.5">
          {items.map((ch, i) => (
            <div key={i} className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="inline-flex min-w-[54px] justify-center">
                <TonePill tone="neutral">{ch.label || '—'}</TonePill>
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{valueOf(ch)}</span>
              <div className="flex shrink-0 items-center gap-0.5">
                <IconButton label={`Edit ${single}`} onClick={() => onEdit(i)} Icon={Pencil} sm />
                <IconButton label={`Delete ${single}`} onClick={() => onDelete(i)} Icon={Trash2} sm danger />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
//  Roles tab
// ════════════════════════════════════════════════════════════════════════

const ROLES_PAGE_SIZE = 5;
const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD'];

function RolesTab({
  clientId,
  roles,
  titleCounts,
  loading,
  onConfirm,
  onSaved,
  onError,
}: {
  clientId: number;
  roles: ClientRoleRate[];
  titleCounts: Map<string, number>;
  loading: boolean;
  onConfirm: (c: { title: string; message: string; onConfirm: () => void }) => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const del = useDeleteRoleRate();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<{ open: boolean; role: ClientRoleRate | null }>({ open: false, role: null });

  const q = search.trim().toLowerCase();
  const filtered = roles.filter((r) => !q || r.role.toLowerCase().includes(q) || (r.currency ?? '').toLowerCase().includes(q));

  const pages = Math.max(1, Math.ceil(filtered.length / ROLES_PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * ROLES_PAGE_SIZE;
  const pageRows = filtered.slice(start, start + ROLES_PAGE_SIZE);

  function removeRole(r: ClientRoleRate) {
    onConfirm({
      title: 'Delete role?',
      message: `The rate for "${r.role}" will be removed.`,
      onConfirm: async () => {
        try {
          await del.mutateAsync({ clientId, id: r.id });
          onSaved('Role deleted.');
        } catch (e) {
          onError(errText(e, 'Could not delete the role.'));
        }
      },
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search roles"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <Button size="sm" className="ml-auto" onClick={() => setModal({ open: true, role: null })}>
          <Plus className="h-4 w-4" /> New role
        </Button>
      </div>

      {loading ? (
        <Loader />
      ) : filtered.length === 0 ? (
        <Empty
          Icon={Tag}
          title={roles.length === 0 ? 'No roles yet' : 'No roles match'}
          description={roles.length === 0 ? 'Add a billable rate for each role you bill this client at.' : 'Try a different search.'}
          action={
            roles.length === 0 ? (
              <Button size="sm" onClick={() => setModal({ open: true, role: null })}>
                New role
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Card className="overflow-hidden p-0">
            <div className="grid grid-cols-[1fr_120px_110px_140px_64px] items-center gap-3 border-b border-border bg-muted/50 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
              <span>Role</span>
              <span className="text-right">Rate</span>
              <span className="hidden sm:block">Currency</span>
              <span className="hidden sm:block">Effective</span>
              <span />
            </div>
            {pageRows.map((r) => (
              <div
                key={r.id}
                className="grid grid-cols-[1fr_120px_110px_140px_64px] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-semibold text-foreground">{r.role}</span>
                  {(() => {
                    const n = titleCounts.get(r.role.trim().toLowerCase()) ?? 0;
                    return n > 0 ? (
                      <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10.5px] font-semibold text-primary" title={`${n} ${n === 1 ? 'person holds' : 'people hold'} this title`}>
                        {n} {n === 1 ? 'person' : 'people'}
                      </span>
                    ) : null;
                  })()}
                </span>
                <span className="text-right text-sm">
                  <strong className="font-bold text-foreground">${Math.round(num(r.rate))}</strong>
                  <span className="text-muted-foreground">/hr</span>
                </span>
                <span className="hidden text-sm text-muted-foreground sm:block">{r.currency || 'USD'}</span>
                <span className="hidden text-sm text-muted-foreground sm:block">{fmtDate(r.effective_date) || '—'}</span>
                <div className="flex shrink-0 items-center justify-end gap-0.5">
                  <IconButton label="Edit role" onClick={() => setModal({ open: true, role: r })} Icon={Pencil} sm />
                  <IconButton label="Delete role" onClick={() => void removeRole(r)} Icon={Trash2} sm danger />
                </div>
              </div>
            ))}
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Showing {pageRows.length} of {filtered.length} {filtered.length === 1 ? 'role' : 'roles'}
            </p>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="secondary" disabled={safePage === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Prev
              </Button>
              {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPage(p)}
                  className={cn(
                    'grid h-8 min-w-8 place-items-center rounded-lg px-2 text-sm font-semibold transition-colors',
                    p === safePage ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-primary/10 hover:text-foreground',
                  )}
                >
                  {p}
                </button>
              ))}
              <Button size="sm" variant="secondary" disabled={safePage === pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      <RoleModal
        open={modal.open}
        clientId={clientId}
        role={modal.role}
        onClose={() => setModal({ open: false, role: null })}
        onSaved={onSaved}
        onError={onError}
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
//  Notes tab
// ════════════════════════════════════════════════════════════════════════

function NotesTab({
  clientId,
  notes,
  projects,
  tasksByProject,
  loading,
  onConfirm,
  onSaved,
  onError,
}: {
  clientId: number;
  notes: ClientNote[];
  projects: FullProject[];
  tasksByProject: Map<number, FullTask[]>;
  loading: boolean;
  onConfirm: (c: { title: string; message: string; onConfirm: () => void }) => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const del = useDeleteClientNote();
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<{ open: boolean; note: ClientNote | null }>({ open: false, note: null });

  const q = search.trim().toLowerCase();
  // Search any field: author, note text, date, AND the linked project name /
  // code / task name so finding a note by its project or task works.
  const filtered = notes.filter((n) => {
    if (!q) return true;
    return [
      n.author ?? '',
      n.body,
      n.note_date ? fmtDate(n.note_date) : '',
      n.project_name ?? '',
      n.project_code ?? '',
      n.task_name ?? '',
    ].some((f) => f.toLowerCase().includes(q));
  });

  function removeNote(n: ClientNote) {
    onConfirm({
      title: 'Delete note?',
      message: 'This note will be removed.',
      onConfirm: async () => {
        try {
          await del.mutateAsync({ clientId, id: n.id });
          onSaved('Note deleted.');
        } catch (e) {
          onError(errText(e, 'Could not delete the note.'));
        }
      },
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search notes..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Button size="sm" className="ml-auto" onClick={() => setModal({ open: true, note: null })}>
          <Plus className="h-4 w-4" /> Add note
        </Button>
      </div>

      {loading ? (
        <Loader />
      ) : notes.length === 0 ? (
        <Empty
          Icon={StickyNote}
          title="No notes yet"
          description="Capture context, meeting notes, or anything the team should know about this client."
          action={
            <Button size="sm" onClick={() => setModal({ open: true, note: null })}>
              Add note
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <Empty Icon={StickyNote} title="No notes match" description="Try a different search." />
      ) : (
        filtered.map((n) => {
          const author = n.author || 'Unknown';
          return (
            <Card key={n.id} className="p-4">
              <div className="flex items-start gap-3">
                <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl text-xs font-semibold', avatarTone(author))}>
                  {initials(author)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <p className="text-sm font-semibold text-foreground">{author}</p>
                    {n.note_date ? <span className="text-xs text-muted-foreground">{fmtDate(n.note_date)}</span> : null}
                  </div>
                  {n.project_name || n.task_name ? (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {n.project_name ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          <Briefcase className="h-3 w-3" />{n.project_name}{n.project_code ? ` · ${n.project_code}` : ''}
                        </span>
                      ) : null}
                      {n.task_name ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                          {n.task_name}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  <p className="mt-1.5 whitespace-pre-wrap text-sm text-foreground">{n.body}</p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <IconButton label="Edit note" onClick={() => setModal({ open: true, note: n })} Icon={Pencil} sm />
                  <IconButton label="Delete note" onClick={() => void removeNote(n)} Icon={Trash2} sm danger />
                </div>
              </div>
            </Card>
          );
        })
      )}

      <NoteModal
        open={modal.open}
        clientId={clientId}
        target={{ mode: 'free', projects, tasksByProject }}
        note={modal.note}
        onClose={() => setModal({ open: false, note: null })}
        onSaved={onSaved}
        onError={onError}
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
//  Modals
// ════════════════════════════════════════════════════════════════════════

const labelClass = 'mb-1 block text-[13px] font-medium text-muted-foreground';
const selectClass =
  'h-9 w-full rounded-full border border-border bg-transparent px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';
const textareaClass =
  'w-full rounded-2xl border border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

function ClientModal({
  open,
  client,
  users,
  onClose,
  onSaved,
}: {
  open: boolean;
  client: Client | null;
  users: ManagedUser[];
  onClose: () => void;
  onSaved: (msg: string, id?: number) => void;
}) {
  const isEdit = !!client;
  const { user: modalActingUser } = useAuth();
  const create = useCreateClient();
  const update = useUpdateClient();
  const setTeam = useSetClientTeam();
  // Existing roster (edit only) to pre-fill the pickers.
  const teamQ = useClientTeam(isEdit && open ? client!.id : null);

  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [type, setType] = useState('external');
  const [status, setStatus] = useState<ClientStatus>('active');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [since, setSince] = useState('');
  const [pmIds, setPmIds] = useState<number[]>([]);
  const [memberIds, setMemberIds] = useState<number[]>([]);
  const [selfManage, setSelfManage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setName(client?.name ?? '');
    setCompany(client?.company ?? '');
    setType(client?.client_type ?? 'external');
    setStatus(client?.status ?? 'active');
    setContactName(client?.contact_name ?? '');
    setContactEmail(client?.contact_email ?? '');
    setContactPhone(client?.contact_phone ?? '');
    setSince(client?.since ?? '');
    setSelfManage(client?.client_self_manage_enabled ?? false);
    setPmIds([]);
    setMemberIds([]);
    setError(null);
    setErrors({});
  }, [open, client]);

  // Pre-fill the pickers from the fetched roster on edit.
  useEffect(() => {
    if (!open || !isEdit) return;
    const rows = (teamQ.data ?? []) as ClientTeamMember[];
    setPmIds(rows.filter((m) => m.assignment_role === 'pm').map((m) => m.user_id));
    setMemberIds(rows.filter((m) => m.assignment_role === 'member').map((m) => m.user_id));
  }, [open, isEdit, teamQ.data]);

  // PM options. Admins can assign any manager. A MANAGER acting here may assign
  // only themselves + managers within their own subtree — never a manager ABOVE
  // them (a supervisor). Mirrors the task-assignee subtree guard.
  const managerOptions: PickerOption[] = useMemo(() => {
    const managers = users.filter((u) => u.role === 'MANAGER');
    const actingIsManager = modalActingUser?.role === 'MANAGER';
    if (!actingIsManager || !modalActingUser) {
      return managers.map((u) => ({ id: u.id, name: u.full_name, sub: 'Manager' }));
    }
    // Subtree of the acting manager: themselves + everyone reporting (any
    // manager, transitively) to them.
    const subtree = new Set<number>([modalActingUser.id]);
    let grew = true;
    while (grew) {
      grew = false;
      users.forEach((u) => {
        if (!subtree.has(u.id) && managersOfUser(u).some((mid) => subtree.has(mid))) {
          subtree.add(u.id); grew = true;
        }
      });
    }
    return managers
      .filter((u) => subtree.has(u.id))
      .map((u) => ({ id: u.id, name: u.full_name, sub: 'Manager' }));
  }, [users, modalActingUser]);

  // Members scoped to the selected PMs' reports; fall back to any non-manager
  // user when that set is empty so the picker stays usable.
  const memberOptions: PickerOption[] = useMemo(() => {
    const underSelected = users.filter((u) => u.manager_id != null && pmIds.includes(u.manager_id));
    const pool = underSelected.length ? underSelected : users.filter((u) => u.role !== 'MANAGER');
    return pool.map((u) => ({ id: u.id, name: u.full_name, sub: u.role }));
  }, [users, pmIds]);

  const saving = create.isPending || update.isPending || setTeam.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const nextErrors: Record<string, string> = {};
    if (!name.trim()) nextErrors.name = 'Client name is required.';
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }
    const body: ClientBody = {
      name: name.trim(),
      client_type: type,
      status,
      company: company.trim() || null,
      since: since || null,
      contact_name: contactName.trim() || null,
      contact_email: contactEmail.trim() || null,
      contact_phone: contactPhone.trim() || null,
      client_self_manage_enabled: selfManage,
    };
    try {
      let clientId: number;
      if (isEdit && client) {
        await update.mutateAsync({ id: client.id, data: body });
        clientId = client.id;
        // Edit: update the roster via the team endpoint.
        await setTeam.mutateAsync({ id: client.id, data: { pm_ids: pmIds, member_ids: memberIds } });
      } else {
        // Create: send the team WITH the create so it's one atomic request (no
        // follow-up PUT /team that would re-check access and 403 / or 500 on a
        // duplicate-name retry).
        const created = (await create.mutateAsync({ ...body, pm_ids: pmIds, member_ids: memberIds })) as Client;
        clientId = created.id;
      }
      onSaved(isEdit ? 'Client updated.' : `Client ${name.trim()} created successfully.`, clientId);
      onClose();
    } catch (err) {
      setError(errText(err, 'Could not save the client.'));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit client · ${client?.name}` : 'New client'} className="max-w-4xl" flushBottom>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Wider, two-column layout so everything fits without vertical scroll. */}
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
          {/* Left column: identity */}
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Name<RequiredMark /></label>
              <Input value={name} onChange={(e) => { setName(e.target.value); setErrors((p) => ({ ...p, name: '' })); }} placeholder="Acme Corp" required error={!!errors.name} />
              <FieldError error={errors.name} />
            </div>
            <div>
              <label className={labelClass}>Legal / company name</label>
              <Input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Corporation LLC" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Type</label>
                <select className={selectClass} value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="external">External</option>
                  <option value="internal">Internal</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Status</label>
                <select className={selectClass} value={status} onChange={(e) => setStatus(e.target.value as ClientStatus)}>
                  {(Object.keys(CLIENT_STATUS_LABEL) as ClientStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {CLIENT_STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {/* The "Let this client manage their own employees" toggle is hidden:
                the client manager/employee two-tier model was retired (everyone
                is a flat CLIENT now). The selfManage value still round-trips on
                save so any existing setting is preserved, not wiped. */}
          </div>

          {/* Right column: primary contact */}
          <div className="space-y-3 md:border-l md:border-border md:pl-6">
            <p className="text-xs font-semibold text-foreground">Primary contact</p>
            <div>
              <label className={labelClass}>Name (optional)</label>
              <Input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Jane Doe" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Email</label>
                <Input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="jane@acme.com" />
              </div>
              <div>
                <label className={labelClass}>Phone</label>
                <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="+1 (555) 000-0000" />
              </div>
            </div>
            <div>
              <label className={labelClass}>Client since</label>
              <Input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
            </div>
          </div>

          {/* Team spans full width below */}
          <div className="border-t border-border pt-3 md:col-span-2">
            <p className="mb-2 text-xs font-semibold text-foreground">Team</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={labelClass}>Project managers</label>
                <MultiPicker
                  options={managerOptions}
                  selected={pmIds}
                  onChange={setPmIds}
                  placeholder="Assign project managers..."
                  emptyText="No managers available."
                />
              </div>
              <div>
                <label className={labelClass}>Team members</label>
                <MultiPicker
                  options={memberOptions}
                  selected={memberIds}
                  onChange={setMemberIds}
                  placeholder="Assign team members..."
                  emptyText={pmIds.length ? 'No people available for the selected managers.' : 'Add project managers first to choose their team.'}
                />
              </div>
            </div>
          </div>
          {error ? <p className="text-sm text-rose-600 dark:text-rose-300 md:col-span-2">{error}</p> : null}
        </div>
        <div className="sticky bottom-0 -mx-4 mt-2 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
              </>
            ) : isEdit ? (
              'Save changes'
            ) : (
              'Create client'
            )}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ProjectModal({
  open,
  clientId,
  clients,
  project,
  pms,
  users,
  tasks,
  nameOf,
  onClose,
  onSaved,
}: {
  open: boolean;
  clientId: number;
  clients: Client[];
  project: FullProject | null;
  pms: ClientTeamMember[];
  users: ManagedUser[];
  tasks: FullTask[];
  nameOf: (uid: number) => string;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const isEdit = !!project;
  const create = useCreateProject();
  const update = useUpdateProject();
  const updateTask = useUpdateTask();
  // Auto code (PR####) for NEW projects only; fetched while the modal is open.
  const nextCodeQ = useNextProjectCode(open && !isEdit);
  // Staffing policy: when cross-team staffing is on, the team pool widens from
  // the project's PMs' reports to every PM on this client's reports.
  const allowCrossTeam = useCrossTeamStaffing();
  const clientPmIds = useMemo(() => pms.map((m) => m.user_id), [pms]);
  // Contracts for the project's client — to tie the project to an MSA/SOW.
  const contractsQ = useContracts(open ? (project?.client_id ?? clientId) : null);
  const contractOptions = contractsQ.data ?? [];

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<ProjectStatus>('planning');
  const [budget, setBudget] = useState('');
  const [estHours, setEstHours] = useState(''); // PSA planned hours (for EVM/baseline)
  const [revRec, setRevRec] = useState('as_billed'); // PSA revenue recognition method
  const [billableRate, setBillableRate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [managerIds, setManagerIds] = useState<number[]>([]);
  const [active, setActive] = useState(true);
  const [description, setDescription] = useState('');
  const [resourceIds, setResourceIds] = useState<number[]>([]);
  // The client this project belongs to. Editable so an admin can re-point a
  // project to a different client (the backend client_id is a normal mutable
  // FK). Defaults to the currently-open client for new projects.
  const [projectClientId, setProjectClientId] = useState<number>(clientId);
  const [contractId, setContractId] = useState<number | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Two-step roster removal: the first save with a conflict warns; the second
  // proceeds and also strips the removed members from the conflicting tasks.
  const [proceedRemoval, setProceedRemoval] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    setCode(project?.code ?? '');
    setStatus(project?.status ?? 'planning');
    setBudget(project?.budget_amount != null ? String(project.budget_amount) : '');
    setEstHours(project?.estimated_hours != null ? String(project.estimated_hours) : '');
    setRevRec((project as { revenue_recognition?: string } | null)?.revenue_recognition ?? 'as_billed');
    setBillableRate(project?.billable_rate != null ? String(project.billable_rate) : '');
    setEndDate(project?.end_date ?? '');
    setManagerIds(project?.manager_ids ?? (project?.manager_id != null ? [project.manager_id] : []));
    setActive(project?.is_active ?? true);
    setDescription(project?.description ?? '');
    setResourceIds(project?.resource_ids ?? []);
    setProjectClientId(project?.client_id ?? clientId);
    setContractId(project?.contract_id ?? '');
    setProceedRemoval(false);
    setError(null);
    setErrors({});
  }, [open, project, clientId]);

  // Prefill the auto code on a NEW project once it arrives. Editable: only fill
  // an empty field, so a code the user typed isn't clobbered by a late fetch.
  useEffect(() => {
    if (!open || isEdit) return;
    if (nextCodeQ.data) setCode((c) => (c.trim() ? c : nextCodeQ.data!));
  }, [open, isEdit, nextCodeQ.data]);

  // PM choices = the client's assigned PMs (multi-select).
  const pmOptions: PickerOption[] = pms.map((m) => ({ id: m.user_id, name: m.full_name, sub: m.role }));
  // Team-member choices. By DEFAULT, only employees who report (org tree) to a
  // selected PM — keeps staffing inside the project's management chain. When the
  // tenant enables cross-team staffing, the pool widens to the client's whole
  // management chain + their reports (see `staffingPool`). Empty until a PM with
  // reports is picked (in the restricted default).
  const teamOptions: PickerOption[] = useMemo(
    () =>
      staffingPool(users, { pmIds: managerIds, clientPmIds, allowCrossTeam })
        .map((u) => ({ id: u.id, name: u.full_name, sub: u.role })),
    [users, managerIds, clientPmIds, allowCrossTeam],
  );

  const saving = create.isPending || update.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const nextErrors: Record<string, string> = {};
    if (!name.trim()) nextErrors.name = 'Project name is required.';
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }
    // Roster-removal conflict guard: warn once before removing someone who is
    // still assigned to a task in this project.
    const removed = isEdit && project ? (project.resource_ids ?? []).filter((id) => !resourceIds.includes(id)) : [];
    const conflicts = removed
      .map((id) => ({ id, tasks: tasks.filter((t) => (t.assignee_ids ?? []).includes(id)) }))
      .filter((c) => c.tasks.length > 0);
    if (conflicts.length && !proceedRemoval) {
      setProceedRemoval(true);
      const names = conflicts
        .map((cf) => `${nameOf(cf.id)} (${cf.tasks.map((t) => `"${t.name}"`).join(', ')})`)
        .join('; ');
      setError(`Still assigned to tasks: ${names}. Click Save again to remove them from the project AND those tasks.`);
      return;
    }

    const body: ProjectBody = {
      name: name.trim(),
      client_id: projectClientId,
      // Billable rate ($/h) is set in the form. Falls back to any existing
      // value, else 0, so the non-null column stays satisfied.
      billable_rate: billableRate ? num(billableRate) : (project?.billable_rate != null ? num(project.billable_rate) : 0),
      code: code.trim() || null,
      description: description.trim() || null,
      end_date: endDate || null,
      budget_amount: budget ? num(budget) : null,
      estimated_hours: estHours ? num(estHours) : null,
      revenue_recognition: revRec,
      currency: project?.currency ?? 'USD',
      is_active: active,
      status,
      manager_ids: managerIds,
      resource_ids: resourceIds,
      contract_id: contractId === '' ? null : Number(contractId),
    };
    try {
      if (isEdit && project) {
        await update.mutateAsync({ id: project.id, data: body });
        // Strip removed roster members from any tasks they were still on.
        for (const cf of conflicts) {
          for (const t of cf.tasks) {
            const nextAssignees = (t.assignee_ids ?? []).filter((a) => a !== cf.id);
            await updateTask.mutateAsync({ id: t.id, data: { project_id: project.id, assignee_ids: nextAssignees } });
          }
        }
        onSaved('Project updated.');
      } else {
        await create.mutateAsync(body);
        onSaved(`Project ${name.trim()} created successfully.`);
      }
      onClose();
    } catch (err) {
      setError(errText(err, 'Could not save the project.'));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit project · ${project?.name}` : 'New project'} className="max-w-4xl" flushBottom>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Wider, two-column layout so everything fits without vertical scroll. */}
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
          <div className="grid grid-cols-[1fr_120px] gap-3 md:col-span-2">
            <div>
              <label className={labelClass}>Name<RequiredMark /></label>
              <Input value={name} onChange={(e) => { setName(e.target.value); setErrors((p) => ({ ...p, name: '' })); }} placeholder="Website redesign" required error={!!errors.name} />
              <FieldError error={errors.name} />
            </div>
            <div>
              <label className={labelClass}>Code</label>
              <Input value={code} onChange={(e) => setCode(e.target.value)}
                placeholder={!isEdit && nextCodeQ.isFetching ? 'Generating…' : 'PR0001'} />
            </div>
          </div>
          <div>
            <label className={labelClass}>Client</label>
            <select
              className={selectClass}
              value={projectClientId}
              onChange={(e) => setProjectClientId(Number(e.target.value))}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {projectClientId !== clientId ? (
              <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                Moving this project to a different client. Its project managers and team may need to be reassigned to that client's roster.
              </p>
            ) : null}
          </div>
          <div>
            <label className={labelClass}>Contract</label>
            <select
              className={selectClass}
              value={contractId}
              onChange={(e) => setContractId(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">No contract</option>
              {contractOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}{c.value != null ? ` · ${Number(c.value).toLocaleString(undefined, { style: 'currency', currency: 'USD' })}` : ''}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Tie this project to a contract (MSA/SOW) to track value burn.
            </p>
          </div>
          <div>
            <label className={labelClass}>Status</label>
            <select className={selectClass} value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
              {(Object.keys(PROJECT_STATUS_LABEL) as ProjectStatus[]).map((s) => (
                <option key={s} value={s}>
                  {PROJECT_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Active</label>
            <select className={selectClass} value={active ? 'yes' : 'no'} onChange={(e) => setActive(e.target.value === 'yes')}>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Budget ($)</label>
            <Input type="number" step="0.01" min="0" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="Client budget" />
          </div>
          <div>
            <label className={labelClass}>Estimated hours</label>
            <Input type="number" step="1" min="0" value={estHours} onChange={(e) => setEstHours(e.target.value)} placeholder="Planned hours" />
          </div>
          <div>
            <label className={labelClass}>Revenue recognition</label>
            <select value={revRec} onChange={(e) => setRevRec(e.target.value)} className={selectClass}>
              <option value="as_billed">As billed (T&amp;M)</option>
              <option value="percent_complete">% complete (fixed-fee)</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Billable rate ($/h)</label>
            <Input type="number" step="0.01" min="0" value={billableRate} onChange={(e) => setBillableRate(e.target.value)} placeholder="e.g. 150" />
          </div>
          <div>
            <label className={labelClass}>Due date</label>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <label className={labelClass}>Project managers</label>
            <MultiPicker
              options={pmOptions}
              selected={managerIds}
              onChange={setManagerIds}
              placeholder="Assign project managers..."
              emptyText="No project managers on this client. Add them in the client's edit form first."
              nameById={nameOf}
            />
          </div>
          <div className="md:col-span-2">
            <label className={labelClass}>Team members</label>
            <MultiPicker
              options={teamOptions}
              selected={resourceIds}
              onChange={setResourceIds}
              placeholder="Add team members to this project..."
              emptyText={
                managerIds.length
                  ? (allowCrossTeam
                      ? 'No employees report to this client’s managers.'
                      : 'No employees report to the selected managers.')
                  : 'Select project managers first to choose their team.'
              }
              nameById={nameOf}
            />
          </div>
          <div className="md:col-span-2">
            <label className={labelClass}>Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Scope, goals, key context..." className={textareaClass} />
          </div>
          {error ? <p className="text-sm text-rose-600 dark:text-rose-300 md:col-span-2">{error}</p> : null}
        </div>
        <div className="sticky bottom-0 -mx-4 mt-2 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
              </>
            ) : isEdit ? (
              'Save changes'
            ) : (
              'Create project'
            )}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// Client-side access to a single task, managed from the internal task editor.
// Client employees aren't internal `task_assignees` — they get scoped access via
// ClientAccessGrant. This section lists the client's people and lets an internal
// PM/admin share THIS task with them (read, or read+update) by creating/removing
// a task-scoped grant. Only shown when editing an existing task (a grant needs a
// task id). Note a client employee may also inherit task access from a
// whole-project grant; that inherited access is shown as a locked "via project"
// state and managed on the Client access tab, not here.
function ClientTaskAccessSection({
  clientId, projectId, taskId, onFlash,
}: {
  clientId: number;
  projectId: number;
  taskId: number;
  onFlash: (tone: 'ok' | 'err', text: string) => void;
}) {
  const qc = useQueryClient();
  const usersQ = useQuery({
    queryKey: ['client-portal-users', clientId],
    queryFn: () => clientPortalApi.clientUsers(clientId).then((r) => r.data),
    enabled: clientId > 0,
  });
  const [busyUser, setBusyUser] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const users = (usersQ.data ?? []) as ClientPortalUser[];
  const refresh = () => qc.invalidateQueries({ queryKey: ['client-portal-users', clientId] });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Per person: a direct grant on THIS task (editable here), or whole-project
  // access on THIS task's project (which already covers the task, so it's shown
  // as a read-only "Via project" chip).
  const rows = users.map((u) => {
    const direct = u.grants.find((g) => g.task_id === taskId);
    const projectGrant = u.grants.find((g) => g.project_id === projectId);
    return { user: u, direct, viaProject: !direct && !!projectGrant };
  });
  // People shown as chips = anyone with access to this task (direct or via
  // project). The dropdown offers everyone; selecting toggles a direct grant.
  const shownRows = rows.filter((r) => r.direct || r.viaProject);
  const q = query.trim().toLowerCase();
  const optionRows = rows.filter((r) =>
    !q || r.user.full_name.toLowerCase().includes(q) || (r.user.label ?? '').toLowerCase().includes(q));

  async function setShared(u: ClientPortalUser, share: boolean) {
    setBusyUser(u.user_id);
    try {
      if (share) {
        // Default to read+update (never delete) so the client person can both
        // see AND work the task. A task grant also surfaces the owning project
        // in their portal, so they get to the project automatically.
        await clientPortalApi.createGrant({ user_id: u.user_id, task_id: taskId, capabilities: ['read', 'update'] });
        onFlash('ok', `Shared this task with ${u.full_name}.`);
      } else {
        const g = u.grants.find((x) => x.task_id === taskId);
        if (g) await clientPortalApi.revokeGrant(g.id);
        onFlash('ok', `Removed ${u.full_name} from this task.`);
      }
      refresh();
    } catch (e) {
      onFlash('err', errText(e, 'Could not update client access.'));
    } finally { setBusyUser(null); }
  }

  async function setCanEdit(grantId: number, canEdit: boolean, name: string) {
    setBusyUser(-1);
    try {
      await clientPortalApi.updateGrant(grantId, (canEdit ? ['read', 'update'] : ['read']) as ClientCapability[]);
      onFlash('ok', `Updated access for ${name}.`);
      refresh();
    } catch (e) {
      onFlash('err', errText(e, 'Could not update client access.'));
    } finally { setBusyUser(null); }
  }

  return (
    <div>
      <label className={labelClass}>Client access</label>
      {usersQ.isLoading ? (
        <div className="flex items-center gap-2 py-2 text-[12.5px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading client people…
        </div>
      ) : rows.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">
          No client accounts on this client yet. Invite them on the Client access tab.
        </p>
      ) : (
        <div ref={ref} className="relative">
          {/* Dropdown trigger + selected chips (mirrors the internal Assign-to
              picker so it scales to many client people). */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => setOpen((o) => !o)}
            className="flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-2xl border border-border bg-transparent px-2 py-1.5 text-sm focus-within:border-primary"
          >
            {shownRows.length === 0 ? (
              <span className="px-1 text-muted-foreground">Share this task with client people…</span>
            ) : (
              shownRows.map(({ user: u, direct, viaProject }) => {
                const canEdit = direct?.capabilities.includes('update') ?? true;
                const busy = busyUser === u.user_id || busyUser === -1;
                return (
                  <span key={u.user_id}
                    className={cn('inline-flex items-center gap-1 rounded-full py-0.5 pl-1 pr-1.5 text-xs font-semibold',
                      viaProject ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary')}
                  >
                    <span className={cn('grid h-4 w-4 place-items-center rounded-full text-[8px] font-semibold', avatarTone(u.full_name))}>{initials(u.full_name)}</span>
                    {u.full_name}
                    {viaProject ? (
                      <span className="ml-0.5 rounded-full bg-background/60 px-1 text-[9px] font-medium uppercase tracking-wide">Via project</span>
                    ) : direct ? (
                      <>
                        <button type="button" disabled={busy} title="Toggle edit permission"
                          onClick={(e) => { e.stopPropagation(); void setCanEdit(direct.id, !canEdit, u.full_name); }}
                          className="ml-0.5 rounded-full bg-background/60 px-1 text-[9px] font-medium uppercase tracking-wide hover:bg-background">
                          {canEdit ? 'Edit' : 'View'}
                        </button>
                        <button type="button" aria-label={`Remove ${u.full_name}`} disabled={busy}
                          onClick={(e) => { e.stopPropagation(); void setShared(u, false); }}
                          className="opacity-70 hover:opacity-100">
                          <X className="h-3 w-3" />
                        </button>
                      </>
                    ) : null}
                  </span>
                );
              })
            )}
            <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
          </div>

          {open ? (
            <div className="absolute z-50 mt-1.5 max-h-60 w-full overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-xl">
              <Input className="mb-1.5 h-8" placeholder="Search client people…" value={query}
                onChange={(e) => setQuery(e.target.value)} onClick={(e) => e.stopPropagation()} />
              {optionRows.map(({ user: u, direct, viaProject }) => {
                const sel = !!direct || viaProject;
                const busy = busyUser === u.user_id || busyUser === -1;
                return (
                  <button key={u.user_id} type="button" disabled={viaProject || busy}
                    onClick={() => void setShared(u, !direct)}
                    title={viaProject ? 'Already has access to the whole project (manage on the Client access tab)' : undefined}
                    className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-primary/5',
                      (viaProject || busy) && 'opacity-60')}
                  >
                    <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold', avatarTone(u.full_name))}>{initials(u.full_name)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-foreground">{u.full_name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{viaProject ? 'Has whole-project access' : (u.label ?? 'Client')}</span>
                    </span>
                    <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-md border', sel ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-transparent')}>
                      <Check className="h-3 w-3" />
                    </span>
                  </button>
                );
              })}
              {optionRows.length === 0 ? <p className="px-2 py-2 text-xs text-muted-foreground">No matches.</p> : null}
            </div>
          ) : null}
        </div>
      )}
      <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] text-muted-foreground">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          Pick client people to share just this task with them (read + edit). “Via project”
          means they already have whole-project access. Internal teammates are set under “Assign to”.
        </span>
      </p>
    </div>
  );
}

function TaskModal({
  open,
  project,
  task,
  myTeam,
  users,
  clientPmIds,
  actingUserName,
  actingUserRole,
  nameOf,
  onClose,
  onSaved,
  onFlash,
}: {
  open: boolean;
  project: FullProject;
  task: FullTask | null;
  // The acting user + their org-chain reports (for staffing a PM-less project).
  myTeam: ManagedUser[];
  // Full assignable directory + the client's PM ids — used to widen the assignee
  // pool when cross-team staffing is enabled.
  users: ManagedUser[];
  clientPmIds: number[];
  actingUserName: string;
  actingUserRole?: string;
  nameOf: (uid: number) => string;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onFlash: (tone: 'ok' | 'err', text: string) => void;
}) {
  const isEdit = !!task;
  const { user: actingUser } = useAuth();
  const create = useCreateTask();
  const update = useUpdateTask();
  const allowCrossTeam = useCrossTeamStaffing();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [status, setStatus] = useState<TaskStatus>('to_do');
  const [estimatedHours, setEstimatedHours] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [blockedReason, setBlockedReason] = useState('');
  const [assigneeIds, setAssigneeIds] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setName(task?.name ?? '');
    setDescription(task?.description ?? '');
    setPriority(task?.priority ?? 'medium');
    setStatus(task?.status ?? (task && !task.is_active ? 'done' : 'to_do'));
    setEstimatedHours(task?.estimated_hours != null ? String(task.estimated_hours) : '');
    setDueDate(task?.due_date ?? '');
    setBlockedReason(task?.blocked_reason ?? '');
    setAssigneeIds(task?.assignee_ids ?? []);
    setError(null);
    setErrors({});
  }, [open, task]);

  const projectPmIds = useMemo<number[]>(() => {
    const ids = new Set<number>(project.manager_ids ?? []);
    if (project.manager_id != null) ids.add(project.manager_id);
    return [...ids];
  }, [project.manager_ids, project.manager_id]);
  const hasPM = projectPmIds.length > 0;

  // Subtree guard for a MANAGER (admins/viewers/PAs manage the whole tenant, so
  // null = allow everyone). The acting manager may assign:
  //   • their own subtree (themselves + transitive reports), AND
  //   • when they are a PM on THIS project, the subtrees of the CO-PMs too
  //     (co-PMs share a project's assignable pool), and the co-PMs themselves.
  // But NEVER a supervisor above the acting manager (no assigning upward).
  const restrictToSubtree = actingUserRole === 'MANAGER';
  const allowedIds = useMemo(() => {
    if (!restrictToSubtree || !actingUser) return null;
    // subtree(rootId) = root + everyone who reports (transitively, any manager)
    // to root.
    const subtreeOf = (rootId: number): Set<number> => {
      const ids = new Set<number>([rootId]);
      let grew = true;
      while (grew) {
        grew = false;
        users.forEach((u) => {
          if (!ids.has(u.id) && managersOfUser(u).some((mid) => ids.has(mid))) {
            ids.add(u.id); grew = true;
          }
        });
      }
      return ids;
    };
    const allowed = new Set<number>(myTeam.map((u) => u.id));
    // Co-PM expansion: only when the acting manager is a PM on this project.
    if (projectPmIds.includes(actingUser.id)) {
      projectPmIds.forEach((pmId) => {
        if (pmId === actingUser.id) return;
        allowed.add(pmId);                       // the co-PM
        subtreeOf(pmId).forEach((id) => allowed.add(id)); // and their reports
      });
    }
    // Never allow assigning a supervisor of the acting manager (walk up).
    const ancestors = new Set<number>();
    const byId = new Map(users.map((u) => [u.id, u]));
    let frontier = managersOfUser(actingUser);
    while (frontier.length) {
      const next: number[] = [];
      frontier.forEach((mid) => {
        if (ancestors.has(mid)) return;
        ancestors.add(mid);
        const m = byId.get(mid);
        if (m) next.push(...managersOfUser(m));
      });
      frontier = next;
    }
    ancestors.forEach((id) => allowed.delete(id));
    return allowed;
  }, [restrictToSubtree, actingUser, myTeam, users, projectPmIds]);

  // Assignee pool. The backend auto-adds any chosen assignee to the project
  // roster, so this only governs what the picker OFFERS:
  //   cross-team ON  → everyone reporting to ANY PM on the client.
  //   cross-team OFF → the project's PMs and THEIR reports (so a PM's employees
  //                    show, not just the bare roster) for a PM'd project; else
  //                    the acting user's reports (PM-less projects).
  // In every branch we intersect with `allowedIds` so a manager can only reach
  // into their own subtree, never upward to a manager above them.
  const assigneeOptions: PickerOption[] = useMemo(() => {
    let pool: ManagedUser[];
    if (allowCrossTeam) {
      pool = staffingPool(users, { pmIds: clientPmIds, clientPmIds, allowCrossTeam: true });
    } else if (hasPM) {
      // The project PMs + everyone who reports (transitively) to ANY of them
      // (co-managed reports included, not just those under a primary manager).
      const pmSet = new Set(projectPmIds);
      const ids = new Set<number>(projectPmIds);
      let grew = true;
      while (grew) {
        grew = false;
        users.forEach((u) => {
          if (!ids.has(u.id) && managersOfUser(u).some((mid) => ids.has(mid))) {
            ids.add(u.id); grew = true;
          }
        });
      }
      // Offer the PMs themselves AND anyone who has a manager (i.e. is a report
      // somewhere) — so both managers and employees in the subtree can be picked.
      pool = users.filter((u) => ids.has(u.id) && (pmSet.has(u.id) || managersOfUser(u).length > 0));
    } else {
      pool = myTeam;
    }
    // Project/task assignees are INTERNAL teammates; external users (clients /
    // contractors) get access via the client-portal grant flow. Also intersect
    // with allowedIds so a manager can only reach their own subtree.
    return pool
      .filter((u) => !u.is_external)
      .filter((u) => allowedIds == null || allowedIds.has(u.id))
      .map((u) => ({ id: u.id, name: u.full_name, sub: u.role }));
  }, [allowCrossTeam, users, clientPmIds, hasPM, projectPmIds, myTeam, allowedIds]);
  const canStaffSelf = !hasPM && myTeam.length > 0;

  const saving = create.isPending || update.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const nextErrors: Record<string, string> = {};
    if (!name.trim()) nextErrors.name = 'Task name is required.';
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }
    const estTrim = estimatedHours.trim();
    const body: TaskBody = {
      project_id: project.id,
      name: name.trim(),
      description: description.trim() || null,
      priority,
      status,
      is_active: status !== 'done',
      // Phase 2: send null to clear an unset estimate / due date.
      estimated_hours: estTrim ? estTrim : null,
      due_date: dueDate || null,
      // Reason only travels with a blocked status; any other status clears it.
      blocked_reason: status === 'blocked' ? (blockedReason.trim() || null) : null,
      assignee_ids: assigneeIds,
    };
    try {
      if (isEdit && task) {
        await update.mutateAsync({ id: task.id, data: body });
        onSaved('Task updated.');
      } else {
        await create.mutateAsync(body);
        onSaved(`Task ${name.trim()} created successfully.`);
      }
      onClose();
    } catch (err) {
      setError(errText(err, 'Could not save the task.'));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit task · ${task?.name}` : 'New task'} className="max-w-4xl" flushBottom>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Wider, two-column layout so everything fits without vertical scroll.
            Wide controls (assignee picker, client access, description) span both. */}
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <label className={labelClass}>Name<RequiredMark /></label>
            <Input value={name} onChange={(e) => { setName(e.target.value); setErrors((p) => ({ ...p, name: '' })); }} placeholder="Build the login form" required error={!!errors.name} />
            <FieldError error={errors.name} />
          </div>
          <div>
            <label className={labelClass}>Priority</label>
            <select className={selectClass} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              {(Object.keys(TASK_PRIORITY_LABEL) as TaskPriority[]).map((p) => (
                <option key={p} value={p}>
                  {TASK_PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Status</label>
            <select className={selectClass} value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
              {(Object.keys(TASK_STATUS_LABEL) as TaskStatus[]).map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Estimated hours</label>
            <Input
              type="number"
              min="0"
              step="0.25"
              value={estimatedHours}
              onChange={(e) => setEstimatedHours(e.target.value)}
              placeholder="e.g. 14"
            />
          </div>
          <div>
            <label className={labelClass}>Due date</label>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          {status === 'blocked' ? (
            <div className="md:col-span-2">
              <label className={labelClass}>Why is it blocked?</label>
              <textarea
                value={blockedReason}
                onChange={(e) => setBlockedReason(e.target.value)}
                rows={2}
                placeholder="e.g. Waiting on the API contract from the client"
                className={textareaClass}
              />
            </div>
          ) : null}
          <div className="md:col-span-2">
            <label className={labelClass}>Assign to</label>
            <MultiPicker
              options={assigneeOptions}
              selected={assigneeIds}
              onChange={setAssigneeIds}
              nameById={nameOf}
              placeholder={hasPM || canStaffSelf ? 'Assign team members...' : 'No one available to assign'}
              emptyText={
                hasPM
                  ? 'No more people to assign. This picker offers the project managers and their reports.'
                  : canStaffSelf
                    ? 'No reports available.'
                    : 'You have no reports to assign. Set a project manager on the project first.'
              }
            />
            {canStaffSelf && assigneeIds.length > 0 ? (
              <p className="mt-1.5 flex items-start gap-1.5 text-[12px] text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>This project has no manager yet. Saving will set <b>{actingUserName}</b> as its project manager and add the people you assign to the project roster.</span>
              </p>
            ) : null}
          </div>
          {isEdit && task ? (
            <div className="md:col-span-2">
              <ClientTaskAccessSection clientId={project.client_id} projectId={project.id} taskId={task.id} onFlash={onFlash} />
            </div>
          ) : null}
          <div className="md:col-span-2">
            <label className={labelClass}>Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Detail, acceptance criteria, or context..." className={textareaClass} />
          </div>
          {error ? <p className="text-sm text-rose-600 dark:text-rose-300 md:col-span-2">{error}</p> : null}
        </div>
        <div className="sticky bottom-0 -mx-4 mt-2 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
              </>
            ) : isEdit ? (
              'Save changes'
            ) : (
              'Create task'
            )}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ContractModal({
  open,
  clientId,
  contract,
  onClose,
  onSaved,
}: {
  open: boolean;
  clientId: number;
  contract: Contract | null;
  onClose: () => void;
  onSaved: (msg: string, id?: number) => void;
}) {
  const isEdit = !!contract;
  const create = useCreateContract();
  const update = useUpdateContract();
  const uploadDoc = useUploadContractDocument();

  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<ContractStatus>('draft');
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setTitle(contract?.title ?? '');
    setKind(contract?.kind ?? '');
    setStart(contract?.start_date ?? '');
    setEnd(contract?.end_date ?? '');
    setValue(contract?.value != null ? String(contract.value) : '');
    setStatus(contract?.status ?? 'draft');
    setFile(null);
    setError(null);
    setErrors({});
  }, [open, contract]);

  const saving = create.isPending || update.isPending || uploadDoc.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const nextErrors: Record<string, string> = {};
    if (!title.trim()) nextErrors.title = 'Title is required.';
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }
    const body: ContractBody = {
      title: title.trim(),
      kind: kind.trim() || null,
      start_date: start || null,
      end_date: end || null,
      value: value.trim() === '' ? null : num(value),
      status,
    };
    try {
      let contractId: number | undefined;
      if (isEdit && contract) {
        await update.mutateAsync({ clientId, id: contract.id, data: body });
        contractId = contract.id;
      } else {
        const created = await create.mutateAsync({ clientId, data: body });
        contractId = (created as Contract)?.id;
      }
      // Optional in-modal document attach: upload to the (possibly new)
      // contract once it exists. A failed upload doesn't lose the contract.
      if (file && contractId != null) {
        try {
          await uploadDoc.mutateAsync({ clientId, id: contractId, file });
        } catch (uerr) {
          onSaved(isEdit ? 'Contract saved, but the document upload failed.' : 'Contract created, but the document upload failed.', contractId);
          setError(errText(uerr, 'Document upload failed.'));
          onClose();
          return;
        }
      }
      onSaved(isEdit ? 'Contract updated.' : `Contract ${title.trim()} created successfully.`, contractId);
      onClose();
    } catch (err) {
      setError(errText(err, 'Could not save the contract.'));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit contract · ${contract?.title}` : 'New contract'} className="max-w-3xl" flushBottom>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Wider, two-column layout so everything fits without vertical scroll. */}
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <label className={labelClass}>Title<RequiredMark /></label>
            <Input value={title} onChange={(e) => { setTitle(e.target.value); setErrors((p) => ({ ...p, title: '' })); }} placeholder="SOW · Website Replatform" required error={!!errors.title} />
            <FieldError error={errors.title} />
          </div>
          <div className="md:col-span-2">
            <label className={labelClass}>Type</label>
            <Input value={kind} onChange={(e) => setKind(e.target.value)} placeholder="Statement of work" />
          </div>
          <div>
            <label className={labelClass}>Start</label>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>End</label>
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Value ($)</label>
            <Input type="number" step="0.01" min="0" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 400000" />
          </div>
          <div>
            <label className={labelClass}>Status</label>
            <select className={selectClass} value={status} onChange={(e) => setStatus(e.target.value as ContractStatus)}>
              {(Object.keys(CONTRACT_STATUS_LABEL) as ContractStatus[]).map((s) => (
                <option key={s} value={s}>
                  {CONTRACT_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label className={labelClass}>Signed document {isEdit && contract?.has_document ? '(replace)' : '(optional)'}</label>
            <input ref={fileRef} type="file" className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <div className="flex items-center gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
                <Paperclip className="h-3.5 w-3.5" /> {file ? 'Change file' : 'Attach document'}
              </Button>
              <span className="truncate text-[12px] text-muted-foreground">
                {file ? file.name : (isEdit && contract?.has_document ? (contract.document_name || 'Document attached') : 'No file selected')}
              </span>
              {file ? (
                <button type="button" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ''; }}
                  className="text-[12px] text-muted-foreground hover:text-foreground">Clear</button>
              ) : null}
            </div>
          </div>
          {error ? <p className="text-sm text-rose-600 dark:text-rose-300 md:col-span-2">{error}</p> : null}
        </div>
        <div className="sticky bottom-0 -mx-4 mt-2 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
              </>
            ) : isEdit ? (
              'Save changes'
            ) : (
              'Create contract'
            )}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ContactModal({
  open,
  clientId,
  contact,
  onClose,
  onSaved,
}: {
  open: boolean;
  clientId: number;
  contact: ClientContact | null;
  onClose: () => void;
  onSaved: (msg: string, id?: number) => void;
}) {
  const isEdit = !!contact;
  const create = useCreateClientContact();
  const update = useUpdateClientContact();

  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setName(contact?.name ?? '');
    setRole(contact?.role ?? '');
    // On create the modal seeds a primary email/phone; on edit channels are
    // managed from the expanded card, so the channel fields stay hidden.
    setEmail('');
    setPhone('');
    setError(null);
    setErrors({});
  }, [open, contact]);

  const saving = create.isPending || update.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const nextErrors: Record<string, string> = {};
    if (!name.trim()) nextErrors.name = 'Contact name is required.';
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }
    try {
      if (isEdit && contact) {
        const data: ClientContactBody = { name: name.trim(), role: role.trim() || null };
        await update.mutateAsync({ clientId, id: contact.id, data });
        onSaved('Contact updated.', contact.id);
      } else {
        const emails: ContactChannel[] = email.trim() ? [{ label: 'Work', address: email.trim() }] : [];
        const phones: ContactChannel[] = phone.trim() ? [{ label: 'Mobile', number: phone.trim() }] : [];
        const data: ClientContactBody = { name: name.trim(), role: role.trim() || null, emails, phones };
        const created = (await create.mutateAsync({ clientId, data })) as ClientContact;
        onSaved(`Contact ${name.trim()} created successfully.`, created?.id);
      }
      onClose();
    } catch (err) {
      setError(errText(err, 'Could not save the contact.'));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit contact · ${contact?.name}` : 'New contact'} className="max-w-2xl" flushBottom>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Contact name<RequiredMark /></label>
            <Input value={name} onChange={(e) => { setName(e.target.value); setErrors((p) => ({ ...p, name: '' })); }} placeholder="Jane Doe" required error={!!errors.name} />
            <FieldError error={errors.name} />
          </div>
          <div>
            <label className={labelClass}>Role / title</label>
            <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Operations Director" />
          </div>
        </div>
        {!isEdit ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Email</label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@acme.com" />
            </div>
            <div>
              <label className={labelClass}>Phone</label>
              <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 (555) 000-0000" />
            </div>
          </div>
        ) : (
          <p className="text-[10.5px] text-muted-foreground">Manage emails and phones from the contact row after saving.</p>
        )}
        {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
        <div className="sticky bottom-0 -mx-4 mt-2 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
              </>
            ) : isEdit ? (
              'Save changes'
            ) : (
              'Create contact'
            )}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// One modal for adding/editing a single email or phone channel. Returns the
// channel payload to the parent, which persists the whole array.
function ChannelModal({
  open,
  kind,
  channel,
  saving,
  onClose,
  onSubmit,
}: {
  open: boolean;
  kind: 'emails' | 'phones';
  channel: ContactChannel | null;
  saving: boolean;
  onClose: () => void;
  onSubmit: (payload: ContactChannel) => void;
}) {
  const isEmail = kind === 'emails';
  const isEdit = !!channel;
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setLabel(channel?.label ?? '');
    setValue((isEmail ? channel?.address : channel?.number) ?? '');
    setError(null);
    setErrors({});
  }, [open, channel, isEmail]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const nextErrors: Record<string, string> = {};
    if (!value.trim()) nextErrors.value = isEmail ? 'Email address is required.' : 'Phone number is required.';
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }
    const payload: ContactChannel = isEmail
      ? { label: label.trim() || null, address: value.trim() }
      : { label: label.trim() || null, number: value.trim() };
    onSubmit(payload);
  }

  const noun = isEmail ? 'email' : 'phone';
  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit ${noun}` : `New ${noun}`} className="max-w-sm" flushBottom>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={labelClass}>Label</label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={isEmail ? 'Work' : 'Mobile'} />
        </div>
        <div>
          <label className={labelClass}>{isEmail ? 'Email address' : 'Phone number'}<RequiredMark /></label>
          <Input
            type={isEmail ? 'email' : 'tel'}
            value={value}
            onChange={(e) => { setValue(e.target.value); setErrors((p) => ({ ...p, value: '' })); }}
            placeholder={isEmail ? 'jane@acme.com' : '+1 (555) 000-0000'}
            required
            error={!!errors.value}
          />
          <FieldError error={errors.value} />
        </div>
        {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
        <div className="sticky bottom-0 -mx-4 mt-2 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
              </>
            ) : isEdit ? (
              'Save changes'
            ) : (
              `Add ${noun}`
            )}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RoleModal({
  open,
  clientId,
  role,
  onClose,
  onSaved,
  onError,
}: {
  open: boolean;
  clientId: number;
  role: ClientRoleRate | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const isEdit = !!role;
  const create = useCreateRoleRate();
  const update = useUpdateRoleRate();

  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [effective, setEffective] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setName(role?.role ?? '');
    setRate(role?.rate != null ? String(role.rate) : '');
    setCurrency(role?.currency ?? 'USD');
    setEffective(role?.effective_date ?? '');
    setError(null);
    setErrors({});
  }, [open, role]);

  const saving = create.isPending || update.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const nextErrors: Record<string, string> = {};
    if (!name.trim()) nextErrors.name = 'Role is required.';
    if (num(rate) <= 0) nextErrors.rate = 'Enter a rate greater than 0.';
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }
    const body: ClientRoleRateBody = {
      role: name.trim(),
      rate: num(rate),
      currency,
      effective_date: effective || null,
    };
    try {
      if (isEdit && role) {
        await update.mutateAsync({ clientId, id: role.id, data: body });
        onSaved('Role updated.');
      } else {
        await create.mutateAsync({ clientId, data: body });
        onSaved(`Role ${name.trim()} created successfully.`);
      }
      onClose();
    } catch (err) {
      onError(errText(err, 'Could not save the role.'));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit role · ${role?.role}` : 'New role'} className="max-w-3xl" flushBottom>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Wider, two-column layout so everything fits without vertical scroll. */}
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <label className={labelClass}>Role<RequiredMark /></label>
            <Input value={name} onChange={(e) => { setName(e.target.value); setErrors((p) => ({ ...p, name: '' })); }} placeholder="Senior Engineer" required error={!!errors.name} />
            <FieldError error={errors.name} />
          </div>
          <div>
            <label className={labelClass}>Rate ($/hr)<RequiredMark /></label>
            <Input type="number" step="0.01" min="0" value={rate} onChange={(e) => { setRate(e.target.value); setErrors((p) => ({ ...p, rate: '' })); }} placeholder="295" required error={!!errors.rate} />
            <FieldError error={errors.rate} />
          </div>
          <div>
            <label className={labelClass}>Currency</label>
            <select className={selectClass} value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label className={labelClass}>Effective from</label>
            <Input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
          </div>
          {error ? <p className="text-sm text-rose-600 dark:text-rose-300 md:col-span-2">{error}</p> : null}
        </div>
        <div className="sticky bottom-0 -mx-4 mt-2 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
              </>
            ) : isEdit ? (
              'Save changes'
            ) : (
              'Create role'
            )}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════════
//  Shared primitives
// ════════════════════════════════════════════════════════════════════════

interface PickerOption {
  id: number;
  name: string;
  sub?: string;
}

// Shared open-coordinator so only ONE MultiPicker is open at a time. Opening a
// picker closes every other one synchronously — so clicking an adjacent picker
// (e.g. Team members while Project managers is open) opens it in a single click
// instead of the first click just dismissing the other.
const multiPickerClosers = new Set<() => void>();
function closeOtherMultiPickers(except: () => void) {
  multiPickerClosers.forEach((close) => { if (close !== except) close(); });
}

// Chip-style multi-select. Selected ids that fall outside the option list are
// pruned (so changing the PM set narrows the member pool cleanly).
function MultiPicker({
  options,
  selected,
  onChange,
  placeholder,
  emptyText,
  nameById,
}: {
  options: PickerOption[];
  selected: number[];
  onChange: (ids: number[]) => void;
  placeholder: string;
  emptyText: string;
  // Optional directory for resolving chip names of selected ids that aren't in
  // the current option pool (e.g. team members whose PM isn't selected). Without
  // it those chips fall back to "#<id>".
  nameById?: (id: number) => string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // When there isn't room below the trigger, the panel opens upward.
  const [flipUp, setFlipUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Register this picker's closer in the shared coordinator so opening any other
  // picker closes this one (and vice versa) — see openSelf below.
  useEffect(() => {
    const close = () => setOpen(false);
    multiPickerClosers.add(close);
    return () => { multiPickerClosers.delete(close); };
  }, []);

  // Open this picker: close any other open picker first, then decide whether to
  // drop the panel up or down based on the room beneath the trigger.
  const PANEL_MAX = 260; // ~max-h-60 (240) + the search row's headroom
  const openSelf = () => {
    closeOtherMultiPickers(() => setOpen(false));
    const rect = ref.current?.getBoundingClientRect();
    if (rect) {
      const below = window.innerHeight - rect.bottom;
      setFlipUp(below < PANEL_MAX && rect.top > below);
    }
    setQuery('');
    setOpen(true);
  };
  const toggleOpen = () => (open ? setOpen(false) : openSelf());

  // Prune selected ids no longer available as options (e.g. narrowing the PM
  // set drops their reports from the member picker). Skip pruning while the
  // option list is still empty/loading, or it would silently wipe a valid
  // selection (the directory query hadn't resolved yet) on Save.
  useEffect(() => {
    if (options.length === 0) return;
    const allowed = new Set(options.map((o) => o.id));
    const next = selected.filter((id) => allowed.has(id));
    if (next.length !== selected.length) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const byId = new Map(options.map((o) => [o.id, o]));
  const q = query.trim().toLowerCase();
  const visible = options.filter((o) => !q || o.name.toLowerCase().includes(q) || (o.sub ?? '').toLowerCase().includes(q));

  const toggle = (id: number) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  return (
    <div ref={ref} className="relative">
      <div
        role="button"
        tabIndex={0}
        onClick={toggleOpen}
        className="flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-2xl border border-border bg-transparent px-2 py-1.5 text-sm focus-within:border-primary"
      >
        {selected.length === 0 ? (
          <span className="px-1 text-muted-foreground">{placeholder}</span>
        ) : (
          selected.map((id) => {
            const o = byId.get(id);
            const nm = o?.name ?? nameById?.(id) ?? `#${id}`;
            return (
              <span key={id} className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-1 pr-1.5 text-xs font-semibold text-primary">
                <span className={cn('grid h-4 w-4 place-items-center rounded-full text-[8px] font-semibold', avatarTone(nm))}>{initials(nm)}</span>
                {nm}
                <button
                  type="button"
                  aria-label={`Remove ${nm}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(id);
                  }}
                  className="opacity-70 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })
        )}
        <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
      </div>

      {open ? (
        <div className={cn(
          'absolute z-50 max-h-60 w-full overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-xl',
          flipUp ? 'bottom-full mb-1.5' : 'mt-1.5',
        )}>
          {options.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">{emptyText}</p>
          ) : (
            <>
              <Input className="mb-1.5 h-8" placeholder="Search people..." value={query} onChange={(e) => setQuery(e.target.value)} onClick={(e) => e.stopPropagation()} />
              {visible.map((o) => {
                const sel = selected.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => toggle(o.id)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-primary/5"
                  >
                    <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold', avatarTone(o.name))}>{initials(o.name)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-foreground">{o.name}</span>
                      {o.sub ? <span className="block truncate text-[11px] text-muted-foreground">{o.sub}</span> : null}
                    </span>
                    <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-md border', sel ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-transparent')}>
                      <Check className="h-3 w-3" />
                    </span>
                  </button>
                );
              })}
              {visible.length === 0 ? <p className="px-2 py-2 text-xs text-muted-foreground">No matches.</p> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

// Styled delete confirmation (replaces native window.confirm). Renders nothing
// until a confirm payload is set on the page.
function ConfirmDialog({
  confirm,
  onClose,
  onConfirm,
}: {
  confirm: ConfirmState | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  // Default to the destructive (delete) styling for back-compat; non-destructive
  // actions (archive) pass danger=false + their own label/icon.
  const danger = confirm?.danger ?? true;
  const label = confirm?.confirmLabel ?? 'Delete';
  const Icon = confirm?.confirmIcon ?? Trash2;
  return (
    <Modal open={!!confirm} onClose={onClose} title="" className="max-w-sm">
      {confirm ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            {/* Leading icon chip is a danger signal; only destructive confirms
                (delete) get it. Non-destructive actions (archive) read calmer
                without it. */}
            {danger ? (
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-rose-500/10 text-rose-500">
                <Icon className="h-5 w-5" />
              </span>
            ) : null}
            <div className="min-w-0">
              <p className="text-base font-semibold text-foreground">{confirm.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{confirm.message}</p>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={onConfirm}
              className={danger
                ? 'bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-700'
                : undefined}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function IconButton({ label, onClick, Icon, sm, danger }: { label: string; onClick: () => void; Icon: typeof Pencil; sm?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'grid place-items-center rounded-full text-muted-foreground transition-colors',
        sm ? 'h-7 w-7' : 'h-8 w-8',
        danger ? 'hover:bg-rose-500/10 hover:text-rose-500' : 'hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className={sm ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
    </button>
  );
}

function Loader() {
  return (
    <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
    </div>
  );
}
