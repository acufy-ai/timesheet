/**
 * Per-employee Team Timesheet PDF report generator.
 *
 * Runs entirely client-side: the data already loaded into the
 * Team Timesheets tab (entries + employees + tenant) gets formatted
 * into one PDF per employee. No backend round-trip, no shared
 * intermediate file, nothing that could leak between tenants.
 *
 * Layout (see design discussion):
 *   Tenant logo / name (top-left)         "Timesheet Report" (top-right)
 *   --------------------------------------------------------------
 *   Employee  / Manager / Period / Status / Total hours (label/value list,
 *     any empty field is omitted entirely)
 *
 *   PROJECT SUMMARY
 *   Project | Days | Total hours
 *   ...
 *   Total   | Σ    | Σ
 *
 *   Footer: generated date · tenant name · page N / M
 *
 * Fields hide when empty for the selected employee, per the design
 * brief; only what is actually present for that person is rendered.
 */
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format, parseISO } from 'date-fns';

import type { TimeEntry, User } from '@/types';

export interface PdfTenantBranding {
  name: string;
  // Data URL (PNG/JPG/WEBP/GIF). When null the tenant name is rendered
  // as text in the header.
  logoDataUrl: string | null;
  // MIME type, used by jsPDF to pick the right image decoder.
  logoMime: string | null;
}

export interface PdfReportFilters {
  startDate?: string | null;
  endDate?: string | null;
  status?: string | null;
}

/** Summary-only timesheet approved via the inbox queue (no line items
 *  were extracted into TimeEntry rows). The PDF renders these in a
 *  separate "Inbox-approved" section keyed by client, since they have
 *  no project — the client name IS the grouping signal. */
export interface PdfIngestionTimesheet {
  client_name: string | null;
  period_start: string | null;
  period_end: string | null;
  total_hours: number | string | null;
}

export interface PdfReportInput {
  employee: User;
  entries: TimeEntry[];
  ingestionTimesheets?: PdfIngestionTimesheet[];
  managerName?: string | null;
  /** Distinct supervisor names extracted from the employee's ingestion
   *  timesheets, if any. Shown in the metadata block under "Supervisor"
   *  when non-empty. Real TimeEntry rows don't carry a supervisor field
   *  — this is purely the ingestion source. */
  supervisorNames?: string[];
  /** Distinct reviewer (approver) names from the employee's ingestion
   *  timesheets. Shown in the footer as "Approved by …" when present.
   *  Kept out of the metadata block on purpose: the per-employee header
   *  is for the person whose hours are being reported, while reviewer
   *  attribution belongs alongside generation provenance. */
  approverNames?: string[];
  /** Map of project_id → client name. Used to render a unified
   *  Client / Project / Days / Hours table that works for both real
   *  TimeEntries (project + client lookup) and ingestion rows (client
   *  directly on the row, no project). Pass an empty map if the caller
   *  can't resolve client names — the Client column will just be blank
   *  for real entries in that case. */
  clientByProjectId?: Map<number, string>;
  branding: PdfTenantBranding;
  filters: PdfReportFilters;
}

const PAGE_MARGIN = 14; // mm
const HEADER_HEIGHT = 22;
const BODY_TEXT = 10;
const LABEL_COLOR: [number, number, number] = [110, 110, 120];
const HAIRLINE_COLOR: [number, number, number] = [220, 220, 225];
const FOOTER_COLOR: [number, number, number] = [140, 140, 150];

const fmtDate = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  try {
    return format(parseISO(iso), 'MMM d, yyyy');
  } catch {
    return iso;
  }
};

const fmtPeriod = (start?: string | null, end?: string | null): string | null => {
  const s = fmtDate(start);
  const e = fmtDate(end);
  if (s && e) return s === e ? s : `${s} – ${e}`;
  return s || e || null;
};

const statusLabel = (status?: string | null): string | null => {
  if (!status) return null;
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
};

/**
 * Exposed for testing. Builds the metadata label/value rows shown
 * at the top of an employee report, with empty fields omitted so the
 * PDF only renders fields that have data for the selected employee.
 */
export const buildMetadataRows = (
  employee: { full_name?: string | null },
  entries: { hours?: number | string }[],
  managerName: string | null | undefined,
  filters: PdfReportFilters,
  ingestionTimesheets: PdfIngestionTimesheet[] = [],
  supervisorNames: string[] = [],
): Array<[string, string]> => {
  const entryHours = entries.reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const ingestionHours = ingestionTimesheets.reduce(
    (sum, ts) => sum + Number(ts.total_hours || 0),
    0,
  );
  const totalHours = entryHours + ingestionHours;
  const period = fmtPeriod(filters.startDate, filters.endDate);
  const rows: Array<[string, string]> = [];
  if (employee.full_name) rows.push(['Employee', employee.full_name]);
  if (managerName) rows.push(['Manager', managerName]);
  // Supervisor (extracted from the employee's ingestion timesheets).
  // Deduplicated; multiple distinct names get comma-joined. Empty when
  // there's no ingestion source or no supervisor was extracted.
  const distinctSupervisors = Array.from(
    new Set(supervisorNames.map((s) => (s || '').trim()).filter(Boolean)),
  );
  if (distinctSupervisors.length > 0) {
    rows.push(['Supervisor', distinctSupervisors.join(', ')]);
  }
  if (period) rows.push(['Period', period]);
  if (statusLabel(filters.status)) rows.push(['Status', statusLabel(filters.status) as string]);
  if (totalHours > 0) rows.push(['Total hours', `${totalHours.toFixed(1)} h`]);
  return rows;
};

