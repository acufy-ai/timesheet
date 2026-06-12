import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  EyeOff,
  LayoutGrid,
  Loader2,
  Plus,
  RefreshCw,
  Rows,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Button, Empty, StatusBadge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { clientsApi } from '@/api/client';
import {
  useAssignChainCandidate,
  useBulkDeleteEmails,
  useBulkReprocess,
  useClients,
  useCreateClient,
  useDeleteEmail,
  useFetchEmails,
  useFetchJobStatus,
  useCancelFetchJob,
  useIngestionTimesheets,
  useMailboxes,
  usePromoteSkipped,
  useConfirmSkip,
  useReprocessStoredEmail,
  useSkippedEmails,
  useUpdateIngestionData,
  useAssignableUsers,
} from '@/hooks/useAdmin';
import { useAuth, useIsAdmin, useIsManager } from '@/contexts/AuthContext';
import {
  buildRowGroups,
  buildSkippedRowGroup,
  type TimesheetRowGroup,
} from '@/lib/inboxGrouping';
import {
  STATUS_OPTIONS,
  domainOf,
  formatDateRange,
  formatHours,
  formatRelativeReceived,
  getApiErrorMessage,
  getInitials,
  isActionableSkippedEmail,
  isPersonalDomain,
  isStaleReceived,
  prettifySkipReason,
  statusLabel,
  suggestNameFromDomain,
  STALE_BUSINESS_DAYS,
} from '@/lib/ingestion';
import type { Client, IngestionSummary } from '@/types/admin';

// ── Local constants / tiny helpers ───────────────────────────────────
// View mode is localStorage-only in f3 (no user-prefs endpoint).
const VIEW_MODE_STORAGE_KEY = 'inbox.viewMode';
// Active fetch-job id is persisted per tenant so a reload doesn't drop the
// polling UI while a job is still running in the worker.
const activeJobKey = (tenantId?: number | null) =>
  `inbox.activeFetchJob.${tenantId ?? 'anon'}`;
// Dismissed-skipped-banner count is persisted per tenant.
const skippedDismissKey = (tenantId?: number | null) =>
  tenantId != null ? `inbox.skippedBannerDismissedCount.${tenantId}` : null;

// f2 cleaned up a couple of recurring OCR artifacts on extracted employee
// names. Ported verbatim so display matches.
function cleanEmployeeNameForDisplay(value?: string | null): string {
  if (!value) return '';
  const compactLeadingPrefix = value.replace(/^ven[aij](?=[A-Z])/, '');
  const parts = compactLeadingPrefix.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1 && /^ven[aij]$/i.test(parts[0])) parts.shift();
  if (parts.length > 0 && /^ashw/i.test(parts[0])) parts[0] = `Ai${parts[0].slice(1)}`;
  return parts.join(' ').trim() || compactLeadingPrefix.trim();
}

// Status tone is handled inside StatusBadge (variant=ingestion).
type ChainCandidate = { name?: string | null; email?: string | null };

// Defensively pull forwarded-chain candidates from llm_match_suggestions. f3
// types this as Array<Record<string, unknown>> | { chain_candidates } so we
// accept either the f2 object-with-array shape or a bare array.
function chainCandidatesOf(row: IngestionSummary): ChainCandidate[] {
  const raw = row.llm_match_suggestions as unknown;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((c) => (c && typeof c === 'object' ? (c as ChainCandidate) : null))
      .filter((c): c is ChainCandidate => Boolean(c && (c.name || c.email)));
  }
  if (typeof raw === 'object' && 'chain_candidates' in (raw as Record<string, unknown>)) {
    const list = (raw as { chain_candidates?: unknown }).chain_candidates;
    if (Array.isArray(list)) {
      return list
        .map((c) => (c && typeof c === 'object' ? (c as ChainCandidate) : null))
        .filter((c): c is ChainCandidate => Boolean(c && (c.name || c.email)));
    }
  }
  return [];
}

// Optional field — present on IngestionTimesheetSummary but not always on the
// inbox row wire payload. Read it through a cast so the suggestion still works.
function extractedClientName(row: IngestionSummary): string {
  return (row as { extracted_client_name?: string | null }).extracted_client_name ?? '';
}

// Local cascade hook (clientsApi.createFromDomain). Mirrors the f3
// useCreateClientFromDomain contract: creates the client and cascades the
// assignment to pending timesheets from that domain server-side.
function useCreateClientFromDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, domain }: { name: string; domain: string }) =>
      clientsApi.createFromDomain(name, domain).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
    },
  });
}

function countStatuses(groups: TimesheetRowGroup[]): Record<string, number> {
  return STATUS_OPTIONS.reduce<Record<string, number>>((acc, option) => {
    acc[option.key] = option.key
      ? groups.filter((g) => g.status === option.key).length
      : groups.length;
    return acc;
  }, {});
}

