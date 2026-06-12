import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, Loader2, Printer, Search } from 'lucide-react';

import { Button, Modal } from '@/components/ui';
import { useClients, useUsers, useAllProjects } from '@/hooks/useAdmin';
import { cn } from '@/lib/cn';
import type { IngestionTimesheetSummary, ManagedUser } from '@/types/admin';
import type { Project, TimeEntry } from '@/types/time';

// Standalone export modal for the Approved Timesheets tab. Ports frontend2's
// AdminPage export builders + modal: the admin picks a format (CSV / PDF /
// Print) and which employees to include, then we build the file entirely
// client-side from the already-loaded data (manual TimeEntry rows + approved-
// ingestion summary rows). No backend round-trip — the data never leaves the
// browser, so nothing can leak across tenants.
//
// The employee picker is the UNION of everyone who has a manual entry
// (entries[].user) OR an approved-ingestion row (ingestion[].employee_id).
// An empty selection means "all available". Heavy deps (jsPDF, autotable,
// JSZip) are dynamically imported only when an export actually runs.

type ExportFormat = 'csv' | 'pdf' | 'print';

export interface ApprovedExportModalProps {
  open: boolean;
  onClose: () => void;
  entries: TimeEntry[];
  ingestion: IngestionTimesheetSummary[];
  startDate: string;
  endDate: string;
}

