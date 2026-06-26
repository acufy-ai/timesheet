import { useMemo, useState } from 'react';
import { Activity, ArrowRight, ChevronDown, Database, Inbox, Loader2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Card, Empty, TonePill } from '@/components/ui';
import type { Tone } from '@/components/ui';
import {
  useAdminProjects,
  useClients,
  useRecentActivity,
  useSystemHealth,
  useUsers,
} from '@/hooks/useAdmin';
import { useDismissedSignals, useDismissSignal } from '@/hooks/useNotifications';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';

const SEVERITY_TONE: Record<string, Tone> = { error: 'danger', warning: 'warning', success: 'success', info: 'info' };
const HEALTH_ICON: Record<string, typeof Database> = { database: Database, redis: Activity, email_ingestion: Inbox };

function relTime(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Deterministic decorative sparkline bars from a string seed — matches
// frontend2 (the bars are illustrative; the status badge carries the truth).
function sparkline(seed: string): number[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return Array.from({ length: 28 }, (_, i) => {
    h = (h * 1103515245 + 12345) >>> 0;
    return 30 + ((h >> (i % 13)) % 70);
  });
}

// Admin org-stats dashboard view, matching frontend2's "Organization Stats":
// attention banner, 5 stat tiles (People w/ role breakdown, Clients, Active
// projects, Pending invites, Notifications), collapsible Recent Org Activity,
// and System Health cards with status badges + sparklines.
export function AdminOrgStats() {
  const navigate = useNavigate();
  const usersQ = useUsers();
  const clientsQ = useClients();
  const projectsQ = useAdminProjects();
  const activityQ = useRecentActivity(12);
  const healthQ = useSystemHealth();

  const dismissedQ = useDismissedSignals();
  const dismissSignal = useDismissSignal();
  const dismissed = useMemo(
    () => new Set((dismissedQ.data ?? []).map((d) => d.signal_key)),
    [dismissedQ.data],
  );
  const [activityExpanded, setActivityExpanded] = useState(false);

  const users = usersQ.data ?? [];
  const counts = useMemo(() => {
    const emp = users.filter((u) => u.role === 'EMPLOYEE').length;
    const mgr = users.filter((u) => u.role === 'MANAGER').length;
    const adm = users.filter((u) => u.role === 'ADMIN').length;
    // Everything not emp/mgr/adm (viewers, client-portal users, etc.) — folded
    // into one bucket so the breakdown always sums to `people`. Previously these
    // were dropped, so e.g. 94 people read "82 emp · 5 mgr · 2 adm" (= 89).
    const other = users.length - emp - mgr - adm;
    const pendingInvites = users.filter((u) => !u.email_verified && !u.is_external).length;
    return { people: users.length, emp, mgr, adm, other, pendingInvites };
  }, [users]);

  const activity = activityQ.data ?? [];

  // Action queue: derive attention items (org-chart gaps, stale invites, recent
  // errors/warnings) ranked by urgency, each linking to a filtered destination.
  const STALE_DAYS = 7;
  const queue = useMemo(() => {
    const items: { id: string; urgency: 'urgent' | 'warn' | 'info'; title: string; detail: string; cta: string; go: () => void }[] = [];
    const noManager = users.filter((u) => u.is_active && !u.is_external && (u.role === 'EMPLOYEE' || u.role === 'MANAGER') && !u.manager_id);
    if (noManager.length > 0) {
      const sample = noManager.slice(0, 3).map((u) => u.full_name).join(', ');
      items.push({ id: 'no-manager', urgency: 'urgent', title: `${noManager.length} user${noManager.length === 1 ? '' : 's'} without a manager`, detail: `${sample}${noManager.length > 3 ? ` +${noManager.length - 3} more` : ''}. Approval chain is broken until assigned.`, cta: 'Assign managers', go: () => navigate('/user-management?attention=no_manager') });
    }
    const staleCutoff = Date.now() - STALE_DAYS * 86400000;
    const stale = users.filter((u) => u.is_active && !u.email_verified && !u.is_external && (u as { created_at?: string }).created_at && Date.parse((u as { created_at?: string }).created_at as string) < staleCutoff);
    const unverified = users.filter((u) => !u.email_verified && !u.is_external);
    if (stale.length > 0) {
      items.push({ id: 'stale-invites', urgency: 'warn', title: `${stale.length} unverified invitation${stale.length === 1 ? '' : 's'} over ${STALE_DAYS}d old`, detail: "Resend or revoke. Unverified accounts can't sign in.", cta: 'Open users', go: () => navigate('/user-management?attention=unverified') });
    } else if (unverified.length > 0) {
      items.push({ id: 'unverified', urgency: 'info', title: `${unverified.length} pending ${unverified.length === 1 ? 'invite' : 'invites'}`, detail: "Users who haven't verified their email yet.", cta: 'Open users', go: () => navigate('/user-management?attention=unverified') });
    }
    activity.filter((a) => a.severity === 'error').slice(0, 3).forEach((a) => {
      items.push({ id: `err-${a.id}`, urgency: 'urgent', title: a.summary, detail: 'Recent error in the workspace. Investigate before it cascades.', cta: 'Investigate', go: () => navigate(a.route ?? '/audit-trail') });
    });
    activity.filter((a) => a.severity === 'warning').slice(0, 2).forEach((a) => {
      items.push({ id: `warn-${a.id}`, urgency: 'warn', title: a.summary, detail: 'Recent warning in the workspace. Worth a look.', cta: 'Review', go: () => navigate(a.route ?? '/audit-trail') });
    });
    const order = { urgent: 0, warn: 1, info: 2 };
    return items.filter((i) => !dismissed.has(i.id)).sort((a, b) => order[a.urgency] - order[b.urgency]);
  }, [users, activity, dismissed, navigate]);

  const loading = usersQ.isLoading || clientsQ.isLoading || projectsQ.isLoading;
  if (loading) {
    return <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>;
  }

  const visibleActivity = activityExpanded ? activity : activity.slice(0, 5);
  const queueVisible = queue.slice(0, 5);
  const URGENCY_DOT: Record<string, string> = { urgent: 'bg-rose-500', warn: 'bg-amber-500', info: 'bg-sky-500' };

  return (
    <div className="space-y-4">
      {/* Needs your attention — action queue */}
      {queue.length > 0 ? (
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">Needs your attention</p>
            <span className="text-xs text-muted-foreground">{queue.length} {queue.length === 1 ? 'item' : 'items'}</span>
          </div>
          <ul className="space-y-2">
            {queueVisible.map((it) => (
              <li key={it.id} className="relative">
                <button type="button" onClick={it.go} className="group flex w-full items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-3 py-2.5 pr-8 text-left transition hover:border-primary/40 hover:bg-primary/5">
                  <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', URGENCY_DOT[it.urgency])} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{it.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{it.detail}</span>
                  </span>
                  <span className="ml-2 hidden shrink-0 items-center gap-1 text-xs font-medium text-primary group-hover:flex">{it.cta} <ArrowRight className="h-3.5 w-3.5" /></span>
                </button>
                <button type="button" aria-label="Dismiss" onClick={() => dismissSignal.mutate({ key: it.id })} className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground"><X className="h-3 w-3" /></button>
              </li>
            ))}
          </ul>
          {queue.length > queueVisible.length ? <p className="mt-2 text-xs text-muted-foreground">{queue.length - queueVisible.length} more not shown.</p> : null}
        </Card>
      ) : null}

      {/* 5 stat tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatBox label="People" value={counts.people} sub={`${counts.emp} emp · ${counts.mgr} mgr · ${counts.adm} adm${counts.other > 0 ? ` · ${counts.other} other` : ''}`} onClick={() => navigate('/user-management')} />
        <StatBox label="Clients" value={clientsQ.data?.length ?? 0} onClick={() => navigate('/client-management')} />
        <StatBox label="Active projects" value={projectsQ.data?.length ?? 0} onClick={() => navigate('/client-management')} />
        <StatBox label="Pending invites" value={counts.pendingInvites} onClick={() => navigate('/user-management')} />
        <StatBox label="Recent events" value={activity.length} onClick={() => navigate('/audit-trail')} />
      </div>

      {/* Recent Org Activity (collapsible) */}
      <Card>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-semibold text-foreground">Recent Org Activity</p>
          <button type="button" onClick={() => setActivityExpanded((v) => !v)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">
            {activity.length} items <ChevronDown className={cn('h-4 w-4 transition-transform', activityExpanded && 'rotate-180')} />
          </button>
        </div>
        {activityQ.isLoading ? (
          <div className="grid place-items-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" /></div>
        ) : activity.length === 0 ? (
          <Empty title="No recent activity" description="Workspace events will appear here." className="border-0" />
        ) : (
          <div className="divide-y divide-border">
            {visibleActivity.map((e) => (
              <button key={e.id} type="button" onClick={() => e.route && navigate(e.route)} disabled={!e.route} className={cn('flex w-full items-start gap-3 px-4 py-2.5 text-left', e.route ? 'hover:bg-primary/5' : 'cursor-default')}>
                <span className={cn('mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold', avatarTone(e.actor_name ?? 'system'))}>{initials(e.actor_name ?? 'SY')}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">{e.summary}</p>
                  <p className="text-xs text-muted-foreground">{e.activity_type.replace(/_/g, ' ').toLowerCase()}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  <TonePill tone={SEVERITY_TONE[e.severity] ?? 'info'}>{e.severity}</TonePill>
                  <span className="text-[11px] text-muted-foreground">{relTime(e.created_at)}</span>
                </div>
              </button>
            ))}
            {activity.length > 5 ? (
              <button type="button" onClick={() => setActivityExpanded((v) => !v)} className="w-full px-4 py-2 text-center text-xs font-medium text-primary hover:bg-primary/5">
                {activityExpanded ? 'Show less' : `Show ${activity.length - 5} more`}
              </button>
            ) : null}
          </div>
        )}
      </Card>

      {/* System Health */}
      <Card>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-semibold text-foreground">System Health</p>
          <p className="text-xs text-muted-foreground">last 24h</p>
        </div>
        {healthQ.isLoading && !healthQ.data ? (
          <div className="grid place-items-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" /></div>
        ) : (
          <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-3">
            {(healthQ.data ?? []).map((c) => {
              const Icon = HEALTH_ICON[c.key] ?? Activity;
              const bars = sparkline(c.key);
              const max = Math.max(...bars);
              return (
                <div key={c.key} className="rounded-xl border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Icon className="h-4 w-4" /></span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground">{c.label}</p>
                        <p className="truncate text-xs text-muted-foreground" title={c.subtitle}>{c.subtitle}</p>
                      </div>
                    </div>
                    <TonePill tone={c.status === 'healthy' ? 'success' : c.status === 'attention' ? 'warning' : 'neutral'}>
                      {c.status === 'healthy' ? 'Healthy' : c.status === 'attention' ? 'Attention' : '—'}
                    </TonePill>
                  </div>
                  <div className="mt-3 flex h-8 items-end gap-0.5">
                    {bars.map((b, i) => (
                      <div key={i} className={cn('flex-1 rounded-sm', c.status === 'healthy' ? 'bg-emerald-500/50' : 'bg-amber-500/50')} style={{ height: `${(b / max) * 100}%` }} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function StatBox({ label, value, sub, onClick }: { label: string; value: number; sub?: string; onClick?: () => void }) {
  const inner = (
    <>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums text-foreground">{value}</p>
      {sub ? <p className="mt-1 text-[11px] text-muted-foreground">{sub}</p> : null}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="rounded-2xl border border-border bg-card p-4 text-left transition-shadow hover:border-primary/30 hover:shadow-sm">{inner}</button>
  ) : (
    <Card className="p-4">{inner}</Card>
  );
}
