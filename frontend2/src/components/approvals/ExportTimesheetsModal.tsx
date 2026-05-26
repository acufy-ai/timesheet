import React, { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';

import {
  buildEmployeeTimesheetPdf,
  employeePdfFilename,
  type PdfReportFilters,
  type PdfTenantBranding,
} from '@/utils/teamTimesheetPdf';
import type { IngestionTimesheetSummary, TimeEntry, User } from '@/types';

/**
 * D-061: shared Export modal for Approved Timesheets surfaces.
 *
 * Admin's User Management page and the manager's Approvals page both
 * have an "Approved Timesheets" rollup; both want the same three
 * export formats (CSV / PDF / Print) and the same employee picker.
 * This component is the canonical implementation.
 *
 * Inputs are deliberately data-only (entries + ingestion summaries +
 * supporting maps + branding/filters). The caller decides what's in
 * scope — admin sends the workspace view, manager sends their
 * direct-reports view — and the modal just renders what it's given.
 */

export type ExportFormat = 'csv' | 'pdf' | 'print';

interface Props {
  open: boolean;
  onClose: () => void;
  /** All time entries currently visible in the consumer's table. */
  entries: TimeEntry[];
  /** Inbox-PDF summaries the consumer wants surfaced as standalone
   *  rows (i.e. unmaterialised PDFs). Typically excludes
   *  ``time_entries_created=true`` to avoid double-counting. */
  ingestionSummaries: IngestionTimesheetSummary[];
  /** All inbox summaries in scope, including materialised ones. Used
   *  ONLY as a lookup map so the CSV/PDF can tag materialised
   *  per-day entries as inbox-derived (Source=Inbox, Client column,
   *  Supervisor extraction, blank Project). Defaults to
   *  ``ingestionSummaries`` for backward compatibility. */
  ingestionLookup?: IngestionTimesheetSummary[];
  /** All users — used to resolve employee_id → User for the picker. */
  users: User[];
  /** All projects — used by the PDF generator to label client/project. */
  projects: Array<{ id: number; name: string; client_id: number }>;
  /** All clients — projects join here via client_id. */
  clients: Array<{ id: number; name: string }>;
  /** Tenant branding (logo + name) for the PDF header. */
  branding: PdfTenantBranding;
  /** Date/status filters for the PDF footer + CSV filename. */
  filters: PdfReportFilters;
  /** Optional initial employee selection (toolbar filter). */
  initialEmployeeIds?: number[];
}

export const ExportTimesheetsModal: React.FC<Props> = ({
  open,
  ingestionLookup,
  onClose,
  entries,
  ingestionSummaries,
  users,
  projects,
  clients,
  branding,
  filters,
  initialEmployeeIds = [],
}) => {
  const [exportFormat, setExportFormat] = useState<ExportFormat>('pdf');
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');

  // Reset state every time the modal opens; pre-seed selection from
  // the caller's toolbar filter if provided.
  useEffect(() => {
    if (!open) return;
    setExportFormat('pdf');
    setSelection(new Set(initialEmployeeIds));
    setSearch('');
  }, [open, initialEmployeeIds]);

  // Inbox-lookup map: tags materialised per-day entries as
  // inbox-derived in the CSV/PDF (Source=Inbox, blank Project, swap
  // in extracted Client / Supervisor). Caller may pass a wider
  // ``ingestionLookup`` that includes ``time_entries_created=true``
  // rows that the rollup excluded; without that, the CSV labels
  // those entries as "Internal" by mistake.
  const inboxLookupSource = ingestionLookup ?? ingestionSummaries;

  // Outside-click dismissal handled at the JSX layer via overlay
  // onClick + dialog stopPropagation. Avoids the native-mousedown
  // race that can swallow inner-button clicks at the gap between
  // React's synthetic-event delegation and a document-level listener.

  // Picker enumerates real users (by employee_id) PLUS name-only inbox
  // rows (sender email didn't match a workspace user). Managers acting
  // on their own inbox-reviewed PDFs are another case: their own
  // user_id won't be in the manager-scoped useUsers() list, so we also
  // hydrate from entry.user.full_name when available. Synthetic
  // (negative) ids stand in for both — they translate back via
  // syntheticNameById when CSV/PDF filtering runs below.
  const { employeesWithEntries, syntheticNameById, realIdToFullName } = useMemo(() => {
    const userById = new Map<number, User>(users.map((u) => [u.id, u]));
    const idsReal = new Set<number>();
    const nameOnlyRows = new Map<string, IngestionTimesheetSummary>();
    // Backfill: if a TimeEntry's user isn't in the users list (manager
    // viewing their own time entries, for example), remember the
    // user_id → full_name mapping so we can still build a picker row.
    const realIdToFullName = new Map<number, string>();
    for (const e of entries) {
      idsReal.add(e.user_id);
      const fullName = e.user?.full_name;
      if (fullName && !userById.has(e.user_id)) {
        realIdToFullName.set(e.user_id, fullName);
      }
    }
    for (const ts of ingestionSummaries) {
      if (ts.employee_id) {
        idsReal.add(ts.employee_id);
      } else {
        const name = (ts.employee_name ?? ts.extracted_employee_name ?? '').trim();
        if (name && !nameOnlyRows.has(name)) nameOnlyRows.set(name, ts);
      }
    }
    const realUsers: User[] = Array.from(idsReal)
      .map((id) => {
        const u = userById.get(id);
        if (u) return u;
        const name = realIdToFullName.get(id);
        if (!name) return null;
        // Hydrate a minimal User from the entry-side full_name when
        // the scoped /users response didn't include this row.
        return { id, full_name: name } as unknown as User;
      })
      .filter((u): u is User => Boolean(u));
    // Stable negative ids: -1, -2, ... in alphabetical order of name.
    // CSV/PDF filters use the syntheticNameById map below to translate.
    const syntheticNameById = new Map<number, string>();
    const syntheticUsers: User[] = [];
    let nextSynth = -1;
    Array.from(nameOnlyRows.keys()).sort().forEach((name) => {
      const id = nextSynth--;
      syntheticNameById.set(id, name);
      syntheticUsers.push({ id, full_name: name } as unknown as User);
    });
    const combined = [...realUsers, ...syntheticUsers].sort((a, b) =>
      a.full_name.localeCompare(b.full_name),
    );
    return { employeesWithEntries: combined, syntheticNameById, realIdToFullName };
  }, [entries, ingestionSummaries, users]);

  const filteredEmployees = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return employeesWithEntries;
    return employeesWithEntries.filter((u) => u.full_name.toLowerCase().includes(q));
  }, [employeesWithEntries, search]);

  const toggle = (id: number) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const generateLabel = (() => {
    const count = selection.size;
    if (exportFormat === 'csv') return 'Download CSV';
    if (exportFormat === 'pdf') {
      if (count <= 1) return 'Download PDF';
      return `Download ZIP (${count})`;
    }
    return 'Open in new tab';
  })();

  const formatHint = (() => {
    if (exportFormat === 'csv') return 'One row per time entry. Filters apply.';
    if (exportFormat === 'pdf') return 'One PDF per employee. Bundled as a ZIP when multiple are picked.';
    return 'Opens the first selected employee in a new tab and triggers print.';
  })();

  // ─── Export implementations ────────────────────────────────────

  const runCsv = (employeeIds: number[]) => {
    // Split selection into real ids and synthetic (negative) ids that
    // stand in for unbound inbox rows. Synthetic ids translate back
    // to canonical names via syntheticNameById; we then match
    // ingestion rows by name when employee_id is null.
    const realIds = employeeIds.filter((id) => id > 0);
    const synthNames = new Set(
      employeeIds.filter((id) => id < 0).map((id) => syntheticNameById.get(id)).filter((n): n is string => Boolean(n))
    );
    const scopedEntries = employeeIds.length
      ? entries.filter((e) => realIds.includes(e.user_id))
      : entries;
    const scopedIngestion = employeeIds.length
      ? ingestionSummaries.filter((ts) => {
          if (ts.employee_id != null) return realIds.includes(ts.employee_id);
          const name = (ts.employee_name ?? ts.extracted_employee_name ?? '').trim();
          return name && synthNames.has(name);
        })
      : ingestionSummaries;
    if (scopedEntries.length === 0 && scopedIngestion.length === 0) return;

    // Column shape — wider than before so external employees get
    // their Client + Supervisor + Approved-by surfaced separately
    // from Project (which is often empty for inbox-derived rows).
    const header = [
      'Employee',
      'Source',
      'Client',
      'Project',
      'Task',
      'Date',
      'Hours',
      'Supervisor',
      'Approved by',
      'Status',
    ];
    const escape = (value: unknown) => {
      const s = value == null ? '' : String(value);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // For internal entries we need project → client lookup so the
    // CSV's Client column is meaningful (the project alone doesn't
    // carry the client name on the wire). When an entry is inbox-
    // derived (ingestion_timesheet_id set), the Client column reads
    // the inbox row's client_name instead of the project's anchor
    // client, the Project column is left blank, and Supervisor uses
    // the extracted supervisor from the PDF.
    const clientNameById = new Map<number, string>(clients.map((c) => [c.id, c.name]));
    const projectClientById = new Map<number, string>();
    for (const p of projects) {
      const cn = clientNameById.get(p.client_id);
      if (cn) projectClientById.set(p.id, cn);
    }
    const userById = new Map<number, User>(users.map((u) => [u.id, u]));
    const inboxByTimesheetId = new Map<string, IngestionTimesheetSummary>();
    inboxLookupSource.forEach((ts) => inboxByTimesheetId.set(String(ts.id), ts));
    const entryRows = scopedEntries.map((entry) => {
      const inboxLink = entry.ingestion_timesheet_id
        ? inboxByTimesheetId.get(String(entry.ingestion_timesheet_id))
        : null;
      const isInboxDerived = Boolean(inboxLink);
      const inboxClientName = inboxLink
        ? (inboxLink.client_name || inboxLink.extracted_client_name || '')
        : '';
      return [
        entry.user?.full_name ?? '',
        isInboxDerived ? 'Inbox' : 'Internal',
        isInboxDerived
          ? inboxClientName
          : (projectClientById.get(entry.project_id) ?? ''),
        // Project is empty for inbox-derived entries (external work
        // doesn't have an internal project label); internal entries
        // surface the project the user logged time against.
        isInboxDerived ? '' : (entry.project?.name ?? ''),
        entry.task?.name ?? '',
        entry.entry_date,
        Number(entry.hours),
        isInboxDerived ? (inboxLink?.extracted_supervisor_name ?? '') : '',
        entry.approved_by_name ?? (entry.approved_by ? userById.get(entry.approved_by)?.full_name ?? '' : ''),
        entry.status,
      ];
    });
    const ingestionRows = scopedIngestion.map((ts) => {
      const employeeName =
        (ts.employee_id ? userById.get(ts.employee_id)?.full_name : null)
        ?? ts.employee_name
        ?? ts.extracted_employee_name
        ?? '';
      // For inbox rows we only know the client. A project name is
      // sometimes set on the IngestionTimesheet but isn't reliably
      // populated; leave blank when absent so the user sees a clean
      // signal instead of a fake placeholder.
      //
      // Date column emits the full period range (period_start -
      // period_end) matching the in-table display "Apr 13 - Apr 19".
      // Single-day periods collapse to just that one date.
      const periodLabel = (() => {
        const s = ts.period_start ?? '';
        const e = ts.period_end ?? '';
        if (!s) return '';
        if (!e || e === s) return s;
        return `${s} - ${e}`;
      })();
      return [
        employeeName,
        'Inbox',
        ts.client_name ?? '',
        '', // Project: empty for inbox rows until a project gets attached
        '',
        periodLabel,
        Number(ts.total_hours ?? 0),
        ts.extracted_supervisor_name ?? '',
        ts.reviewer_name ?? '',
        'APPROVED',
      ];
    });
    // Trailing total row: sum hours so the admin sees the grand total
    // without re-running SUM() in Excel. Hours column is index 6.
    const totalHours = [...entryRows, ...ingestionRows].reduce(
      (sum, row) => sum + (Number(row[6]) || 0),
      0,
    );
    const totalRow = ['Total', '', '', '', '', '', totalHours, '', '', ''];
    const csv = [header, ...entryRows, ...ingestionRows, totalRow]
      .map((row) => row.map(escape).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `team-timesheets-${filters.startDate || 'all'}-to-${filters.endDate || 'all'}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const buildReports = async (employeeIds: number[]) => {
    const allUsers = users;
    const userById = new Map<number, User>(allUsers.map((u) => [u.id, u]));
    const entriesByEmployee = new Map<number, TimeEntry[]>();
    for (const e of entries) {
      const list = entriesByEmployee.get(e.user_id) ?? [];
      list.push(e);
      entriesByEmployee.set(e.user_id, list);
    }
    const ingestionByEmployee = new Map<number, IngestionTimesheetSummary[]>();
    // Same name-only fallback as the picker: bucket inbox rows by the
    // user's name when employee_id is null so we can produce a PDF
    // for unbound external contractors.
    const ingestionByName = new Map<string, IngestionTimesheetSummary[]>();
    for (const ts of ingestionSummaries) {
      if (ts.employee_id) {
        const list = ingestionByEmployee.get(ts.employee_id) ?? [];
        list.push(ts);
        ingestionByEmployee.set(ts.employee_id, list);
      } else {
        const name = (ts.employee_name ?? ts.extracted_employee_name ?? '').trim();
        if (!name) continue;
        const list = ingestionByName.get(name) ?? [];
        list.push(ts);
        ingestionByName.set(name, list);
      }
    }
    const clientNameById = new Map<number, string>(clients.map((c) => [c.id, c.name]));
    const clientByProjectId = new Map<number, string>();
    for (const p of projects) {
      const cn = clientNameById.get(p.client_id);
      if (cn) clientByProjectId.set(p.id, cn);
    }

    const reports: { employee: User; blob: Blob }[] = [];
    for (const id of employeeIds) {
      // Resolve real user, or synthesise a minimal User-shape from
      // the synthetic-id-to-name map for unbound inbox rows.
      let employee: User | undefined = userById.get(id);
      let empIngestion: IngestionTimesheetSummary[] = [];
      let empEntries: TimeEntry[] = [];
      if (employee) {
        empEntries = entriesByEmployee.get(id) ?? [];
        empIngestion = ingestionByEmployee.get(id) ?? [];
      } else if (id > 0) {
        // Real id but scoped /users response didn't include this user
        // (e.g. manager viewing entries for users outside their tree
        // that came in through inbox-reviewer scope). Hydrate from
        // the entry-side full_name map and use the same buckets.
        const fallbackName = realIdToFullName.get(id);
        if (!fallbackName) continue;
        empEntries = entriesByEmployee.get(id) ?? [];
        empIngestion = ingestionByEmployee.get(id) ?? [];
        if (empEntries.length === 0 && empIngestion.length === 0) continue;
        employee = { id, full_name: fallbackName } as unknown as User;
      } else if (id < 0) {
        const name = syntheticNameById.get(id);
        if (!name) continue;
        empIngestion = ingestionByName.get(name) ?? [];
        if (empIngestion.length === 0) continue;
        employee = { id, full_name: name } as unknown as User;
      }
      if (!employee) continue;
      if (empEntries.length === 0 && empIngestion.length === 0) continue;
      const manager = employee.manager_id ? userById.get(employee.manager_id) : null;
      const supervisorNames = empIngestion
        .map((ts) => (ts.extracted_supervisor_name || '').trim())
        .filter((s): s is string => Boolean(s));
      const approverNames = empIngestion
        .map((ts) => (ts.reviewer_name || '').trim())
        .filter((s): s is string => Boolean(s));
      const blob = buildEmployeeTimesheetPdf({
        employee,
        entries: empEntries,
        ingestionTimesheets: empIngestion.map((ts) => ({
          client_name: ts.client_name ?? null,
          period_start: ts.period_start ?? null,
          period_end: ts.period_end ?? null,
          total_hours: ts.total_hours ?? null,
        })),
        managerName: manager?.full_name ?? null,
        supervisorNames,
        approverNames,
        clientByProjectId,
        branding,
        filters,
      });
      reports.push({ employee, blob });
    }
    return reports;
  };

  const runPdf = async (employeeIds: number[]) => {
    if (employeeIds.length === 0) return;
    const reports = await buildReports(employeeIds);
    if (reports.length === 0) return;

    if (reports.length === 1) {
      const { employee, blob } = reports[0];
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = employeePdfFilename(employee.full_name, filters);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      return;
    }

    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    for (const { employee, blob } of reports) {
      const buf = await blob.arrayBuffer();
      zip.file(employeePdfFilename(employee.full_name, filters), buf);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const link = document.createElement('a');
    link.href = url;
    const stamp = filters.startDate && filters.endDate ? `-${filters.startDate}-to-${filters.endDate}` : '';
    link.download = `team-timesheets${stamp}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const runPrint = async (employeeIds: number[]) => {
    if (employeeIds.length === 0) return;
    const reports = await buildReports(employeeIds);
    if (reports.length === 0) return;
    const first = reports[0];
    const url = URL.createObjectURL(first.blob);
    const win = window.open(url, '_blank');
    if (!win) {
      const link = document.createElement('a');
      link.href = url;
      link.download = employeePdfFilename(first.employee.full_name, filters);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return;
    }
    win.addEventListener('load', () => {
      try {
        win.focus();
        win.print();
      } catch {
        /* cross-origin blob print may throw; the user can print from the tab manually */
      }
    });
  };

  const handleGenerate = async () => {
    const ids = Array.from(selection);
    if (ids.length === 0) return;
    onClose();
    if (exportFormat === 'csv') runCsv(ids);
    else if (exportFormat === 'pdf') await runPdf(ids);
    else await runPrint(ids);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-modal-title"
        className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-border">
          <p id="export-modal-title" className="text-base font-semibold">Export team timesheets</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Pick a format and choose which employees to include.
          </p>
        </div>

        <div className="px-5 pt-4">
          <div className="inline-flex w-full overflow-hidden rounded-lg border border-border">
            <FormatButton value="csv" active={exportFormat === 'csv'} onClick={setExportFormat} label="CSV" />
            <FormatButton value="pdf" active={exportFormat === 'pdf'} onClick={setExportFormat} label="PDF" />
            <FormatButton value="print" active={exportFormat === 'print'} onClick={setExportFormat} label="Print" />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">{formatHint}</p>
        </div>

        <div className="px-5 pt-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employees…"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
          />
        </div>

        <div className="px-5 py-2 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            {selection.size === 0
              ? `${employeesWithEntries.length} available`
              : `${selection.size} selected`}
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => setSelection(new Set(employeesWithEntries.map((u) => u.id)))}
            >
              Select all
            </button>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setSelection(new Set())}
            >
              Clear
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto border-t border-border">
          {filteredEmployees.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No employees with entries in this view.
            </p>
          ) : (
            filteredEmployees.map((u) => {
              const checked = selection.has(u.id);
              return (
                <button
                  type="button"
                  key={u.id}
                  onClick={() => toggle(u.id)}
                  className="flex w-full items-center gap-2.5 px-5 py-2 text-sm text-left hover:bg-muted/60 transition"
                >
                  <span
                    className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center ${
                      checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                    }`}
                  >
                    {checked && <Check className="w-3 h-3" />}
                  </span>
                  <span className="truncate">{u.full_name}</span>
                </button>
              );
            })
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted transition"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={selection.size === 0}
            onClick={handleGenerate}
            className="px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {generateLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

const FormatButton: React.FC<{
  value: ExportFormat;
  label: string;
  active: boolean;
  onClick: (v: ExportFormat) => void;
}> = ({ value, label, active, onClick }) => (
  <button
    type="button"
    onClick={() => onClick(value)}
    className={`flex-1 px-3 py-2 text-xs font-medium transition ${
      active
        ? 'bg-primary text-primary-foreground shadow-sm'
        : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
    }`}
  >
    {label}
  </button>
);
