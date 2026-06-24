import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Briefcase, Check, ChevronRight, Folder, Loader2, Plus, ShieldCheck, UserPlus, Users, X,
} from 'lucide-react';

import { Button, Card, Empty, TonePill } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { clientPortalApi } from '@/api/client';
import { ClientWorkView } from '@/pages/ClientPortalPage';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import type { ClientEmployeeSummary, PortalProject, PortalTask } from '@/types/admin';

const STATUS_TONE: Record<string, 'success' | 'brand' | 'info' | 'neutral' | 'warning' | 'danger'> = {
  planning: 'info', in_progress: 'brand', on_hold: 'info', completed: 'success',
  to_do: 'info', done: 'success', pending: 'warning', approved: 'success', rejected: 'danger',
};
const fmt = (s?: string | null) => (s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '');

// The CLIENT_MANAGER portal: the senior client person manages their own client
// employees — inviting them (when self-manage is enabled), assigning them to the
// work shared with the manager, and reviewing their updates.
export function ClientManagerPortalPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'mywork' | 'team'>('mywork');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const flashAndFade = (tone: 'ok' | 'err', text: string) => {
    setFlash({ tone, text });
    window.setTimeout(() => setFlash(null), 4000);
  };

  const ctxQ = useQuery({ queryKey: ['cm', 'context'], queryFn: () => clientPortalApi.managerContext().then((r) => r.data) });
  const portalCtxQ = useQuery({ queryKey: ['client-portal', 'context'], queryFn: () => clientPortalApi.portalContext().then((r) => r.data) });
  const employeesQ = useQuery({ queryKey: ['cm', 'employees'], queryFn: () => clientPortalApi.managerEmployees().then((r) => r.data) });

  const ctx = ctxQ.data;
  const portalCtx = portalCtxQ.data;
  const employees = employeesQ.data ?? [];

  const refreshTeam = () => { qc.invalidateQueries({ queryKey: ['cm', 'employees'] }); qc.invalidateQueries({ queryKey: ['cm', 'context'] }); };

  return (
    <div className="space-y-5">
      {/* Hero */}
      {/* Soft, theme-blended hero (matches the User Management hero). */}
      <div className="overflow-hidden rounded-2xl border border-border bg-primary/[0.05]">
        <div className="flex items-start gap-4 px-6 py-5">
          <span className={cn('grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-lg font-semibold ring-2 ring-primary/15', avatarTone(user?.full_name ?? '?'))}>
            {initials(user?.full_name ?? '?')}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-[22px] font-bold tracking-tight text-foreground">{user?.full_name ?? 'Client manager'}</h1>
            <div className="mt-1 text-[13px] text-muted-foreground">
              {(ctx?.client_names ?? []).join(', ') || 'Client'} · Client manager
            </div>
            {portalCtx?.account_team?.length ? (
              <div className="mt-1.5 inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <Briefcase className="h-3.5 w-3.5 text-primary" />
                Account team: <span className="font-medium text-foreground">{portalCtx.account_team.map((p) => p.name).join(', ')}</span>
              </div>
            ) : null}
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <TonePill tone="brand">{employees.length} {employees.length === 1 ? 'team member' : 'team members'}</TonePill>
            </div>
          </div>
        </div>
      </div>

      {flash ? (
        <div role="alert" className={cn('rounded-xl border px-3 py-2 text-sm',
          flash.tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300')}>
          {flash.text}
        </div>
      ) : null}

      {/* Tabs */}
      <div className="flex gap-1 rounded-full bg-muted p-0.5 w-fit">
        {([['mywork', 'My work'], ['team', 'Team & assignments']] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={cn('rounded-full px-4 py-1.5 text-sm font-semibold transition', tab === k ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground')}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'mywork' ? (
        <div>
          <div className="mb-3">
            <h2 className="font-display text-lg font-bold">My work</h2>
            <p className="text-[13px] text-muted-foreground">The projects and tasks shared with you. Update them directly here.</p>
          </div>
          {/* The manager's own granted work, capability-gated (no review — they're
              the top of the client chain). Reuses the client work view. */}
          <ClientWorkView heading={false} />
        </div>
      ) : (
        <TeamTab
          ctx={ctx} employees={employees} loading={employeesQ.isLoading}
          onFlash={flashAndFade} onChanged={refreshTeam}
        />
      )}
    </div>
  );
}

function TeamTab({
  ctx, employees, loading, onFlash, onChanged,
}: {
  ctx: { can_invite_employees: boolean } | undefined;
  employees: ClientEmployeeSummary[];
  loading: boolean;
  onFlash: (t: 'ok' | 'err', m: string) => void;
  onChanged: () => void;
}) {
  const [inviting, setInviting] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState('');
  const [assignFor, setAssignFor] = useState<ClientEmployeeSummary | null>(null);

  const invite = useMutation({
    mutationFn: () => clientPortalApi.managerInvite({ full_name: name.trim(), email: email.trim(), label: label.trim() || undefined }).then((r) => r.data),
    onSuccess: (r) => { setInviting(false); setName(''); setEmail(''); setLabel(''); onChanged(); onFlash('ok', r.message); },
    onError: (e: unknown) => onFlash('err', extractError(e)),
  });
  const removeEmp = useMutation({
    mutationFn: (userId: number) => clientPortalApi.managerRemoveEmployee(userId),
    onSuccess: () => { onChanged(); onFlash('ok', 'Employee removed.'); },
    onError: (e: unknown) => onFlash('err', extractError(e)),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg font-bold">Your team</h2>
          <p className="text-[13px] text-muted-foreground">Client employees you manage and what they can work on.</p>
        </div>
        {ctx?.can_invite_employees ? (
          <Button size="sm" onClick={() => setInviting((v) => !v)}>
            <UserPlus className="h-4 w-4" /> Invite employee
          </Button>
        ) : null}
      </div>

      {!ctx?.can_invite_employees ? (
        <div className="flex items-start gap-2.5 rounded-xl bg-muted/60 px-4 py-2.5 text-[12.5px] text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Self-management is turned off for your account. Your account team adds employees and assigns their work. You can still review what they do.</span>
        </div>
      ) : null}

      {inviting ? (
        <Card className="space-y-2.5 p-4">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name"
              className="h-9 rounded-md border border-border bg-background px-2.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" />
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" type="email"
              className="h-9 rounded-md border border-border bg-background px-2.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" />
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Role / title (optional)"
              className="h-9 rounded-md border border-border bg-background px-2.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" disabled={!name.trim() || !email.trim() || invite.isPending} onClick={() => invite.mutate()}>
              {invite.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />} Send invite
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setInviting(false)}>Cancel</Button>
          </div>
        </Card>
      ) : null}

      {loading ? (
        <div className="grid place-items-center py-12 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : employees.length === 0 ? (
        <Empty Icon={Users} title="No employees yet" description={ctx?.can_invite_employees ? 'Invite your first employee to start assigning work.' : 'Your account team will add your employees here.'} />
      ) : (
        <div className="space-y-2">
          {employees.map((e) => (
            <Card key={e.user_id} className="p-3.5">
              <div className="flex items-center gap-3">
                <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-bold', avatarTone(e.full_name))}>{initials(e.full_name)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-semibold">{e.full_name}</span>
                    {e.label ? <span className="text-[11px] text-muted-foreground">{e.label}</span> : null}
                    {!e.email_verified ? <TonePill tone="warning">Invited</TonePill> : <TonePill tone="success">Active</TonePill>}
                  </div>
                  <div className="text-[12px] text-muted-foreground">{e.email} · {e.assignment_count} {e.assignment_count === 1 ? 'assignment' : 'assignments'}</div>
                </div>
                {ctx?.can_invite_employees ? (
                  <Button size="sm" variant="secondary" onClick={() => setAssignFor(e)}>
                    <Plus className="h-3.5 w-3.5" /> Assign work
                  </Button>
                ) : null}
                <button type="button" aria-label="Remove employee" onClick={() => { if (window.confirm(`Remove ${e.full_name} from your team?`)) removeEmp.mutate(e.user_id); }}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500">
                  <X className="h-4 w-4" />
                </button>
              </div>
              {/* The actual assignments — so the manager sees WHAT each person works on. */}
              {(e.assignments ?? []).length ? (
                <div className="mt-2.5 space-y-1 border-t border-border pt-2.5 pl-12">
                  {(e.assignments ?? []).map((a) => (
                    <div key={a.grant_id} className="flex items-center justify-between gap-2 text-[12.5px]">
                      <span className="min-w-0 truncate">
                        {a.scope === 'task' ? (
                          <><span className="font-medium text-foreground">{a.task_name ?? `Task #${a.task_id}`}</span>
                            {a.project_name ? <span className="text-muted-foreground"> · {a.project_name}</span> : null}</>
                        ) : (
                          <><span className="font-medium text-foreground">{a.project_name ?? `Project #${a.project_id}`}</span>
                            <span className="text-muted-foreground"> · whole project</span></>
                        )}
                      </span>
                      <TonePill tone={a.capabilities.includes('update') ? 'brand' : 'neutral'}>
                        {a.capabilities.includes('update') ? 'Can edit' : 'View only'}
                      </TonePill>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-2 border-t border-border pt-2 pl-12 text-[12px] italic text-muted-foreground">No work assigned yet.</div>
              )}
            </Card>
          ))}
        </div>
      )}

      {assignFor ? (
        <AssignModal employee={assignFor} onClose={() => setAssignFor(null)} onFlash={onFlash} onAssigned={onChanged} />
      ) : null}
    </div>
  );
}

// Pick a task from the manager's shared scope and grant it to the employee.
function AssignModal({
  employee, onClose, onFlash, onAssigned,
}: {
  employee: ClientEmployeeSummary;
  onClose: () => void;
  onFlash: (t: 'ok' | 'err', m: string) => void;
  onAssigned: () => void;
}) {
  const scopeQ = useQuery({ queryKey: ['cm', 'assignable'], queryFn: () => clientPortalApi.managerAssignable().then((r) => r.data) });
  const projects = scopeQ.data ?? [];
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [canUpdate, setCanUpdate] = useState(true);

  const assign = useMutation({
    mutationFn: (vars: { project_id?: number; task_id?: number }) =>
      clientPortalApi.managerAssign({ employee_user_id: employee.user_id, ...vars, capabilities: canUpdate ? ['read', 'update'] : ['read'] }).then((r) => r.data),
    onSuccess: () => { onAssigned(); onFlash('ok', `Assigned to ${employee.full_name}.`); },
    onError: (e: unknown) => onFlash('err', extractError(e)),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-base font-bold">Assign work to {employee.full_name}</h3>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
        <p className="mb-3 text-[13px] text-muted-foreground">Choose a task to assign. Employees can view and update — never create or delete.</p>

        <label className="mb-3 flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={canUpdate} onChange={(e) => setCanUpdate(e.target.checked)} className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]" />
          Allow editing (uncheck for view-only)
        </label>

        {scopeQ.isLoading ? (
          <div className="grid place-items-center py-10 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : projects.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-muted-foreground">Nothing has been shared with you to assign yet.</p>
        ) : (
          <div className="max-h-[50vh] space-y-1.5 overflow-y-auto">
            {projects.map((p: PortalProject) => {
              const isOpen = open[p.id] ?? true;
              return (
                <div key={p.id} className="overflow-hidden rounded-lg border border-border">
                  <button type="button" onClick={() => setOpen((s) => ({ ...s, [p.id]: !(s[p.id] ?? true) }))}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-primary/[0.03]">
                    <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
                    <Folder className="h-4 w-4 text-primary" />
                    <span className="text-[13.5px] font-semibold">{p.name}</span>
                    {p.status ? <TonePill tone={STATUS_TONE[p.status] ?? 'neutral'}>{fmt(p.status)}</TonePill> : null}
                  </button>
                  {isOpen ? (
                    <div className="border-t border-border bg-background px-3 py-2">
                      {(p.tasks ?? []).length === 0 ? (
                        <p className="py-1 text-[12px] text-muted-foreground">No tasks shared on this project.</p>
                      ) : (
                        <div className="space-y-1">
                          {p.tasks.map((t: PortalTask) => (
                            <div key={t.id} className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-primary/[0.04]">
                              <span className="text-[13px]">{t.name}</span>
                              <Button size="sm" variant="secondary" disabled={assign.isPending} onClick={() => assign.mutate({ task_id: t.id })}>
                                {assign.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Assign
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  );
}

function extractError(err: unknown): string {
  const e = err as { response?: { data?: { detail?: string } }; message?: string };
  const d = e?.response?.data?.detail;
  return (typeof d === 'string' ? d : undefined) ?? e?.message ?? 'Something went wrong.';
}
