import { useMemo, useState } from 'react';
import { Archive, Building2, Database, Loader2, PauseCircle, Plus, Search, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, Empty, Input, Modal, StatTile, StatusBadge, TonePill, WorkspaceHeader } from '@/components/ui';
import type { TileTone, Tone } from '@/components/ui';
import { useCreateTenant, useTenants, useTenantStats } from '@/hooks/usePlatform';
import type { Tenant } from '@/types/platform';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';

const STATUS_TONE: Record<string, Tone> = { active: 'success', inactive: 'neutral', suspended: 'danger', archived: 'neutral' };

type StatusTab = 'all' | 'active' | 'suspended' | 'archived';

// Relative "time ago" for last-activity. Falls back to a date for older stamps.
function relativeFrom(iso?: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';
  const min = Math.floor((Date.now() - then.getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Platform-admin: the tenants (workspaces) list with create + per-tenant stats
// (admins/users/last-activity), status tabs, and a processing filter. Drills
// into a detail page. Cross-tenant superuser surface.
export function PlatformTenantsPage() {
  const navigate = useNavigate();
  // Two list calls so we can derive the archived set as the diff (the backend
  // hides archived tenants by default; there's no `archived` status on the row).
  const visibleQ = useTenants(false);
  const allQ = useTenants(true);
  const statsQ = useTenantStats();
  const create = useCreateTenant();

  const [search, setSearch] = useState('');
  const [statusTab, setStatusTab] = useState<StatusTab>('all');
  const [featuresFilter, setFeaturesFilter] = useState<'' | 'processing'>('');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [isolated, setIsolated] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => visibleQ.data ?? [], [visibleQ.data]);
  const all = useMemo(() => allQ.data ?? [], [allQ.data]);
  const stats = statsQ.data?.stats ?? {};

  // Archived = present in the with-archived list but hidden from the default one.
  const archived = useMemo(() => {
    const visibleIds = new Set(visible.map((t) => t.id));
    return all.filter((t) => !visibleIds.has(t.id));
  }, [all, visible]);

  // Stat-tile counts.
  const counts = useMemo(() => {
    const total = visible.length + archived.length;
    const active = visible.filter((t) => t.status === 'active').length;
    const suspended = visible.filter((t) => t.status === 'suspended').length;
    const processing = visible.filter((t) => t.ingestion_enabled).length;
    return { total, active, suspended, archived: archived.length, processing };
  }, [visible, archived]);

  // Per-tab badges on the strip.
  const tabCounts: Record<StatusTab, number> = {
    all: visible.length,
    active: counts.active,
    suspended: counts.suspended,
    archived: counts.archived,
  };

  // The archived tab operates on the archived diff; every other tab on the
  // default visible set.
  const baseSet = statusTab === 'archived' ? archived : visible;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return baseSet.filter((t) => {
      if (statusTab === 'active' && t.status !== 'active') return false;
      if (statusTab === 'suspended' && t.status !== 'suspended') return false;
      if (featuresFilter === 'processing' && !t.ingestion_enabled) return false;
      if (q && !(`${t.name} ${t.slug}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [baseSet, statusTab, featuresFilter, search]);

  const isLoading = visibleQ.isLoading || allQ.isLoading;
  const isError = visibleQ.isError || allQ.isError;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !slug.trim()) { setError('Name and slug are required.'); return; }
    try {
      const t = await create.mutateAsync({ name: name.trim(), slug: slug.trim().toLowerCase(), is_isolated: isolated });
      setCreateOpen(false); setName(''); setSlug('');
      navigate(`/platform/tenants/${t.slug}`);
    } catch (err) {
      const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof d === 'string' ? d : 'Could not create the tenant.');
    }
  }

  const STAT_TILES: { label: string; value: number; hint: string; Icon: typeof Building2; tone: TileTone }[] = [
    { label: 'All tenants', value: counts.total, hint: 'Total workspaces', Icon: Building2, tone: 'rose' },
    { label: 'Active', value: counts.active, hint: pct(counts.active, counts.total), Icon: ShieldCheck, tone: 'emerald' },
    { label: 'Suspended', value: counts.suspended, hint: pct(counts.suspended, counts.total), Icon: PauseCircle, tone: 'amber' },
    { label: 'Archived', value: counts.archived, hint: pct(counts.archived, counts.total), Icon: Archive, tone: 'sky' },
    { label: 'Processing enabled', value: counts.processing, hint: pct(counts.processing, counts.total), Icon: Database, tone: 'violet' },
  ];

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        title="Tenants"
        description={`${counts.total} ${counts.total === 1 ? 'workspace' : 'workspaces'}`}
        primary={<Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> New tenant</Button>}
      />

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {STAT_TILES.map((t) => (
          <StatTile key={t.label} Icon={t.Icon} tone={t.tone} label={t.label} value={isLoading ? '…' : t.value} hint={t.hint} />
        ))}
      </div>

      {/* Status tab strip */}
      <div role="tablist" className="flex flex-wrap items-center gap-1 border-b border-border">
        {(['all', 'active', 'suspended', 'archived'] as StatusTab[]).map((tab) => {
          const isActive = statusTab === tab;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setStatusTab(tab)}
              className={cn(
                'group inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition',
                isActive ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
              <span className={cn(
                'inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
                isActive ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground group-hover:bg-muted/70',
              )}>
                {tabCounts[tab]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Toolbar: search + feature filter */}
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search tenants by name or slug..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select
          value={featuresFilter}
          onChange={(e) => setFeaturesFilter(e.target.value as '' | 'processing')}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
          aria-label="Filter by feature"
        >
          <option value="">All features</option>
          <option value="processing">Processing on</option>
        </select>
      </Card>

      {isLoading ? (
        <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>
      ) : isError ? (
        <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">Couldn't load tenants. You may not have platform-admin access.</Card>
      ) : filtered.length === 0 ? (
        <Empty
          Icon={Building2}
          title={visible.length === 0 && archived.length === 0 ? 'No tenants' : 'No matching tenants'}
          description={visible.length === 0 && archived.length === 0 ? 'Create the first workspace to get started.' : 'No tenants match the current filters.'}
          action={<Button size="sm" onClick={() => setCreateOpen(true)}>New tenant</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((t) => (
            <TenantCard
              key={t.id}
              tenant={t}
              isArchivedRow={statusTab === 'archived'}
              stats={stats[t.id]}
              onOpen={() => navigate(`/platform/tenants/${t.slug}`)}
            />
          ))}
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New tenant">
        <form onSubmit={handleCreate} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => { setName(e.target.value); if (!slug || slug === name.toLowerCase().replace(/[^a-z0-9]+/g, '-')) setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }} placeholder="Acme Consulting" autoFocus />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Slug</label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="acme-consulting" />
          </div>
          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={isolated} onChange={(e) => setIsolated(e.target.checked)} className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]" />
            Isolated (own database)
          </label>
          {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={create.isPending}>
              {create.isPending ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Creating…</>) : 'Create tenant'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function pct(n: number, total: number): string {
  if (total === 0) return '—';
  const p = Math.round((n / total) * 1000) / 10;
  return `${p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)}% of all`;
}

// One tenant card: avatar, name/slug, status pill, processing pill, and the
// per-tenant stat row (admins / users / last activity) from /platform/tenants/stats.
function TenantCard({
  tenant,
  isArchivedRow,
  stats,
  onOpen,
}: {
  tenant: Tenant;
  isArchivedRow: boolean;
  stats?: { user_count?: number | null; admin_count?: number | null; last_activity_at?: string | null; error?: string | null };
  onOpen: () => void;
}) {
  const statusKey = isArchivedRow ? 'archived' : tenant.status;
  const statusLabel = statusKey.charAt(0).toUpperCase() + statusKey.slice(1);
  const statsFailed = Boolean(stats?.error);
  const admins = stats?.admin_count ?? null;
  const users = stats?.user_count ?? null;

  const statValue = (v: number | null) => {
    if (statsFailed) return <span className="text-muted-foreground" title={stats?.error ?? undefined}>N/A</span>;
    if (v == null) return <span className="text-muted-foreground">…</span>;
    return <span className="font-semibold tabular-nums text-foreground">{v}</span>;
  };

  return (
    <Card className="cursor-pointer p-4 transition-shadow hover:border-primary/30 hover:shadow-sm" onClick={onOpen}>
      <div className="flex items-center justify-between">
        <span className={cn('grid h-10 w-10 place-items-center rounded-xl text-sm font-semibold', avatarTone(tenant.name))}>{initials(tenant.name)}</span>
        {statusKey === 'active'
          ? <StatusBadge status="approved" variant="timesheet" label="Active" showIcon={false} />
          : <TonePill tone={STATUS_TONE[statusKey] ?? 'neutral'}>{statusLabel}</TonePill>}
      </div>

      <p className="mt-3 truncate text-sm font-semibold text-foreground">{tenant.name}</p>
      <div className="mt-0.5 flex items-center gap-2">
        <p className="truncate text-xs text-muted-foreground">/{tenant.slug}</p>
        {tenant.ingestion_enabled
          ? <TonePill tone="success">Processing on</TonePill>
          : <TonePill tone="neutral">Processing off</TonePill>}
      </div>

      {/* Per-tenant stats from /platform/tenants/stats */}
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Admins</div>
          <div className={cn('text-sm', admins === 0 && !statsFailed ? 'font-semibold text-amber-600 dark:text-amber-400' : '')}>
            {admins === 0 && !statsFailed ? '0' : statValue(admins)}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Users</div>
          <div className="text-sm">{statValue(users)}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Last activity</div>
          <div className="text-xs text-muted-foreground">{statsFailed ? 'N/A' : relativeFrom(stats?.last_activity_at)}</div>
        </div>
      </div>
    </Card>
  );
}
