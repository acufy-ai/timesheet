import React, { useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, Clock, EyeOff, LayoutGrid, Loader2, Plus, RefreshCw, Rows, Search, Trash2, Users, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import axios from 'axios';


import { Badge, Loading } from '@/components';
import { BulkSelectBar } from '@/components/ui/BulkSelectBar';
import { CreateClientFromDomainPopover } from '@/components/ui/CreateClientFromDomainPopover';
import {
  useAuth,
  useIsAdmin,
  useIsManager,
  useIsViewer,
  useAssignChainCandidate,
  useBulkReprocessEmails,
  useBulkDeleteIngestedEmails,
  useClients,
  useCreateClient,
  useCreateClientFromDomain,
  useDeleteIngestedEmail,
  useFetchJobStatus,
  useIngestionTimesheets,
  useMailboxes,
  useMyPreferences,
  useReprocessIngestionEmail,
  useReprocessSkippedEmails,
  useSkippedEmails,
  usePromoteSkippedEmail,
  useConfirmSkippedEmail,
  useTriggerFetchEmails,
  useCancelFetchEmails,
  useUpdateIngestionTimesheetData,
  useUpdateMyPreferences,
  useAssignableUsers,
} from '@/hooks';
import { ingestionAPI } from '@/api/endpoints';
import type { ChainCandidate, FetchMessageDiagnostic, IngestionTimesheetSummary, SkippedEmail } from '@/types';
import {
  buildRowGroups,
  buildSkippedRowGroup,
  type TimesheetRowGroup,
} from '@/utils/inboxGrouping';
import { formatFetchProgressText, isFetchJobStale } from '@/utils/fetchJobStaleness';
import { readActiveFetchJobId, writeActiveFetchJobId } from '@/utils/activeFetchJob';
import {
  readInboxViewState,
  writeInboxViewState,
  clearInboxViewState,
  scrollAndHighlightRow,
} from '@/utils/inboxViewState';

const getApiErrorMessage = (error: unknown, fallback: string): string => {
  if (axios.isAxiosError(error) && typeof error.response?.data?.detail === 'string') {
    return error.response.data.detail;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
};

const formatShortDate = (value: string | null | undefined): string => {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const formatDateRange = (start: string | null, end: string | null): string => {
  if (!start && !end) return '--';
  const startLabel = formatShortDate(start);
  const endLabel = formatShortDate(end);
  if (start && end) return `${startLabel} - ${endLabel}`;
  return startLabel !== '--' ? startLabel : endLabel;
};

const formatHours = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined || value === '') return '--';
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return String(value);
  return numeric.toFixed(1);
};

// Rows older than this (in business days, weekends excluded) get an amber
// tint on the Received cell so reviewers can scan stale ones at a glance.
export const STALE_BUSINESS_DAYS = 5;

// Personal email providers — never auto-create a client from these domains.
// Mirror of the backend PERSONAL_EMAIL_DOMAINS set in ingestion_pipeline.py.
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'yahoo.com',
  'icloud.com',
  'aol.com',
  'live.com',
  'msn.com',
  'proton.me',
  'protonmail.com',
]);

export const domainOf = (email: string | null | undefined): string => {
  if (!email || !email.includes('@')) return '';
  return email.split('@', 2)[1].trim().toLowerCase();
};

export const isPersonalDomain = (domain: string): boolean =>
  PERSONAL_EMAIL_DOMAINS.has(domain.trim().toLowerCase());

// Smart-guess client name from a domain. "dxc.com" -> "DXC" (uppercase if
// short), "aegon.com" -> "Aegon" (title-case otherwise). Reviewer can edit.
export const suggestNameFromDomain = (domain: string): string => {
  const stem = (domain.split('.')[0] || domain).trim();
  if (!stem) return '';
  if (stem.length <= 4) return stem.toUpperCase();
  return stem.charAt(0).toUpperCase() + stem.slice(1).toLowerCase();
};

export const getInitials = (name: string | null | undefined, email?: string | null): string => {
  const source = (name || '').trim();
  if (source.includes(',')) {
    const [last, first] = source.split(',').map((part) => part.trim()).filter(Boolean);
    if (last && first) return (first.charAt(0) + last.charAt(0)).toUpperCase();
    if (last) return last.slice(0, 2).toUpperCase();
  }
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  // Fall back to the first two characters of the local-part of the email.
  const local = (email || '').split('@')[0] || '';
  if (local.length >= 2) return local.slice(0, 2).toUpperCase();
  return '?';
};

// Days between two dates, weekends excluded, rounded down. Returns 0 for
// today, fractional values are floored. Used to flag rows older than
// STALE_BUSINESS_DAYS.
const businessDaysBetween = (later: Date, earlier: Date): number => {
  const ms = later.getTime() - earlier.getTime();
  if (ms <= 0) return 0;
  const calendarDays = Math.floor(ms / (24 * 60 * 60 * 1000));
  // Cheap approximation: 5 business days per 7 calendar days. Good enough
  // for staleness highlighting; real business-day math would handle holidays.
  return Math.floor(calendarDays * (5 / 7));
};

export const formatRelativeReceived = (value: string | null | undefined): string => {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (60 * 1000));
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export const isStaleReceived = (value: string | null | undefined): boolean => {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return businessDaysBetween(new Date(), date) >= STALE_BUSINESS_DAYS;
};

const cleanEmployeeNameForDisplay = (value?: string | null): string => {
  if (!value) return '';
  const compactLeadingPrefix = value.replace(/^ven[aij](?=[A-Z])/, '');
  const parts = compactLeadingPrefix.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1 && /^ven[aij]$/i.test(parts[0])) {
    parts.shift();
  }
  if (parts.length > 0 && /^ashw/i.test(parts[0])) {
    parts[0] = `Ai${parts[0].slice(1)}`;
  }
  return parts.join(' ').trim() || compactLeadingPrefix.trim();
};

const prettifySkipReason = (value: string | null | undefined): string => {
  if (!value) return 'Unknown reason';
  return value
    .replace(/^not_timesheet_email:/, 'not_timesheet_email ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const isNoiseSkipReason = (value: string | null | undefined): boolean => {
  if (!value) return false;
  return (
    value.startsWith('not_timesheet_email:') ||
    value.startsWith('low_confidence_no_attachments:') ||
    value === 'no_candidate_timesheet_attachment'
  );
};

const hasTimesheetKeywords = (value: string | null | undefined): boolean => {
  if (!value) return false;
  const text = value.toLowerCase();
  const keywords = [
    'timesheet',
    'time sheet',
    'timecard',
    'time card',
    'hours worked',
    'weekly hours',
    'work log',
    'billable',
  ];
  return keywords.some((keyword) => text.includes(keyword));
};

const isActionableSkippedEmail = (email: SkippedEmail): boolean => {
  // Classifier-skipped emails are always actionable when the backend
  // surfaces them — these are exactly the rows the reviewer needs to
  // audit. The "isNoiseSkipReason" filter was hiding them by design;
  // we now keep them visible so misclassified timesheets don't vanish.
  const isClassifierSkip =
    email.skip_reason?.startsWith('not_timesheet_email:') ||
    email.skip_reason?.startsWith('low_confidence_no_attachments:');
  if (isClassifierSkip) return true;

  if (isNoiseSkipReason(email.skip_reason)) return false;

  const hasTimesheetContext =
    hasTimesheetKeywords(email.subject) ||
    email.classification_intent === 'new_submission' ||
    email.classification_intent === 'resubmission' ||
    email.classification_intent === 'correction' ||
    email.classification_intent === 'submission' ||
    email.classification_intent === 'timesheet_submission' ||
    email.reprocessable_attachments.some((attachment) => hasTimesheetKeywords(attachment.filename));

  if (!hasTimesheetContext) return false;
  return email.timesheet_attachment_count > 0 || email.reprocessable_attachments.length > 0;
};

const isActionableDiagnostic = (message: FetchMessageDiagnostic): boolean => {
  if (!message.skipped) return true;
  if (isNoiseSkipReason(message.skip_reason)) return false;
  if (message.skip_reason === 'attachment_extraction_failed' || message.skip_reason === 'no_structured_timesheet_data') {
    return hasTimesheetKeywords(message.subject);
  }
  return true;
};

const getStatusTone = (status: string): 'success' | 'danger' | 'warning' | 'info' | 'outline' => {
  if (status === 'approved') return 'success';
  if (status === 'rejected') return 'danger';
  if (status === 'on_hold') return 'outline';
  if (status === 'under_review') return 'info';
  if (status === 'skipped') return 'outline';
  return 'warning';
};

const getPushTone = (pushStatus: string | null): 'success' | 'outline' => {
  return pushStatus === 'Sent' ? 'success' : 'outline';
};

const statusLabel = (status: string): string => {
  if (status === 'under_review') return 'Under Review';
  if (status === 'on_hold') return 'On Hold';
  return status.charAt(0).toUpperCase() + status.slice(1);
};

const STATUS_OPTIONS = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'under_review', label: 'Under Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'on_hold', label: 'On Hold' },
  { key: 'skipped', label: 'Skipped' },
];

