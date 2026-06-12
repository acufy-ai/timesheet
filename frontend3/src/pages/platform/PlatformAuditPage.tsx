import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, RefreshCw, Search, X } from 'lucide-react';

import { Button, Card, TonePill, WorkspaceHeader } from '@/components/ui';
import type { Tone } from '@/components/ui';
import { cn } from '@/lib/cn';
import { usePlatformAudit, usePlatformAuditEvent, useTenants } from '@/hooks/usePlatform';
import type {
  PlatformAuditCategory,
  PlatformAuditRow,
  PlatformAuditSeverity,
} from '@/types/platform';

// ── Helpers ──────────────────────────────────────────────────────────

type RangePreset = '7d' | '30d' | '90d' | 'all';

const presetToRange = (preset: RangePreset): { start?: string; end?: string } => {
  if (preset === 'all') return {};
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);
  return { start: toIsoDate(start), end: toIsoDate(end) };
};

// yyyy-MM-dd in local time (the backend filters on a DATE, so the day is all
// that matters). date-fns isn't a frontend3 dependency so we format by hand.
function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtTimestamp(iso: string, withSeconds = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'N/A';
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'N/A';
  const diff = Math.max(0, Date.now() - t);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return fmtTimestamp(iso).slice(0, 10);
}

const CATEGORY_TONE: Record<string, Tone> = {
  tenant: 'success',
  feature: 'brand',
  admin: 'info',
  credentials: 'danger',
  migration: 'warning',
  system: 'neutral',
};

const CATEGORY_LABEL: Record<string, string> = {
  tenant: 'Tenant',
  feature: 'Feature',
  admin: 'Admin',
  credentials: 'Credentials',
  migration: 'Migration',
  system: 'System',
};

const categoryTone = (c: PlatformAuditCategory): Tone => CATEGORY_TONE[c] ?? 'neutral';
const categoryLabel = (c: PlatformAuditCategory): string => CATEGORY_LABEL[c] ?? String(c);

const severityClass = (s: PlatformAuditSeverity): string => {
  if (s === 'critical' || s === 'error') return 'text-rose-600 dark:text-rose-400';
  if (s === 'warn' || s === 'warning') return 'text-amber-600 dark:text-amber-400';
  return 'text-muted-foreground';
};

