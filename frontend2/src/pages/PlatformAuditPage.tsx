import React, { useMemo, useState } from 'react';
import { format } from 'date-fns';
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';

import { Loading } from '@/components';
import {
  usePlatformAudit,
  usePlatformAuditEvent,
  useTenants,
} from '@/hooks';
import type {
  PlatformAuditCategory,
  PlatformAuditEventRow,
  PlatformAuditSeverity,
} from '@/types';

// ── Helpers ──────────────────────────────────────────────────────────

type RangePreset = '7d' | '30d' | '90d' | 'all';

const presetToRange = (preset: RangePreset): { start?: string; end?: string } => {
  if (preset === 'all') return {};
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);
  return {
    start: format(start, 'yyyy-MM-dd'),
    end: format(end, 'yyyy-MM-dd'),
  };
};

const eventTypeChipClass = (category: PlatformAuditCategory): string => {
  if (category === 'tenant') return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
  if (category === 'feature') return 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300';
  if (category === 'admin') return 'bg-sky-500/15 text-sky-600 dark:text-sky-400';
  if (category === 'credentials') return 'bg-rose-500/15 text-rose-600 dark:text-rose-400';
  if (category === 'migration') return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
  return 'bg-muted text-muted-foreground';
};

const eventTypeLabel = (category: PlatformAuditCategory): string => {
  if (category === 'tenant') return 'Tenant';
  if (category === 'feature') return 'Feature';
  if (category === 'admin') return 'Admin';
  if (category === 'credentials') return 'Credentials';
  if (category === 'migration') return 'Migration';
  return 'System';
};

const severityClass = (severity: PlatformAuditSeverity): string => {
  if (severity === 'critical') return 'text-rose-500';
  if (severity === 'warn') return 'text-amber-500';
  return 'text-muted-foreground';
};

const relativeTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'N/A';
  const diffMs = Date.now() - date.getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return format(date, 'MMM d, yyyy');
};