// ── Loose accessors for fields that exist on the wire but aren't on the
// trimmed TS shapes (ingestion reviewer name, inbox-derived entry link). ──
function str(v: unknown): string {
  return v == null ? '' : String(v);
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Resolve the employee display name for an ingestion summary, preferring a
// matched roster user, then the stored employee name, then the extracted one.
function ingestionEmployeeName(
  ts: IngestionTimesheetSummary,
  userById: Map<number, ManagedUser>,
): string {
  return (
    (ts.employee_id != null ? userById.get(ts.employee_id)?.full_name : null) ??
    ts.employee_name ??
    ts.extracted_employee_name ??
    ''
  );
}

// "Apr 13 - Apr 19" style period label; single-day periods collapse.
function periodLabel(ts: IngestionTimesheetSummary): string {
  const s = ts.period_start ?? '';
  const e = ts.period_end ?? '';
  if (!s) return '';
  if (!e || e === s) return s;
  return `${s} - ${e}`;
}

// Slug-safe per-employee PDF filename.
function employeePdfFilename(name: string, startDate: string, endDate: string): string {
  const slug = (name || 'employee')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const stamp = startDate && endDate ? `-${startDate}-to-${endDate}` : '';
  return `${slug || 'employee'}-timesheet${stamp}.pdf`;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ApprovedExportModal({
  open,
  onClose,
  entries,
  ingestion,
  startDate,
  endDate,
}: ApprovedExportModalProps) {
  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seeded = useRef(false);

  // Roster + catalog for name resolution. Only fetched while the modal is open.
  const usersQ = useUsers(open);
  const clientsQ = useClients(open);
  const projectsQ = useAllProjects(open);
  const users = useMemo(() => usersQ.data ?? [], [usersQ.data]);
  const clients = useMemo(() => clientsQ.data ?? [], [clientsQ.data]);
  const projects = useMemo<Project[]>(() => projectsQ.data ?? [], [projectsQ.data]);

  const userById = useMemo(
    () => new Map<number, ManagedUser>(users.map((u) => [u.id, u])),
    [users],
  );
  const clientNameById = useMemo(
    () => new Map<number, string>(clients.map((c) => [c.id, c.name])),
    [clients],
  );
  // project_id -> client name, for the manual-entry Client column.
  const clientByProjectId = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of projects) {
      const cn = clientNameById.get(p.client_id);
      if (cn) m.set(p.id, cn);
    }
    return m;
  }, [projects, clientNameById]);

  // Inbox-summary lookup so a manual TimeEntry materialized from an inbox PDF
  // can join back to its client / supervisor. Untyped link field on the wire.
  const inboxById = useMemo(() => {
    const m = new Map<string, IngestionTimesheetSummary>();
    for (const ts of ingestion) m.set(String(ts.id), ts);
    return m;
  }, [ingestion]);

  // Employees with at least one exportable row: a manual entry OR an approved-
  // ingestion summary. Sorted by name; only those resolvable to a roster user
  // show in the picker (we need the user record for the PDF header / manager).
  const availableEmployees = useMemo<ManagedUser[]>(() => {
    const ids = new Set<number>();
    for (const e of entries) ids.add(e.user_id);
    for (const ts of ingestion) if (ts.employee_id != null) ids.add(ts.employee_id);
    return Array.from(ids)
      .map((id) => userById.get(id))
      .filter((u): u is ManagedUser => Boolean(u))
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [entries, ingestion, userById]);

  // Some ingestion rows resolve to a name but not a roster user (unmatched
  // employee). Keep those names for the CSV grouping even though they can't
  // appear in the picker.
  const filteredEmployees = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return availableEmployees;
    return availableEmployees.filter((u) => u.full_name.toLowerCase().includes(q));
  }, [availableEmployees, search]);

  // Reset transient state each time the modal opens. Selection starts empty so
  // the user explicitly chooses (empty == all available at export time).
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (seeded.current) return;
    seeded.current = true;
    setFormat('pdf');
    setSelection(new Set());
    setSearch('');
    setError(null);
    setBusy(false);
  }, [open]);

  function toggle(id: number) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Resolve the effective employee-id filter. Empty selection = all available.
  function effectiveIds(): number[] {
    if (selection.size > 0) return [...selection];
    return availableEmployees.map((u) => u.id);
  }

  // ── CSV: grouped-by-employee, merging manual + ingestion rows ──────────
  function exportCsv(ids: number[]) {
    const idSet = new Set(ids);
    const scopedEntries =
      selection.size > 0 ? entries.filter((e) => idSet.has(e.user_id)) : entries;
    const scopedIngestion =
      selection.size > 0
        ? ingestion.filter((ts) => ts.employee_id != null && idSet.has(ts.employee_id))
        : ingestion;
    if (scopedEntries.length === 0 && scopedIngestion.length === 0) {
      setError('Nothing to export for the current selection.');
      return;
    }

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

    // Manual entries. An entry materialized from an inbox PDF carries a link
    // back to its ingestion summary (untyped on the trimmed shape); when set,
    // surface the inbox client + supervisor and blank the project.
    const entryRows = scopedEntries.map((entry) => {
      const loose = entry as unknown as Record<string, unknown>;
      const linkId = loose.ingestion_timesheet_id;
      const inboxLink = linkId != null ? inboxById.get(String(linkId)) : null;
      const isInbox = Boolean(inboxLink);
      const inboxClient = inboxLink
        ? str(inboxLink.client_name) || str(inboxLink.extracted_client_name)
        : '';
      const task = loose.task as { name?: string } | null | undefined;
      const taskName = str(task?.name);
      return [
        entry.user?.full_name ?? '',
        isInbox ? 'Inbox' : 'Manual',
        isInbox ? inboxClient : clientByProjectId.get(entry.project_id) ?? '',
        isInbox ? '' : entry.project?.name ?? '',
        taskName,
        entry.entry_date,
        num(entry.hours),
        isInbox ? str(inboxLink?.extracted_supervisor_name) : '',
        entry.approved_by_name ?? '',
        entry.status,
      ];
    });

    const ingestionRows = scopedIngestion.map((ts) => [
      ingestionEmployeeName(ts, userById),
      'Inbox',
      ts.client_name ?? '',
      '',
      '',
      periodLabel(ts),
      num(ts.total_hours),
      ts.extracted_supervisor_name ?? '',
      str(ts.reviewer_name),
      'APPROVED',
    ]);

    // Group by employee, sort each block by date, per-employee subtotal +
    // grand total. Hours is column index 6 across both row shapes.
    const allRows = [...entryRows, ...ingestionRows];
    const groups = new Map<string, typeof allRows>();
    for (const row of allRows) {
      const employee = String(row[0] ?? '');
      const existing = groups.get(employee);
      if (existing) existing.push(row);
      else groups.set(employee, [row]);
    }
    const sortedEmployees = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
    const orderedRows: typeof allRows = [];
    let grandTotal = 0;
    for (const employee of sortedEmployees) {
      const rows = groups.get(employee)!;
      rows.sort((a, b) => String(a[5] ?? '').localeCompare(String(b[5] ?? '')));
      orderedRows.push(...rows);
      const subtotal = rows.reduce((sum, row) => sum + num(row[6]), 0);
      grandTotal += subtotal;
      orderedRows.push([`${employee} subtotal`, '', '', '', '', '', subtotal, '', '', '']);
    }
    const totalRow = ['Total', '', '', '', '', '', grandTotal, '', '', ''];
    const csv = [header, ...orderedRows, totalRow]
      .map((row) => row.map(escape).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    triggerDownload(blob, `team-timesheets-${startDate || 'all'}-to-${endDate || 'all'}.csv`);
  }

  // ── PDF: one branded report per employee ───────────────────────────────
  // Dynamically import jsPDF + autotable. Returns { name, blob } per employee
  // that actually has rows.
  async function buildReports(ids: number[]): Promise<{ name: string; blob: Blob }[]> {
    const { default: jsPDF } = await import('jspdf');
    const autoTableMod = await import('jspdf-autotable');
    const autoTable = (autoTableMod.default ?? autoTableMod) as unknown as (
      doc: unknown,
      opts: Record<string, unknown>,
    ) => void;

    const entriesByEmployee = new Map<number, TimeEntry[]>();
    for (const e of entries) {
      const list = entriesByEmployee.get(e.user_id) ?? [];
      list.push(e);
      entriesByEmployee.set(e.user_id, list);
    }
    const ingestionByEmployee = new Map<number, IngestionTimesheetSummary[]>();
    for (const ts of ingestion) {
      if (ts.employee_id == null) continue;
      const list = ingestionByEmployee.get(ts.employee_id) ?? [];
      list.push(ts);
      ingestionByEmployee.set(ts.employee_id, list);
    }

    const PAGE_MARGIN = 14;
    const HAIRLINE: [number, number, number] = [220, 220, 225];
    const periodStr = startDate && endDate ? `${startDate} – ${endDate}` : startDate || endDate || '';
    const generated = new Date().toISOString().slice(0, 10);

    const reports: { name: string; blob: Blob }[] = [];
    for (const id of ids) {
      const employee = userById.get(id);
      if (!employee) continue;
      const empEntries = entriesByEmployee.get(id) ?? [];
      const empIngestion = ingestionByEmployee.get(id) ?? [];
      if (empEntries.length === 0 && empIngestion.length === 0) continue;

      const manager = employee.manager_id != null ? userById.get(employee.manager_id) : null;
      const supervisors = Array.from(
        new Set(
          empIngestion
            .map((ts) => (ts.extracted_supervisor_name || '').trim())
            .filter((s): s is string => Boolean(s)),
        ),
      );
      const approvers = Array.from(
        new Set(
          empIngestion
            .map((ts) => str(ts.reviewer_name).trim())
            .filter((s) => Boolean(s)),
        ),
      );

      const entryHours = empEntries.reduce((sum, e) => sum + num(e.hours), 0);
      const ingestionHours = empIngestion.reduce((sum, ts) => sum + num(ts.total_hours), 0);
      const totalHours = entryHours + ingestionHours;

      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      let cursorY = PAGE_MARGIN;

      // Header: workspace label left, "Timesheet Report" right.
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.text('Timesheet', PAGE_MARGIN, cursorY + 8);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(80, 80, 90);
      doc.text('Timesheet Report', pageWidth - PAGE_MARGIN, cursorY + 6, { align: 'right' });
      doc.setTextColor(0, 0, 0);

      const headerBottom = cursorY + 12;
      doc.setDrawColor(...HAIRLINE);
      doc.setLineWidth(0.2);
      doc.line(PAGE_MARGIN, headerBottom, pageWidth - PAGE_MARGIN, headerBottom);
      cursorY = headerBottom + 8;

      // Metadata block (empty fields omitted).
      const metaRows: Array<[string, string]> = [];
      metaRows.push(['Employee', employee.full_name]);
      if (manager?.full_name) metaRows.push(['Manager', manager.full_name]);
      if (supervisors.length > 0) metaRows.push(['Supervisor', supervisors.join(', ')]);
      if (periodStr) metaRows.push(['Period', periodStr]);
      if (totalHours > 0) metaRows.push(['Total hours', `${totalHours.toFixed(1)} h`]);

      doc.setFontSize(10);
      for (const [label, value] of metaRows) {
        doc.setTextColor(110, 110, 120);
        doc.text(label, PAGE_MARGIN, cursorY);
        doc.setTextColor(20, 20, 25);
        doc.text(value, PAGE_MARGIN + 32, cursorY);
        cursorY += 5.5;
      }
      doc.setTextColor(0, 0, 0);
      cursorY += 4;

      // Unified Client / Project / Days / Hours table. Manual entries
      // aggregate by (Client, Project); ingestion rows aggregate by Client
      // with a blank project + N/A days.
      type Agg = { client: string; project: string; days: Set<string>; hours: number };
      const aggMap = new Map<string, Agg>();
      for (const entry of empEntries) {
        const project = entry.project?.name ?? 'N/A';
        const client = clientByProjectId.get(entry.project_id) ?? '';
        const key = `entry|${client}|${project}`;
        const existing = aggMap.get(key);
        if (existing) {
          existing.days.add(entry.entry_date);
          existing.hours += num(entry.hours);
        } else {
          aggMap.set(key, {
            client,
            project,
            days: new Set([entry.entry_date]),
            hours: num(entry.hours),
          });
        }
      }
      for (const ts of empIngestion) {
        const client = ts.client_name || 'Unspecified client';
        const key = `ingestion|${client}`;
        const existing = aggMap.get(key);
        if (existing) existing.hours += num(ts.total_hours);
        else aggMap.set(key, { client, project: '', days: new Set<string>(), hours: num(ts.total_hours) });
      }

      const summaryRows = Array.from(aggMap.values())
        .sort((a, b) => {
          const c = a.client.localeCompare(b.client);
          return c !== 0 ? c : a.project.localeCompare(b.project);
        })
        .map((row) => [
          row.client,
          row.project,
          row.days.size > 0 ? String(row.days.size) : 'N/A',
          `${row.hours.toFixed(1)} h`,
        ]);

      const totalDays = new Set(empEntries.map((e) => e.entry_date)).size;
      if (summaryRows.length > 0) {
        autoTable(doc, {
          startY: cursorY,
          head: [['Client', 'Project', 'Days', 'Total hours']],
          body: summaryRows,
          foot: [['Total', '', totalDays > 0 ? String(totalDays) : 'N/A', `${totalHours.toFixed(1)} h`]],
          theme: 'plain',
          margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
          styles: {
            font: 'helvetica',
            fontSize: 10,
            cellPadding: { top: 2.2, bottom: 2.2, left: 2, right: 2 },
          },
          headStyles: {
            fillColor: [248, 248, 250],
            textColor: [60, 60, 70],
            fontStyle: 'bold',
            lineWidth: { bottom: 0.3 },
            lineColor: HAIRLINE,
          },
          footStyles: {
            fillColor: [248, 248, 250],
            textColor: [40, 40, 50],
            fontStyle: 'bold',
            lineWidth: { top: 0.3 },
            lineColor: HAIRLINE,
          },
          bodyStyles: { lineWidth: { bottom: 0.1 }, lineColor: HAIRLINE },
          columnStyles: {
            2: { halign: 'right', cellWidth: 22 },
            3: { halign: 'right', cellWidth: 32 },
          },
        });
      } else {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(110, 110, 120);
        doc.text('No time entries in the selected period.', PAGE_MARGIN, cursorY);
        doc.setTextColor(0, 0, 0);
      }

      // Footer on every page.
      const pageCount = doc.getNumberOfPages();
      for (let i = 1; i <= pageCount; i += 1) {
        doc.setPage(i);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(140, 140, 150);
        const footerY = pageHeight - 8;
        if (approvers.length > 0) {
          doc.text(`Approved by ${approvers.join(', ')}`, PAGE_MARGIN, footerY, { align: 'left' });
          doc.text(`Generated ${generated}`, pageWidth / 2, footerY, { align: 'center' });
          doc.text(`Page ${i} / ${pageCount}`, pageWidth - PAGE_MARGIN, footerY, { align: 'right' });
        } else {
          doc.text(
            `Generated ${generated}  ·  Page ${i} / ${pageCount}`,
            pageWidth / 2,
            footerY,
            { align: 'center' },
          );
        }
        doc.setTextColor(0, 0, 0);
      }

      reports.push({
        name: employeePdfFilename(employee.full_name, startDate, endDate),
        blob: doc.output('blob'),
      });
    }
    return reports;
  }

  async function exportPdf(ids: number[]) {
    const reports = await buildReports(ids);
    if (reports.length === 0) {
      setError('Nothing to export for the current selection.');
      return;
    }
    if (reports.length === 1) {
      triggerDownload(reports[0].blob, reports[0].name);
      return;
    }
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    for (const { name, blob } of reports) {
      zip.file(name, await blob.arrayBuffer());
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const stamp = startDate && endDate ? `-${startDate}-to-${endDate}` : '';
    triggerDownload(zipBlob, `team-timesheets${stamp}.zip`);
  }

  async function exportPrint(ids: number[]) {
    const reports = await buildReports(ids);
    if (reports.length === 0) {
      setError('Nothing to export for the current selection.');
      return;
    }
    // Print the first selected employee. Opening N native print dialogs is
    // hostile; the hint warns the user.
    const first = reports[0];
    const url = URL.createObjectURL(first.blob);
    const win = window.open(url, '_blank');
    if (!win) {
      // Popup blocked: fall back to a download so the export isn't lost.
      triggerDownload(first.blob, first.name);
      URL.revokeObjectURL(url);
      return;
    }
    win.addEventListener('load', () => {
      try {
        win.focus();
        win.print();
      } catch {
        // Older browsers throw on print() for blob URLs; the user can still
        // print from the opened tab manually.
      }
    });
  }

  async function handleExport() {
    setError(null);
    const ids = effectiveIds();
    if (ids.length === 0) {
      setError('No employees with timesheets in this view.');
      return;
    }
    setBusy(true);
    try {
      if (format === 'csv') {
        exportCsv(ids);
      } else if (format === 'pdf') {
        await exportPdf(ids);
      } else {
        await exportPrint(ids);
      }
      // Leave the modal open on error (set above); close on a clean run.
      if (!error) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const count = selection.size;
  const exportLabel = (() => {
    if (busy) return 'Working…';
    if (format === 'csv') return 'Download CSV';
    if (format === 'pdf') return count > 1 ? `Download ZIP (${count})` : 'Download PDF';
    return 'Open in new tab';
  })();
  const formatHint = (() => {
    if (format === 'csv') return 'One grouped CSV merging manual + inbox rows, with per-employee subtotals.';
    if (format === 'pdf') return 'One PDF per employee. Bundled as a ZIP when multiple are picked.';
    return 'Opens the first selected employee in a new tab and triggers print.';
  })();

  const FORMATS: { value: ExportFormat; label: string }[] = [
    { value: 'csv', label: 'CSV' },
    { value: 'pdf', label: 'PDF' },
    { value: 'print', label: 'Print' },
  ];

  return (
    <Modal open={open} onClose={onClose} title="Export approved timesheets" className="max-w-lg">
      <div className="space-y-4">
        {/* Format segmented control */}
        <div>
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Format</span>
          <div className="inline-flex w-full overflow-hidden rounded-full border border-border">
            {FORMATS.map((f) => {
              const on = format === f.value;
              return (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFormat(f.value)}
                  aria-pressed={on}
                  className={cn(
                    'flex-1 px-3 py-1.5 text-xs font-medium transition',
                    on
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground',
                  )}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">{formatHint}</p>
        </div>

        {/* Employee picker */}
        <div className="border-t border-border pt-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search employees…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-full rounded-full border border-border bg-transparent pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {count === 0 ? `${availableEmployees.length} available` : `${count} selected`}
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                onClick={() => setSelection(new Set(availableEmployees.map((u) => u.id)))}
              >
                Select all
              </button>
              <button
                type="button"
                className="text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setSelection(new Set())}
              >
                Clear
              </button>
            </div>
          </div>

          <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-border">
            {filteredEmployees.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No employees with timesheets in this view.
              </p>
            ) : (
              filteredEmployees.map((u) => {
                const checked = selection.has(u.id);
                return (
                  <button
                    type="button"
                    key={u.id}
                    onClick={() => toggle(u.id)}
                    className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-foreground transition hover:bg-primary/5"
                  >
                    <span
                      className={cn(
                        'grid h-4 w-4 shrink-0 place-items-center rounded border',
                        checked
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border',
                      )}
                    >
                      {checked && <Check className="h-3 w-3" />}
                    </span>
                    <span className="truncate">{u.full_name}</span>
                  </button>
                );
              })
            )}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Leave the selection empty to export everyone available.
          </p>
        </div>

        {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleExport} disabled={busy}>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : format === 'print' ? (
              <Printer className="h-3.5 w-3.5" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {exportLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