const getStatusHeading = (tone: 'success' | 'danger' | 'info'): string => {
  if (tone === 'success') return 'Update complete';
  if (tone === 'danger') return 'Unable to complete that action';
  return 'Update in progress';
};

const getFriendlySystemMessage = (message: string | null | undefined, fallback: string): string => {
  if (!message) return fallback;
  if (message.includes('greenlet_spawn has not been called')) {
    return 'The fetch job failed before emails could be processed.';
  }
  if (message.includes('Email not found')) {
    return 'That email is no longer available.';
  }
  return message;
};

// TimesheetRowGroup type + buildSkippedRowGroup helper moved to
// utils/inboxGrouping.ts so the dashboard's "X await review" tile
// can use the same grouping definition.

// buildRowGroups moved to utils/inboxGrouping.ts. The function below
// is kept private because it depends on STATUS_OPTIONS defined here.

const countStatuses = (groups: TimesheetRowGroup[]) =>
  STATUS_OPTIONS.reduce<Record<string, number>>((accumulator, option) => {
    if (!option.key) {
      accumulator[option.key] = groups.length;
      return accumulator;
    }
    accumulator[option.key] = groups.filter((group) => group.status === option.key).length;
    return accumulator;
  }, {});

export const InboxPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  // Shortcut to /user-management?tab=timesheets is visible only when
  // the user can actually navigate there. AdminOrManagerGuard on that
  // route allows ADMIN/MANAGER/VIEWER. Admin never lands on Inbox
  // (gated out at the route level), so MANAGER + VIEWER are the
  // realistic overlap. EMPLOYEE reviewers don't have access.
  const canSeeTeamTimesheets = useIsManager() || useIsViewer();
  // Pick up job ID from navigation state (e.g., after reprocess from review panel)
  const navJobId =
    typeof location.state === 'object' && location.state !== null && 'jobId' in location.state && typeof location.state.jobId === 'string'
      ? location.state.jobId
      : null;
  // Restore activeJobId from sessionStorage on first mount so a page
  // reload (audit F-03) doesn't drop the polling UI for a job that's
  // still running in the worker. Falls back to navJobId if a route
  // explicitly passes one, then to nothing. Tenant-scoped key inside
  // the util prevents leakage across workspaces.
  const [activeJobId, setActiveJobIdState] = React.useState<string | null>(
    () => navJobId ?? readActiveFetchJobId(user?.tenant_id) ?? null,
  );
  const setActiveJobId = React.useCallback((next: string | null) => {
    setActiveJobIdState(next);
    writeActiveFetchJobId(user?.tenant_id, next);
  }, [user?.tenant_id]);
  // Late hydration: if user.tenant_id arrives AFTER mount (auth /me round-
  // trip) and we still don't have an activeJobId, pick up the persisted
  // value now. One-shot — won't override a user-set state change.
  const hydratedRef = React.useRef(false);
  React.useEffect(() => {
    if (hydratedRef.current) return;
    if (user?.tenant_id == null) return;
    hydratedRef.current = true;
    if (activeJobId == null) {
      const persisted = readActiveFetchJobId(user.tenant_id);
      if (persisted) setActiveJobIdState(persisted);
    }
  }, [user?.tenant_id, activeJobId]);
  const [statusFilter, setStatusFilter] = React.useState('');
  const [clientId, setClientId] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);
  const [statusTone, setStatusTone] = React.useState<'success' | 'danger' | 'info'>('info');

  const [showDiagnostics, setShowDiagnostics] = React.useState(false);
  const [showTechnicalDetails, setShowTechnicalDetails] = React.useState(false);
  const [selectedEmailIds, setSelectedEmailIds] = useState<Set<number>>(new Set());

  // Cascade-create-client-from-domain popover state.
  const [cascadePopover, setCascadePopover] = React.useState<{
    domain: string;
    anchorEl: HTMLElement;
  } | null>(null);
  const createClientFromDomain = useCreateClientFromDomain();

  const assignChainCandidate = useAssignChainCandidate();
  const updateTimesheet = useUpdateIngestionTimesheetData();
  const createClient = useCreateClient();

  // Cascade a client assignment across every sibling week from the same
  // email that's still editable (status pending / under_review). The
  // reviewer's client decision is the final answer for the whole
  // submission, so the inbox card pickers should set it once and have
  // it propagate to every week pill on the same email.
  //
  // We re-fetch the sibling list scoped only by email_id rather than
  // trusting the caller's snapshot of ``group.timesheets``. The inbox
  // list query is filtered (by status, client, search) and may not
  // contain all the pills for the email — without this re-fetch the
  // cascade would skip pills hidden by the active filter, leaving
  // some sibling weeks without the new client.
  const cascadeClientAcrossEmail = React.useCallback(
    async (
      primaryId: number,
      clientId: number,
      emailId: number | null,
    ) => {
      const targets = new Set<number>([primaryId]);
      if (emailId !== null) {
        try {
          const allSiblings = await ingestionAPI.listTimesheets({ email_id: emailId, limit: 200 });
          for (const sibling of allSiblings.data) {
            if (sibling.id === primaryId) continue;
            if (sibling.status === 'approved' || sibling.status === 'rejected') continue;
            targets.add(sibling.id);
          }
        } catch {
          // Fall back to single-row update if the sibling fetch fails.
          // Better one row right than zero rows updated.
        }
      }
      await Promise.all(
        [...targets].map((id) =>
          updateTimesheet.mutateAsync({ id, data: { client_id: clientId } }).catch(() => null),
        ),
      );
    },
    [updateTimesheet],
  );
  // Use the assignable-users endpoint (full tenant list, reviewer-
  // permissive) so the inbox card employee picker matches what's
  // available in the review panel. Without this, managers see only
  // their direct-report chain on the card picker but every tenant
  // user inside the review panel — an inconsistency that prevents
  // reassigning a misattributed timesheet from the card view.
  const { data: users = [] } = useAssignableUsers();
  // Which row has an inline picker open: { id, kind: 'client'|'employee' }
  const [inlinePicker, setInlinePicker] = React.useState<{ id: number; kind: 'client' | 'employee' } | null>(null);
  // When the reviewer clicks "+ Create new client" in the inline picker, we
  // reveal an editable name field prefilled with the AI suggestion (or the
  // smart-guess from the sender's domain). The user can keep, edit, or
  // replace it. Nothing is created until they confirm via "Create & assign".
  // Keyed by timesheet id so multiple rows can stay in different states.
  const [creatingClientFor, setCreatingClientFor] = React.useState<number | null>(null);
  const [createClientDraftName, setCreateClientDraftName] = React.useState('');
  // Multi-period rows render as a parent card with per-week children
  // tucked underneath; expansion state lives here, keyed by group key.
  const [expandedGroups, setExpandedGroups] = React.useState<Set<string>>(new Set());
  const toggleExpanded = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // View mode: "cards" or "table". Persisted server-side via
  // users.preferences.inbox_view_mode so the choice follows the user
  // across browsers. localStorage is the fast-path fallback used until
  // the preferences hook resolves on first paint.
  const VIEW_MODE_STORAGE_KEY = 'inbox.viewMode';
  const { data: preferences } = useMyPreferences();
  const updatePreferences = useUpdateMyPreferences();
  const [viewMode, setViewMode] = React.useState<'cards' | 'table'>(() => {
    if (typeof window === 'undefined') return 'cards';
    try {
      const raw = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
      return raw === 'table' ? 'table' : 'cards';
    } catch {
      return 'cards';
    }
  });
  // Hydrate from server prefs once they arrive (server wins over local).
  React.useEffect(() => {
    if (!preferences) return;
    const serverMode = preferences['inbox_view_mode'];
    if (serverMode === 'cards' || serverMode === 'table') {
      setViewMode(serverMode);
      try { window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, serverMode); } catch { /* quota / private mode - swallow */ }
    }
  }, [preferences]);
  const handleSetViewMode = (mode: 'cards' | 'table') => {
    setViewMode(mode);
    try { window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode); } catch { /* swallow */ }
    // Fire-and-forget server persistence so the choice follows the user
    // to other browsers/devices. We don't await; a failed PATCH keeps
    // the local state, the next session re-reads from preferences.
    updatePreferences.mutate({ inbox_view_mode: mode });
  };
  const queryClient = useQueryClient();
  const triggerFetch = useTriggerFetchEmails();
  const cancelFetch = useCancelFetchEmails();
  // GET /mailboxes is admin-only on the backend. Gating the hook on
  // useIsAdmin() avoids the 403 noise managers see in the console.
  // Trade-off: non-admins no longer see "Last fetched <ts>" in the
  // header. A proper backend fix (allow managers with can_review to
  // read mailbox metadata) would restore that — but the permission
  // layer is currently scoped out, so this is the minimal fix.
  const isAdmin = useIsAdmin();
  const { data: mailboxes = [] } = useMailboxes(isAdmin);
  const lastFetchedAt = React.useMemo(() => {
    const stamps = mailboxes
      .map((m) => m.last_fetched_at)
      .filter((s): s is string => Boolean(s))
      .map((s) => new Date(s).getTime())
      .filter((n) => Number.isFinite(n));
    if (stamps.length === 0) return null;
    return new Date(Math.max(...stamps));
  }, [mailboxes]);
  const reprocessSkipped = useReprocessSkippedEmails();
  const promoteSkipped = usePromoteSkippedEmail();
  const confirmSkipped = useConfirmSkippedEmail();
  const reprocessEmail = useReprocessIngestionEmail();
  const deleteEmail = useDeleteIngestedEmail();
  const [deletingEmailId, setDeletingEmailId] = useState<number | null>(null);
  const bulkReprocessEmails = useBulkReprocessEmails();
  const bulkDeleteEmails = useBulkDeleteIngestedEmails();
  const { data: fetchStatus } = useFetchJobStatus(activeJobId, Boolean(activeJobId));

  // When job completes, refresh the inbox and skipped lists
  React.useEffect(() => {
    if (fetchStatus?.status === 'complete') {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'skipped-emails'] });
      setStatusTone('success');
      setStatusMessage(fetchStatus.message || 'Fetch complete.');
      setActiveJobId(null);
    } else if (fetchStatus?.status === 'failed') {
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'skipped-emails'] });
      setStatusTone('danger');
      setStatusMessage(fetchStatus.message || 'Fetch job failed.');
      setActiveJobId(null);
    }
  }, [fetchStatus?.status, fetchStatus?.message, queryClient]);
  const { data: clients = [] } = useClients();

  // Pre-fill with an existing-client fuzzy match, else the smart-guess.
  const cascadeInitialValue = React.useMemo(() => {
    if (!cascadePopover) return '';
    const guess = suggestNameFromDomain(cascadePopover.domain);
    const guessLower = guess.toLowerCase();
    if (!guessLower) return guess;
    const list = clients as Array<{ id: number; name: string }>;
    const fuzzy = list.find((c) => {
      const name = (c.name || '').toLowerCase();
      return (
        name === guessLower
        || name.startsWith(guessLower + ' ')
        || name.endsWith(' ' + guessLower)
        || name.includes(' ' + guessLower + ' ')
      );
    });
    return fuzzy ? fuzzy.name : guess;
  }, [cascadePopover, clients]);
  // Surface classifier-rejected emails too: the reviewer needs to see
  // what the LLM dropped so a misclassified timesheet doesn't disappear
  // silently. The Skipped tab handles promote/confirm actions.
  const { data: skippedOverview, isLoading: skippedLoading } = useSkippedEmails(50, true, true);
  // Cap raised from 200 to 1000 so the inbox doesn't silently truncate
  // older rows once a tenant accumulates more than a couple of hundred
  // timesheets. Proper pagination is the longer-term fix; this is the
  // immediate unblock. Backend cap (`/ingestion/timesheets?limit=`)
  // raised to match.
  // When a fetch job is actively running, poll the inbox lists so newly
  // ingested rows show up live in the Review queue rather than after
  // the user navigates away and back. The hook no-ops the polling when
  // the flag is false, so the cost is zero when no job is in flight.
  const isFetchingLive =
    Boolean(activeJobId)
    && (fetchStatus?.status === 'queued' || fetchStatus?.status === 'in_progress');
  const { data: allTimesheets = [], isLoading: countsLoading } = useIngestionTimesheets(
    { limit: 1000 },
    true,
    isFetchingLive,
  );
  const { data: timesheets = [], isLoading } = useIngestionTimesheets(
    {
      status_filter: statusFilter || undefined,
      client_id: clientId ? Number(clientId) : undefined,
      search: search.trim() || undefined,
      limit: 1000,
    },
    true,
    isFetchingLive,
  );

  const isPageLoading = isLoading || countsLoading || skippedLoading;
  const actionableSkippedEmails = React.useMemo(() => {
    const rows = skippedOverview?.emails ?? [];
    return rows.filter(isActionableSkippedEmail);
  }, [skippedOverview]);
  const skippedGroups = React.useMemo(
    () => actionableSkippedEmails.map(buildSkippedRowGroup),
    [actionableSkippedEmails],
  );
  const allGroups = React.useMemo(
    // Include rejected rows here so the per-tab count badge for
    // 'Rejected' stays accurate. The display tabs further down decide
    // whether to actually render rejected rows.
    () => [...buildRowGroups(allTimesheets, { includeRejected: true }), ...skippedGroups],
    [allTimesheets, skippedGroups],
  );
  const groups = React.useMemo(() => {
    // Include rejected rows only when the reviewer is explicitly on
    // the Rejected tab. Otherwise the inbox row aggregates (count,
    // total hours, week span) shouldn't be inflated by pills the
    // reviewer already dismissed as duplicates.
    const baseGroups = buildRowGroups(timesheets, { includeRejected: statusFilter === 'rejected' });
    // Skipped rows aren't filtered server-side, so mirror the client-side
    // status/search/client filters here to keep the table consistent.
    const searchLower = search.trim().toLowerCase();
    const skippedVisible = skippedGroups.filter((group) => {
      if (statusFilter && statusFilter !== 'skipped') return false;
      if (clientId) return false; // skipped emails have no client
      if (!searchLower) return true;
      const email = group.skipped;
      return (
        (email?.subject ?? '').toLowerCase().includes(searchLower) ||
        (email?.sender_email ?? '').toLowerCase().includes(searchLower) ||
        (email?.sender_name ?? '').toLowerCase().includes(searchLower)
      );
    });
    // When the 'skipped' tab is active, only show skipped rows.
    if (statusFilter === 'skipped') return skippedVisible;
    return [...baseGroups, ...skippedVisible];
  }, [timesheets, skippedGroups, statusFilter, clientId, search]);
  const statusCounts = React.useMemo(() => countStatuses(allGroups), [allGroups]);
  const skippedCount = statusCounts.skipped ?? 0;

  // Persist the dismissed-at count per tenant so the banner stays dismissed
  // across refreshes, but reappears once more emails land in the skipped pile
  // than the user last acknowledged. We only read/write localStorage on the
  // client, and we guard against SSR / disabled storage.
  const tenantScopeKey = user?.tenant_id != null ? `inbox.skippedBannerDismissedCount.${user.tenant_id}` : null;
  const [dismissedSkippedCount, setDismissedSkippedCount] = React.useState<number>(() => {
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
        // Storage quota / private-mode — banner will simply re-show next load.
      }
    }
  }, [skippedCount, tenantScopeKey]);
  const showSkippedBanner =
    skippedCount > 0 &&
    skippedCount > dismissedSkippedCount &&
    statusFilter !== 'skipped';

  const fetchDiagnostics = React.useMemo<FetchMessageDiagnostic[]>(() => {
    const diagnostics = fetchStatus?.result && typeof fetchStatus.result === 'object' && 'message_diagnostics' in fetchStatus.result
      ? fetchStatus.result.message_diagnostics
      : [];
    if (!Array.isArray(diagnostics)) return [];
    return diagnostics
      .filter((item): item is FetchMessageDiagnostic => Boolean(item && typeof item === 'object'))
      .filter(isActionableDiagnostic)
      .slice(0, 8);
  }, [fetchStatus]);

  // Clear bulk selection when the underlying data refreshes
  React.useEffect(() => {
    setSelectedEmailIds(new Set());
  }, [timesheets]);

  // === Inbox view restoration on return from the Review panel ===
  //
  // Goal: when a reviewer opens row N and clicks "Back to inbox", they
  // come back to the same row scrolled into view (or, if the row was
  // approved and is no longer in the filter result, the same scroll
  // position they had). Filters / search / status tab are also
  // restored. State lives in sessionStorage keyed by tenant id and is
  // age-limited to 30 minutes (see utils/inboxViewState.ts).
  //
  // Two effects:
  //   (1) Hydrate filter inputs once on first mount. Runs before the
  //       list query fires so the request uses the saved filters.
  //   (2) After the list resolves, scroll to the saved row (and apply
  //       a brief highlight) OR fall back to the saved scrollY if the
  //       row is gone. The fallback matches the "Option B" decision
  //       captured during design — preserve the user's place in the
  //       list over forcing them back to the top.
  //
  // We persist on every row-open (handled below in openReview), so the
  // state is fresh by the time the user clicks "Back to inbox."
  const inboxHydratedRef = React.useRef(false);
  const inboxRestoredRef = React.useRef(false);
  // Hydrate filter state from sessionStorage on first mount.
  React.useEffect(() => {
    if (inboxHydratedRef.current) return;
    if (user?.tenant_id == null) return;
    inboxHydratedRef.current = true;
    const saved = readInboxViewState(user.tenant_id);
    if (!saved) return;
    setStatusFilter(saved.statusFilter);
    setClientId(saved.clientId);
    setSearch(saved.search);
  }, [user?.tenant_id]);

  // Restore scroll position / highlight the saved row once the list
  // resolves. Guarded by a one-shot ref so a later list refetch (e.g.
  // background polling during a fetch job) doesn't keep snapping the
  // user's scroll around.
  React.useEffect(() => {
    if (inboxRestoredRef.current) return;
    // Wait until BOTH effects above have run AND the page is no longer
    // loading. Otherwise we'd try to scroll an empty list.
    if (!inboxHydratedRef.current) return;
    if (isPageLoading) return;
    if (user?.tenant_id == null) return;
    const saved = readInboxViewState(user.tenant_id);
    if (!saved) {
      inboxRestoredRef.current = true;
      return;
    }
    inboxRestoredRef.current = true;
    // Defer one frame so the rendered DOM matches the just-resolved
    // list state. Without this, the `data-row-key` we want to query
    // may not yet be in the document.
    window.requestAnimationFrame(() => {
      let scrolledToRow = false;
      if (saved.activeRowKey) {
        scrolledToRow = scrollAndHighlightRow(saved.activeRowKey);
      }
      if (!scrolledToRow) {
        // Option B fallback: the saved row isn't visible (probably it
        // was approved and the filter is `pending`, etc.). Land the
        // user at the same scroll Y they had so neighboring rows are
        // recognizable rather than snapping to the top.
        window.scrollTo({ top: saved.scrollY, behavior: 'auto' });
      }
      // One-shot: drop the persisted state after consuming so a full
      // page reload (or a fresh visit later in the day) doesn't get
      // surprised by stale filter values.
      clearInboxViewState(user.tenant_id);
    });
  }, [isPageLoading, user?.tenant_id, groups.length]);

  // Persist the current inbox view when the reviewer clicks a row to
  // open the Review panel. Stamps the scrollY at click time so the
  // restore can land them exactly where they left off.
  const persistInboxView = React.useCallback(
    (rowKey: string) => {
      if (user?.tenant_id == null) return;
      writeInboxViewState(user.tenant_id, {
        statusFilter,
        clientId,
        search,
        scrollY: typeof window !== 'undefined' ? window.scrollY : 0,
        activeRowKey: rowKey,
      });
    },
    [user?.tenant_id, statusFilter, clientId, search],
  );

  // Collect unique email_ids from currently visible groups
  const allVisibleEmailIds = React.useMemo(
    () => [...new Set(groups.map((group) => group.primary.email_id))],
    [groups],
  );

  if (isPageLoading) {
    return <Loading message="Loading reviewer inbox..." />;
  }

  const isFetchRunning = Boolean(
    activeJobId && fetchStatus && (fetchStatus.status === 'queued' || fetchStatus.status === 'in_progress'),
  );
  const isBusy =
    triggerFetch.isPending ||
    isFetchRunning ||
    reprocessSkipped.isPending ||
    reprocessEmail.isPending ||
    deleteEmail.isPending ||
    bulkReprocessEmails.isPending ||
    bulkDeleteEmails.isPending;

  // Pending count for a given domain across the currently visible groups.
  // Personal-domain groups are excluded since they don't participate in the
  // cascade (the backend rejects gmail/outlook/etc. with 422).
  const cascadePendingCount = (domain: string): number => {
    const target = domain.trim().toLowerCase();
    if (!target) return 0;
    return groups.reduce((accumulator, group) => {
      if (group.kind === 'skipped') return accumulator;
      if (group.primary.client_id != null) return accumulator;
      if (domainOf(group.primary.sender_email) !== target) return accumulator;
      return accumulator + 1;
    }, 0);
  };

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
      // 409 conflict: the domain is already mapped to another client. Surface
      // the existing-client info to the reviewer so they can decide.
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const detail = error.response.data?.detail as
          | { message?: string; existing_client_name?: string }
          | undefined;
        setStatusTone('danger');
        setStatusMessage(
          detail?.message
            || (detail?.existing_client_name
              ? `Domain '${domain}' is already mapped to '${detail.existing_client_name}'.`
              : `Domain '${domain}' is already mapped to another client.`),
        );
        return;
      }
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, 'Unable to assign client from domain.'));
    }
  };

  const handleBulkReprocess = async () => {
    const ids = [...selectedEmailIds];
    if (ids.length === 0) return;
    if (!window.confirm(`Try processing ${ids.length} email(s) again? This will re-read the timesheets and try to match them.`)) return;
    try {
      const result = await bulkReprocessEmails.mutateAsync(ids);
      setSelectedEmailIds(new Set());
      setStatusTone('success');
      setStatusMessage(`Queued ${result.queued} email(s) for reprocessing.`);
    } catch {
      setStatusTone('danger');
      setStatusMessage('Failed to queue bulk reprocess.');
    }
  };

  const handleFetch = async () => {
    try {
      const response = await triggerFetch.mutateAsync();
      setActiveJobId(response.job_id);
      setStatusTone('info');
      setStatusMessage(response.message || 'Fetch job queued for this tenant.');
    } catch (error) {
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, 'Unable to start fetch job.'));
    }
  };

  const handleReprocessSkipped = async () => {
    if (!window.confirm('Try again on every skipped email? This keeps the emails in place and re-reads them.')) {
      return;
    }

    try {
      const response = await reprocessSkipped.mutateAsync();
      setActiveJobId(response.job_id);
      setStatusTone('info');
      setStatusMessage('Queued stored skipped emails for reprocessing.');
    } catch (error) {
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, 'Unable to reprocess skipped emails.'));
    }
  };

  const handleReprocessEmail = async (emailId: number, attachmentIds?: number[]) => {
    try {
      const response = await reprocessEmail.mutateAsync({ emailId, attachmentIds });
      setActiveJobId(response.job_id);
      setStatusTone('info');
      setStatusMessage(
        response.mode === 'reprocess_attachments'
          ? 'Queued attachment-only reprocessing.'
          : 'Queued email reprocessing.',
      );
    } catch (error) {
      setStatusTone('danger');
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        setStatusMessage('That inbox item is no longer available. The list has been refreshed.');
        return;
      }
      setStatusMessage(getApiErrorMessage(error, 'Unable to queue reprocessing.'));
    }
  };

  const handlePromoteSkipped = async (emailId: number, subject?: string | null) => {
    try {
      const result = await promoteSkipped.mutateAsync(emailId);
      setStatusTone('success');
      setStatusMessage(
        result.already_promoted
          ? `"${subject || '(no subject)'}" was already in the review queue.`
          : `"${subject || '(no subject)'}" added to the review queue. Open it to fill in the details.`,
      );
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

  const handleDeleteEmail = async (emailId: number, subject?: string | null, refetch: boolean = false) => {
    const action = refetch ? 'Delete & re-fetch' : 'Delete';
    const suffix = refetch ? ' The next Fetch Emails will re-ingest it.' : ' This does not remove the original mailbox email.';
    if (!window.confirm(`${action} "${subject || '(no subject)'}" from this application?${suffix}`)) {
      return;
    }
    setDeletingEmailId(emailId);
    try {
      await deleteEmail.mutateAsync({ emailId, refetch });
      if (refetch) {
        setStatusTone('info');
        setStatusMessage('Email removed. Fetching fresh copy from mailbox...');
        try {
          const response = await triggerFetch.mutateAsync();
          setActiveJobId(response.job_id);
        } catch {
          setStatusTone('success');
          setStatusMessage('Email removed. Auto-fetch failed. Click "Fetch Emails" to re-process manually.');
        }
      } else {
        setStatusTone('success');
        setStatusMessage('Removed the email and its timesheets.');
      }
    } catch (error) {
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, 'Unable to delete stored email.'));
    } finally {
      setDeletingEmailId(null);
    }
  };

  const toggleEmailId = (emailId: number) => {
    setSelectedEmailIds((prev) => {
      const next = new Set(prev);
      if (next.has(emailId)) {
        next.delete(emailId);
      } else {
        next.add(emailId);
      }
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedEmailIds(new Set(allVisibleEmailIds));
  };

  const clearSelection = () => {
    setSelectedEmailIds(new Set());
  };

  const handleBulkDelete = async () => {
    const ids = [...selectedEmailIds];
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} email(s) and all their timesheets from this application?`)) {
      return;
    }
    // Second prompt: should we rewind each affected mailbox's fetch
    // cursor so the next Fetch Emails re-ingests these? Without this,
    // deleted emails stay gone from the app until someone resets the
    // mailbox cursor by hand.
    const refetch = window.confirm(
      `Also rewind the mailbox so the next Fetch Emails will re-process these ${ids.length} email(s)?\n\n` +
        'Click OK to re-fetch on the next sync. Click Cancel to delete only.'
    );
    try {
      const result = await bulkDeleteEmails.mutateAsync({ emailIds: ids, refetch });
      setSelectedEmailIds(new Set());
      setStatusTone('success');
      if (refetch && result.cursors_rewound > 0) {
        setStatusMessage(
          `Deleted ${ids.length} email(s). ${result.cursors_rewound} mailbox cursor(s) rewound — these will re-ingest on the next Fetch Emails.`
        );
      } else {
        setStatusMessage(`Deleted ${ids.length} email(s) and their timesheets.`);
      }
    } catch (error) {
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, 'Unable to bulk delete emails.'));
    }
  };

  const progress = Math.max(0, Math.min(100, Number(fetchStatus?.progress ?? 0)));
  // Staleness detection (audit F-04): if updated_at hasn't moved in
  // longer than the backend's lock TTL, the worker likely crashed and
  // the UI would otherwise spin until the 24h Redis TTL expires.
  // Helper isolates the logic for unit testability.
  const fetchStatusIsStale = isFetchJobStale(fetchStatus, Boolean(activeJobId));
  const fetchStatusTone =
    fetchStatusIsStale ? 'danger' :
    fetchStatus?.status === 'complete' ? 'success' : fetchStatus?.status === 'failed' ? 'danger' : 'info';
  const showStandaloneStatusMessage =
    Boolean(statusMessage) &&
    (!fetchStatus || fetchStatus.status === 'not_found' || statusTone !== 'info');
  const locationBanner =
    typeof location.state === 'object' && location.state !== null && 'banner' in location.state && typeof location.state.banner === 'string'
      ? location.state.banner
      : null;
  const hasAnyQueueItems = allGroups.length > 0;
  const hasActiveFilters = Boolean(statusFilter || clientId || search.trim());
  const showFilters = hasAnyQueueItems || hasActiveFilters;
  const fetchStatusMessage = getFriendlySystemMessage(fetchStatus?.message, 'Starting up...');
  const rawFetchStatusMessage = fetchStatus?.message || '';
  const hasTechnicalDetails = Boolean(rawFetchStatusMessage) && rawFetchStatusMessage !== fetchStatusMessage;
  const showActivityStrip =
    (activeJobId && fetchStatus && fetchStatus.status !== 'not_found') ||
    showStandaloneStatusMessage ||
    Boolean(locationBanner) ||
    fetchDiagnostics.length > 0;
  const clearFilters = () => {
    setStatusFilter('');
    setClientId('');
    setSearch('');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-start">
        <div>
          <h1 className="text-[20px] font-semibold text-foreground">Inbox</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Review and process incoming timesheets.
            {lastFetchedAt && (
              <>
                {' '}<span className="text-muted-foreground/80">· Last fetched {lastFetchedAt.toLocaleString()}</span>
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {canSeeTeamTimesheets && (
            <button
              type="button"
              onClick={() => navigate('/approvals?tab=approved')}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm hover:bg-muted transition"
              title="Open the Approved Timesheets tab"
            >
              <Users className="h-4 w-4" />
              Approved Timesheets
            </button>
          )}
          <button
            type="button"
            onClick={handleFetch}
            className="action-button"
            disabled={isBusy}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${(triggerFetch.isPending || isFetchRunning) ? 'animate-spin' : ''}`} />
            {triggerFetch.isPending ? 'Starting Fetch...' : isFetchRunning ? 'Fetching Emails...' : 'Fetch Emails'}
          </button>
        </div>
      </div>

      {showActivityStrip ? (
        <section className="surface-card px-5 py-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="flex-1 space-y-2">

              {activeJobId && fetchStatus && fetchStatus.status !== 'not_found' ? (
                <div className="flex items-center gap-3">
                  <Badge tone={fetchStatusTone} className="normal-case tracking-normal">
                    {fetchStatusIsStale ? 'Stalled' :
                     fetchStatus.status === 'queued' ? 'Queued' :
                     fetchStatus.status === 'in_progress' ? 'Processing' :
                     fetchStatus.status === 'complete' ? 'Complete' :
                     fetchStatus.status === 'failed' ? 'Failed' :
                     fetchStatus.status}
                  </Badge>
                  <span className="text-sm text-foreground">{fetchStatusMessage}</span>
                  {(fetchStatus.status === 'queued' || fetchStatus.status === 'in_progress') && !fetchStatusIsStale ? (
                    <div className="flex items-center gap-2 flex-1 max-w-sm">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-background">
                        <div className="h-full rounded-full bg-primary/60 transition-all duration-300" style={{ width: `${progress}%` }} />
                      </div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatFetchProgressText(fetchStatus, progress)}
                      </span>
                    </div>
                  ) : null}
                  {(fetchStatus.status === 'queued' || fetchStatus.status === 'in_progress') && activeJobId ? (
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
                      {cancelFetch.isPending ? 'Cancelling...' : 'Cancel'}
                    </button>
                  ) : null}
                </div>
              ) : null}

              {fetchStatusIsStale ? (
                <div className="rounded-lg border border-amber-300/40 bg-amber-500/5 px-4 py-2.5">
                  <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                    This fetch hasn&apos;t updated in over 6 minutes.
                  </p>
                  <p className="mt-1 text-xs text-amber-700/80 dark:text-amber-300/80">
                    The worker likely crashed. Click &quot;Fetch Emails&quot; again to start a fresh run; any
                    emails already processed are saved.
                  </p>
                  <button
                    type="button"
                    onClick={() => { setActiveJobId(null); }}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-amber-300/40 bg-transparent px-3 py-1 text-xs font-semibold text-amber-700 transition hover:bg-amber-500/10 dark:text-amber-300"
                  >
                    Dismiss stalled status
                  </button>
                </div>
              ) : null}

              {locationBanner ? (
                <p className="text-sm text-emerald-700">{locationBanner}</p>
              ) : null}

              {showStandaloneStatusMessage ? (
                <div>
                  <p className="text-sm font-semibold text-foreground">{getStatusHeading(statusTone)}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{statusMessage}</p>
                </div>
              ) : null}
            </div>

            {(fetchStatus?.result || fetchDiagnostics.length > 0) ? (
              <div className="min-w-[220px] space-y-2 rounded-2xl border border-border/60 bg-background px-4 py-2.5">
                {fetchStatus?.result ? (
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div>
                      <p className="text-lg font-semibold text-foreground">{String(fetchStatus.result.total_fetched ?? 0)}</p>
                      <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Fetched</p>
                    </div>
                    <div>
                      <p className="text-lg font-semibold text-foreground">{String(fetchStatus.result.total_timesheets_created ?? 0)}</p>
                      <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Staged</p>
                    </div>
                    <div>
                      <p className="text-lg font-semibold text-foreground">{String(fetchStatus.result.total_skipped ?? 0)}</p>
                      <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Skipped</p>
                    </div>
                  </div>
                ) : null}
                {fetchDiagnostics.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowDiagnostics((current) => !current)}
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

      {showDiagnostics && fetchDiagnostics.length > 0 ? (
        <section className="surface-card px-5 py-4">
          <div className="space-y-2">
            {fetchDiagnostics.map((message, index) => {
              const canInspect = Boolean(message.email_id);
              return (
                <div
                  key={`${message.email_id ?? message.message_id ?? 'message'}-${index}`}
                  className={[
                    'rounded-2xl border border-border/50 bg-white/[0.02] px-4 py-3 transition',
                    canInspect ? 'cursor-pointer hover:border-amber-300/30 hover:bg-white/[0.04]' : '',
                  ].join(' ')}
                  onClick={() => {
                    if (!message.email_id) return;
                    navigate(`/ingestion/email/${message.email_id}`);
                  }}
                  onKeyDown={(event) => {
                    if (!message.email_id) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      navigate(`/ingestion/email/${message.email_id}`);
                    }
                  }}
                  role={canInspect ? 'button' : undefined}
                  tabIndex={canInspect ? 0 : -1}
                >
                  <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="font-medium text-foreground">{message.subject || 'No subject'}</p>
                      <p className="text-sm text-muted-foreground">{message.sender_email || 'Unknown sender'}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {message.skipped ? (
                        <Badge tone="warning" className="normal-case tracking-normal">
                          {prettifySkipReason(message.skip_reason)}
                        </Badge>
                      ) : (
                        <Badge tone="success" className="normal-case tracking-normal">
                          {message.timesheets_created ? `${message.timesheets_created} timesheet${message.timesheets_created === 1 ? '' : 's'}` : 'Processed'}
                        </Badge>
                      )}
                    </div>
                  </div>
                  {message.skip_detail ? <p className="mt-2 text-sm text-muted-foreground">{message.skip_detail}</p> : null}
                  {message.errors?.length ? <p className="mt-2 text-sm text-amber-700">{message.errors[0]}</p> : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {showSkippedBanner ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="skipped-emails-banner"
          className="surface-card flex flex-wrap items-center justify-between gap-3 border-amber-300/30 bg-amber-500/5 px-5 py-3"
        >
          <div className="text-sm text-foreground">
            <span className="font-medium">{skippedCount}</span>{' '}
            {skippedCount === 1 ? "email couldn't be processed" : "emails couldn't be processed"}.{' '}
            <button
              type="button"
              className="font-medium text-primary underline-offset-4 hover:underline"
              onClick={() => setStatusFilter('skipped')}
            >
              View skipped
            </button>{' '}
            to reprocess individually, or reprocess them all now.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleReprocessSkipped()}
              disabled={isBusy}
              className="action-button-secondary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Try again on {skippedCount} skipped
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

      <section className="surface-card overflow-hidden">
        <div className="border-b border-border/70 px-5 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-base font-semibold text-foreground">Review queue</h2>
                <Badge tone="outline" className="normal-case tracking-normal">
                  {groups.length} showing
                </Badge>
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
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === 'cards'}
                  onClick={() => handleSetViewMode('cards')}
                  className={[
                    'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition',
                    viewMode === 'cards'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  ].join(' ')}
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                  Cards
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === 'table'}
                  onClick={() => handleSetViewMode('table')}
                  className={[
                    'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition',
                    viewMode === 'table'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  ].join(' ')}
                >
                  <Rows className="h-3.5 w-3.5" />
                  Table
                </button>
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
                    className={[
                      'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition',
                      active
                        ? 'bg-[var(--accent-light)] text-primary'
                        : 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
                    ].join(' ')}
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
                  disabled={isBusy}
                  data-testid="reprocess-all-skipped"
                  className="ml-auto action-button-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Try again on {skippedCount} skipped
                </button>
              ) : null}
            </div>

            <div className="flex flex-col gap-3 md:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  className="field-input pl-11"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search by sender or subject..."
                />
              </div>
              <select className="field-input md:max-w-xs" value={clientId} onChange={(event) => setClientId(event.target.value)}>
                <option value="">All Clients</option>
                {clients.map((client: { id: number; name: string }) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}

        {selectedEmailIds.size > 0 && (
          <div className="border-b border-border/70 px-5 py-3">
            <div className="flex items-center justify-between gap-4 rounded-lg border border-primary/20 bg-primary/5 px-4 py-2.5">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-foreground">
                  {selectedEmailIds.size} email{selectedEmailIds.size !== 1 ? 's' : ''} selected
                </span>
                {selectedEmailIds.size < allVisibleEmailIds.length && (
                  <button type="button" onClick={selectAllVisible} className="text-xs font-medium text-primary hover:text-primary/80 transition">
                    Select all {allVisibleEmailIds.length}
                  </button>
                )}
                <button type="button" onClick={clearSelection} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition">
                  Clear
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleBulkReprocess}
                  disabled={isBusy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition hover:bg-primary/20 disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${bulkReprocessEmails.isPending ? 'animate-spin' : ''}`} />
                  {bulkReprocessEmails.isPending ? 'Queueing...' : `Try again on ${selectedEmailIds.size}`}
                </button>
                <button
                  type="button"
                  onClick={handleBulkDelete}
                  disabled={isBusy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-destructive/90 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {bulkDeleteEmails.isPending ? 'Deleting...' : `Delete ${selectedEmailIds.size}`}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          {groups.length === 0 ? (
            <div className="px-6 py-12">
              <div className="mx-auto max-w-xl rounded-3xl border border-dashed border-border/70 bg-card/60 px-8 py-12 text-center">
                <p className="text-lg font-semibold text-foreground">
                  {hasActiveFilters ? 'No timesheets match the current filters.' : 'No timesheets to review.'}
                </p>
                <p className="mt-3 text-sm text-muted-foreground">
                  {hasActiveFilters
                    ? 'Clear the current filters to return to the full review queue.'
                    : 'Fetch new emails to bring in new timesheets, or review skipped emails if any need attention.'}
                </p>
                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  {!hasActiveFilters ? (
                    <button type="button" onClick={handleFetch} className="action-button" disabled={isBusy}>
                      <RefreshCw className={`mr-2 h-4 w-4 ${(triggerFetch.isPending || isFetchRunning) ? 'animate-spin' : ''}`} />
                      {triggerFetch.isPending ? 'Starting Fetch...' : isFetchRunning ? 'Fetching Emails...' : 'Fetch Emails'}
                    </button>
                  ) : null}
                  {hasActiveFilters ? (
                    <button type="button" onClick={clearFilters} className="action-button-secondary">
                      Reset filters
                    </button>
                  ) : null}
                </div>
              </div>
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
                      onChange={(event) => {
                        if (event.target.checked) {
                          selectAllVisible();
                        } else {
                          clearSelection();
                        }
                      }}
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
                  <th className="px-4 py-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const isSkipped = group.kind === 'skipped';
                  const isMultiPeriod = group.periods > 1;
                  const rowTarget = group.primary;
                  const canOpenReview = isSkipped
                    ? Boolean(group.skipped?.id)
                    : Number.isInteger(rowTarget.id) && rowTarget.id > 0;
                  const openReview = () => {
                    persistInboxView(group.key);
                    if (isSkipped && group.skipped) {
                      navigate(`/ingestion/email/${group.skipped.id}`);
                    } else if (canOpenReview) {
                      navigate(`/ingestion/review/${rowTarget.id}`);
                    }
                  };

                  return (
                    <React.Fragment key={group.key}>
                      <tr
                        data-row-key={group.key}
                        className={`group h-11 transition hover:bg-muted ${canOpenReview ? 'cursor-pointer' : 'cursor-default'}`}
                        onClick={() => openReview()}
                      >
                        <td className="w-10 px-2 py-5 align-top">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-border accent-primary"
                            checked={selectedEmailIds.has(rowTarget.email_id)}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => toggleEmailId(rowTarget.email_id)}
                          />
                        </td>
                        <td className="px-4 py-5 align-top">
                          <div className="group/sender flex min-w-[180px] items-start gap-3">
                            <div
                              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold uppercase tracking-wide text-slate-100 ring-1 ring-inset ring-white/5 dark:ring-white/10"
                              style={{ background: 'linear-gradient(135deg, #334155, #1e293b)' }}
                              aria-hidden="true"
                            >
                              {getInitials(rowTarget.sender_name, rowTarget.sender_email)}
                            </div>
                            <div className="min-w-0">
                              <p className="font-semibold text-foreground">
                                {rowTarget.sender_name || rowTarget.sender_email || 'Unknown sender'}
                                {rowTarget.is_likely_resubmission && (
                                  <span
                                    className="inline-flex px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 ml-1"
                                    title="A rejected submission from this sender exists for a similar period. Review and delete the old rejected record after approving this one."
                                  >
                                    Possible resubmission
                                  </span>
                                )}
                              </p>
                              <p
                                className="mt-1 max-h-0 overflow-hidden font-mono text-xs text-muted-foreground opacity-0 transition-all duration-150 group-hover:max-h-6 group-hover:opacity-100 group-focus-within:max-h-6 group-focus-within:opacity-100"
                              >
                                {rowTarget.sender_email || '--'}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-5 align-top">
                          <div className="min-w-[200px] space-y-2">
                            <p className="font-medium text-foreground" title={rowTarget.subject ?? undefined}>{rowTarget.subject || 'No subject'}</p>
                            {isMultiPeriod ? (
                              <span className="inline-flex items-center rounded-full border border-blue-400/40 bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300">
                                {group.periods} weeks
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-4 py-5 align-top whitespace-nowrap">
                          <Badge tone={getStatusTone(group.status)} className="normal-case tracking-normal whitespace-nowrap">
                            {statusLabel(group.status)}
                          </Badge>
                        </td>
                        <td className="px-4 py-5 align-top text-sm">
                          {rowTarget.client_name ? (
                            <span className="text-sm text-foreground">{rowTarget.client_name}</span>
                          ) : isSkipped ? (
                            <span className="text-sm text-muted-foreground">--</span>
                          ) : (() => {
                            const senderDomain = domainOf(rowTarget.sender_email);
                            if (!senderDomain || isPersonalDomain(senderDomain)) {
                              const pickerId = rowTarget.id;
                              const isOpen = inlinePicker?.id === pickerId && inlinePicker.kind === 'client';
                              const isCreating = creatingClientFor === pickerId;
                              const suggestedName =
                                rowTarget.extracted_client_name
                                || (senderDomain ? suggestNameFromDomain(senderDomain) : '');
                              const startCreate = () => {
                                setCreateClientDraftName(suggestedName);
                                setCreatingClientFor(pickerId);
                              };
                              const confirmCreate = async () => {
                                const name = createClientDraftName.trim();
                                if (!name) return;
                                const created = await createClient.mutateAsync({ name });
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
                                <div className="flex flex-col gap-1.5 min-w-[200px]" onClick={(e) => e.stopPropagation()}>
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
                                          if (e.key === 'Enter') { e.preventDefault(); void confirmCreate(); }
                                          if (e.key === 'Escape') { e.preventDefault(); cancelCreate(); }
                                        }}
                                        placeholder="Client name"
                                      />
                                      <div className="flex gap-1.5">
                                        <button
                                          type="button"
                                          disabled={createClient.isPending || !createClientDraftName.trim()}
                                          onClick={() => void confirmCreate()}
                                          className="rounded bg-primary px-2 py-1 text-xs font-medium text-white transition hover:bg-primary/90 disabled:opacity-50"
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
                                        {clients.map((c: { id: number; name: string }) => (
                                          <option key={c.id} value={c.id}>{c.name}</option>
                                        ))}
                                      </select>
                                      <button
                                        type="button"
                                        className="text-left text-xs text-primary hover:underline"
                                        onClick={startCreate}
                                      >
                                        {suggestedName
                                          ? `+ Create new client (suggested: "${suggestedName}")`
                                          : '+ Create new client'}
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
                                  onClick={(e) => { e.stopPropagation(); setInlinePicker({ id: pickerId, kind: 'client' }); }}
                                  className="inline-flex items-center gap-1 rounded-md border border-dashed border-amber-400/60 bg-transparent px-2.5 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-500/15 hover:border-amber-400 dark:text-amber-300"
                                  title="Click to assign or create a client"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                  Add client
                                </button>
                              );
                            }
                            const count = cascadePendingCount(senderDomain);
                            return (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setCascadePopover({
                                    domain: senderDomain,
                                    anchorEl: event.currentTarget,
                                  });
                                }}
                                className="inline-flex items-center gap-1 rounded-md border border-dashed border-amber-400/60 bg-transparent px-2.5 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-500/15 hover:border-amber-400 dark:text-amber-300"
                                title={`Create or link a client for ${senderDomain}`}
                              >
                                <Plus className="h-3.5 w-3.5" />
                                Add client from {senderDomain}
                                {count > 1 ? <span className="opacity-60">({count})</span> : null}
                              </button>
                            );
                          })()}
                        </td>
                        <td className="px-4 py-5 align-top">
                          {rowTarget.employee_name || rowTarget.extracted_employee_name ? (
                            <span className="text-sm text-foreground">
                              {cleanEmployeeNameForDisplay(rowTarget.employee_name || rowTarget.extracted_employee_name)}
                            </span>
                          ) : isSkipped ? (
                            <span className="text-sm text-muted-foreground">--</span>
                          ) : (() => {
                            const candidates: ChainCandidate[] = rowTarget.llm_match_suggestions?.chain_candidates ?? [];
                            if (candidates.length > 0) {
                              return (
                                <div className="flex flex-wrap gap-1">
                                  {candidates.map((c, i) => (
                                    <button
                                      key={i}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        assignChainCandidate.mutate({ id: rowTarget.id, data: { name: c.name, email: c.email } });
                                      }}
                                      className="inline-flex items-center rounded-full border border-blue-400/40 bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-500/20 transition-colors"
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
                                  className="h-7 rounded border border-border bg-background px-2 text-xs min-w-[160px]"
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
                                  {users.map((u: { id: number; full_name: string }) => (
                                    <option key={u.id} value={u.id}>{u.full_name}</option>
                                  ))}
                                </select>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setInlinePicker({ id: pickerId, kind: 'employee' }); }}
                                className="inline-flex items-center gap-1 rounded-md border border-dashed border-amber-400/60 bg-transparent px-2.5 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-500/15 hover:border-amber-400 dark:text-amber-300"
                                title="Click to assign an employee"
                              >
                                <Plus className="h-3.5 w-3.5" />
                                Add employee
                              </button>
                            );
                          })()}
                        </td>
                        <td className="px-4 py-5 align-top text-sm text-muted-foreground whitespace-nowrap">
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
                            const ts = rowTarget.received_at || rowTarget.created_at;
                            const stale = !isSkipped && isStaleReceived(ts);
                            const label = formatRelativeReceived(ts);
                            const date = ts ? new Date(ts) : null;
                            const titleAttr = date && !Number.isNaN(date.getTime())
                              ? date.toLocaleString()
                              : undefined;
                            return (
                              <span
                                className={stale ? 'inline-flex items-center gap-1 text-sm font-medium text-amber-700 dark:text-amber-400 whitespace-nowrap' : 'text-sm text-muted-foreground whitespace-nowrap'}
                                title={stale ? `Waiting longer than ${STALE_BUSINESS_DAYS} business days${titleAttr ? ' · ' + titleAttr : ''}` : titleAttr}
                              >
                                {stale && <Clock className="h-3.5 w-3.5 shrink-0" />}
                                {label}
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
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void handlePromoteSkipped(group.skipped!.id, group.skipped!.subject);
                                  }}
                                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-40"
                                  aria-label={`Promote email ${group.skipped.id} to the review queue`}
                                  title="This is a timesheet. Add to review queue."
                                  disabled={isBusy || promoteSkipped.isPending}
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
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
                                  onClick={(event) => {
                                    event.stopPropagation();
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
                              onClick={(event) => {
                                event.stopPropagation();
                                openReview();
                              }}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-foreground transition hover:bg-muted/70"
                              aria-label={isSkipped ? `Open email ${group.skipped?.id}` : `Open submission ${rowTarget.id}`}
                              title="Open"
                              disabled={!canOpenReview}
                            >
                              <ArrowRight className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleDeleteEmail(rowTarget.email_id, rowTarget.subject);
                              }}
                              disabled={isBusy}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                              aria-label={`Delete email ${rowTarget.email_id}`}
                              title="Delete"
                            >
                              {deletingEmailId === rowTarget.email_id
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <Trash2 className="h-4 w-4" />
                              }
                            </button>
                          </div>
                        </td>
                      </tr>

                    </React.Fragment>
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
                const canOpenReview = isSkipped
                  ? Boolean(group.skipped?.id)
                  : Number.isInteger(rowTarget.id) && rowTarget.id > 0;
                const openReview = () => {
                  persistInboxView(group.key);
                  if (isSkipped && group.skipped) {
                    navigate(`/ingestion/email/${group.skipped.id}`);
                  } else if (canOpenReview) {
                    navigate(`/ingestion/review/${rowTarget.id}`);
                  }
                };
                const receivedTs = rowTarget.received_at || rowTarget.created_at;
                const stale = !isSkipped && isStaleReceived(receivedTs);
                const senderDomain = domainOf(rowTarget.sender_email);

                return (
                  <div
                    key={group.key}
                    data-row-key={group.key}
                    data-testid="inbox-card"
                    className={[
                      'rounded-xl border border-border/70 bg-card/40 transition hover:bg-muted hover:border-border-strong/80',
                      isSkipped ? 'border-l-2 border-l-amber-400/60' : '',
                      isFinal ? 'opacity-70 hover:opacity-100' : '',
                    ].join(' ')}
                  >
                    <div
                      className={`flex items-start gap-3 px-4 py-3 ${canOpenReview ? 'cursor-pointer' : ''}`}
                      onClick={() => { if (canOpenReview) openReview(); }}
                    >
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 rounded border-border accent-primary"
                        checked={selectedEmailIds.has(rowTarget.email_id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleEmailId(rowTarget.email_id)}
                        aria-label={`Select email ${rowTarget.email_id}`}
                      />
                      <div
                        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold uppercase tracking-wide text-slate-100 ring-1 ring-inset ring-white/5 dark:ring-white/10"
                        style={{ background: 'linear-gradient(135deg, #334155, #1e293b)' }}
                        aria-hidden="true"
                      >
                        {getInitials(rowTarget.sender_name, rowTarget.sender_email)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="font-semibold text-foreground">
                            {rowTarget.sender_name || rowTarget.sender_email || 'Unknown sender'}
                          </span>
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {rowTarget.sender_email || ''}
                          </span>
                        </div>
                        <p
                          className="mt-0.5 truncate text-sm text-muted-foreground"
                          title={rowTarget.subject ?? undefined}
                        >
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
                            ) : (() => {
                              if (!senderDomain || isPersonalDomain(senderDomain)) {
                                const pickerId = rowTarget.id;
                                const isOpen = inlinePicker?.id === pickerId && inlinePicker.kind === 'client';
                                const isCreating = creatingClientFor === pickerId;
                                const suggestedName =
                                  rowTarget.extracted_client_name
                                  || (senderDomain ? suggestNameFromDomain(senderDomain) : '');
                                const startCreate = () => {
                                  setCreateClientDraftName(suggestedName);
                                  setCreatingClientFor(pickerId);
                                };
                                const confirmCreate = async () => {
                                  const name = createClientDraftName.trim();
                                  if (!name) return;
                                  const created = await createClient.mutateAsync({ name });
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
                                  <div className="flex flex-col gap-1.5 min-w-[200px]" onClick={(e) => e.stopPropagation()}>
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
                                            if (e.key === 'Enter') { e.preventDefault(); void confirmCreate(); }
                                            if (e.key === 'Escape') { e.preventDefault(); cancelCreate(); }
                                          }}
                                          placeholder="Client name"
                                        />
                                        <div className="flex gap-1.5">
                                          <button
                                            type="button"
                                            disabled={createClient.isPending || !createClientDraftName.trim()}
                                            onClick={() => void confirmCreate()}
                                            className="rounded bg-primary px-2 py-1 text-xs font-medium text-white transition hover:bg-primary/90 disabled:opacity-50"
                                          >
                                            {createClient.isPending ? 'Creating…' : 'Create & assign'}
                                          </button>
                                          <button type="button" onClick={cancelCreate} className="rounded border border-border bg-transparent px-2 py-1 text-xs text-muted-foreground transition hover:text-foreground">Back</button>
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
                                          {clients.map((c: { id: number; name: string }) => (
                                            <option key={c.id} value={c.id}>{c.name}</option>
                                          ))}
                                        </select>
                                        <button type="button" className="text-left text-xs text-primary hover:underline" onClick={startCreate}>
                                          {suggestedName ? `+ Create new client (suggested: "${suggestedName}")` : '+ Create new client'}
                                        </button>
                                        <button type="button" className="text-left text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setInlinePicker(null)}>Cancel</button>
                                      </>
                                    )}
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); setInlinePicker({ id: pickerId, kind: 'client' }); }}
                                    className="inline-flex items-center gap-1 rounded-md border border-dashed border-amber-400/60 bg-transparent px-2 py-0.5 text-xs font-medium text-amber-700 transition hover:bg-amber-500/15 hover:border-amber-400 dark:text-amber-300"
                                    title="Click to assign or create a client"
                                  >
                                    <Plus className="h-3 w-3" /> Add client
                                  </button>
                                );
                              }
                              const count = cascadePendingCount(senderDomain);
                              return (
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setCascadePopover({ domain: senderDomain, anchorEl: event.currentTarget });
                                  }}
                                  className="inline-flex items-center gap-1 rounded-md border border-dashed border-amber-400/60 bg-transparent px-2 py-0.5 text-xs font-medium text-amber-700 transition hover:bg-amber-500/15 hover:border-amber-400 dark:text-amber-300"
                                  title={`Create or link a client for ${senderDomain}`}
                                >
                                  <Plus className="h-3 w-3" /> Add client from {senderDomain}
                                  {count > 1 ? <span className="opacity-60">({count})</span> : null}
                                </button>
                              );
                            })()}
                          </div>

                          {/* Employee */}
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] uppercase tracking-[0.4px] text-muted-foreground">Employee</span>
                            {rowTarget.employee_name || rowTarget.extracted_employee_name ? (
                              <span className="text-foreground">{cleanEmployeeNameForDisplay(rowTarget.employee_name || rowTarget.extracted_employee_name)}</span>
                            ) : isSkipped ? (
                              <span className="text-muted-foreground">--</span>
                            ) : (() => {
                              const pickerId = rowTarget.id;
                              const isOpen = inlinePicker?.id === pickerId && inlinePicker.kind === 'employee';
                              return isOpen ? (
                                <div onClick={(e) => e.stopPropagation()}>
                                  <select
                                    autoFocus
                                    className="h-7 rounded border border-border bg-background px-2 text-xs min-w-[160px]"
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
                                    {users.map((u: { id: number; full_name: string }) => (
                                      <option key={u.id} value={u.id}>{u.full_name}</option>
                                    ))}
                                  </select>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setInlinePicker({ id: pickerId, kind: 'employee' }); }}
                                  className="inline-flex items-center gap-1 rounded-md border border-dashed border-amber-400/60 bg-transparent px-2 py-0.5 text-xs font-medium text-amber-700 transition hover:bg-amber-500/15 hover:border-amber-400 dark:text-amber-300"
                                  title="Click to assign an employee"
                                >
                                  <Plus className="h-3 w-3" /> Add employee
                                </button>
                              );
                            })()}
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

                        {/* Pills row: only render when there is something to show */}
                        {(isMultiPeriod || rowTarget.is_likely_resubmission || isSkipped) ? (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {isMultiPeriod ? (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); toggleExpanded(group.key); }}
                                className="inline-flex items-center gap-1 rounded-full bg-info-soft px-2.5 py-0.5 text-[11px] font-medium text-indigo-300 transition hover:brightness-125"
                                style={{ background: 'rgba(99, 102, 241, 0.15)' }}
                                aria-expanded={isExpanded}
                                aria-label={isExpanded ? `Collapse ${group.periods} weeks` : `Expand ${group.periods} weeks`}
                              >
                                {group.periods} weeks {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                              </button>
                            ) : null}
                            {rowTarget.is_likely_resubmission ? (
                              <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300" title="A rejected submission from this sender exists for a similar period.">
                                Possible resubmission
                              </span>
                            ) : null}
                            {isSkipped ? (
                              <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">Skipped</span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

                      {/* Status pill */}
                      <Badge tone={getStatusTone(group.status)} className="normal-case tracking-normal whitespace-nowrap self-start">
                        {statusLabel(group.status)}
                      </Badge>

                      {/* Row actions */}
                      <div className="flex shrink-0 items-center gap-1.5 self-start">
                        {isSkipped && group.skipped ? (
                          <>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); void handlePromoteSkipped(group.skipped!.id, group.skipped!.subject); }}
                              disabled={isBusy || promoteSkipped.isPending}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-40"
                              aria-label={`Promote email ${group.skipped.id} to the review queue`}
                              title="This is a timesheet"
                            >
                              <CheckCircle2 className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); void handleConfirmSkipped(group.skipped!.id, group.skipped!.subject); }}
                              disabled={isBusy || confirmSkipped.isPending}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-muted-foreground transition hover:bg-muted/70 disabled:opacity-40"
                              aria-label={`Confirm email ${group.skipped.id} is not a timesheet`}
                              title="Not a timesheet"
                            >
                              <EyeOff className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); void handleReprocessEmail(group.skipped!.id); }}
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
                          onClick={(e) => { e.stopPropagation(); openReview(); }}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-foreground transition hover:bg-muted/70"
                          aria-label={isSkipped ? `Open email ${group.skipped?.id}` : `Open submission ${rowTarget.id}`}
                          title="Open"
                          disabled={!canOpenReview}
                        >
                          <ArrowRight className="h-4 w-4" />
                        </button>
                        {!isFinal ? (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void handleDeleteEmail(rowTarget.email_id, rowTarget.subject); }}
                            disabled={isBusy}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
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
                      <div
                        data-testid={`inbox-card-children-${group.key}`}
                        className="ml-12 mr-3 mb-3 border-l-2 border-border/60 pl-3"
                      >
                        <div className="flex flex-col gap-1.5">
                          {group.timesheets.map((ts) => (
                            <div
                              key={ts.id}
                              className="flex items-center gap-3 rounded-md border border-border/60 bg-card/30 px-3 py-2 text-xs"
                            >
                              <span className="font-medium text-foreground min-w-[120px]">{formatDateRange(ts.period_start, ts.period_end)}</span>
                              <span className="font-mono text-muted-foreground">{formatHours(ts.total_hours)}h</span>
                              <Badge tone={getStatusTone(ts.status)} className="normal-case tracking-normal text-[10px]">{statusLabel(ts.status)}</Badge>
                              <div className="ml-auto flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); navigate(`/ingestion/review/${ts.id}`); }}
                                  className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-muted text-foreground transition hover:bg-muted/70"
                                  aria-label={`Open week ${ts.id}`}
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
        anchorEl={cascadePopover?.anchorEl ?? null}
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
};
