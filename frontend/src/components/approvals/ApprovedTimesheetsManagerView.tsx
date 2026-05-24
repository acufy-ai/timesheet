import React, { useMemo, useState } from 'react';
import { endOfWeek, format, parseISO, startOfWeek } from 'date-fns';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, Info, ListFilter, Paperclip, Upload } from 'lucide-react';

import { adminAPI, timeentriesAPI } from '@/api';
import {
  useAuth,
  useClients,
  useProjects,
  useUsers,
  useWeekStartsOn,
} from '@/hooks';
import { useTenantLogo } from '@/hooks/useTenantLogo';
import { DateRangePickerCalendar } from '@/components';
import { EmployeeMultiSelectPicker } from '@/components/EmployeeMultiSelectPicker';
import type { IngestionTimesheetSummary, TimeEntry, User } from '@/types';
import { ExportTimesheetsModal } from './ExportTimesheetsModal';
import { SourceAttachmentViewer, useSourceAttachmentViewer } from './SourceAttachmentViewer';

/**
 * D-061: Approved Timesheets tab on the manager's Approvals page.
 *
 * Mirrors the admin's User Management → Approved Timesheets surface
 * (filters · rolled-up table · row drill-in · CSV/PDF/Print export)
 * but scopes the dataset to the manager's direct reports + inbox
 * PDFs they personally reviewed. Admins-also see the workspace view.
 *
 * Status filter defaults to APPROVED so the tab matches its name,
 * but the manager can broaden to All / Draft / Submitted / Rejected
 * if they want to see in-flight work without bouncing back to the
 * Pending tab.
 */

const PAGE_SIZE = 50;
type StatusFilter = '' | 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

function statusFilterLabel(s: StatusFilter): string {
  if (!s) return 'Status: All';
  const pretty = s.charAt(0) + s.slice(1).toLowerCase();
  return `Status: ${pretty}`;
}