const formatJson = (value: unknown): string => {
  if (value === null || value === undefined) return 'N/A';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const PAGE_SIZE = 50;

// Platform-admin audit log: cross-tenant control-plane events with full
// filtering, paging, and a right-side detail drawer.
export function PlatformAuditPage() {
  const [category, setCategory] = useState<PlatformAuditCategory | ''>('');
  const [tenantId, setTenantId] = useState<number | ''>('');
  const [rangePreset, setRangePreset] = useState<RangePreset>('30d');
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data: tenants = [] } = useTenants();
  const range = useMemo(() => presetToRange(rangePreset), [rangePreset]);

  const params = useMemo(
    () => ({
      limit: PAGE_SIZE,
      offset,
      category: category || undefined,
      tenant_id: tenantId === '' ? undefined : tenantId,
      search: search.trim() || undefined,
      range_start: range.start,
      range_end: range.end,
    }),
    [offset, category, tenantId, search, range.start, range.end],
  );

  const q = usePlatformAudit(params);
  const detailQ = usePlatformAuditEvent(selectedId);
  const detail = detailQ.data;

  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  const totalPages = total === 0 ? 1 : Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const activeFilterCount =
    (category ? 1 : 0) +
    (tenantId !== '' ? 1 : 0) +
    (search ? 1 : 0) +
    (rangePreset !== 'all' ? 1 : 0);

  const resetFilters = () => {
    setCategory('');
    setTenantId('');
    setRangePreset('30d');
    setSearch('');
    setSearchDraft('');
    setOffset(0);
  };

  const submitSearch: React.FormEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault();
    setSearch(searchDraft);
    setOffset(0);
  };

  const selectClass =
    'h-8 rounded-full border border-border bg-transparent px-3 text-xs text-foreground transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';
  const labelClass = 'text-[11px] font-semibold uppercase tracking-wider text-muted-foreground';

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        title="Platform audit"
        description="Control-plane changes only: workspace lifecycle, feature toggles, platform-admin actions, credential rotations."
      />

      {/* ── Filter bar ─────────────────────────────────────────────── */}
      <Card className="p-3">
        <form onSubmit={submitSearch} className="flex flex-wrap items-center gap-2">
          <span className={labelClass}>Range</span>
          <select
            value={rangePreset}
            onChange={(e) => {
              setRangePreset(e.target.value as RangePreset);
              setOffset(0);
            }}
            className={selectClass}
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="all">All time</option>
          </select>

          <span className={labelClass}>Event type</span>
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setOffset(0);
            }}
            className={selectClass}
          >
            <option value="">All types</option>
            <option value="tenant">Workspace lifecycle</option>
            <option value="feature">Features</option>
            <option value="admin">Platform admins</option>
            <option value="credentials">Credentials</option>
            <option value="migration">Migrations</option>
            <option value="system">System</option>
          </select>

          <span className={labelClass}>Workspace</span>
          <select
            value={tenantId}
            onChange={(e) => {
              const raw = e.target.value;
              setTenantId(raw === '' ? '' : Number(raw));
              setOffset(0);
            }}
            className={selectClass}
          >
            <option value="">All workspaces</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <div className="relative ml-auto min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Search summary, actor, workspace, IP..."
              className="h-8 w-full rounded-full border border-border bg-transparent pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
            Reset
          </Button>
          <Button type="submit" variant="primary" size="sm">
            Apply
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            aria-label="Refresh audit list"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', q.isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </form>

        {activeFilterCount > 0 ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {total} event{total === 1 ? '' : 's'} match
          </p>
        ) : null}
      </Card>

      {/* ── Table ──────────────────────────────────────────────────── */}
      {q.isLoading && !q.data ? (
        <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
        </div>
      ) : q.isError ? (
        <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">
          Couldn't load the platform audit log.
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/30">
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2.5 font-semibold">When</th>
                  <th className="px-3 py-2.5 font-semibold">Actor</th>
                  <th className="px-3 py-2.5 font-semibold">Event</th>
                  <th className="px-3 py-2.5 font-semibold">Workspace</th>
                  <th className="px-3 py-2.5 font-semibold">Summary</th>
                  <th className="px-3 py-2.5 font-semibold">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((row: PlatformAuditRow) => (
                  <tr
                    key={row.id}
                    onClick={() => setSelectedId(row.id)}
                    className="cursor-pointer transition-colors hover:bg-primary/5"
                  >
                    <td className="whitespace-nowrap px-3 py-3 align-top tabular-nums text-foreground">
                      {fmtTimestamp(row.created_at)}
                      <span className="block text-[10px] text-muted-foreground">
                        {relTime(row.created_at)}
                      </span>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className="font-medium text-foreground">
                        {row.actor_email ?? row.actor_label ?? 'System'}
                      </span>
                      {row.actor_label && row.actor_email ? (
                        <span className="block text-[10px] text-muted-foreground">
                          {row.actor_label}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <TonePill tone={categoryTone(row.category)}>
                        {categoryLabel(row.category)}
                      </TonePill>
                      <span className={cn('mt-1 block font-mono text-[10px]', severityClass(row.severity))}>
                        {row.event}
                      </span>
                    </td>
                    <td className="px-3 py-3 align-top">
                      {row.tenant_name ? (
                        <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          {row.tenant_name}
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">N/A</span>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top text-foreground">
                      <span className="line-clamp-2">{row.summary}</span>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {row.request_ip ?? 'N/A'}
                      </span>
                    </td>
                  </tr>
                ))}
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-12 text-center text-muted-foreground">
                      No audit events match the current filters.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {total > PAGE_SIZE ? (
            <div className="flex items-center justify-between border-t border-border bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">
              <span>
                Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total} events
              </span>
              <div className="inline-flex items-center gap-1">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  disabled={offset === 0}
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> Previous
                </Button>
                <span className="px-2">
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                  disabled={offset + PAGE_SIZE >= total}
                >
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      )}

      {/* ── Detail drawer (right-side overlay) ─────────────────────── */}
      {selectedId !== null ? (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSelectedId(null);
          }}
        >
          <aside
            className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-border bg-card shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Audit event detail"
          >
            <div className="sticky top-0 z-10 flex items-start justify-between border-b border-border bg-card px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {detail ? (
                    <TonePill tone={categoryTone(detail.category)}>
                      {categoryLabel(detail.category)}
                    </TonePill>
                  ) : null}
                  {detail ? (
                    <span className={cn('font-mono text-[10px]', severityClass(detail.severity))}>
                      {detail.severity}
                    </span>
                  ) : null}
                </div>
                <h2 className="mt-1.5 text-sm font-semibold text-foreground">
                  {detail?.summary ?? 'Loading event…'}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                aria-label="Close"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {detailQ.isLoading || !detail ? (
              <div className="grid flex-1 place-items-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" />
              </div>
            ) : (
              <div className="space-y-4 px-5 py-4 text-xs">
                <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2">
                  <DetailTerm>Event ID</DetailTerm>
                  <dd className="font-mono text-foreground">evt_{detail.id}</dd>

                  <DetailTerm>Timestamp</DetailTerm>
                  <dd className="text-foreground">
                    {fmtTimestamp(detail.created_at, true)}
                    <span className="ml-1 text-muted-foreground">· {relTime(detail.created_at)}</span>
                  </dd>

                  <DetailTerm>Actor</DetailTerm>
                  <dd className="text-foreground">
                    {detail.actor_email ?? detail.actor_label ?? 'System'}
                    {detail.actor_label && detail.actor_email ? (
                      <span className="ml-1 text-muted-foreground">({detail.actor_label})</span>
                    ) : null}
                  </dd>

                  <DetailTerm>IP</DetailTerm>
                  <dd className="font-mono text-foreground">{detail.request_ip ?? 'N/A'}</dd>

                  <DetailTerm>User agent</DetailTerm>
                  <dd className="break-words text-foreground">{detail.user_agent ?? 'N/A'}</dd>

                  {detail.tenant_name ? (
                    <>
                      <DetailTerm>Workspace</DetailTerm>
                      <dd className="text-foreground">
                        {detail.tenant_name}
                        {detail.tenant_slug ? (
                          <span className="ml-1 font-mono text-muted-foreground">
                            ({detail.tenant_slug}
                            {detail.tenant_id != null ? `, id=${detail.tenant_id}` : ''})
                          </span>
                        ) : null}
                      </dd>
                    </>
                  ) : null}

                  {detail.route ? (
                    <>
                      <DetailTerm>Route</DetailTerm>
                      <dd className="break-words font-mono text-foreground">{detail.route}</dd>
                    </>
                  ) : null}

                  <DetailTerm>Sub-event</DetailTerm>
                  <dd className="font-mono text-foreground">{detail.event}</dd>
                </dl>

                {detail.before_state != null ? (
                  <div>
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Before
                    </p>
                    <pre className="overflow-x-auto rounded-xl border border-border bg-muted/30 p-3 font-mono text-[11px] text-foreground">
                      {formatJson(detail.before_state)}
                    </pre>
                  </div>
                ) : null}

                {detail.after_state != null ? (
                  <div>
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      After
                    </p>
                    <pre className="overflow-x-auto rounded-xl border border-border bg-muted/30 p-3 font-mono text-[11px] text-foreground">
                      {formatJson(detail.after_state)}
                    </pre>
                  </div>
                ) : null}
              </div>
            )}
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function DetailTerm({ children }: { children: React.ReactNode }) {
  return (
    <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </dt>
  );
}