const mimeToImageFormat = (mime: string | null): 'PNG' | 'JPEG' | 'WEBP' => {
  if (!mime) return 'PNG';
  const m = mime.toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'JPEG';
  if (m.includes('webp')) return 'WEBP';
  return 'PNG';
};

/**
 * Builds a per-employee PDF and returns its Blob. Caller decides what
 * to do with it (download, zip, open-and-print).
 */
export const buildEmployeeTimesheetPdf = (input: PdfReportInput): Blob => {
  const { employee, entries, managerName, branding, filters } = input;
  const ingestionTimesheets = input.ingestionTimesheets ?? [];
  const supervisorNames = input.supervisorNames ?? [];
  const approverNames = input.approverNames ?? [];
  const clientByProjectId = input.clientByProjectId ?? new Map<number, string>();
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  // ── Header ───────────────────────────────────────────────────────
  let cursorY = PAGE_MARGIN;
  const headerBottom = cursorY + HEADER_HEIGHT;

  // Logo (or tenant name text fallback) — top left. Preserve aspect
  // ratio: scale to fit max 14mm tall and max 60mm wide. Without this,
  // the previous code forced 32×12 mm which squashed any logo that
  // wasn't 8:3, including the dark-rounded-rect Acufy mark used in the
  // settings preview.
  const LOGO_MAX_H_MM = 14;
  const LOGO_MAX_W_MM = 60;
  let logoBottomY = cursorY;
  if (branding.logoDataUrl) {
    try {
      const fmt = mimeToImageFormat(branding.logoMime);
      // jsPDF reads the pixel dims off the data URL; we convert to mm
      // by scaling to fit the configured box while keeping the ratio.
      const props = doc.getImageProperties(branding.logoDataUrl);
      const pxW = props.width || 1;
      const pxH = props.height || 1;
      const ratio = pxW / pxH;
      let drawW = LOGO_MAX_H_MM * ratio;
      let drawH = LOGO_MAX_H_MM;
      if (drawW > LOGO_MAX_W_MM) {
        drawW = LOGO_MAX_W_MM;
        drawH = LOGO_MAX_W_MM / ratio;
      }
      doc.addImage(branding.logoDataUrl, fmt, PAGE_MARGIN, cursorY, drawW, drawH, undefined, 'FAST');
      logoBottomY = cursorY + drawH;
    } catch {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.text(branding.name, PAGE_MARGIN, cursorY + 8);
      logoBottomY = cursorY + 10;
    }
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(branding.name, PAGE_MARGIN, cursorY + 8);
    logoBottomY = cursorY + 10;
  }

  // "Timesheet Report" — top right.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(80, 80, 90);
  doc.text('Timesheet Report', pageWidth - PAGE_MARGIN, cursorY + 6, { align: 'right' });
  doc.setTextColor(0, 0, 0);

  // Hairline under header. Pin it below the taller of logo / title so
  // we don't draw the line through a tall logo. Title baseline sits at
  // cursorY + 6, with descender slack ~2mm; logo bottom is computed.
  const titleBaseline = cursorY + 8;
  const effectiveHeaderBottom = Math.max(logoBottomY, titleBaseline) + 4;
  doc.setDrawColor(...HAIRLINE_COLOR);
  doc.setLineWidth(0.2);
  doc.line(PAGE_MARGIN, effectiveHeaderBottom, pageWidth - PAGE_MARGIN, effectiveHeaderBottom);

  cursorY = effectiveHeaderBottom + 8;

  // ── Metadata block (label/value list, empty fields hidden) ───────
  const entryHours = entries.reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const ingestionHours = ingestionTimesheets.reduce(
    (sum, ts) => sum + Number(ts.total_hours || 0),
    0,
  );
  const totalHours = entryHours + ingestionHours;
  const metaRows = buildMetadataRows(
    employee, entries, managerName, filters, ingestionTimesheets, supervisorNames,
  );

  doc.setFontSize(BODY_TEXT);
  metaRows.forEach(([label, value]) => {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...LABEL_COLOR);
    doc.text(label, PAGE_MARGIN, cursorY);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(20, 20, 25);
    doc.text(value, PAGE_MARGIN + 32, cursorY);
    cursorY += 5.5;
  });
  doc.setTextColor(0, 0, 0);

  cursorY += 4;

  // ── Unified timesheet summary table ──────────────────────────────
  // Real TimeEntry rows aggregate by (Client, Project); ingestion-only
  // rows aggregate by Client with a blank Project. One table, one look
  // — the report doesn't shout "this part was extracted from an email."
  // Days = number of distinct entry dates for real entries; blank for
  // ingestion-only rows since there's no per-day breakdown.

  type SummaryRow = { client: string; project: string; days: Set<string>; hours: number };
  const aggMap = new Map<string, SummaryRow>();

  // Real entries → Client (looked up from project_id) + Project.
  for (const entry of entries) {
    const project = entry.project?.name ?? 'N/A';
    const client = entry.project_id != null
      ? (clientByProjectId.get(entry.project_id) ?? '')
      : '';
    const key = `entry|${client}|${project}`;
    const existing = aggMap.get(key);
    if (existing) {
      existing.days.add(entry.entry_date);
      existing.hours += Number(entry.hours || 0);
    } else {
      aggMap.set(key, {
        client,
        project,
        days: new Set([entry.entry_date]),
        hours: Number(entry.hours || 0),
      });
    }
  }

  // Ingestion-only rows → Client only, Project left blank. Aggregate
  // by client to avoid two adjacent rows for the same client when
  // multiple weekly timesheets were approved for the same period.
  for (const ts of ingestionTimesheets) {
    const client = ts.client_name || 'Unspecified client';
    const key = `ingestion|${client}`;
    const existing = aggMap.get(key);
    if (existing) {
      existing.hours += Number(ts.total_hours || 0);
    } else {
      aggMap.set(key, {
        client,
        project: '',
        days: new Set<string>(),
        hours: Number(ts.total_hours || 0),
      });
    }
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

  if (summaryRows.length > 0) {
    const totalDays = new Set(entries.map((e) => e.entry_date)).size;
    autoTable(doc, {
      startY: cursorY,
      head: [['Client', 'Project', 'Days', 'Total hours']],
      body: summaryRows,
      foot: [['Total', '', totalDays > 0 ? String(totalDays) : 'N/A', `${totalHours.toFixed(1)} h`]],
      theme: 'plain',
      margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
      styles: { font: 'helvetica', fontSize: BODY_TEXT, cellPadding: { top: 2.2, bottom: 2.2, left: 2, right: 2 } },
      headStyles: {
        fillColor: [248, 248, 250],
        textColor: [60, 60, 70],
        fontStyle: 'bold',
        lineWidth: { bottom: 0.3 },
        lineColor: HAIRLINE_COLOR,
      },
      footStyles: {
        fillColor: [248, 248, 250],
        textColor: [40, 40, 50],
        fontStyle: 'bold',
        lineWidth: { top: 0.3 },
        lineColor: HAIRLINE_COLOR,
      },
      bodyStyles: {
        lineWidth: { bottom: 0.1 },
        lineColor: HAIRLINE_COLOR,
      },
      columnStyles: {
        2: { halign: 'right', cellWidth: 22 },
        3: { halign: 'right', cellWidth: 32 },
      },
    });
  } else {
    // Defensive — the picker filters out zero-data employees, so we
    // shouldn't actually reach here. Leave a short note instead of
    // a blank report if we do.
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(BODY_TEXT);
    doc.setTextColor(...LABEL_COLOR);
    doc.text('No time entries in the selected period.', PAGE_MARGIN, cursorY);
    doc.setTextColor(0, 0, 0);
  }

  // ── Footer (every page) ──────────────────────────────────────────
  // Three-column layout when an approver is present:
  //   [Approved by …]              [Generated · Tenant]              [Page N/M]
  // No-approver case falls back to the original centered single-line
  // layout so single-source (non-ingestion) reports stay clean.
  const pageCount = doc.getNumberOfPages();
  const generated = format(new Date(), 'MMM d, yyyy');
  const distinctApprovers = Array.from(
    new Set(approverNames.map((n) => (n || '').trim()).filter(Boolean)),
  );
  for (let i = 1; i <= pageCount; i += 1) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...FOOTER_COLOR);
    const footerY = pageHeight - 8;
    if (distinctApprovers.length > 0) {
      doc.text(`Approved by ${distinctApprovers.join(', ')}`, PAGE_MARGIN, footerY, { align: 'left' });
      doc.text(`Generated ${generated}  ·  ${branding.name}`, pageWidth / 2, footerY, { align: 'center' });
      doc.text(`Page ${i} / ${pageCount}`, pageWidth - PAGE_MARGIN, footerY, { align: 'right' });
    } else {
      const footer = `Generated ${generated}  ·  ${branding.name}  ·  Page ${i} / ${pageCount}`;
      doc.text(footer, pageWidth / 2, footerY, { align: 'center' });
    }
    doc.setTextColor(0, 0, 0);
  }

  return doc.output('blob');
};

/**
 * Slug-safe filename for a per-employee PDF. Falls back to "employee"
 * when the name is empty/punctuation-only.
 */
export const employeePdfFilename = (
  employeeName: string,
  filters: PdfReportFilters,
): string => {
  const slug = (employeeName || 'employee')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const stamp = filters.startDate && filters.endDate
    ? `-${filters.startDate}-to-${filters.endDate}`
    : '';
  return `${slug || 'employee'}-timesheet${stamp}.pdf`;
};
