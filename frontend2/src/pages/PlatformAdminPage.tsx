import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Archive,
  Building2,
  ChevronRight,
  Database,
  FileText,
  PauseCircle,
  PlusCircle,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { tenantsAPI } from '@/api';
import { usePlatformTenantStats } from '@/hooks';
import type { Tenant, TenantStatus } from '@/types';

// ── PlatformAdminPage ────────────────────────────────────────────────
//
// The platform-admin tenants page. Layout (matches the May 2026
// redesign mockup):
//
//   [ header + intro ]
//   [ 5 stat tiles: All / Active / Suspended / Archived / Processing ]
//   [ All | Active | Suspended | Archived ]  -- status tab strip
//   [ search ] [ feature filter ] [ admins filter ] [ + New tenant ]
//   [   compact table of tenants                                  ][ side rail ]
//
// Stats are computed client-side from two list calls (default = no
// archived, second call adds them) so we don't need a backend
// aggregate endpoint. Archived tenants are a soft-delete state -
// the backend hides them by default.

// ─── Pills ──────────────────────────────────────────────────────────

const STATUS_PILL: Record<
  TenantStatus | 'archived',
  { label: string; classes: string }
> = {
  active: {
    label: 'Active',
    classes: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
  inactive: {
    label: 'Inactive',
    classes: 'bg-muted text-muted-foreground',
  },
  suspended: {
    label: 'Suspended',
    classes: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  },
  archived: {
    label: 'Archived',
    classes: 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400',
  },
};

const apiError = (e: unknown): string =>
  (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Something went wrong';

const initialsFor = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

const relativeFrom = (iso: string | null): string => {
  if (!iso) return 'N/A';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'N/A';
  const diffMs = Date.now() - then.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

type StatusTab = 'all' | 'active' | 'suspended' | 'archived';

// ─── Page ───────────────────────────────────────────────────────────

export const PlatformAdminPage: React.FC = () => {
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Two list calls so we can derive archived counts without a new
  // backend endpoint. The archived-only list is the diff.
  const { data: tenantsVisible = [], isLoading: tenantsLoading } = useQuery({
    queryKey: ['tenants'],
    queryFn: () => tenantsAPI.list().then((r) => r.data),
  });
  const { data: tenantsAll = [] } = useQuery({
    queryKey: ['tenants', 'with-archived'],
    queryFn: () => tenantsAPI.list({ include_archived: true }).then((r) => r.data),
  });

  const archivedTenants = useMemo(() => {
    const visibleIds = new Set(tenantsVisible.map((t) => t.id));
    return tenantsAll.filter((t) => !visibleIds.has(t.id));
  }, [tenantsAll, tenantsVisible]);

  const { data: statsResp } = usePlatformTenantStats();
  const statsByTenant = useMemo(() => {
    const map: Record<number, NonNullable<typeof statsResp>['stats'][string]> = {};
    if (statsResp?.stats) {
      for (const [k, v] of Object.entries(statsResp.stats)) {
        const id = Number(k);
        if (Number.isFinite(id)) map[id] = v;
      }
    }
    return map;
  }, [statsResp]);

  // ── Filter state ────────────────────────────────────────────────
  const [statusTab, setStatusTab] = useState<StatusTab>('all');
  const [search, setSearch] = useState('');
  const [featuresFilter, setFeaturesFilter] = useState<'' | 'processing'>('');

  // The dataset the tabs operate on. "Archived" only includes archived
  // rows; everything else operates on the default visible set.
  const baseSet = statusTab === 'archived' ? archivedTenants : tenantsVisible;

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return baseSet.filter((t) => {
      if (statusTab === 'active' && t.status !== 'active') return false;
      if (statusTab === 'suspended' && t.status !== 'suspended') return false;
      if (featuresFilter === 'processing' && !t.ingestion_enabled) return false;
      if (needle) {
        const blob = `${t.name} ${t.slug}`.toLowerCase();
        if (!blob.includes(needle)) return false;
      }
      return true;
    });
  }, [baseSet, statusTab, featuresFilter, search]);

  // ── Stat tile counts ────────────────────────────────────────────
  const counts = useMemo(() => {
    const total = tenantsVisible.length + archivedTenants.length;
    const active = tenantsVisible.filter((t) => t.status === 'active').length;
    const suspended = tenantsVisible.filter((t) => t.status === 'suspended').length;
    const archived = archivedTenants.length;
    const processing = tenantsVisible.filter((t) => t.ingestion_enabled).length;
    return { total, active, suspended, archived, processing };
  }, [tenantsVisible, archivedTenants]);

  // Per-tab counts shown on the tab strip itself.
  const tabCounts: Record<StatusTab, number> = {
    all: tenantsVisible.length,
    active: counts.active,
    suspended: counts.suspended,
    archived: counts.archived,
  };

  // ── Create-tenant modal ─────────────────────────────────────────
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createSlug, setCreateSlug] = useState('');
  const [createIsolated, setCreateIsolated] = useState(false);
  const [createError, setCreateError] = useState('');

  const createTenant = useMutation({
    mutationFn: (d: { name: string; slug: string; is_isolated?: boolean }) =>
      tenantsAPI.create(d).then((r) => r.data),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ['tenants'] });
      qc.invalidateQueries({ queryKey: ['tenants', 'with-archived'] });
      qc.invalidateQueries({ queryKey: ['platform', 'tenants', 'stats'] });
      setShowCreate(false);
      setCreateName('');
      setCreateSlug('');
      setCreateIsolated(false);
      setCreateError('');
      navigate(`/platform/tenants/${t.slug}`);
    },
    onError: (e: unknown) => setCreateError(apiError(e)),
  });

  const submitCreate = (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError('');
    const name = createName.trim();
    const slug = createSlug.trim();
    if (!name || !slug) {
      setCreateError('Name and slug are required.');
      return;
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      setCreateError('Slug must be lowercase letters, numbers, hyphens only.');
      return;
    }
    createTenant.mutate({ name, slug, is_isolated: createIsolated });
  };

  const [slugTouched, setSlugTouched] = useState(false);
  const onChangeName = (v: string) => {
    setCreateName(v);
    if (!slugTouched) {
      setCreateSlug(v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    }
  };

  return (
    <div className="space-y-5">
      {/* ── Header ───────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Tenants</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage tenants, access, and email-processing settings across the platform.
        </p>
      </div>

      {/* ── Stat strip ────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile
          label="All tenants"
          value={counts.total}
          sublabel="Total tenants"
          icon={<Building2 className="h-5 w-5" />}
          accent="rose"
          loading={tenantsLoading}
        />
        <StatTile
          label="Active"
          value={counts.active}
          sublabel={percentLabel(counts.active, counts.total)}
          icon={<ShieldCheck className="h-5 w-5" />}
          accent="emerald"
          loading={tenantsLoading}
        />
        <StatTile
          label="Suspended"
          value={counts.suspended}
          sublabel={percentLabel(counts.suspended, counts.total)}
          icon={<PauseCircle className="h-5 w-5" />}
          accent="amber"
          loading={tenantsLoading}
        />
        <StatTile
          label="Archived"
          value={counts.archived}
          sublabel={percentLabel(counts.archived, counts.total)}
          icon={<Archive className="h-5 w-5" />}
          accent="slate"
          loading={tenantsLoading}
        />
        <StatTile
          label="Processing enabled"
          value={counts.processing}
          sublabel={percentLabel(counts.processing, counts.total)}
          icon={<Database className="h-5 w-5" />}
          accent="violet"
          loading={tenantsLoading}
        />
      </div>

      {/* ── Status tabs ──────────────────────────────────────────── */}
      <div role="tablist" className="flex flex-wrap items-center gap-1 border-b border-border">
        {(['all', 'active', 'suspended', 'archived'] as StatusTab[]).map((tab) => {
          const isActive = statusTab === tab;
          const label = tab.charAt(0).toUpperCase() + tab.slice(1);
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setStatusTab(tab)}
              className={[
                'group inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition',
                isActive
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {label}
              <span
                className={[
                  'inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
                  isActive
                    ? 'bg-primary/15 text-primary'
                    : 'bg-muted text-muted-foreground group-hover:bg-muted/70',
                ].join(' ')}
              >
                {tabCounts[tab]}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── Body: toolbar + table beside a side rail ─────────────── */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-3 min-w-0">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[240px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tenants by name or slug…"
                className="w-full rounded-md border border-border bg-card pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <select
              value={featuresFilter}
              onChange={(e) => setFeaturesFilter(e.target.value as '' | 'processing')}
              className="rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
            >
              <option value="">All features</option>
              <option value="processing">Processing on</option>
            </select>
            <button
              type="button"
              onClick={() => { setShowCreate(true); setCreateError(''); setSlugTouched(false); }}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              <PlusCircle className="h-4 w-4" />
              New tenant
            </button>
          </div>

          {/* Compact row list */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="grid grid-cols-[1fr_120px_140px_70px_70px_120px_24px] gap-3 border-b border-border bg-muted/30 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <div>Tenant</div>
              <div>Processing</div>
              <div>Status</div>
              <div className="text-right">Admins</div>
              <div className="text-right">Users</div>
              <div className="text-right">Last activity</div>
              <div></div>
            </div>

            {tenantsLoading ? (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">Loading tenants…</div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                {tenantsVisible.length === 0 && archivedTenants.length === 0
                  ? 'No tenants yet.'
                  : 'No tenants match the current filters.'}
              </div>
            ) : (
              filtered.map((t) => (
                <TenantRow
                  key={t.id}
                  tenant={t}
                  isArchivedRow={statusTab === 'archived'}
                  stats={statsByTenant[t.id]}
                  onOpen={() => navigate(`/platform/tenants/${t.slug}`)}
                />
              ))
            )}

            {filtered.length > 0 && (
              <div className="flex items-center justify-between border-t border-border bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
                <span>
                  Showing {filtered.length} of {baseSet.length} tenant{baseSet.length === 1 ? '' : 's'}
                </span>
                <span>Click any row to manage that tenant</span>
              </div>
            )}
          </div>
        </div>

        {/* Side rail */}
        <aside className="hidden lg:block">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
              <FileText className="h-4 w-4 text-primary" />
              Tenant details
            </div>
            <div className="rounded-lg border border-border bg-background/60 p-4">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-md bg-muted" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-2 w-3/4 rounded bg-muted" />
                  <div className="flex items-center gap-1.5">
                    <div className="h-1.5 w-12 rounded-full bg-emerald-500/40" />
                  </div>
                </div>
              </div>
              <div className="mt-4 space-y-2">
                <div className="h-2 w-full rounded bg-muted" />
                <div className="h-2 w-5/6 rounded bg-muted" />
                <div className="h-2 w-4/6 rounded bg-muted" />
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Click any tenant row to open the detail view and manage settings, admins, features, and more.
            </p>
            <button
              type="button"
              onClick={() => navigate('/platform/settings?tab=docs')}
              className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs font-semibold text-primary transition hover:bg-primary/10"
            >
              Learn more
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        </aside>
      </div>

      {/* ── New-tenant modal ─────────────────────────────────────── */}
      {showCreate && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Create new tenant"
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 px-4"
          onClick={() => { if (!createTenant.isPending) setShowCreate(false); }}
        >
          <div
            className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <form onSubmit={submitCreate} className="p-5 space-y-4">
              <div>
                <h2 className="text-base font-semibold text-foreground">New tenant</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Identity only. You can flip features and add admin contacts on the detail page after creation.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Name</label>
                <input
                  autoFocus
                  value={createName}
                  onChange={(e) => onChangeName(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                  placeholder="e.g. Acme Corp"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Slug</label>
                <input
                  value={createSlug}
                  onChange={(e) => { setSlugTouched(true); setCreateSlug(e.target.value); }}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
                  placeholder="acme-corp"
                  pattern="^[a-z0-9-]+$"
                  required
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Lowercase letters, numbers, hyphens. Used in URLs and database names.
                </p>
              </div>
              <div className="rounded-md border border-border bg-background/40 px-3 py-2.5">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createIsolated}
                    onChange={(e) => setCreateIsolated(e.target.checked)}
                    disabled={createTenant.isPending}
                    className="mt-0.5"
                  />
                  <span className="text-xs">
                    <span className="block font-medium text-foreground">Create as isolated database</span>
                    <span className="block mt-0.5 text-muted-foreground">
                      Provisions a dedicated <code className="font-mono">acufy_tenant_{createSlug || '<slug>'}</code> database
                      for this tenant. Cannot be changed after creation. Existing tenants stay on the shared database; leave
                      unchecked to onboard there.
                    </span>
                  </span>
                </label>
              </div>
              {createError && (
                <p className="text-xs text-rose-500">{createError}</p>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  disabled={createTenant.isPending}
                  className="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createTenant.isPending}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {createTenant.isPending ? 'Creating…' : 'Create tenant'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Helpers ────────────────────────────────────────────────────────

const percentLabel = (n: number, total: number): string => {
  if (total === 0) return 'N/A';
  const pct = Math.round((n / total) * 1000) / 10;
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1)}% of all tenants`;
};

// ─── Stat tile ──────────────────────────────────────────────────────

type Accent = 'rose' | 'emerald' | 'amber' | 'slate' | 'violet';

const ACCENT_CLASSES: Record<Accent, { wrap: string; icon: string }> = {
  rose: { wrap: 'bg-rose-500/10 border-rose-500/20', icon: 'text-rose-500' },
  emerald: { wrap: 'bg-emerald-500/10 border-emerald-500/20', icon: 'text-emerald-500' },
  amber: { wrap: 'bg-amber-500/10 border-amber-500/20', icon: 'text-amber-500' },
  slate: { wrap: 'bg-zinc-500/10 border-zinc-500/20', icon: 'text-zinc-500' },
  violet: { wrap: 'bg-violet-500/10 border-violet-500/20', icon: 'text-violet-500' },
};

const StatTile: React.FC<{
  label: string;
  value: number;
  sublabel: string;
  icon: React.ReactNode;
  accent: Accent;
  loading: boolean;
}> = ({ label, value, sublabel, icon, accent, loading }) => {
  const ac = ACCENT_CLASSES[accent];
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${ac.wrap}`}>
          <span className={ac.icon}>{icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="mt-0.5 text-2xl font-semibold tabular-nums text-foreground">
            {loading ? '…' : value}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">{sublabel}</div>
        </div>
      </div>
    </div>
  );
};

// ─── Row component ──────────────────────────────────────────────────

interface TenantRowProps {
  tenant: Tenant;
  isArchivedRow: boolean;
  stats?: {
    user_count: number | null;
    admin_count: number | null;
    last_activity_at: string | null;
    error: string | null;
  };
  onOpen: () => void;
}

const TenantRow: React.FC<TenantRowProps> = ({ tenant, isArchivedRow, stats, onOpen }) => {
  const pill = isArchivedRow ? STATUS_PILL.archived : STATUS_PILL[tenant.status];
  const userCount = stats?.user_count ?? null;
  const adminCount = stats?.admin_count ?? null;
  const last = stats?.last_activity_at ?? null;
  const statsFailed = Boolean(stats?.error);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full grid-cols-[1fr_120px_140px_70px_70px_120px_24px] gap-3 border-b border-border px-4 py-3 text-left text-sm transition last:border-b-0 hover:bg-muted/30 focus:outline-none focus:ring-2 focus:ring-primary/30"
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white"
          style={{ background: 'linear-gradient(135deg, #334155, #1e293b)' }}
          aria-hidden="true"
        >
          {initialsFor(tenant.name)}
        </div>
        <div className="min-w-0">
          <p className="truncate font-semibold text-foreground">{tenant.name}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{tenant.slug}</p>
        </div>
      </div>

      <div className="flex items-center">
        {tenant.ingestion_enabled ? (
          <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            On
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Off
          </span>
        )}
      </div>

      <div className="flex items-center">
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${pill.classes}`}>
          {pill.label}
        </span>
      </div>

      <div className="flex items-center justify-end">
        {statsFailed ? (
          <span className="text-muted-foreground" title={stats?.error ?? undefined}>N/A</span>
        ) : adminCount == null ? (
          <span className="text-muted-foreground">…</span>
        ) : (
          <span className={`font-semibold tabular-nums ${adminCount === 0 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}>
            {adminCount}
          </span>
        )}
      </div>

      <div className="flex items-center justify-end">
        {statsFailed ? (
          <span className="text-muted-foreground" title={stats?.error ?? undefined}>N/A</span>
        ) : userCount == null ? (
          <span className="text-muted-foreground">…</span>
        ) : (
          <span className="font-semibold tabular-nums text-foreground">{userCount}</span>
        )}
      </div>

      <div className="flex items-center justify-end text-xs text-muted-foreground">
        {statsFailed ? 'N/A' : relativeFrom(last)}
      </div>

      <div className="flex items-center justify-end text-muted-foreground">
        <ChevronRight className="h-4 w-4" />
      </div>
    </button>
  );
};