export const ApprovedTimesheetsManagerView: React.FC = () => {
  const { user, tenant } = useAuth();
  const { dataUrl: tenantLogoDataUrl } = useTenantLogo();
  const weekStartsOn = useWeekStartsOn();
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'PLATFORM_ADMIN';
  // Admins see workspace; pure managers see their reports + their
  // own inbox-approved PDFs. Backend enforces the scope by role.
  const scope: 'mine' | 'workspace' = isAdmin ? 'workspace' : 'mine';

  // ── Filters ──────────────────────────────────────────────────
  const [employeeIds, setEmployeeIds] = useState<number[]>([]);
  const [employeePickerOpen, setEmployeePickerOpen] = useState(false);
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('APPROVED');

  // ── Supporting data ──────────────────────────────────────────
  const { data: usersAll = [] } = useUsers();
  const { data: projectsAll = [] } = useProjects();
  const { data: clientsAll = [] } = useClients();

  // Pull a wide range and filter client-side so the user can swap
  // status without retriggering a network request. ``limit=500``
  // mirrors the admin view.
  const internalQuery = useQuery({
    queryKey: ['approved-timesheets', 'internal', scope, startDate, endDate],
    queryFn: () =>
      timeentriesAPI
        .listAll({
          start_date: startDate || undefined,
          end_date: endDate || undefined,
          limit: 500,
        })
        .then((r) => r.data as TimeEntry[]),
  });

  // Inbox-PDF (ingestion) summaries. We fetch the full set (without
  // filtering out time_entries_created=true) because the rollup
  // needs to map per-day TimeEntry rows back to their originating
  // client name via ingestion_timesheet_id. Summary-only PDFs (no
  // entries materialised) still get their own rollup row; materialised
  // ones contribute the client metadata to the entry rows above.
  const inboxQuery = useQuery({
    queryKey: ['approved-timesheets', 'inbox', scope],
    queryFn: () =>
      adminAPI
        .listApprovedIngestionTimesheets({ scope })
        .then((r) => (r.data as IngestionTimesheetSummary[]).filter((ts) => ts.total_hours)),
  });

  const internalEntries = useMemo(
    () => internalQuery.data ?? [],
    [internalQuery.data],
  );
  const inboxSummaries = useMemo(
    () => inboxQuery.data ?? [],
    [inboxQuery.data],
  );
  const loading = internalQuery.isLoading || inboxQuery.isLoading;

  // ── Client-side filtering ───────────────────────────────────
  const employeeIdSet = useMemo(() => new Set(employeeIds), [employeeIds]);
  const filteredInternal = useMemo(() => {
    return internalEntries.filter((e) => {
      if (statusFilter && e.status !== statusFilter) return false;
      if (employeeIdSet.size > 0 && !employeeIdSet.has(e.user_id)) return false;
      return true;
    });
  }, [internalEntries, statusFilter, employeeIdSet]);

  const filteredInbox = useMemo(() => {
    // Inbox rows only show when the status filter accepts APPROVED.
    if (statusFilter && statusFilter !== 'APPROVED') return [];
    return inboxSummaries.filter((ts) => {
      // Materialised PDFs are surfaced as per-day TimeEntry rows
      // via the internal loop, so we exclude them from rollups,
      // stat tiles, and CSV exports as a separate inbox section
      // to avoid double-counting.
      if (ts.time_entries_created) return false;
      if (employeeIdSet.size > 0) {
        if (!ts.employee_id || !employeeIdSet.has(ts.employee_id)) return false;
      }
      if (startDate && ts.period_end && ts.period_end < startDate) return false;
      if (endDate && ts.period_start && ts.period_start > endDate) return false;
      return true;
    });
  }, [inboxSummaries, statusFilter, employeeIdSet, startDate, endDate]);

  // ── Aggregate into (employee, project) rows ────────────────
  type AggRow = {
    key: string;
    kind: 'internal' | 'inbox';
    employeeName: string;
    projectName: string;
    minDate: string;
    maxDate: string;
    days: number;
    hours: number;
    pdfCount?: number;
    statuses: Set<string>;
    entries: TimeEntry[];
    ingestionSummaries: IngestionTimesheetSummary[];
  };
  // Lookup so we can swap project → client name when an internal
  // entry was materialised from an inbox-approved IngestionTimesheet.
  // External employees don't have a real "project" — they have a
  // Client (e.g. "Better Business Systems"), so the rollup should
  // surface that even when per-day TimeEntry rows exist.
  const inboxByTimesheetId = useMemo(() => {
    const map = new Map<string, IngestionTimesheetSummary>();
    inboxSummaries.forEach((ts) => map.set(String(ts.id), ts));
    return map;
  }, [inboxSummaries]);

  const rows = useMemo<AggRow[]>(() => {
    const map = new Map<string, AggRow>();

    filteredInternal.forEach((e) => {
      // Detect inbox-derived entries by the ingestion link. When set,
      // group them under the client (employee + client) and show the
      // client name instead of the project the entry is anchored to.
      // Prefer the linked client (``client_name`` via the FK) but
      // fall back to ``extracted_client_name`` from the PDF so we
      // surface what the document actually said even when the
      // reviewer never picked a workspace client.
      const inboxLink = e.ingestion_timesheet_id
        ? inboxByTimesheetId.get(String(e.ingestion_timesheet_id))
        : null;
      const inboxClientName = inboxLink
        ? (inboxLink.client_name || inboxLink.extracted_client_name || null)
        : null;
      const isInboxDerived = Boolean(inboxLink);
      const key = isInboxDerived
        ? `inbox-derived-${e.user_id}-${inboxLink?.client_id ?? inboxClientName ?? 'unknown'}`
        : `int-${e.user_id}-${e.project_id}`;
      const displayName = isInboxDerived
        ? (inboxClientName ?? 'Unspecified client')
        : (e.project?.name ?? 'N/A');
      const existing = map.get(key);
      const hours = Number(e.hours) || 0;
      if (existing) {
        existing.hours += hours;
        existing.days += 1;
        if (e.entry_date < existing.minDate) existing.minDate = e.entry_date;
        if (e.entry_date > existing.maxDate) existing.maxDate = e.entry_date;
        existing.statuses.add(e.status);
        existing.entries.push(e);
      } else {
        map.set(key, {
          key,
          kind: isInboxDerived ? 'inbox' : 'internal',
          employeeName: e.user?.full_name ?? 'N/A',
          projectName: displayName,
          minDate: e.entry_date,
          maxDate: e.entry_date,
          days: 1,
          hours,
          statuses: new Set([e.status]),
          entries: [e],
          ingestionSummaries: inboxLink ? [inboxLink] : [],
        });
      }
    });

    filteredInbox.forEach((ts) => {
      // Skip materialised PDFs — they're already represented by per-
      // day TimeEntry rows that this rollup picks up through the
      // internal loop above (with project label swapped to client
      // via ingestion_timesheet_id).
      if (ts.time_entries_created) return;
      const employeeKey = ts.employee_id != null
        ? `emp-${ts.employee_id}`
        : `name-${(ts.employee_name ?? ts.extracted_employee_name ?? '?').toLowerCase()}`;
      const clientKey = ts.client_id != null
        ? `c-${ts.client_id}`
        : `cn-${(ts.client_name ?? '?').toLowerCase()}`;
      const key = `inb-${employeeKey}-${clientKey}`;
      const periodStart = ts.period_start ?? ts.reviewed_at?.slice(0, 10) ?? '';
      const periodEnd = ts.period_end ?? periodStart;
      const hours = Number(ts.total_hours ?? 0);
      const existing = map.get(key);
      if (existing) {
        existing.hours += hours;
        if (periodStart && (!existing.minDate || periodStart < existing.minDate)) existing.minDate = periodStart;
        if (periodEnd && (!existing.maxDate || periodEnd > existing.maxDate)) existing.maxDate = periodEnd;
        existing.pdfCount = (existing.pdfCount ?? 0) + 1;
        existing.ingestionSummaries.push(ts);
      } else {
        map.set(key, {
          key,
          kind: 'inbox',
          employeeName: ts.employee_name ?? ts.extracted_employee_name ?? 'N/A',
          projectName: ts.client_name ?? 'N/A',
          minDate: periodStart,
          maxDate: periodEnd,
          days: 0,
          hours,
          pdfCount: 1,
          statuses: new Set(['APPROVED']),
          entries: [],
          ingestionSummaries: [ts],
        });
      }
    });

    return Array.from(map.values()).sort((a, b) =>
      (b.maxDate || '').localeCompare(a.maxDate || ''),
    );
  }, [filteredInternal, filteredInbox, inboxByTimesheetId]);

  // ── Drill-in state ──────────────────────────────────────────
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [expandedWeekKey, setExpandedWeekKey] = useState<string | null>(null);
  const toggleRow = (key: string) => {
    setExpandedRowKey((prev) => {
      const next = prev === key ? null : key;
      setExpandedWeekKey(null);
      return next;
    });
  };

  // ── Source-PDF viewer (paperclip on per-week drill-in) ──────
  const attachmentViewer = useSourceAttachmentViewer();

  // ── Pagination ──────────────────────────────────────────────
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  // Reset to page 1 whenever filters change row count.
  React.useEffect(() => { setPage(1); }, [rows.length]);
  const paged = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // ── Stat tiles (computed from filtered set) ────────────────
  const totalEntries = useMemo(
    () => filteredInternal.length + filteredInbox.length,
    [filteredInternal.length, filteredInbox.length],
  );
  const distinctEmployees = useMemo(() => {
    const set = new Set<string>();
    filteredInternal.forEach((e) => set.add(`u-${e.user_id}`));
    filteredInbox.forEach((ts) => set.add(`e-${ts.employee_id ?? ts.employee_name ?? '?'}`));
    return set.size;
  }, [filteredInternal, filteredInbox]);
  const totalHours = useMemo(
    () =>
      filteredInternal.reduce((acc, e) => acc + (Number(e.hours) || 0), 0) +
      filteredInbox.reduce((acc, ts) => acc + (Number(ts.total_hours) || 0), 0),
    [filteredInternal, filteredInbox],
  );

  // ── Export modal ─────────────────────────────────────────────
  const [exportOpen, setExportOpen] = useState(false);
  const branding = useMemo(
    () => ({
      name: tenant?.name ?? 'Workspace',
      logoDataUrl: tenantLogoDataUrl,
      logoMime: tenant?.logo_mime_type ?? null,
    }),
    [tenant?.name, tenant?.logo_mime_type, tenantLogoDataUrl],
  );
  const exportFilters = useMemo(
    () => ({
      startDate: startDate || null,
      endDate: endDate || null,
      status: statusFilter || null,
    }),
    [startDate, endDate, statusFilter],
  );

  // The picker's employee list scope: a pure manager only sees their
  // direct reports (computed from the visible rows); admins see all
  // active employees in the workspace.
  const employeesForFilter = useMemo<User[]>(() => {
    if (isAdmin) {
      return (usersAll as User[]).filter((u) => u.is_active && u.role === 'EMPLOYEE');
    }
    // For pure managers, only show employees who actually appear in
    // the data they have access to.
    const allowedIds = new Set<number>();
    internalEntries.forEach((e) => allowedIds.add(e.user_id));
    inboxSummaries.forEach((ts) => { if (ts.employee_id) allowedIds.add(ts.employee_id); });
    return (usersAll as User[]).filter((u) => allowedIds.has(u.id));
  }, [usersAll, isAdmin, internalEntries, inboxSummaries]);

  return (
    <div className="space-y-4">
      {/* Scope banner + Export */}
      <div className="flex items-start gap-3 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-3">
        <Info className="w-4 h-4 mt-0.5 text-blue-500 flex-shrink-0" />
        <p className="text-sm">
          {isAdmin ? (
            <>
              You have <strong>admin access</strong>: showing all approved timesheets and inbox
              submissions for the workspace. Same dataset as the admin User Management view.
            </>
          ) : (
            <>
              Showing approvals from your <strong>direct reports</strong> and inbox timesheets you
              <strong> personally approved</strong>.
              <span className="text-muted-foreground"> Admins see all workspace approvals here and on User Management.</span>
            </>
          )}
        </p>
        <button
          type="button"
          onClick={() => setExportOpen(true)}
          disabled={rows.length === 0}
          className="ml-auto flex items-center gap-2 px-3 py-1.5 border border-border rounded-lg text-sm hover:bg-muted transition disabled:opacity-50 disabled:cursor-not-allowed bg-card"
        >
          <Upload className="w-3.5 h-3.5" />
          Export
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-start gap-3">
        <EmployeeMultiSelectPicker
          allEmployees={employeesForFilter}
          selectedIds={employeeIds}
          onChange={setEmployeeIds}
          open={employeePickerOpen}
          onOpenChange={setEmployeePickerOpen}
        />
        <DateRangePickerCalendar
          startDate={startDate}
          endDate={endDate}
          onStartDateChange={setStartDate}
          onEndDateChange={setEndDate}
        />
        {/* Same shape as the employee picker + date range picker —
            leading icon, rounded-lg, py-2, theme tokens — so the
            three filter pills read as a single visual family.
            The native <select> is layered transparently across the
            entire pill so clicks anywhere inside (icon, label, chevron)
            open the dropdown, matching the other two pickers. */}
        <div className="relative inline-flex items-center gap-2 rounded-lg border border-border bg-card pl-3 pr-9 py-2 text-sm hover:border-primary/40 transition cursor-pointer">
          <ListFilter className="w-4 h-4 text-muted-foreground" />
          <span className="text-foreground">{statusFilterLabel(statusFilter)}</span>
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground absolute right-2.5 pointer-events-none" />
          <select
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            aria-label="Status filter"
          >
            <option value="" className="bg-card text-foreground">Status: All</option>
            <option value="DRAFT" className="bg-card text-foreground">Status: Draft</option>
            <option value="SUBMITTED" className="bg-card text-foreground">Status: Submitted</option>
            <option value="APPROVED" className="bg-card text-foreground">Status: Approved</option>
            <option value="REJECTED" className="bg-card text-foreground">Status: Rejected</option>
          </select>
        </div>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">Entries</div>
          <div className="text-2xl font-semibold">{totalEntries}</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">Employees</div>
          <div className="text-2xl font-semibold">{distinctEmployees}</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">Total hours</div>
          <div className="text-2xl font-semibold tabular-nums">{totalHours.toFixed(2)}</div>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {loading ? (
          <p className="p-8 text-center text-sm text-muted-foreground">Loading approved timesheets…</p>
        ) : rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No timesheets match the current filters.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
              <tr>
                <th className="px-3 py-3 w-8"></th>
                <th className="px-4 py-3">Employee</th>
                <th className="px-4 py-3">Client / Project</th>
                <th className="px-4 py-3">Date range</th>
                <th className="px-4 py-3 text-right">Days</th>
                <th className="px-4 py-3 text-right">Total hours</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((r) => {
                const isExpanded = expandedRowKey === r.key;
                const status = pickPrimaryStatus(r.statuses);
                return (
                  <React.Fragment key={r.key}>
                    <tr
                      className="border-b border-border hover:bg-muted/30 cursor-pointer"
                      onClick={() => toggleRow(r.key)}
                    >
                      <td className="px-3 py-3 text-muted-foreground text-xs select-none">
                        {isExpanded ? '▼' : '▶'}
                      </td>
                      <td className="px-4 py-3 font-medium">{r.employeeName}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {r.projectName}
                        {r.kind === 'inbox' && (
                          <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-500 border border-violet-500/30 text-[10px] font-medium">
                            Inbox
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {r.minDate ? format(parseISO(r.minDate), 'MMM d') : 'N/A'}
                        {r.maxDate && r.maxDate !== r.minDate && ` – ${format(parseISO(r.maxDate), 'MMM d, yyyy')}`}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {r.kind === 'inbox' ? `${r.pdfCount} PDFs` : r.days}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">
                        {r.hours.toFixed(2)}h
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill status={status} mixed={r.statuses.size > 1} />
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-muted/20 border-b border-border">
                        <td colSpan={7} className="px-6 py-4">
                          <RowDrillIn
                            row={r}
                            weekStartsOn={weekStartsOn === 1 ? 1 : 0}
                            expandedWeekKey={expandedWeekKey}
                            onExpandWeek={setExpandedWeekKey}
                            onOpenAttachment={attachmentViewer.open}
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}

        {rows.length > PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border text-xs text-muted-foreground">
            <span>
              Showing {(page - 1) * PAGE_SIZE + 1} – {Math.min(page * PAGE_SIZE, rows.length)} of {rows.length}
            </span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-2.5 py-1 rounded border border-border bg-card disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ‹
              </button>
              <span className="px-2 py-1 text-foreground">{page} / {totalPages}</span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-2.5 py-1 rounded border border-border bg-card disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ›
              </button>
            </div>
          </div>
        )}
      </div>

      <ExportTimesheetsModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        entries={filteredInternal}
        ingestionSummaries={filteredInbox}
        users={usersAll}
        projects={projectsAll}
        clients={clientsAll}
        branding={branding}
        filters={exportFilters}
        initialEmployeeIds={employeeIds}
      />

      <SourceAttachmentViewer state={attachmentViewer.state} onClose={attachmentViewer.close} />
    </div>
  );
};

// ─── Sub-components ────────────────────────────────────────────

const StatusPill: React.FC<{ status: string; mixed: boolean }> = ({ status, mixed }) => {
  const label = mixed ? 'MIXED' : status;
  const classes = (() => {
    if (mixed) return 'bg-muted text-muted-foreground border-border';
    switch (status) {
      case 'APPROVED':
        return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30';
      case 'SUBMITTED':
        return 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30';
      case 'REJECTED':
        return 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30';
      case 'DRAFT':
      default:
        return 'bg-muted text-muted-foreground border-border';
    }
  })();
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${classes}`}>
      {label}
    </span>
  );
};

const RowDrillIn: React.FC<{
  row: {
    kind: 'internal' | 'inbox';
    entries: TimeEntry[];
    ingestionSummaries: IngestionTimesheetSummary[];
  };
  weekStartsOn: 0 | 1;
  expandedWeekKey: string | null;
  onExpandWeek: (key: string | null) => void;
  onOpenAttachment: (attachmentId: number, filename: string) => void;
}> = ({ row, weekStartsOn, expandedWeekKey, onExpandWeek, onOpenAttachment }) => {
  // Inbox-PDF rows: bucket by the week the PDF's period_start lands in.
  // First click on the row opens the week list; clicking a week drills
  // into the per-PDF detail with a paperclip that opens the source file.
  if (row.kind === 'inbox') {
    type IngWeek = {
      key: string;
      start: Date;
      end: Date;
      summaries: IngestionTimesheetSummary[];
      totalHours: number;
    };
    const ingWeekMap = new Map<string, IngWeek>();
    row.ingestionSummaries.forEach((ts) => {
      const periodStart = ts.period_start ?? ts.reviewed_at?.slice(0, 10) ?? '';
      if (!periodStart) return;
      const d = parseISO(periodStart);
      const wStart = startOfWeek(d, { weekStartsOn });
      const wEnd = endOfWeek(d, { weekStartsOn });
      const key = format(wStart, 'yyyy-MM-dd');
      const existing = ingWeekMap.get(key);
      const hours = Number(ts.total_hours ?? 0);
      if (existing) {
        existing.summaries.push(ts);
        existing.totalHours += hours;
      } else {
        ingWeekMap.set(key, { key, start: wStart, end: wEnd, summaries: [ts], totalHours: hours });
      }
    });
    const ingWeeks = Array.from(ingWeekMap.values()).sort((a, b) => a.key.localeCompare(b.key));
    if (ingWeeks.length === 0) {
      return <p className="text-xs text-muted-foreground">No submissions in range.</p>;
    }
    const activeIngWeek = expandedWeekKey
      ? ingWeeks.find((w) => w.key === expandedWeekKey) ?? null
      : null;

    if (!activeIngWeek) {
      return (
        <div className="space-y-2">
          {ingWeeks.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => onExpandWeek(w.key)}
              className="w-full flex items-center justify-between rounded-lg border border-border bg-card/60 px-4 py-3 text-left hover:bg-card hover:border-primary/40 transition"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  Week of {format(w.start, 'MMM d')} – {format(w.end, 'MMM d, yyyy')}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {w.summaries.length} {w.summaries.length === 1 ? 'submission' : 'submissions'}
                </p>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className="text-sm font-medium">{w.totalHours.toFixed(2)}h</span>
                <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                  APPROVED
                </span>
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              </div>
            </button>
          ))}
        </div>
      );
    }

    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => onExpandWeek(null)}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          Back to weeks
        </button>
        <p className="text-sm font-medium">
          Week of {format(activeIngWeek.start, 'MMM d')} – {format(activeIngWeek.end, 'MMM d, yyyy')}
          <span className="text-muted-foreground font-normal">
            {' · '}{activeIngWeek.totalHours.toFixed(2)}h · {activeIngWeek.summaries.length} {activeIngWeek.summaries.length === 1 ? 'submission' : 'submissions'}
          </span>
        </p>
        {activeIngWeek.summaries.map((ts) => {
          const periodStart = ts.period_start ?? '';
          const periodEnd = ts.period_end ?? periodStart;
          const periodLabel = periodStart
            ? (periodEnd && periodEnd !== periodStart
                ? `${format(parseISO(periodStart), 'MMM d')} – ${format(parseISO(periodEnd), 'MMM d, yyyy')}`
                : format(parseISO(periodStart), 'MMM d, yyyy'))
            : 'N/A';
          return (
            <div key={ts.id} className="rounded-lg border border-border bg-card/60 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-foreground">{periodLabel}</span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">{ts.client_name ?? 'Unspecified client'}</span>
                  </div>
                  {ts.extracted_supervisor_name && (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Supervisor: <span className="text-foreground">{ts.extracted_supervisor_name}</span>
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-sm font-medium text-foreground">
                    {Number(ts.total_hours ?? 0)}h
                  </span>
                  <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                    APPROVED
                  </span>
                  {ts.attachment_id && (
                    <button
                      type="button"
                      title="View source timesheet file"
                      onClick={() => onOpenAttachment(ts.attachment_id!, ts.subject ?? `Timesheet-${ts.id}`)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition"
                    >
                      <Paperclip className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Internal entries: bucket by week, then list per-day on expansion.
  type Week = {
    key: string;
    start: Date;
    end: Date;
    entries: TimeEntry[];
    totalHours: number;
  };
  const weekMap = new Map<string, Week>();
  row.entries.forEach((e) => {
    const d = parseISO(e.entry_date);
    const wStart = startOfWeek(d, { weekStartsOn });
    const wEnd = endOfWeek(d, { weekStartsOn });
    const key = format(wStart, 'yyyy-MM-dd');
    const existing = weekMap.get(key);
    if (existing) {
      existing.entries.push(e);
      existing.totalHours += Number(e.hours) || 0;
    } else {
      weekMap.set(key, { key, start: wStart, end: wEnd, entries: [e], totalHours: Number(e.hours) || 0 });
    }
  });
  const weeks = Array.from(weekMap.values()).sort((a, b) => a.key.localeCompare(b.key));
  const activeWeek = expandedWeekKey ? weeks.find((w) => w.key === expandedWeekKey) ?? null : null;

  if (weeks.length === 0) {
    return <p className="text-xs text-muted-foreground">No entries in range.</p>;
  }

  if (!activeWeek) {
    return (
      <div className="space-y-2">
        {weeks.map((w) => (
          <button
            key={w.key}
            type="button"
            onClick={() => onExpandWeek(w.key)}
            className="w-full flex items-center justify-between rounded-lg border border-border bg-card/60 px-4 py-3 text-left hover:bg-card hover:border-primary/40 transition"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">
                Week of {format(w.start, 'MMM d')} – {format(w.end, 'MMM d, yyyy')}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{w.entries.length} entries</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">{w.totalHours.toFixed(2)}h</span>
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </div>
          </button>
        ))}
      </div>
    );
  }

  // Active week: per-day breakdown.
  const dayMap = new Map<string, TimeEntry[]>();
  activeWeek.entries.forEach((e) => {
    const list = dayMap.get(e.entry_date) ?? [];
    list.push(e);
    dayMap.set(e.entry_date, list);
  });
  const days = Array.from(dayMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => onExpandWeek(null)}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition"
      >
        <ChevronLeft className="w-3.5 h-3.5" />
        Back to weeks
      </button>
      <p className="text-sm font-medium">
        Week of {format(activeWeek.start, 'MMM d')} – {format(activeWeek.end, 'MMM d, yyyy')}
        <span className="text-muted-foreground font-normal">
          {' · '}{activeWeek.totalHours.toFixed(2)}h · {activeWeek.entries.length} entries
        </span>
      </p>
      <div className="space-y-1.5">
        {days.map(([date, entries]) => (
          <div key={date} className="rounded-md border border-border bg-card/60 px-3 py-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{format(parseISO(date), 'EEE, MMM d')}</span>
              <span className="text-muted-foreground text-xs">
                {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
              </span>
            </div>
            <ul className="mt-1.5 space-y-1">
              {entries.map((e) => (
                <li key={e.id} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground truncate">
                    {e.project?.name ?? 'Unknown'}
                    {e.task?.name ? ` · ${e.task.name}` : ''}
                    {e.description ? ` · ${e.description.length > 80 ? `${e.description.slice(0, 80)}…` : e.description}` : ''}
                  </span>
                  <span className="font-medium tabular-nums ml-2 flex-shrink-0">
                    {Number(e.hours).toFixed(2)}h
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
};

function pickPrimaryStatus(statuses: Set<string>): string {
  if (statuses.has('REJECTED')) return 'REJECTED';
  if (statuses.has('DRAFT')) return 'DRAFT';
  if (statuses.has('SUBMITTED')) return 'SUBMITTED';
  if (statuses.has('APPROVED')) return 'APPROVED';
  return 'APPROVED';
}
