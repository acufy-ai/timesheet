import React from 'react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import {
  Activity,
  ArrowRight,
  Building2,
  Clock3,
  DatabaseZap,
  Download,
  Plus,
  RefreshCw,
  Settings,
  ShieldAlert,
  UserPlus,
  Users,
  Wrench,
} from 'lucide-react';

import { Loading } from '@/components';
import {
  usePlatformAudit,
  usePlatformDashboardHealth,
  usePlatformDashboardSummary,
} from '@/hooks';
import type {
  PlatformAuditCategory,
  PlatformAuditEventRow,
  PlatformAuditSeverity,
  PlatformHealthWidget,
} from '@/types';

// ── Status-dot color for the health cards. Maps the three statuses the
// backend returns to a Tailwind class. Keep this small and explicit;
// adding new states means the backend also added them. ────────────────
const statusDotClass = (status: PlatformHealthWidget['status']): string => {
  if (status === 'good') return 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]';
  if (status === 'warn') return 'bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.18)]';
  return 'bg-rose-500 shadow-[0_0_0_3px_rgba(244,63,94,0.18)]';
};

const statusLabel = (status: PlatformHealthWidget['status']): string => {
  if (status === 'good') return 'Healthy';
  if (status === 'warn') return 'Attention';
  return 'Failing';
};

// ── Icon picker for activity-feed rows. Categories drive both icon
// and tint so the eye can scan the feed quickly. ───────────────────────
const categoryIcon = (category: PlatformAuditCategory): React.ReactNode => {
  if (category === 'tenant') return <Plus className="h-4 w-4" />;
  if (category === 'feature') return <Settings className="h-4 w-4" />;
  if (category === 'admin') return <UserPlus className="h-4 w-4" />;
  if (category === 'credentials') return <ShieldAlert className="h-4 w-4" />;
  if (category === 'migration') return <DatabaseZap className="h-4 w-4" />;
  return <Wrench className="h-4 w-4" />;
};

const severityClass = (severity: PlatformAuditSeverity): string => {
  if (severity === 'critical') return 'text-rose-600 dark:text-rose-400';
  if (severity === 'warn') return 'text-amber-600 dark:text-amber-400';
  return 'text-primary';
};

const relativeTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'N/A';
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return format(date, 'MMM d');
};

const AGGREGATE_SKELETON = Array.from({ length: 4 }, (_, i) => i);