// Pretty-print JSON for the drawer. Falls back to a string repr if
// JSON.stringify is unhappy (cyclic refs from a future event type, etc.).
const formatJson = (value: unknown): string => {
  if (value === null || value === undefined) return 'N/A';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

// ── Page ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

export interface PlatformAuditPageProps {
  /**
   * Hide the standalone page header (h1 + subtitle). Used when this
   * component is embedded inside another page that already has its
   * own header - e.g. the Settings hub's Logs sub-tab.
   */
  embedded?: boolean;
}

export const PlatformAuditPage: React.FC<PlatformAuditPageProps> = ({ embedded = false }) => {
  const [category, setCategory] = useState<PlatformAuditCategory | ''>('');
  const [tenantId, setTenantId] = useState<number | ''>('');
  const [rangePreset, setRangePreset] = useState<RangePreset>('30d');
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data: tenants = [] } = useTenants();
  const range = useMemo(() => presetToRange(rangePreset), [rangePreset]);

  const queryParams = useMemo(
    () => ({
      category: category || undefined,
      tenant_id: tenantId === '' ? undefined : tenantId,
      range_start: range.start,
      range_end: range.end,
      search: search.trim() || undefined,
      limit: PAGE_SIZE,
      offset,
    }),
    [category, tenantId, range.start, range.end, search, offset],
  );

  const { data: auditData, isLoading, isFetching, refetch } = usePlatformAudit(queryParams);
  const { data: detail } = usePlatformAuditEvent(selectedId);

  const totalPages = useMemo(() => {
    if (!auditData || auditData.total === 0) return 1;
    return Math.ceil(auditData.total / PAGE_SIZE);
  }, [auditData]);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const handleResetFilters = () => {
    setCategory('');
    setTenantId('');
    setRangePreset('30d');
    setSearch('');
    setSearchDraft('');
    setOffset(0);
  };

  const handleSearchSubmit: React.FormEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault();
    setSearch(searchDraft);
    setOffset(0);
  };

  const activeFilterCount =
    (category ? 1 : 0) +
    (tenantId !== '' ? 1 : 0) +
    (search ? 1 : 0) +
    (rangePreset !== 'all' ? 1 : 0);

  return (
    <div className="space-y-4">
      {!embedded && (
        <div>
          <h1 className="text-[20px] font-semibold text-foreground">Platform audit</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Control-plane changes only. Tenant lifecycle, feature toggles, platform admin actions,
            credential rotations.
          </p>
        </div>
      )}

      {/* ── Filter bar ──────────────────────────────────────────────── */}
      <section className="surface-card p-3">
        <form
          onSubmit={handleSearchSubmit}
          className="flex flex-wrap items-center gap-2"
        >
          <label className="text-[11px] font-medium uppercase tracking-[0.4px] text-muted-foreground">
            Range
          </label>
          <select
            value={rangePreset}
            onChange={(e) => {
              setRangePreset(e.target.value as RangePreset);
              setOffset(0);
            }}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="all">All time</option>
          </select>

          <label className="text-[11px] font-medium uppercase tracking-[0.4px] text-muted-foreground">
            Event type
          </label>
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value as PlatformAuditCategory | '');
              setOffset(0);
            }}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="">All types</option>
            <option value="tenant">Tenant lifecycle</option>
            <option value="feature">Features</option>
            <option value="admin">Platform admins</option>
            <option value="credentials">Credentials</option>
            <option value="migration">Migrations</option>
            <option value="system">System</option>
          </select>

          <label className="text-[11px] font-medium uppercase tracking-[0.4px] text-muted-foreground">
            Tenant
          </label>
          <select
            value={tenantId}
            onChange={(e) => {
              const raw = e.target.value;
              setTenantId(raw === '' ? '' : Number(raw));
              setOffset(0);
            }}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="">All tenants</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <div className="relative ml-auto flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Search summary, actor, target, IP..."
              className="w-full rounded-md border border-border bg-background px-2 py-1 pl-8 text-xs"
            />
          </div>

          <button
            type="button"
            onClick={handleResetFilters}
            className="rounded-md border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition hover:text-foreground"
          >
            Reset
          </button>
          <button
            type="submit"
            className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground transition hover:opacity-90"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 py-1 text-xs text-foreground transition hover:bg-muted disabled:opacity-50"
            title="Refresh"
            aria-label="Refresh audit list"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </form>

        {activeFilterCount > 0 && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>
              {auditData?.total ?? 0} event{(auditData?.total ?? 0) === 1 ? '' : 's'} match
            </span>
          </div>
        )}
      </section>

      {/* ── Table ──────────────────────────────────────────────────── */}
      {isLoading && !auditData ? (
        <Loading message="Loading audit log..." />
      ) : (
        <section className="surface-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-background">
                <tr className="text-[10px] uppercase tracking-[0.4px] text-muted-foreground">
                  <th className="px-3 py-2.5">When</th>
                  <th className="px-3 py-2.5">Actor</th>
                  <th className="px-3 py-2.5">Event</th>
                  <th className="px-3 py-2.5">Target</th>
                  <th className="px-3 py-2.5">Summary</th>
                  <th className="px-3 py-2.5">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(auditData?.items ?? []).map((row: PlatformAuditEventRow) => (
                  <tr
                    key={row.id}
                    onClick={() => setSelectedId(row.id)}
                    className="cursor-pointer transition hover:bg-muted"
                  >
                    <td className="whitespace-nowrap px-3 py-3 align-top text-foreground tabular-nums">
                      {format(new Date(row.created_at), 'yyyy-MM-dd HH:mm')}
                      <span className="block text-[10px] text-muted-foreground">
                        {relativeTime(row.created_at)}
                      </span>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className="font-medium text-foreground">
                        {row.actor_email ?? row.actor_label ?? 'System'}
                      </span>
                      {row.actor_label && row.actor_email && (
                        <span className="block text-[10px] text-muted-foreground">
                          {row.actor_label}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${eventTypeChipClass(row.category)}`}>
                        {eventTypeLabel(row.category)}
                      </span>
                      <span className={`mt-1 block font-mono text-[10px] ${severityClass(row.severity)}`}>
                        {row.event}
                      </span>
                    </td>
                    <td className="px-3 py-3 align-top">
                      {row.tenant_name ? (
                        <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
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
                {auditData && auditData.items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                      No audit events match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {auditData && auditData.total > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-border bg-background px-4 py-2.5 text-xs text-muted-foreground">
              <span>
                Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, auditData.total)} of{' '}
                {auditData.total} events
              </span>
              <div className="inline-flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  disabled={offset === 0}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-foreground transition hover:bg-muted disabled:opacity-40"
                >
                  <ChevronLeft className="h-3 w-3" /> Previous
                </button>
                <span className="px-2">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                  disabled={offset + PAGE_SIZE >= auditData.total}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-foreground transition hover:bg-muted disabled:opacity-40"
                >
                  Next <ChevronRight className="h-3 w-3" />
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── Detail drawer (right-side overlay) ─────────────────────── */}
      {selectedId !== null && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/40"
          onClick={() => setSelectedId(null)}
        >
          <aside
            onClick={(e) => e.stopPropagation()}
            className="flex h-full w-full max-w-xl flex-col overflow-y-auto bg-card shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Audit event detail"
          >
            <div className="flex items-start justify-between border-b border-border px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-semibold uppercase tracking-[0.4px] text-muted-foreground">
                  {detail ? eventTypeLabel(detail.category) : 'Loading…'}
                </p>
                <h2 className="mt-1 text-sm font-semibold text-foreground">
                  {detail?.summary ?? 'Loading event…'}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {detail ? (
              <div className="space-y-4 px-5 py-4 text-xs">
                <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2">
                  <dt className="font-medium uppercase tracking-[0.4px] text-[10px] text-muted-foreground">Event ID</dt>
                  <dd className="font-mono text-foreground">evt_{detail.id}</dd>
                  <dt className="font-medium uppercase tracking-[0.4px] text-[10px] text-muted-foreground">Timestamp</dt>
                  <dd className="text-foreground">
                    {format(new Date(detail.created_at), 'yyyy-MM-dd HH:mm:ss')} UTC
                    <span className="ml-1 text-muted-foreground">· {relativeTime(detail.created_at)}</span>
                  </dd>
                  <dt className="font-medium uppercase tracking-[0.4px] text-[10px] text-muted-foreground">Actor</dt>
                  <dd className="text-foreground">
                    {detail.actor_email ?? detail.actor_label ?? 'System'}
                  </dd>
                  <dt className="font-medium uppercase tracking-[0.4px] text-[10px] text-muted-foreground">IP</dt>
                  <dd className="font-mono text-foreground">{detail.request_ip ?? 'N/A'}</dd>
                  <dt className="font-medium uppercase tracking-[0.4px] text-[10px] text-muted-foreground">User agent</dt>
                  <dd className="break-words text-foreground">
                    {detail.user_agent ?? 'N/A'}
                  </dd>
                  {detail.tenant_name && (
                    <>
                      <dt className="font-medium uppercase tracking-[0.4px] text-[10px] text-muted-foreground">Tenant</dt>
                      <dd className="text-foreground">
                        {detail.tenant_name}
                        {detail.tenant_slug && (
                          <span className="ml-1 font-mono text-muted-foreground">
                            ({detail.tenant_slug}, id={detail.tenant_id})
                          </span>
                        )}
                      </dd>
                    </>
                  )}
                  {detail.route && (
                    <>
                      <dt className="font-medium uppercase tracking-[0.4px] text-[10px] text-muted-foreground">Route</dt>
                      <dd className="font-mono text-foreground">{detail.route}</dd>
                    </>
                  )}
                  <dt className="font-medium uppercase tracking-[0.4px] text-[10px] text-muted-foreground">Sub-event</dt>
                  <dd className="font-mono text-foreground">{detail.event}</dd>
                </dl>

                {detail.before_state !== null && (
                  <div>
                    <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.4px] text-muted-foreground">
                      Before
                    </p>
                    <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-[11px] text-foreground">
                      {formatJson(detail.before_state)}
                    </pre>
                  </div>
                )}
                {detail.after_state !== null && (
                  <div>
                    <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.4px] text-muted-foreground">
                      After
                    </p>
                    <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-[11px] text-foreground">
                      {formatJson(detail.after_state)}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <div className="px-5 py-10 text-center text-sm text-muted-foreground">
                Loading event detail…
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
};
