import {
  ArrowRight,
  Building2,
  Clock,
  DatabaseZap,
  Loader2,
  Plus,
  Settings,
  ShieldAlert,
  TrendingUp,
  UserPlus,
  Users,
  Wrench,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type { ComponentType } from 'react';

import { Card, StatTile, WorkspaceHeader } from '@/components/ui';
import { usePlatformAudit, usePlatformHealth, usePlatformSummary } from '@/hooks/usePlatform';
import type { PlatformAuditRow } from '@/types/platform';
import { cn } from '@/lib/cn';

const STATUS_DOT: Record<string, string> = { good: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-rose-500' };

// Category drives the icon in the activity feed so the eye can scan quickly.
const CATEGORY_ICON: Record<string, ComponentType<{ className?: string }>> = {
  tenant: Plus,
  feature: Settings,
  admin: UserPlus,
  credentials: ShieldAlert,
  migration: DatabaseZap,
};
const categoryIcon = (category: string): ComponentType<{ className?: string }> =>
  CATEGORY_ICON[category] ?? Wrench;

// Severity tints the icon. Backend emits info / warn(ing) / critical (+ error).
const severityClass = (severity: string): string => {
  if (severity === 'critical' || severity === 'error') return 'text-rose-600 dark:text-rose-400';
  if (severity === 'warn' || severity === 'warning') return 'text-amber-600 dark:text-amber-400';
  return 'text-primary';
};

function relTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'N/A';
  const diff = Math.max(0, Date.now() - d.getTime());
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Platform-admin fleet dashboard: cross-tenant summary metrics + a health grid.
export function PlatformDashboardPage() {
  const navigate = useNavigate();
  const summary = usePlatformSummary();
  const health = usePlatformHealth();
  // Recent activity: 7 most recent control-plane events (same endpoint as
  // /platform/audit, tighter limit + no filters).
  const audit = usePlatformAudit({ limit: 7 });
  const auditItems = audit.data?.items ?? [];

  return (
    <div className="space-y-5">
      <WorkspaceHeader title="Platform" description="Fleet overview across all workspaces." />

      {summary.isLoading ? (
        <div className="grid place-items-center rounded-2xl border border-border bg-card py-12 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>
      ) : summary.isError ? (
        <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">Couldn't load the platform summary. You may not have platform-admin access.</Card>
      ) : summary.data ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile Icon={Building2} tone="primary" value={summary.data.active_tenants} label="Active tenants" hint={summary.data.active_tenants_delta ?? undefined} onClick={() => navigate('/platform/tenants')} />
          <StatTile Icon={Users} tone="sky" value={summary.data.total_users} label="Total users" hint={summary.data.total_users_delta ?? undefined} />
          <StatTile Icon={TrendingUp} tone="violet" value={summary.data.fetch_jobs_24h} label="Fetch jobs (24h)" hint={summary.data.fetch_jobs_24h_delta ?? undefined} />
          <StatTile Icon={Clock} tone="emerald" value={`${Math.round(summary.data.hours_logged_this_week)}h`} label="Hours this week" hint={summary.data.hours_logged_delta ?? undefined} />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.2fr_1fr]">
        <Card>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold text-foreground">System health</p>
            {health.data ? <p className="text-xs text-muted-foreground">refreshed {new Date(health.data.refreshed_at).toLocaleTimeString()}</p> : null}
          </div>
          {health.isLoading ? (
            <div className="grid place-items-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" /></div>
          ) : !health.data || health.data.widgets.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">No health data.</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
              {health.data.widgets.map((w) => (
                <div key={w.key} className="rounded-xl border border-border p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{w.label}</p>
                    <span className={cn('h-2.5 w-2.5 rounded-full', STATUS_DOT[w.status] ?? 'bg-slate-400')} />
                  </div>
                  <p className="mt-1 text-lg font-semibold text-foreground">{w.value}</p>
                  {w.detail ? <p className="text-xs text-muted-foreground">{w.detail}</p> : null}
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Recent platform activity: 7-event preview into /platform/audit. */}
        <Card>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold text-foreground">Recent activity</p>
            <Link to="/platform/audit" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              View all
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {audit.isLoading ? (
            <div className="grid place-items-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" /></div>
          ) : auditItems.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">No platform activity yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {auditItems.map((row: PlatformAuditRow) => {
                const Icon = categoryIcon(row.category);
                return (
                  <li key={row.id} className="flex gap-3 px-4 py-3 text-sm">
                    <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/60', severityClass(row.severity))}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-foreground">{row.summary}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {row.actor_email ?? row.actor_label ?? 'System'} · {relTime(row.created_at)}
                        {row.tenant_name ? ` · ${row.tenant_name}` : ''}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
