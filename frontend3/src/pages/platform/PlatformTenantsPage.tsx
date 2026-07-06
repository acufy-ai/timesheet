import { useMemo, useState } from 'react';
import { Building2, Loader2, Mail, Plus, Search } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';

import { Button, Card, Empty, FieldError, Input, Modal, RequiredMark, StatusBadge, TonePill, Tooltip, WorkspaceHeader } from '@/components/ui';
import type { Tone } from '@/components/ui';
import { useCreateTenant, useTenants, useTenantStats } from '@/hooks/usePlatform';
import type { Tenant } from '@/types/platform';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import { TenantDetailPanel } from './PlatformTenantDetailPage';

const STATUS_TONE: Record<string, Tone> = { active: 'success', inactive: 'neutral', suspended: 'danger', archived: 'neutral' };

type StatusTab = 'active' | 'suspended' | 'archived';
type FeatureFilter = '' | 'processing' | 'no-processing' | 'pm' | 'no-pm';

// Platform-admin: the tenants (workspaces) list with create + per-tenant stats
// (admins/users/last-activity), status tabs, and a processing filter. Drills
// into a detail page. Cross-tenant superuser surface.
export function PlatformTenantsPage() {
  const navigate = useNavigate();
  // The selected tenant lives in the URL (/platform/tenants/:slug) so selection
  // is deep-linkable and survives refresh.
  const { slug: selectedSlug } = useParams<{ slug: string }>();
  // Two list calls so we can derive the archived set as the diff (the backend
  // hides archived tenants by default; there's no `archived` status on the row).
  const visibleQ = useTenants(false);
  const allQ = useTenants(true);
  const statsQ = useTenantStats();
  const create = useCreateTenant();

  const [search, setSearch] = useState('');
  const [statusTab, setStatusTab] = useState<StatusTab>('active');
  const [featuresFilter, setFeaturesFilter] = useState<FeatureFilter>('');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [isolated, setIsolated] = useState(true);
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const visible = useMemo(() => visibleQ.data ?? [], [visibleQ.data]);
  const all = useMemo(() => allQ.data ?? [], [allQ.data]);
  const stats = statsQ.data?.stats ?? {};

  // Archived = present in the with-archived list but hidden from the default one.
  const archived = useMemo(() => {
    const visibleIds = new Set(visible.map((t) => t.id));
    return all.filter((t) => !visibleIds.has(t.id));
  }, [all, visible]);

  // The selected tenant (from the URL slug), resolved against the full list so
  // archived tenants can be selected too.
  const selected = useMemo(
    () => (selectedSlug ? all.find((t) => t.slug === selectedSlug) : undefined),
    [all, selectedSlug],
  );
  const selectTenant = (t: Tenant) => navigate(`/platform/tenants/${t.slug}`);

  // Counts for the workspace subtitle + the per-tab badges.
  const counts = useMemo(() => {
    const total = visible.length + archived.length;
    const active = visible.filter((t) => t.status === 'active').length;
    const suspended = visible.filter((t) => t.status === 'suspended').length;
    return { total, active, suspended, archived: archived.length };
  }, [visible, archived]);

  // Per-tab badges on the strip.
  const tabCounts: Record<StatusTab, number> = {
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
      // Feature filters.
      const pm = t.project_management_enabled ?? true;
      if (featuresFilter === 'processing' && !t.ingestion_enabled) return false;
      if (featuresFilter === 'no-processing' && t.ingestion_enabled) return false;
      if (featuresFilter === 'pm' && !pm) return false;
      if (featuresFilter === 'no-pm' && pm) return false;
      if (q && !(`${t.name} ${t.slug}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [baseSet, statusTab, featuresFilter, search]);

  const isLoading = visibleQ.isLoading || allQ.isLoading;
  const isError = visibleQ.isError || allQ.isError;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'This field is required.';
    if (!slug.trim()) next.slug = 'This field is required.';
    // Admin is optional, but if either field is filled both must be valid.
    const wantsAdmin = adminName.trim() !== '' || adminEmail.trim() !== '';
    if (wantsAdmin && !adminName.trim()) next.adminName = 'This field is required.';
    if (wantsAdmin && !adminEmail.includes('@')) next.adminEmail = 'Enter a valid email address.';
    if (Object.keys(next).length > 0) { setErrors(next); return; }
    setErrors({});
    try {
      const t = await create.mutateAsync({
        name: name.trim(),
        slug: slug.trim().toLowerCase(),
        is_isolated: isolated,
        ...(wantsAdmin ? { admin_full_name: adminName.trim(), admin_email: adminEmail.trim() } : {}),
      });
      setCreateOpen(false); setName(''); setSlug(''); setAdminName(''); setAdminEmail(''); setErrors({});
      navigate(`/platform/tenants/${t.slug}`);
    } catch (err) {
      const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof d === 'string' ? d : 'Could not create the tenant.');
    }
  }

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        title="Tenants"
        description={`${counts.total} ${counts.total === 1 ? 'tenant' : 'tenants'}`}
        primary={<Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> New tenant</Button>}
      />

      {/* Status tab strip. No "All" tab: it would either double-count the
          archived tenant (defeating the Archived tab) or read as a confusing
          non-total. Active / Suspended / Archived are mutually exclusive. */}
      <div role="tablist" className="flex flex-wrap items-center gap-1 border-b border-border">
        {(['active', 'suspended', 'archived'] as StatusTab[]).map((tab) => {
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

      {/* Master-detail: tenant list (with search) on the left, the selected
          tenant's detail panel on the right. Selecting a row updates the URL. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(280px,380px)_1fr]">
        {/* LEFT: search + scrollable tenant list. */}
        <div className="flex min-w-0 flex-col gap-3">
          <Card className="flex items-center gap-2 p-2.5">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" placeholder="Search tenants..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <select
              value={featuresFilter}
              onChange={(e) => setFeaturesFilter(e.target.value as FeatureFilter)}
              className="rounded-md border border-border bg-card px-2 py-2 text-sm text-foreground"
              aria-label="Filter by feature"
            >
              <option value="">All features</option>
              <option value="processing">Email processing on</option>
              <option value="no-processing">Email processing off</option>
              <option value="pm">Project management on</option>
              <option value="no-pm">Project management off</option>
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
            <div className="flex max-h-[calc(100vh-320px)] flex-col gap-1.5 overflow-y-auto pr-1">
              {filtered.map((t) => (
                <TenantRow
                  key={t.id}
                  tenant={t}
                  isArchivedRow={statusTab === 'archived'}
                  stats={stats[t.id]}
                  selected={selected?.id === t.id}
                  onSelect={() => selectTenant(t)}
                />
              ))}
            </div>
          )}
        </div>

        {/* RIGHT: selected tenant detail, or a prompt. */}
        <div className="min-w-0">
          {selected ? (
            <TenantDetailPanel
              key={selected.id}
              tenant={selected}
              onArchived={() => navigate('/platform/tenants')}
            />
          ) : (
            <Card className="grid h-full min-h-[300px] place-items-center px-6 py-16 text-center">
              <div>
                <Building2 className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">Select a tenant</p>
                <p className="mt-1 text-sm text-muted-foreground">Pick a workspace from the list to see its details.</p>
              </div>
            </Card>
          )}
        </div>
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New tenant">
        <form onSubmit={handleCreate} className="space-y-3">
          <div>
            <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Name<RequiredMark /></label>
            <Input error={!!errors.name} value={name} onChange={(e) => { setName(e.target.value); if (errors.name) setErrors((p) => ({ ...p, name: '' })); if (!slug || slug === name.toLowerCase().replace(/[^a-z0-9]+/g, '-')) { setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); if (errors.slug) setErrors((p) => ({ ...p, slug: '' })); } }} placeholder="Acme Consulting" autoFocus />
            <FieldError error={errors.name} />
          </div>
          <div>
            <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Slug<RequiredMark /></label>
            <Input error={!!errors.slug} value={slug} onChange={(e) => { setSlug(e.target.value.toLowerCase()); if (errors.slug) setErrors((p) => ({ ...p, slug: '' })); }} placeholder="acme-consulting" />
            <FieldError error={errors.slug} />
          </div>
          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={isolated} onChange={(e) => setIsolated(e.target.checked)} className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]" />
            Isolated (own database)
          </label>

          {/* Optional first admin: created in the new tenant's DB + emailed a
              set-password invite. Skip to create an empty tenant. */}
          <div className="rounded-lg border border-border p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">First admin (optional)</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Admin name</label>
                <Input error={!!errors.adminName} value={adminName} onChange={(e) => { setAdminName(e.target.value); if (errors.adminName) setErrors((p) => ({ ...p, adminName: '' })); }} placeholder="Jane Doe" />
                <FieldError error={errors.adminName} />
              </div>
              <div>
                <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Admin email</label>
                <Input error={!!errors.adminEmail} type="email" value={adminEmail} onChange={(e) => { setAdminEmail(e.target.value); if (errors.adminEmail) setErrors((p) => ({ ...p, adminEmail: '' })); }} placeholder="jane@acme.com" />
                <FieldError error={errors.adminEmail} />
              </div>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">They get an email invite to set their password. You can add admins later from the tenant page.</p>
          </div>

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

// One compact tenant row in the master list: avatar, name/slug, status, and a
// tiny users·admins line. Highlights when it's the selected tenant.
function TenantRow({
  tenant,
  isArchivedRow,
  stats,
  selected,
  onSelect,
}: {
  tenant: Tenant;
  isArchivedRow: boolean;
  stats?: { user_count?: number | null; admin_count?: number | null; last_activity_at?: string | null; error?: string | null };
  selected: boolean;
  onSelect: () => void;
}) {
  const statusKey = isArchivedRow ? 'archived' : tenant.status;
  const statusLabel = statusKey.charAt(0).toUpperCase() + statusKey.slice(1);
  const statsFailed = Boolean(stats?.error);
  const users = stats?.user_count;
  const admins = stats?.admin_count;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors',
        selected ? 'border-primary bg-primary/[0.06]' : 'border-border bg-card hover:border-primary/30 hover:bg-primary/[0.03]',
      )}
    >
      <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[11px] font-semibold', avatarTone(tenant.name))}>{initials(tenant.name)}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-foreground">{tenant.name}</span>
          {statusKey === 'active'
            ? <StatusBadge status="approved" variant="timesheet" label="Active" showIcon={false} />
            : <TonePill tone={STATUS_TONE[statusKey] ?? 'neutral'}>{statusLabel}</TonePill>}
          {tenant.ingestion_enabled ? (
            <Tooltip label="Email processing enabled" side="top">
              <Mail className="h-3.5 w-3.5 shrink-0 text-primary" aria-label="Email processing enabled" />
            </Tooltip>
          ) : null}
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">/{tenant.slug}</span>
          {!statsFailed && (users != null || admins != null) ? (
            <span className="shrink-0 tabular-nums">· {users ?? '…'} users · {admins ?? '…'} admins</span>
          ) : null}
        </span>
      </span>
    </button>
  );
}