// ── Create-client-from-domain popover (self-contained) ───────────────
// f3 has no shared CreateClientFromDomainPopover yet, so we inline a small,
// behavior-equivalent version: editable name prefilled with a fuzzy/existing
// match or the smart-guess, an existing-client picker, and a cascade count.
function CreateClientFromDomainPopover({
  open,
  domain,
  cascadeCount,
  existingClients,
  initialValue,
  isSubmitting,
  onConfirm,
  onClose,
}: {
  open: boolean;
  domain: string;
  cascadeCount: number;
  existingClients: Array<{ id: number; name: string }>;
  initialValue: string;
  isSubmitting: boolean;
  onConfirm: (payload: { name: string; existing: { id: number; name: string } | null }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialValue);
  const [existingId, setExistingId] = useState('');

  React.useEffect(() => {
    if (open) {
      setName(initialValue);
      setExistingId('');
    }
  }, [open, initialValue]);

  if (!open) return null;

  const existing = existingId
    ? existingClients.find((c) => String(c.id) === existingId) ?? null
    : null;
  const canSubmit = existing ? true : Boolean(name.trim());

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-sm rounded-2xl border border-border bg-card text-card-foreground shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-semibold text-foreground">Add client from {domain}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          {cascadeCount > 1 ? (
            <p className="rounded-lg bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
              This will also assign the client to {cascadeCount} pending emails from{' '}
              <span className="font-medium text-foreground">{domain}</span>.
            </p>
          ) : null}

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-[0.4px] text-muted-foreground">
              New client name
            </label>
            <input
              autoFocus
              type="text"
              className="field-input"
              value={name}
              disabled={Boolean(existing)}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit && !isSubmitting) {
                  e.preventDefault();
                  onConfirm({ name: name.trim(), existing });
                }
              }}
              placeholder="Client name"
            />
          </div>

          {existingClients.length > 0 ? (
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-[0.4px] text-muted-foreground">
                …or link an existing client
              </label>
              <select
                className="field-input"
                value={existingId}
                onChange={(e) => setExistingId(e.target.value)}
              >
                <option value="">Create a new client</option>
                {existingClients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!canSubmit || isSubmitting}
              onClick={() => onConfirm({ name: name.trim(), existing })}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
                </>
              ) : existing ? (
                `Link ${domain}`
              ) : (
                'Create & assign'
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────
export function InboxPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = useIsAdmin();
  const isManager = useIsManager();
  const isViewer = user?.role === 'VIEWER';
  // Approved-timesheets shortcut targets a route that allows MANAGER/VIEWER.
  const canSeeTeamTimesheets = isManager || isViewer;

  const queryClient = useQueryClient();

  // ── Filters / search / view ──────────────────────────────────────
  const [statusFilter, setStatusFilter] = useState('');
  const [clientId, setClientId] = useState('');
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'cards' | 'table'>(() => {
    if (typeof window === 'undefined') return 'cards';
    try {
      return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === 'table' ? 'table' : 'cards';
    } catch {
      return 'cards';
    }
  });
  const handleSetViewMode = (mode: 'cards' | 'table') => {
    setViewMode(mode);
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      /* quota / private mode — swallow */
    }
  };

  // ── Status banner (success / danger / info) ──────────────────────
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<'success' | 'danger' | 'info'>('info');

  // ── Bulk selection + row UI state ────────────────────────────────
  const [selectedEmailIds, setSelectedEmailIds] = useState<Set<number>>(new Set());
  const [deletingEmailId, setDeletingEmailId] = useState<number | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [inlinePicker, setInlinePicker] = useState<{ id: number; kind: 'client' | 'employee' } | null>(null);
  const [creatingClientFor, setCreatingClientFor] = useState<number | null>(null);
  const [createClientDraftName, setCreateClientDraftName] = useState('');
  const [cascadePopover, setCascadePopover] = useState<{ domain: string } | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const toggleExpanded = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // ── Active fetch-job id (persisted per tenant) ───────────────────
  const [activeJobId, setActiveJobIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(activeJobKey(user?.tenant_id)) || null;
    } catch {
      return null;
    }
  });
  const setActiveJobId = React.useCallback(
    (next: string | null) => {
      setActiveJobIdState(next);
      try {
        if (next) window.localStorage.setItem(activeJobKey(user?.tenant_id), next);
        else window.localStorage.removeItem(activeJobKey(user?.tenant_id));
      } catch {
        /* swallow */
      }
    },
    [user?.tenant_id],
  );
  // Late hydration: tenant_id may arrive after first mount.
  const hydratedRef = React.useRef(false);
  React.useEffect(() => {
    if (hydratedRef.current || user?.tenant_id == null) return;
    hydratedRef.current = true;
    if (activeJobId == null) {
      try {
        const persisted = window.localStorage.getItem(activeJobKey(user.tenant_id));
        if (persisted) setActiveJobIdState(persisted);
      } catch {
        /* swallow */
      }
    }
  }, [user?.tenant_id, activeJobId]);

  // ── Data hooks ───────────────────────────────────────────────────
  const allTimesheetsQuery = useIngestionTimesheets(true);
  const isLoading = allTimesheetsQuery.isLoading;
  // Stable reference: only changes identity when the query data changes, NOT on
  // every render (a `= []` default would mint a fresh array each render and, via
  // the clear-selection effect below, spin an infinite update loop).
  const allTimesheets = useMemo(() => allTimesheetsQuery.data ?? [], [allTimesheetsQuery.data]);
  const { data: skippedOverview, isLoading: skippedLoading } = useSkippedEmails(true);
  const { data: clients = [] } = useClients();
  const { data: users = [] } = useAssignableUsers();
  // GET /mailboxes is admin-only; gate the hook to avoid 403 noise.
  const { data: mailboxes = [] } = useMailboxes(isAdmin);
  const { data: fetchStatus } = useFetchJobStatus(activeJobId);

  const createClientFromDomain = useCreateClientFromDomain();
  const assignChainCandidate = useAssignChainCandidate();
  const updateTimesheet = useUpdateIngestionData();
  const createClient = useCreateClient();
  const triggerFetch = useFetchEmails();
  const cancelFetch = useCancelFetchJob();
  const reprocessEmail = useReprocessStoredEmail();
  const promoteSkipped = usePromoteSkipped();
  const confirmSkipped = useConfirmSkip();
  const deleteEmail = useDeleteEmail();
  const bulkReprocessEmails = useBulkReprocess();
  const bulkDeleteEmails = useBulkDeleteEmails();

  const lastFetchedAt = useMemo(() => {
    const stamps = mailboxes
      .map((m) => m.last_fetched_at)
      .filter((s): s is string => Boolean(s))
      .map((s) => new Date(s).getTime())
      .filter((n) => Number.isFinite(n));
    return stamps.length ? new Date(Math.max(...stamps)) : null;
  }, [mailboxes]);

  // ── Fetch-job terminal handling ──────────────────────────────────
  // f3 useFetchJobStatus marks 'completed' (not 'complete') as terminal.
  React.useEffect(() => {
    const s = fetchStatus?.status;
    if (s === 'completed') {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'skipped'] });
      setStatusTone('success');
      setStatusMessage(fetchStatus?.message || 'Fetch complete.');
      setActiveJobId(null);
    } else if (s === 'failed' || s === 'error' || s === 'cancelled') {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'skipped'] });
      setStatusTone(s === 'cancelled' ? 'info' : 'danger');
      setStatusMessage(
        fetchStatus?.message || (s === 'cancelled' ? 'Fetch cancelled.' : 'Fetch job failed.'),
      );
      setActiveJobId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchStatus?.status, fetchStatus?.message]);

  // ── Derived: actionable skipped groups ───────────────────────────
  const actionableSkippedEmails = useMemo(
    () => (skippedOverview?.emails ?? []).filter(isActionableSkippedEmail),
    [skippedOverview],
  );
  const skippedGroups = useMemo(
    () => actionableSkippedEmails.map(buildSkippedRowGroup),
    [actionableSkippedEmails],
  );

  // All groups (rejected included) for the per-tab count badges.
  const allGroups = useMemo(
    () => [...buildRowGroups(allTimesheets, { includeRejected: true }), ...skippedGroups],
    [allTimesheets, skippedGroups],
  );

  // Visible groups: client-side status/client/search filtering (f3
  // useIngestionTimesheets takes no params, so we fetch all then filter).
  const groups = useMemo(() => {
    const searchLower = search.trim().toLowerCase();
    const clientNum = clientId ? Number(clientId) : null;

    const matchesSearch = (row: IngestionSummary): boolean => {
      if (!searchLower) return true;
      const name = (row.employee_name || row.extracted_employee_name || '').toLowerCase();
      return (
        (row.sender_email || '').toLowerCase().includes(searchLower) ||
        (row.sender_name || '').toLowerCase().includes(searchLower) ||
        (row.subject || '').toLowerCase().includes(searchLower) ||
        name.includes(searchLower) ||
        (row.client_name || '').toLowerCase().includes(searchLower) ||
        extractedClientName(row).toLowerCase().includes(searchLower)
      );
    };

    const filteredTimesheets = allTimesheets.filter((row) => {
      if (statusFilter && statusFilter !== 'skipped' && row.status !== statusFilter) return false;
      if (clientNum != null && row.client_id !== clientNum) return false;
      if (!matchesSearch(row)) return false;
      return true;
    });
    // Include rejected rows only when explicitly on the Rejected tab.
    const baseGroups = buildRowGroups(filteredTimesheets, {
      includeRejected: statusFilter === 'rejected',
    });

    const skippedVisible = skippedGroups.filter((group) => {
      if (statusFilter && statusFilter !== 'skipped') return false;
      if (clientNum != null) return false; // skipped emails have no client
      if (!searchLower) return true;
      const email = group.skipped;
      return (
        (email?.subject ?? '').toLowerCase().includes(searchLower) ||
        (email?.sender_email ?? '').toLowerCase().includes(searchLower) ||
        (email?.sender_name ?? '').toLowerCase().includes(searchLower)
      );
    });

    if (statusFilter === 'skipped') return skippedVisible;
    return [...baseGroups, ...skippedVisible];
  }, [allTimesheets, skippedGroups, statusFilter, clientId, search]);

  const statusCounts = useMemo(() => countStatuses(allGroups), [allGroups]);
  const skippedCount = statusCounts.skipped ?? 0;

  // ── Dismissible skipped banner (per-tenant localStorage count) ────
  const tenantScopeKey = skippedDismissKey(user?.tenant_id);
  const [dismissedSkippedCount, setDismissedSkippedCount] = useState<number>(() => {
    if (typeof window === 'undefined' || !tenantScopeKey) return 0;
    try {
      const raw = window.localStorage.getItem(tenantScopeKey);
      const parsed = raw == null ? 0 : Number.parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    } catch {
      return 0;
    }
  });
  const dismissSkippedBanner = React.useCallback(() => {
    setDismissedSkippedCount(skippedCount);
    if (typeof window !== 'undefined' && tenantScopeKey) {
      try {
        window.localStorage.setItem(tenantScopeKey, String(skippedCount));
      } catch {
        /* swallow */
      }
    }
  }, [skippedCount, tenantScopeKey]);
  const showSkippedBanner =
    skippedCount > 0 && skippedCount > dismissedSkippedCount && statusFilter !== 'skipped';

  // Clear bulk selection when the underlying data refreshes.
  React.useEffect(() => {
    setSelectedEmailIds(new Set());
  }, [allTimesheets]);

  // Unique email_ids across visible groups (drives select-all + bulk bar).
  const allVisibleEmailIds = useMemo(
    () => [...new Set(groups.map((g) => g.primary.email_id).filter((id): id is number => id != null))],
    [groups],
  );

  // Fetch diagnostics (collapsible, <= 8 rows) from the job result.
  type Diagnostic = {
    email_id?: number | null;
    message_id?: string | null;
    subject?: string | null;
    sender_email?: string | null;
    skipped?: boolean;
    skip_reason?: string | null;
    skip_detail?: string | null;
    timesheets_created?: number | null;
    errors?: string[] | null;
  };
  const fetchDiagnostics = useMemo<Diagnostic[]>(() => {
    const result = fetchStatus?.result;
    const raw =
      result && typeof result === 'object' && 'message_diagnostics' in result
        ? (result as { message_diagnostics?: unknown }).message_diagnostics
        : null;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is Diagnostic => Boolean(item && typeof item === 'object'))
      .slice(0, 8);
  }, [fetchStatus]);

  // ── Loading gate ─────────────────────────────────────────────────
  const isPageLoading = isLoading || skippedLoading;

  const isFetchRunning = Boolean(
    activeJobId &&
      fetchStatus &&
      (fetchStatus.status === 'queued' ||
        fetchStatus.status === 'in_progress' ||
        fetchStatus.status === 'running'),
  );
  const isBusy =
    triggerFetch.isPending ||
    isFetchRunning ||
    reprocessEmail.isPending ||
    deleteEmail.isPending ||
    bulkReprocessEmails.isPending ||
    bulkDeleteEmails.isPending;

  // ── Cascade a client assignment across sibling weeks on the same email ──
  // f3 useIngestionTimesheets has no email_id filter, so we cascade across the
  // siblings already present in allTimesheets (same email_id, still editable).
  const cascadeClientAcrossEmail = React.useCallback(
    async (primaryId: number, clientNum: number, emailId: number | null) => {
      const targets = new Set<number>([primaryId]);
      if (emailId != null) {
        for (const sibling of allTimesheets) {
          if (sibling.email_id !== emailId) continue;
          if (sibling.id === primaryId) continue;
          if (sibling.status === 'approved' || sibling.status === 'rejected') continue;
          targets.add(sibling.id);
        }
      }
      await Promise.all(
        [...targets].map((id) =>
          updateTimesheet.mutateAsync({ id, data: { client_id: clientNum } }).catch(() => null),
        ),
      );
    },
    [allTimesheets, updateTimesheet],
  );

  // Pending count for a domain across currently visible groups (cascade hint).
  const cascadePendingCount = (domain: string): number => {
    const target = domain.trim().toLowerCase();
    if (!target) return 0;
    return groups.reduce((acc, group) => {
      if (group.kind === 'skipped') return acc;
      if (group.primary.client_id != null) return acc;
      if (domainOf(group.primary.sender_email) !== target) return acc;
      return acc + 1;
    }, 0);
  };

  // Pre-fill the popover name with an existing-client fuzzy match, else guess.
  const cascadeInitialValue = useMemo(() => {
    if (!cascadePopover) return '';
    const guess = suggestNameFromDomain(cascadePopover.domain);
    const guessLower = guess.toLowerCase();
    if (!guessLower) return guess;
    const fuzzy = (clients as Client[]).find((c) => {
      const name = (c.name || '').toLowerCase();
      return (
        name === guessLower ||
        name.startsWith(guessLower + ' ') ||
        name.endsWith(' ' + guessLower) ||
        name.includes(' ' + guessLower + ' ')
      );
    });
    return fuzzy ? fuzzy.name : guess;
  }, [cascadePopover, clients]);

  // ── Action handlers ──────────────────────────────────────────────
  const handleCascadeConfirm = async (
    domain: string,
    payload: { name: string; existing: { id: number; name: string } | null },
  ) => {
    try {
      const result = await createClientFromDomain.mutateAsync({
        name: payload.existing ? payload.existing.name : payload.name,
        domain,
      });
      setCascadePopover(null);
      setStatusTone('success');
      setStatusMessage(
        result.cascaded_count > 0
          ? `Assigned ${result.client.name} to ${result.cascaded_count} pending email${result.cascaded_count === 1 ? '' : 's'} from ${domain}.`
          : `Created ${result.client.name} from ${domain}.`,
      );
    } catch (error) {
      const e = error as { response?: { status?: number; data?: { detail?: { message?: string; existing_client_name?: string } } } };
      if (e?.response?.status === 409) {
        const detail = e.response?.data?.detail;
        setStatusTone('danger');
        setStatusMessage(
          detail?.message ||
            (detail?.existing_client_name
              ? `Domain '${domain}' is already mapped to '${detail.existing_client_name}'.`
              : `Domain '${domain}' is already mapped to another client.`),
        );
        return;
      }
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, 'Unable to assign client from domain.'));
    }
  };

  const handleFetch = async () => {
    try {
      const response = await triggerFetch.mutateAsync();
      if (response.job_id) setActiveJobId(response.job_id);
      setStatusTone('info');
      setStatusMessage(response.message || 'Fetch job queued for this tenant.');
    } catch (error) {
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, 'Unable to start fetch job.'));
    }
  };

  // f3 has no dedicated reprocess-all-skipped endpoint; reprocess the
  // currently-actionable skipped emails in bulk instead.
  const handleReprocessSkipped = async () => {
    const ids = actionableSkippedEmails.map((e) => e.id);
    if (ids.length === 0) return;
    if (!window.confirm(`Try again on ${ids.length} skipped email(s)? This keeps the emails in place and re-reads them.`)) {
      return;
    }
    try {
      await bulkReprocessEmails.mutateAsync(ids);
      setStatusTone('info');
      setStatusMessage('Queued skipped emails for reprocessing.');
    } catch (error) {
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, 'Unable to reprocess skipped emails.'));
    }
  };

  const handleReprocessEmail = async (emailId: number) => {
    try {
      await reprocessEmail.mutateAsync({ emailId });
      setStatusTone('info');
      setStatusMessage('Queued email reprocessing.');
    } catch (error) {
      const e = error as { response?: { status?: number } };
      setStatusTone('danger');
      if (e?.response?.status === 404) {
        setStatusMessage('That inbox item is no longer available. The list has been refreshed.');
        return;
      }
      setStatusMessage(getApiErrorMessage(error, 'Unable to queue reprocessing.'));
    }
  };

  const handlePromoteSkipped = async (emailId: number, subject?: string | null) => {
    try {
      await promoteSkipped.mutateAsync(emailId);
      setStatusTone('success');
      setStatusMessage(`"${subject || '(no subject)'}" added to the review queue. Open it to fill in the details.`);
    } catch (error) {
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, 'Unable to promote this email.'));
    }
  };

  const handleConfirmSkipped = async (emailId: number, subject?: string | null) => {
    if (!window.confirm(`Confirm "${subject || '(no subject)'}" really isn't a timesheet? It will stop showing in the Skipped tab.`)) {
      return;
    }
    try {
      await confirmSkipped.mutateAsync(emailId);
      setStatusTone('info');
      setStatusMessage(`Hid "${subject || '(no subject)'}" from the Skipped tab.`);
    } catch (error) {
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, 'Unable to dismiss this email.'));
    }
  };

  const handleDeleteEmail = async (emailId: number, subject?: string | null) => {
    if (!window.confirm(`Delete "${subject || '(no subject)'}" from this application? This does not remove the original mailbox email.`)) {
      return;
    }
    setDeletingEmailId(emailId);
    try {
      await deleteEmail.mutateAsync({ emailId });
      setStatusTone('success');
      setStatusMessage('Removed the email and its timesheets.');
    } catch (error) {
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, 'Unable to delete stored email.'));
    } finally {
      setDeletingEmailId(null);
    }
  };

  const handleBulkReprocess = async () => {
    const ids = [...selectedEmailIds];
    if (ids.length === 0) return;
    if (!window.confirm(`Try processing ${ids.length} email(s) again? This will re-read the timesheets and try to match them.`)) {
      return;
    }
    try {
      await bulkReprocessEmails.mutateAsync(ids);
      setSelectedEmailIds(new Set());
      setStatusTone('success');
      setStatusMessage(`Queued ${ids.length} email(s) for reprocessing.`);
    } catch {
      setStatusTone('danger');
      setStatusMessage('Failed to queue bulk reprocess.');
    }
  };

  const handleBulkDelete = async () => {
    const ids = [...selectedEmailIds];
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} email(s) and all their timesheets from this application?`)) {
      return;
    }
    // Optional second prompt: rewind the mailbox cursor so the next fetch
    // re-ingests these (matches f2's refetch flag).
    const refetch = window.confirm(
      `Also rewind the mailbox so the next Fetch Emails will re-process these ${ids.length} email(s)?\n\n` +
        'Click OK to re-fetch on the next sync. Click Cancel to delete only.',
    );
    try {
      const result = await bulkDeleteEmails.mutateAsync({ emailIds: ids, refetch });
      const cursorsRewound = (result as unknown as { data?: { cursors_rewound?: number } })?.data?.cursors_rewound ?? 0;
      setSelectedEmailIds(new Set());
      setStatusTone('success');
      setStatusMessage(
        refetch && cursorsRewound > 0
          ? `Deleted ${ids.length} email(s). ${cursorsRewound} mailbox cursor(s) rewound — these will re-ingest on the next Fetch Emails.`
          : `Deleted ${ids.length} email(s) and their timesheets.`,
      );
    } catch (error) {
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, 'Unable to bulk delete emails.'));
    }
  };

  const toggleEmailId = (emailId: number) =>
    setSelectedEmailIds((prev) => {
      const next = new Set(prev);
      next.has(emailId) ? next.delete(emailId) : next.add(emailId);
      return next;
    });
  const selectAllVisible = () => setSelectedEmailIds(new Set(allVisibleEmailIds));
  const clearSelection = () => setSelectedEmailIds(new Set());

  const hasAnyQueueItems = allGroups.length > 0;
  const hasActiveFilters = Boolean(statusFilter || clientId || search.trim());
  const showFilters = hasAnyQueueItems || hasActiveFilters;
  const clearFilters = () => {
    setStatusFilter('');
    setClientId('');
    setSearch('');
  };

  const progress = Math.max(0, Math.min(100, Number(fetchStatus?.progress ?? 0)));
  const showStandaloneStatusMessage = Boolean(statusMessage);

  // ── Shared inline client-picker renderer (cards + table) ─────────
  // Returns the JSX for the "assign / create client" cell for a row that has
  // no client yet. Compact controls = card layout; full = table layout.
  const renderClientPicker = (rowTarget: IngestionSummary, compact: boolean) => {
    const senderDomain = domainOf(rowTarget.sender_email);
    if (!senderDomain || isPersonalDomain(senderDomain)) {
      const pickerId = rowTarget.id;
      const isOpen = inlinePicker?.id === pickerId && inlinePicker.kind === 'client';
      const isCreating = creatingClientFor === pickerId;
      const suggestedName =
        extractedClientName(rowTarget) || (senderDomain ? suggestNameFromDomain(senderDomain) : '');
      const startCreate = () => {
        setCreateClientDraftName(suggestedName);
        setCreatingClientFor(pickerId);
      };
      const confirmCreate = async () => {
        const name = createClientDraftName.trim();
        if (!name) return;
        const created = await createClient.mutateAsync({ name, client_type: 'external' });
        await cascadeClientAcrossEmail(pickerId, created.id, rowTarget.email_id ?? null);
        setCreatingClientFor(null);
        setCreateClientDraftName('');
        setInlinePicker(null);
      };
      const cancelCreate = () => {
        setCreatingClientFor(null);
        setCreateClientDraftName('');
      };
      return isOpen ? (
        <div className="flex min-w-[200px] flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
          {isCreating ? (
            <>
              <label className="text-[10px] uppercase tracking-[0.4px] text-muted-foreground">New client name</label>
              <input
                autoFocus
                type="text"
                className="h-7 rounded border border-border bg-background px-2 text-xs"
                value={createClientDraftName}
                onChange={(e) => setCreateClientDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void confirmCreate();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelCreate();
                  }
                }}
                placeholder="Client name"
              />
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={createClient.isPending || !createClientDraftName.trim()}
                  onClick={() => void confirmCreate()}
                  className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
                >
                  {createClient.isPending ? 'Creating…' : 'Create & assign'}
                </button>
                <button
                  type="button"
                  onClick={cancelCreate}
                  className="rounded border border-border bg-transparent px-2 py-1 text-xs text-muted-foreground transition hover:text-foreground"
                >
                  Back
                </button>
              </div>
            </>
          ) : (
            <>
              <select
                autoFocus
                className="h-7 rounded border border-border bg-background px-2 text-xs"
                defaultValue=""
                onChange={async (e) => {
                  const val = e.target.value;
                  if (!val) return;
                  await cascadeClientAcrossEmail(pickerId, Number(val), rowTarget.email_id ?? null);
                  setInlinePicker(null);
                }}
              >
                <option value="">Pick an existing client…</option>
                {(clients as Client[]).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button type="button" className="text-left text-xs text-primary hover:underline" onClick={startCreate}>
                {suggestedName ? `+ Create new client (suggested: "${suggestedName}")` : '+ Create new client'}
              </button>
              <button
                type="button"
                className="text-left text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => setInlinePicker(null)}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setInlinePicker({ id: pickerId, kind: 'client' });
          }}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border border-dashed border-amber-400/60 bg-transparent font-medium text-amber-700 transition hover:border-amber-400 hover:bg-amber-500/15 dark:text-amber-300',
            compact ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs',
          )}
          title="Click to assign or create a client"
        >
          <Plus className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} /> Add client
        </button>
      );
    }
    const count = cascadePendingCount(senderDomain);
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setCascadePopover({ domain: senderDomain });
        }}
        className={cn(
          'inline-flex items-center gap-1 rounded-md border border-dashed border-amber-400/60 bg-transparent font-medium text-amber-700 transition hover:border-amber-400 hover:bg-amber-500/15 dark:text-amber-300',
          compact ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs',
        )}
        title={`Create or link a client for ${senderDomain}`}
      >
        <Plus className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} /> Add client from {senderDomain}
        {count > 1 ? <span className="opacity-60">({count})</span> : null}
      </button>
    );
  };

  // Shared inline employee-picker renderer (chain candidates + fallback).
  const renderEmployeePicker = (rowTarget: IngestionSummary, compact: boolean) => {
    const candidates = chainCandidatesOf(rowTarget);
    if (candidates.length > 0) {
      return (
        <div className="flex flex-wrap gap-1">
          {candidates.map((c, i) => (
            <button
              key={i}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                assignChainCandidate.mutate({
                  id: rowTarget.id,
                  name: c.name ?? undefined,
                  email: c.email ?? undefined,
                });
              }}
              className="inline-flex items-center rounded-full border border-blue-400/40 bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-500/20 dark:text-blue-300"
              title={c.email ?? undefined}
            >
              {c.name || c.email}
            </button>
          ))}
        </div>
      );
    }
    const pickerId = rowTarget.id;
    const isOpen = inlinePicker?.id === pickerId && inlinePicker.kind === 'employee';
    return isOpen ? (
      <div onClick={(e) => e.stopPropagation()}>
        <select
          autoFocus
          className="h-7 min-w-[160px] rounded border border-border bg-background px-2 text-xs"
          defaultValue=""
          onChange={async (e) => {
            const val = e.target.value;
            if (!val) return;
            await updateTimesheet.mutateAsync({ id: pickerId, data: { employee_id: Number(val) } });
            setInlinePicker(null);
          }}
          onBlur={() => setInlinePicker(null)}
        >
          <option value="">Pick employee…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.full_name}
            </option>
          ))}
        </select>
      </div>
    ) : (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setInlinePicker({ id: pickerId, kind: 'employee' });
        }}
        className={cn(
          'inline-flex items-center gap-1 rounded-md border border-dashed border-amber-400/60 bg-transparent font-medium text-amber-700 transition hover:border-amber-400 hover:bg-amber-500/15 dark:text-amber-300',
          compact ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs',
        )}
        title="Click to assign an employee"
      >
        <Plus className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} /> Add employee
      </button>
    );
  };

  // Open the review route for a group (skipped rows can't open a review here).
  const openReviewFor = (group: TimesheetRowGroup) => {
    const rowTarget = group.primary;
    if (group.kind === 'skipped') return; // no /ingestion/email route in f3
    if (Number.isInteger(rowTarget.id) && rowTarget.id > 0) {
      navigate(`/ingestion/review/${rowTarget.id}`);
    }
  };
  const canOpenReviewFor = (group: TimesheetRowGroup) =>
    group.kind !== 'skipped' && Number.isInteger(group.primary.id) && group.primary.id > 0;

  // ── Render ───────────────────────────────────────────────────────
  if (isPageLoading) {
    return (
      <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading reviewer inbox" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-start">
        <div>
          <h1 className="text-4xl font-bold text-foreground">Inbox</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Review and process incoming timesheets.
            {lastFetchedAt ? (
              <span className="text-muted-foreground/80"> · Last fetched {lastFetchedAt.toLocaleString()}</span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canSeeTeamTimesheets ? (
            <Button
              variant="secondary"
              onClick={() => navigate('/approvals?tab=approved')}
              title="Open the Approved Timesheets tab"
            >
              <Users className="h-4 w-4" /> Approved Timesheets
            </Button>
          ) : null}
          <Button onClick={() => void handleFetch()} disabled={isBusy}>
            <RefreshCw className={cn('h-4 w-4', (triggerFetch.isPending || isFetchRunning) && 'animate-spin')} />
            {triggerFetch.isPending ? 'Starting Fetch…' : isFetchRunning ? 'Fetching Emails…' : 'Fetch Emails'}
          </Button>
        </div>
      </div>

      {/* Fetch-job activity strip */}
      {activeJobId && fetchStatus && fetchStatus.status !== 'not_found' ? (
        <section className="rounded-2xl border border-border bg-card px-5 py-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge
                  status={fetchStatus.status === 'in_progress' || fetchStatus.status === 'running' ? 'under_review' : fetchStatus.status === 'completed' ? 'approved' : fetchStatus.status === 'failed' || fetchStatus.status === 'error' ? 'rejected' : 'pending'}
                  variant="ingestion"
                  label={
                    fetchStatus.status === 'queued'
                      ? 'Queued'
                      : fetchStatus.status === 'in_progress' || fetchStatus.status === 'running'
                        ? 'Processing'
                        : fetchStatus.status === 'completed'
                          ? 'Complete'
                          : fetchStatus.status === 'failed' || fetchStatus.status === 'error'
                            ? 'Failed'
                            : fetchStatus.status}
                  showIcon={false}
                />
                <span className="text-sm text-foreground">{fetchStatus.message || 'Starting up…'}</span>
                {(fetchStatus.status === 'queued' || fetchStatus.status === 'in_progress' || fetchStatus.status === 'running') ? (
                  <div className="flex max-w-sm flex-1 items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-background">
                      <div className="h-full rounded-full bg-primary/60 transition-all duration-300" style={{ width: `${progress}%` }} />
                    </div>
                    <span className="whitespace-nowrap text-xs text-muted-foreground">{progress}%</span>
                  </div>
                ) : null}
                {(fetchStatus.status === 'queued' || fetchStatus.status === 'in_progress' || fetchStatus.status === 'running') && activeJobId ? (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await cancelFetch.mutateAsync(activeJobId);
                        setStatusTone('info');
                        setStatusMessage('Fetch cancelled.');
                      } catch (error) {
                        setStatusTone('danger');
                        setStatusMessage(getApiErrorMessage(error, 'Unable to cancel fetch.'));
                      }
                    }}
                    disabled={cancelFetch.isPending}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-transparent px-2.5 py-1 text-xs font-semibold text-muted-foreground transition hover:bg-muted disabled:opacity-50"
                  >
                    {cancelFetch.isPending ? 'Cancelling…' : 'Cancel'}
                  </button>
                ) : null}
              </div>
            </div>

            {(fetchStatus.result || fetchDiagnostics.length > 0) ? (
              <div className="min-w-[220px] space-y-2 rounded-2xl border border-border/60 bg-background px-4 py-2.5">
                {fetchStatus.result ? (
                  <div className="grid grid-cols-3 gap-3 text-center">
                    {([
                      ['total_fetched', 'Fetched'],
                      ['total_timesheets_created', 'Staged'],
                      ['total_skipped', 'Skipped'],
                    ] as const).map(([key, label]) => (
                      <div key={key}>
                        <p className="text-lg font-semibold text-foreground">
                          {String((fetchStatus.result as Record<string, unknown>)?.[key] ?? 0)}
                        </p>
                        <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
                {fetchDiagnostics.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowDiagnostics((c) => !c)}
                    className="flex w-full items-center justify-between rounded-xl bg-muted/40 px-3 py-2 text-left text-sm text-foreground transition hover:bg-muted"
                  >
                    <span>Latest fetch diagnostics</span>
                    {showDiagnostics ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Diagnostics detail */}
      {showDiagnostics && fetchDiagnostics.length > 0 ? (
        <section className="rounded-2xl border border-border bg-card px-5 py-4">
          <div className="space-y-2">
            {fetchDiagnostics.map((message, index) => (
              <div
                key={`${message.email_id ?? message.message_id ?? 'message'}-${index}`}
                className="rounded-2xl border border-border/50 bg-foreground/[0.02] px-4 py-3"
              >
                <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="font-medium text-foreground">{message.subject || 'No subject'}</p>
                    <p className="text-sm text-muted-foreground">{message.sender_email || 'Unknown sender'}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {message.skipped ? (
                      <StatusBadge status="pending" variant="ingestion" label={prettifySkipReason(message.skip_reason)} showIcon={false} />
                    ) : (
                      <StatusBadge
                        status="approved"
                        variant="ingestion"
                        label={message.timesheets_created ? `${message.timesheets_created} timesheet${message.timesheets_created === 1 ? '' : 's'}` : 'Processed'}
                        showIcon={false}
                      />
                    )}
                  </div>
                </div>
                {message.skip_detail ? <p className="mt-2 text-sm text-muted-foreground">{message.skip_detail}</p> : null}
                {message.errors?.length ? <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">{message.errors[0]}</p> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Standalone status banner */}
      {showStandaloneStatusMessage ? (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            'rounded-xl border px-4 py-2.5 text-sm',
            statusTone === 'success' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
            statusTone === 'danger' && 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300',
            statusTone === 'info' && 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
          )}
        >
          {statusMessage}
        </div>
      ) : null}

      {/* Dismissible skipped banner */}
      {showSkippedBanner ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="skipped-emails-banner"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300/30 bg-amber-500/5 px-5 py-3"
        >
          <div className="text-sm text-foreground">
            <span className="font-medium">{skippedCount}</span>{' '}
            {skippedCount === 1 ? "email couldn't be processed" : "emails couldn't be processed"}.{' '}
            <button type="button" className="font-medium text-primary underline-offset-4 hover:underline" onClick={() => setStatusFilter('skipped')}>
              View skipped
            </button>{' '}
            to reprocess individually, or reprocess them all now.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleReprocessSkipped()}
              disabled={isBusy || bulkReprocessEmails.isPending}
              className="action-button-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className="mr-2 h-4 w-4" /> Try again on {skippedCount} skipped
            </button>
            <button
              type="button"
              onClick={dismissSkippedBanner}
              aria-label="Dismiss skipped emails banner"
              className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}

      {/* Review queue */}
      <section className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="border-b border-border/70 px-5 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-base font-semibold text-foreground">Review queue</h2>
                <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                  {groups.length} showing
                </span>
                {hasAnyQueueItems ? (
                  <span className="text-sm text-muted-foreground">{allGroups.length} grouped submissions ready for review</span>
                ) : null}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Open a submission directly, or expand grouped emails to choose a specific week.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div
                role="tablist"
                aria-label="Inbox view"
                data-testid="inbox-view-toggle"
                className="inline-flex rounded-md border border-border bg-muted/30 p-0.5"
              >
                {([
                  ['cards', LayoutGrid, 'Cards'],
                  ['table', Rows, 'Table'],
                ] as const).map(([mode, Icon, label]) => (
                  <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={viewMode === mode}
                    onClick={() => handleSetViewMode(mode)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition',
                      viewMode === mode ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" /> {label}
                  </button>
                ))}
              </div>
              {showFilters ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="text-sm font-medium text-muted-foreground transition hover:text-foreground"
                >
                  Reset filters
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {/* Filters */}
        {showFilters ? (
          <div className="space-y-4 border-b border-border/70 bg-muted/20 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              {STATUS_OPTIONS.map((option) => {
                const active = statusFilter === option.key;
                const count = statusCounts[option.key] ?? 0;
                return (
                  <button
                    key={option.key || 'all'}
                    type="button"
                    onClick={() => setStatusFilter(option.key)}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition',
                      active ? 'bg-primary/15 text-primary' : 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <span>{option.label}</span>
                    <span className="rounded-full px-2 py-0.5 text-[11px]">{count}</span>
                  </button>
                );
              })}
              {statusFilter === 'skipped' && skippedCount > 0 ? (
                <button
                  type="button"
                  onClick={() => void handleReprocessSkipped()}
                  disabled={isBusy || bulkReprocessEmails.isPending}
                  data-testid="reprocess-all-skipped"
                  className="action-button-secondary ml-auto disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw className="mr-2 h-4 w-4" /> Try again on {skippedCount} skipped
                </button>
              ) : null}
            </div>

            <div className="flex flex-col gap-3 md:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  className="field-input pl-11"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by sender, subject, employee or client…"
                />
              </div>
              <select className="field-input md:max-w-xs" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">All Clients</option>
                {(clients as Client[]).map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}

        {/* Sticky bulk bar */}
        {selectedEmailIds.size > 0 ? (
          <div className="sticky bottom-0 z-10 border-b border-border/70 bg-card px-5 py-3">
            <div className="flex items-center justify-between gap-4 rounded-lg border border-primary/20 bg-primary/5 px-4 py-2.5">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-foreground">
                  {selectedEmailIds.size} email{selectedEmailIds.size !== 1 ? 's' : ''} selected
                </span>
                {selectedEmailIds.size < allVisibleEmailIds.length ? (
                  <button type="button" onClick={selectAllVisible} className="text-xs font-medium text-primary transition hover:text-primary/80">
                    Select all {allVisibleEmailIds.length}
                  </button>
                ) : null}
                <button type="button" onClick={clearSelection} className="text-xs font-medium text-muted-foreground transition hover:text-foreground">
                  Clear
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleBulkReprocess()}
                  disabled={isBusy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition hover:bg-primary/20 disabled:opacity-50"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', bulkReprocessEmails.isPending && 'animate-spin')} />
                  {bulkReprocessEmails.isPending ? 'Queueing…' : `Try again on ${selectedEmailIds.size}`}
                </button>
                <button
                  type="button"
                  onClick={() => void handleBulkDelete()}
                  disabled={isBusy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-rose-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-600 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {bulkDeleteEmails.isPending ? 'Deleting…' : `Delete ${selectedEmailIds.size}`}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Rows */}
        <div className="overflow-x-auto">
          {groups.length === 0 ? (
            <div className="px-6 py-12">
              <Empty
                title={hasActiveFilters ? 'No timesheets match the current filters.' : 'No timesheets to review.'}
                description={
                  hasActiveFilters
                    ? 'Clear the current filters to return to the full review queue.'
                    : 'Fetch new emails to bring in new timesheets, or review skipped emails if any need attention.'
                }
                className="mx-auto max-w-xl border-dashed"
                action={
                  hasActiveFilters ? (
                    <Button variant="secondary" onClick={clearFilters}>
                      Reset filters
                    </Button>
                  ) : (
                    <Button onClick={() => void handleFetch()} disabled={isBusy}>
                      <RefreshCw className={cn('h-4 w-4', (triggerFetch.isPending || isFetchRunning) && 'animate-spin')} />
                      {triggerFetch.isPending ? 'Starting Fetch…' : isFetchRunning ? 'Fetching Emails…' : 'Fetch Emails'}
                    </Button>
                  )
                }
              />
            </div>
          ) : viewMode === 'table' ? (
            <table className="min-w-full text-left">
              <thead className="border-b border-border">
                <tr className="text-xs uppercase tracking-[0.06em] text-muted-foreground">
                  <th className="w-10 px-2 py-4">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-border accent-primary"
                      checked={allVisibleEmailIds.length > 0 && allVisibleEmailIds.every((id) => selectedEmailIds.has(id))}
                      onChange={(e) => (e.target.checked ? selectAllVisible() : clearSelection())}
                    />
                  </th>
                  <th className="px-4 py-4 font-medium">Sender</th>
                  <th className="px-4 py-4 font-medium">Subject</th>
                  <th className="px-4 py-4 font-medium">Status</th>
                  <th className="px-4 py-4 font-medium">Client</th>
                  <th className="px-4 py-4 font-medium">Employee</th>
                  <th className="px-4 py-4 font-medium">Week</th>
                  <th className="px-4 py-4 font-medium">Hours</th>
                  <th className="px-4 py-4 font-medium">Received</th>
                  <th className="px-4 py-4 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const isSkipped = group.kind === 'skipped';
                  const isMultiPeriod = group.periods > 1;
                  const rowTarget = group.primary;
                  const canOpen = canOpenReviewFor(group);
                  const ts = rowTarget.received_at || rowTarget.created_at;
                  const stale = !isSkipped && isStaleReceived(ts);
                  return (
                    <tr
                      key={group.key}
                      data-row-key={group.key}
                      className={cn('group h-11 transition hover:bg-muted', canOpen ? 'cursor-pointer' : 'cursor-default')}
                      onClick={() => openReviewFor(group)}
                    >
                      <td className="w-10 px-2 py-5 align-top">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-border accent-primary"
                          checked={rowTarget.email_id != null && selectedEmailIds.has(rowTarget.email_id)}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => rowTarget.email_id != null && toggleEmailId(rowTarget.email_id)}
                        />
                      </td>
                      <td className="px-4 py-5 align-top">
                        <div className="flex min-w-[180px] items-start gap-3">
                          <span
                            className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold uppercase tracking-wide text-slate-100 ring-1 ring-inset ring-white/10"
                            style={{ background: 'linear-gradient(135deg, #334155, #1e293b)' }}
                            aria-hidden="true"
                          >
                            {getInitials(rowTarget.sender_name, rowTarget.sender_email)}
                          </span>
                          <div className="min-w-0">
                            <p className="font-semibold text-foreground">
                              {rowTarget.sender_name || rowTarget.sender_email || 'Unknown sender'}
                            </p>
                            <p className="mt-1 max-h-0 overflow-hidden font-mono text-xs text-muted-foreground opacity-0 transition-all duration-150 group-hover:max-h-6 group-hover:opacity-100">
                              {rowTarget.sender_email || '--'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-5 align-top">
                        <div className="min-w-[200px] space-y-2">
                          <p className="font-medium text-foreground" title={rowTarget.subject ?? undefined}>
                            {rowTarget.subject || 'No subject'}
                          </p>
                          {isMultiPeriod ? (
                            <span className="inline-flex items-center rounded-full border border-blue-400/40 bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300">
                              {group.periods} weeks
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-5 align-top">
                        <StatusBadge status={group.status} variant="ingestion" label={statusLabel(group.status)} />
                      </td>
                      <td className="px-4 py-5 align-top text-sm">
                        {rowTarget.client_name ? (
                          <span className="text-sm text-foreground">{rowTarget.client_name}</span>
                        ) : isSkipped ? (
                          <span className="text-sm text-muted-foreground">--</span>
                        ) : (
                          renderClientPicker(rowTarget, false)
                        )}
                      </td>
                      <td className="px-4 py-5 align-top">
                        {rowTarget.employee_name || rowTarget.extracted_employee_name ? (
                          <span className="text-sm text-foreground">
                            {cleanEmployeeNameForDisplay(rowTarget.employee_name || rowTarget.extracted_employee_name)}
                          </span>
                        ) : isSkipped ? (
                          <span className="text-sm text-muted-foreground">--</span>
                        ) : (
                          renderEmployeePicker(rowTarget, false)
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-5 align-top text-sm text-muted-foreground">
                        {isMultiPeriod
                          ? formatDateRange(group.timesheets[0]?.period_start ?? null, group.timesheets[group.timesheets.length - 1]?.period_end ?? null)
                          : formatDateRange(rowTarget.period_start, rowTarget.period_end)}
                      </td>
                      <td className="px-4 py-5 align-top">
                        {isSkipped ? (
                          <span className="text-sm text-muted-foreground">--</span>
                        ) : group.anomalyCount > 0 ? (
                          <span
                            className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-sm font-medium text-amber-700 dark:text-amber-400"
                            title={`${group.anomalyCount} anomaly${group.anomalyCount === 1 ? '' : 'ies'} flagged. Open to review.`}
                          >
                            {formatHours(group.totalHours)}
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                          </span>
                        ) : (
                          <span className="whitespace-nowrap font-mono text-sm font-medium text-foreground">{formatHours(group.totalHours)}</span>
                        )}
                      </td>
                      <td className="px-4 py-5 align-top">
                        {(() => {
                          const date = ts ? new Date(ts) : null;
                          const titleAttr = date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : undefined;
                          return (
                            <span
                              className={cn('whitespace-nowrap text-sm', stale ? 'inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}
                              title={stale ? `Waiting longer than ${STALE_BUSINESS_DAYS} business days${titleAttr ? ' · ' + titleAttr : ''}` : titleAttr}
                            >
                              {stale ? <Clock className="h-3.5 w-3.5 shrink-0" /> : null}
                              {formatRelativeReceived(ts)}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-5 align-top text-right">
                        <div className="flex justify-end gap-2">
                          {isSkipped && group.skipped ? (
                            <>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handlePromoteSkipped(group.skipped!.id, group.skipped!.subject);
                                }}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-700 transition hover:bg-emerald-500/25 disabled:opacity-40 dark:text-emerald-300"
                                aria-label={`Promote email ${group.skipped.id} to the review queue`}
                                title="This is a timesheet. Add to review queue."
                                disabled={isBusy || promoteSkipped.isPending}
                              >
                                <CheckCircle2 className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleConfirmSkipped(group.skipped!.id, group.skipped!.subject);
                                }}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-muted-foreground transition hover:bg-muted/70 disabled:opacity-40"
                                aria-label={`Confirm email ${group.skipped.id} is not a timesheet`}
                                title="Not a timesheet. Hide from this list."
                                disabled={isBusy || confirmSkipped.isPending}
                              >
                                <EyeOff className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleReprocessEmail(group.skipped!.id);
                                }}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-foreground transition hover:bg-muted/70"
                                aria-label={`Try processing email ${group.skipped.id} again`}
                                title="Try processing again"
                                disabled={isBusy}
                              >
                                <RefreshCw className="h-4 w-4" />
                              </button>
                            </>
                          ) : null}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openReviewFor(group);
                            }}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-foreground transition hover:bg-muted/70 disabled:opacity-40"
                            aria-label={isSkipped ? `Open email ${group.skipped?.id}` : `Open submission ${rowTarget.id}`}
                            title={isSkipped ? 'Open from the Skipped actions' : 'Open'}
                            disabled={!canOpen}
                          >
                            <ArrowRight className="h-4 w-4" />
                          </button>
                          {group.status !== 'approved' && group.status !== 'rejected' && rowTarget.email_id != null ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleDeleteEmail(rowTarget.email_id!, rowTarget.subject);
                              }}
                              disabled={isBusy}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-foreground transition hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-40 dark:hover:text-rose-300"
                              aria-label={`Delete email ${rowTarget.email_id}`}
                              title="Delete"
                            >
                              {deletingEmailId === rowTarget.email_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div data-testid="inbox-cards-view" className="flex flex-col gap-2 p-3">
              {groups.map((group) => {
                const isSkipped = group.kind === 'skipped';
                const isMultiPeriod = group.periods > 1;
                const rowTarget = group.primary;
                const isFinal = group.status === 'approved' || group.status === 'rejected';
                const isExpanded = expandedGroups.has(group.key);
                const canOpen = canOpenReviewFor(group);
                const receivedTs = rowTarget.received_at || rowTarget.created_at;
                const stale = !isSkipped && isStaleReceived(receivedTs);

                return (
                  <div
                    key={group.key}
                    data-row-key={group.key}
                    data-testid="inbox-card"
                    className={cn(
                      'rounded-xl border border-border/70 bg-card/40 transition hover:border-primary/30 hover:bg-muted',
                      isSkipped && 'border-l-2 border-l-amber-400/60',
                      isFinal && 'opacity-70 hover:opacity-100',
                    )}
                  >
                    <div
                      className={cn('flex items-start gap-3 px-4 py-3', canOpen && 'cursor-pointer')}
                      onClick={() => {
                        if (canOpen) openReviewFor(group);
                      }}
                    >
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 rounded border-border accent-primary"
                        checked={rowTarget.email_id != null && selectedEmailIds.has(rowTarget.email_id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => rowTarget.email_id != null && toggleEmailId(rowTarget.email_id)}
                        aria-label={`Select email ${rowTarget.email_id}`}
                      />
                      <span
                        className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold uppercase tracking-wide text-slate-100 ring-1 ring-inset ring-white/10"
                        style={{ background: 'linear-gradient(135deg, #334155, #1e293b)' }}
                        aria-hidden="true"
                      >
                        {getInitials(rowTarget.sender_name, rowTarget.sender_email)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="font-semibold text-foreground">
                            {rowTarget.sender_name || rowTarget.sender_email || 'Unknown sender'}
                          </span>
                          <span className="font-mono text-[11px] text-muted-foreground">{rowTarget.sender_email || ''}</span>
                        </div>
                        <p className="mt-0.5 truncate text-sm text-muted-foreground" title={rowTarget.subject ?? undefined}>
                          {rowTarget.subject || 'No subject'}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                          {/* Client */}
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] uppercase tracking-[0.4px] text-muted-foreground">Client</span>
                            {rowTarget.client_name ? (
                              <span className="text-foreground">{rowTarget.client_name}</span>
                            ) : isSkipped ? (
                              <span className="text-muted-foreground">--</span>
                            ) : (
                              renderClientPicker(rowTarget, true)
                            )}
                          </div>

                          {/* Employee */}
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] uppercase tracking-[0.4px] text-muted-foreground">Employee</span>
                            {rowTarget.employee_name || rowTarget.extracted_employee_name ? (
                              <span className="text-foreground">
                                {cleanEmployeeNameForDisplay(rowTarget.employee_name || rowTarget.extracted_employee_name)}
                              </span>
                            ) : isSkipped ? (
                              <span className="text-muted-foreground">--</span>
                            ) : (
                              renderEmployeePicker(rowTarget, true)
                            )}
                          </div>

                          {/* Period */}
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] uppercase tracking-[0.4px] text-muted-foreground">Period</span>
                            <span className="text-foreground">
                              {isMultiPeriod
                                ? formatDateRange(group.timesheets[0]?.period_start ?? null, group.timesheets[group.timesheets.length - 1]?.period_end ?? null)
                                : formatDateRange(rowTarget.period_start, rowTarget.period_end)}
                            </span>
                          </div>

                          {/* Hours */}
                          {!isSkipped ? (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] uppercase tracking-[0.4px] text-muted-foreground">Hours</span>
                              {group.anomalyCount > 0 ? (
                                <span className="inline-flex items-center gap-1 font-mono text-amber-700 dark:text-amber-400">
                                  {formatHours(group.totalHours)}
                                  <AlertTriangle className="h-3 w-3" />
                                </span>
                              ) : (
                                <span className="font-mono text-foreground">{formatHours(group.totalHours)}</span>
                              )}
                            </div>
                          ) : null}

                          {/* Received */}
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] uppercase tracking-[0.4px] text-muted-foreground">Received</span>
                            {stale ? (
                              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                                <Clock className="h-3 w-3" />
                                {formatRelativeReceived(receivedTs)}
                              </span>
                            ) : (
                              <span className="text-foreground">{formatRelativeReceived(receivedTs)}</span>
                            )}
                          </div>
                        </div>

                        {/* Pills row */}
                        {isMultiPeriod || isSkipped ? (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {isMultiPeriod ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleExpanded(group.key);
                                }}
                                className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium text-indigo-600 transition hover:brightness-125 dark:text-indigo-300"
                                style={{ background: 'rgba(99, 102, 241, 0.15)' }}
                                aria-expanded={isExpanded}
                                aria-label={isExpanded ? `Collapse ${group.periods} weeks` : `Expand ${group.periods} weeks`}
                              >
                                {group.periods} weeks {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                              </button>
                            ) : null}
                            {isSkipped ? (
                              <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                                Skipped
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

                      {/* Status pill */}
                      <StatusBadge status={group.status} variant="ingestion" label={statusLabel(group.status)} className="self-start whitespace-nowrap" />

                      {/* Row actions */}
                      <div className="flex shrink-0 items-center gap-1.5 self-start">
                        {isSkipped && group.skipped ? (
                          <>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handlePromoteSkipped(group.skipped!.id, group.skipped!.subject);
                              }}
                              disabled={isBusy || promoteSkipped.isPending}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-700 transition hover:bg-emerald-500/25 disabled:opacity-40 dark:text-emerald-300"
                              aria-label={`Promote email ${group.skipped.id} to the review queue`}
                              title="This is a timesheet"
                            >
                              <CheckCircle2 className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleConfirmSkipped(group.skipped!.id, group.skipped!.subject);
                              }}
                              disabled={isBusy || confirmSkipped.isPending}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-muted-foreground transition hover:bg-muted/70 disabled:opacity-40"
                              aria-label={`Confirm email ${group.skipped.id} is not a timesheet`}
                              title="Not a timesheet"
                            >
                              <EyeOff className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleReprocessEmail(group.skipped!.id);
                              }}
                              disabled={isBusy}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-foreground transition hover:bg-muted/70 disabled:opacity-40"
                              aria-label={`Reprocess email ${group.skipped.id}`}
                              title="Try processing again"
                            >
                              <RefreshCw className="h-4 w-4" />
                            </button>
                          </>
                        ) : null}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openReviewFor(group);
                          }}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-foreground transition hover:bg-muted/70 disabled:opacity-40"
                          aria-label={isSkipped ? `Open email ${group.skipped?.id}` : `Open submission ${rowTarget.id}`}
                          title="Open"
                          disabled={!canOpen}
                        >
                          <ArrowRight className="h-4 w-4" />
                        </button>
                        {!isFinal && rowTarget.email_id != null ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDeleteEmail(rowTarget.email_id!, rowTarget.subject);
                            }}
                            disabled={isBusy}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-foreground transition hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-40 dark:hover:text-rose-300"
                            aria-label={`Delete email ${rowTarget.email_id}`}
                            title="Delete"
                          >
                            {deletingEmailId === rowTarget.email_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {/* Multi-period child cards (per-week breakdown) */}
                    {isMultiPeriod && isExpanded ? (
                      <div data-testid={`inbox-card-children-${group.key}`} className="mb-3 ml-12 mr-3 border-l-2 border-border/60 pl-3">
                        <div className="flex flex-col gap-1.5">
                          {group.timesheets.map((tsRow) => (
                            <div key={tsRow.id} className="flex items-center gap-3 rounded-md border border-border/60 bg-card/30 px-3 py-2 text-xs">
                              <span className="min-w-[120px] font-medium text-foreground">{formatDateRange(tsRow.period_start, tsRow.period_end)}</span>
                              <span className="font-mono text-muted-foreground">{formatHours(tsRow.total_hours)}h</span>
                              <StatusBadge status={tsRow.status} variant="ingestion" label={statusLabel(tsRow.status)} className="text-[10px]" />
                              <div className="ml-auto flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigate(`/ingestion/review/${tsRow.id}`);
                                  }}
                                  className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-muted text-foreground transition hover:bg-muted/70"
                                  aria-label={`Open week ${tsRow.id}`}
                                  title="Open"
                                >
                                  <ArrowRight className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <CreateClientFromDomainPopover
        open={cascadePopover != null}
        domain={cascadePopover?.domain ?? ''}
        cascadeCount={cascadePopover ? cascadePendingCount(cascadePopover.domain) : 0}
        existingClients={clients as Array<{ id: number; name: string }>}
        initialValue={cascadeInitialValue}
        isSubmitting={createClientFromDomain.isPending}
        onConfirm={(payload) => {
          if (cascadePopover) void handleCascadeConfirm(cascadePopover.domain, payload);
        }}
        onClose={() => setCascadePopover(null)}
      />
    </div>
  );
}

export default InboxPage;

// PORT NOTES:
// PORTED (full behavior, reskinned to f3 primitives):
//  - Cards/Table view toggle persisted to localStorage 'inbox.viewMode' ONLY
//    (f3 has no user-prefs endpoint; f2's server-side inbox_view_mode persistence
//    is intentionally dropped).
//  - Status tabs from STATUS_OPTIONS (All/Pending/Under Review/Approved/Rejected/
//    On Hold/Skipped) + client dropdown (useClients). All filtering is CLIENT-SIDE
//    in useMemo because f3 useIngestionTimesheets(enabled) takes no params: fetch
//    all, then filter by status/client/search. Per-tab counts come from allGroups
//    (rejected included) so badges stay accurate regardless of the active tab.
//  - Bulk toolbar (select / select-all / clear) made STICKY at the bottom of the
//    queue card; bulk reprocess (useBulkReprocess) + bulk delete (useBulkDeleteEmails
//    with the optional refetch/rewind second prompt).
//  - Row actions: skipped -> Promote (usePromoteSkipped) / Confirm-skip (useConfirmSkip)
//    / Reprocess (useReprocessStoredEmail); all rows -> Open (navigate
//    /ingestion/review/:id) / Delete (useDeleteEmail, hidden for approved+rejected).
//  - Inline per-row client picker + "+ Create new client" (useCreateClient, then
//    cascadeClientAcrossEmail). Non-personal sender domains route to the
//    CreateClientFromDomainPopover -> createFromDomain CASCADE.
//  - Inline employee picker (useAssignableUsers) + chain-candidate pills from
//    row.llm_match_suggestions -> useAssignChainCandidate; "+ Add employee" fallback.
//  - Multi-period grouping via buildRowGroups; parent row + chevron-expand to
//    per-week children (cards view), "N weeks" pill (table view).
//  - Fetch-job UI: useFetchEmails -> job_id -> useFetchJobStatus poll; progress bar,
//    Cancel (useCancelFetchJob), Fetched/Staged/Skipped stats, collapsible
//    diagnostics (<=8). Active job id persisted in localStorage (per-tenant) so it
//    survives reload, with late-hydration once tenant_id arrives.
//  - Dismissible skipped banner (per-tenant localStorage dismissed-count) shown when
//    skipped>dismissed and tab!=skipped.
//  - "Approved Timesheets" shortcut (navigate /approvals?tab=approved) for
//    manager/viewer (useIsViewer doesn't exist in f3, so viewer is derived from
//    user.role === 'VIEWER').
//  - Search across sender_email/name, subject, employee name, client_name +
//    extracted_client_name. Staleness tint on Received (isStaleReceived). "Last
//    fetched <ts>" from useMailboxes (admin-gated to avoid 403 noise).
//
// COULD NOT PORT / DELIBERATELY CHANGED (f3 data layer differences):
//  1. fetchJobStatus terminal state is 'completed' (NOT 'complete') and the f3 hook
//     also treats failed/cancelled/error as terminal. The invalidate-on-complete
//     effect was retargeted accordingly; queryKey for skipped is ['ingestion','skipped']
//     in f3 (f2 used 'skipped-emails').
//  2. SKIPPED-ROW "OPEN": f2 navigated to /ingestion/email/:id, which does NOT exist
//     as a route in f3 (only /ingestion/review/:timesheetId). Skipped rows therefore
//     have Open DISABLED; use the Promote/Confirm/Reprocess actions instead. f3 ships
//     a SkippedEmailsDrawer for the email-detail experience but wiring it in was out
//     of scope for this page port.
//  3. "Try again on N skipped": f3 has no reprocess-all-skipped endpoint
//     (useReprocessSkippedEmails). Reimplemented by bulk-reprocessing the currently
//     ACTIONABLE skipped email ids via useBulkReprocess. Behavior is equivalent for
//     the surfaced rows; it won't touch skipped emails the classifier filtered out
//     of the actionable set (f2's server-side variant reprocessed all stored skips).
//  4. CreateClientFromDomainPopover + useCreateClientFromDomain are NOT present in the
//     current f3 tree (only clientsApi.createFromDomain). To keep this a single
//     self-contained module that compiles, both are defined INLINE here (the hook wraps
//     clientsApi.createFromDomain and invalidates ['clients']+['ingestion','timesheets']).
//     If/when a shared f3 CreateClientFromDomainPopover + useCreateClientFromDomain land,
//     delete the local copies and import them instead.
//  5. is_likely_resubmission ("Possible resubmission" badge) and mailbox_label are NOT
//     on the f3 IngestionSummary wire payload (per types/admin.ts), so f2's resubmission
//     badge + mailbox label are omitted. The cards-view pills row now renders only for
//     multi-period or skipped.
//  6. INBOX VIEW RESTORATION (scroll/highlight/filters round-trip via
//     utils/inboxViewState + scrollAndHighlightRow, and the location.state jobId/banner
//     pickup) was dropped: those f2 utils don't exist in f3 and the page navigates to a
//     full review ROUTE here (not an in-page panel), so there is no "Back to inbox"
//     return-to-row contract to preserve. data-row-key attributes are still emitted so a
//     future restoration util can hook in without markup changes.
//  7. cascadeClientAcrossEmail can't re-fetch siblings by email_id (no param on the f3
//     list endpoint), so it cascades across the siblings already in the loaded
//     allTimesheets list. Edge case: weeks not present in the loaded set won't be
//     updated, but the f3 list is unfiltered/full so this is effectively the same set.
//  8. useCreateClient in f3 requires { name, client_type }; the inline "create client"
//     path passes client_type:'external' (the ingestion default). f2 passed only { name }
//     and let the backend default it.
//  9. Type guards added: chainCandidatesOf() and extractedClientName() defensively read
//     llm_match_suggestions (typed Array<Record<string,unknown>> in f3, vs f2's
//     {chain_candidates}) and the optional extracted_client_name field via a cast.
//  10. fetchStatusIsStale / formatFetchProgressText (f2 utils/fetchJobStaleness) were not
//      ported (utils absent in f3). Progress text falls back to a plain "<pct>%". The
//      stalled-job amber callout + "Dismiss stalled status" affordance were dropped; the
//      f3 useFetchJobStatus already stops polling on terminal states, but a crashed worker
//      that never reaches a terminal state will keep the strip until manual page reload.
//      DOUBLE-CHECK if you want the stale-detection affordance back.
//
// ASSUMPTIONS TO VERIFY:
//  - useBulkDeleteEmails returns a payload exposing cursors_rewound; f3's hook returns the
//    raw axios result, so it's read defensively as result.data?.cursors_rewound (falls back
//    to the plain "Deleted N" message if absent).
//  - assignChainCandidate hook signature is flat { id, name?, email? } (confirmed in
//    useAdmin.ts) — NOT f2's { id, data: { name, email } }.
//  - StatusBadge variant="ingestion" covers pending/under_review/approved/rejected/on_hold/
//    skipped (confirmed in INGESTION_STATUS_META); the fetch-job strip reuses those keys
//    with custom labels for queue states.