export const PlatformDashboardPage: React.FC = () => {
  const navigate = useNavigate();
  const { data: summary, isLoading: summaryLoading } = usePlatformDashboardSummary();
  const { data: health, isLoading: healthLoading } = usePlatformDashboardHealth();
  // Recent activity widget shows the 7 most recent events. Same backing
  // endpoint as /platform/audit, just a tighter limit and no filters.
  const { data: audit } = usePlatformAudit({ limit: 7 });

  if (summaryLoading && !summary) {
    return <Loading message="Loading platform dashboard..." />;
  }

  const handleTenantsClick = () => navigate('/platform/tenants');
  const handleViewAllAudit = () => navigate('/platform/audit');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[20px] font-semibold text-foreground">Platform dashboard</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Fleet-wide snapshot. Open the Tenants tab to drill into a specific tenant.
        </p>
      </div>

      {/* ── Aggregate strip ─────────────────────────────────────────── */}
      <h2 className="text-xs font-semibold uppercase tracking-[0.4px] text-muted-foreground">
        Fleet snapshot
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Active tenants — clickable, routes to /platform/tenants. The
            mockup explicitly called this out as the primary cross-link
            into the tenant management surface. */}
        <button
          type="button"
          onClick={handleTenantsClick}
          className="group relative overflow-hidden rounded-xl border border-border bg-card p-4 text-left transition hover:-translate-y-0.5 hover:border-primary hover:bg-muted"
          aria-label="Open Tenants tab"
        >
          <span className="absolute right-3 top-3 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary">
            <ArrowRight className="h-4 w-4" />
          </span>
          <p className="text-[11px] font-medium uppercase tracking-[0.5px] text-muted-foreground">
            <Building2 className="mb-1 inline h-3.5 w-3.5 align-text-bottom" /> Active tenants
          </p>
          <p className="mt-1 text-2xl font-bold leading-tight text-foreground">
            {summary?.active_tenants ?? 'N/A'}
          </p>
          {summary?.active_tenants_delta && (
            <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
              {summary.active_tenants_delta}
            </p>
          )}
        </button>

        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.5px] text-muted-foreground">
            <Users className="mb-1 inline h-3.5 w-3.5 align-text-bottom" /> Total users
          </p>
          <p className="mt-1 text-2xl font-bold leading-tight text-foreground">
            {summary?.total_users?.toLocaleString() ?? 'N/A'}
          </p>
          {summary?.total_users_delta && (
            <p className="mt-1 text-xs text-muted-foreground">{summary.total_users_delta}</p>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.5px] text-muted-foreground">
            <Download className="mb-1 inline h-3.5 w-3.5 align-text-bottom" /> Fetch jobs · 24h
          </p>
          <p className="mt-1 text-2xl font-bold leading-tight text-foreground">
            {summary?.fetch_jobs_24h?.toLocaleString() ?? 'N/A'}
          </p>
          {summary?.fetch_jobs_24h_delta && (
            <p className="mt-1 text-xs text-muted-foreground">
              {summary.fetch_jobs_24h_delta}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.5px] text-muted-foreground">
            <Clock3 className="mb-1 inline h-3.5 w-3.5 align-text-bottom" /> Hours logged · this week
          </p>
          <p className="mt-1 text-2xl font-bold leading-tight text-foreground">
            {summary?.hours_logged_this_week?.toLocaleString(undefined, {
              maximumFractionDigits: 0,
            }) ?? 'N/A'}
          </p>
          {summary?.hours_logged_delta && (
            <p className="mt-1 text-xs text-muted-foreground">{summary.hours_logged_delta}</p>
          )}
        </div>
      </div>

      {/* ── Lower row: Health + Activity ────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.2fr_1fr]">
        {/* Platform health */}
        <section className="surface-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-border/70 bg-background px-5 py-3">
            <h2 className="text-sm font-semibold text-foreground">Platform health</h2>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Activity className="h-3.5 w-3.5" />
              Live · refreshes every 30s
            </span>
          </div>
          {healthLoading && !health ? (
            <div className="px-5 py-8 text-sm text-muted-foreground">Loading…</div>
          ) : (
            <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
              {(health?.widgets ?? AGGREGATE_SKELETON.map((i) => ({
                key: `skel-${i}`,
                label: 'N/A',
                value: 'N/A',
                status: 'warn' as const,
                detail: null,
              }))).map((w) => (
                <div
                  key={w.key}
                  className="rounded-lg border border-border bg-background p-3"
                >
                  <p className="text-[10px] font-medium uppercase tracking-[0.4px] text-muted-foreground">
                    {w.label}
                  </p>
                  <p className="mt-1 text-base font-semibold text-foreground">{w.value}</p>
                  <p className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(w.status)}`} />
                    {w.detail ?? statusLabel(w.status)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Recent platform activity (7-day preview into /platform/audit) */}
        <section className="surface-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-border/70 bg-background px-5 py-3">
            <h2 className="text-sm font-semibold text-foreground">Recent platform activity</h2>
            <button
              type="button"
              onClick={handleViewAllAudit}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              View all
              <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          {audit && audit.items.length > 0 ? (
            <ul className="divide-y divide-border">
              {audit.items.map((row: PlatformAuditEventRow) => (
                <li
                  key={row.id}
                  className="flex gap-3 px-4 py-3 text-sm"
                >
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/60 ${severityClass(row.severity)}`}
                  >
                    {categoryIcon(row.category)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground">{row.summary}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {row.actor_email ?? row.actor_label ?? 'System'} · {relativeTime(row.created_at)}
                      {row.tenant_name ? ` · ${row.tenant_name}` : ''}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 px-5 py-10 text-center text-sm text-muted-foreground">
              <RefreshCw className="h-5 w-5 opacity-60" />
              <p>No platform activity yet. Tenant lifecycle events will appear here as they happen.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
