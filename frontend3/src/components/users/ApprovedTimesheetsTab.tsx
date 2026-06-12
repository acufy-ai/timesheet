import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Loader2, Paperclip } from 'lucide-react';

import { Button, Card, Empty, Input, StatusBadge } from '@/components/ui';
import { useApprovedIngestionTimesheets, useTeamTimesheets, useTenantSettings } from '@/hooks/useAdmin';
import { SourceFileViewer } from './SourceFileViewer';
import { ApprovedExportModal } from './ApprovedExportModal';
import { timesheetStatusKey, type TimeEntry } from '@/types/time';
import type { IngestionTimesheetSummary } from '@/types/admin';

const num = (v: string | number | null | undefined) => (typeof v === 'string' ? parseFloat(v) : v) || 0;

// Week key for an ISO date string honoring the tenant's configured week start
// (0 = Sunday, 1 = Monday). frontend2 uses the tenant setting; we read it from
// the tenant-settings catalog values rather than hardcoding Monday.
function weekStartKey(dateStr: string, weekStartsOn: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  const diff = (d.getDay() - weekStartsOn + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
}
function fmtDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtTs(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtTimeBlock(start?: string | null, end?: string | null): string | null {
  if (!start && !end) return null;
  const t = (v?: string | null) => (v ? v.slice(0, 5) : '');
  return `${t(start)}${start || end ? '–' : ''}${t(end)}`;
}

// Collapse a set of statuses to one badge (REJECTED > DRAFT > SUBMITTED > APPROVED),
// or 'MIXED' when more than one distinct status is present.
function collapseStatus(statuses: string[]): { key: string; mixed: boolean } {
  const set = new Set(statuses.map((s) => s.toUpperCase()));
  if (set.size > 1) return { key: [...set].sort()[0], mixed: true };
  const order = ['REJECTED', 'DRAFT', 'SUBMITTED', 'APPROVED'];
  for (const s of order) if (set.has(s)) return { key: s, mixed: false };
  return { key: [...set][0] ?? 'APPROVED', mixed: false };
}

// Approved Timesheets tab (admin): the whole tenant's MANUAL entries merged with
// approved INBOX (PDF) submissions, grouped employee -> week -> day with source-
// file viewing and a CSV/PDF/Print export. Mirrors frontend2's team-timesheets.
export function ApprovedTimesheetsTab() {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState('APPROVED');
  const [empSearch, setEmpSearch] = useState('');

  const q = useTeamTimesheets({
    start_date: startDate || undefined,
    end_date: endDate || undefined,
    status: status === 'all' ? undefined : status,
  });
  // Inbox-approved PDF timesheets (only relevant for the APPROVED view). These
  // are contractor submissions with no manual TimeEntry rows; without them an
  // inbox-only tenant's Approved tab would appear empty.
  const showInbox = status === 'all' || status === 'APPROVED';
  const inboxQ = useApprovedIngestionTimesheets(showInbox, { scope: 'workspace' });

  // Tenant week-start (0 Sun / 1 Mon). Default Monday if unset.
  const settingsQ = useTenantSettings();
  const weekStartsOn = useMemo(() => {
    const v = settingsQ.data?.week_start_day;
    return v === 0 || v === '0' ? 0 : 1;
  }, [settingsQ.data]);

  const entries = (q.data ?? []) as TimeEntry[];

  // Inbox rows that aren't already materialized into TimeEntry rows (so a PDF
  // already turned into day entries isn't double-counted), within the date window.
  const inboxRows = useMemo<IngestionTimesheetSummary[]>(() => {
    if (!showInbox) return [];
    const list = (inboxQ.data ?? []).filter((t) => !t.time_entries_created && num(t.total_hours) > 0);
    if (!startDate && !endDate) return list;
    return list.filter((t) => {
      const d = (t.period_start ?? t.reviewed_at ?? '').slice(0, 10);
      if (!d) return true;
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return true;
    });
  }, [inboxQ.data, showInbox, startDate, endDate]);

  const search = empSearch.trim().toLowerCase();
  const filteredEntries = useMemo(
    () => (search ? entries.filter((e) => (e.user?.full_name ?? '').toLowerCase().includes(search)) : entries),
    [entries, search],
  );
  const filteredInbox = useMemo(
    () => (search ? inboxRows.filter((t) => (t.employee_name ?? t.extracted_employee_name ?? '').toLowerCase().includes(search)) : inboxRows),
    [inboxRows, search],
  );

  // Group manual entries: employee -> week -> day entries. Inbox rows attach as
  // a per-employee list of PDF submissions.
  type WeekGroup = { weekStart: string; entries: TimeEntry[]; hours: number };
  type EmpGroup = { userId: number; name: string; weeks: WeekGroup[]; hours: number; count: number; statuses: string[]; inbox: IngestionTimesheetSummary[]; inboxHours: number };
  const groups = useMemo<EmpGroup[]>(() => {
    const byEmp = new Map<number, EmpGroup>();
    const ensure = (id: number, name: string): EmpGroup => {
      let g = byEmp.get(id);
      if (!g) { g = { userId: id, name, weeks: [], hours: 0, count: 0, statuses: [], inbox: [], inboxHours: 0 }; byEmp.set(id, g); }
      return g;
    };
    // Manual entries.
    const weekMap = new Map<string, Map<string, TimeEntry[]>>(); // empId -> weekStart -> entries
    filteredEntries.forEach((e) => {
      const uid = e.user?.id ?? e.user_id ?? -1;
      const g = ensure(uid, e.user?.full_name ?? '—');
      g.count += 1; g.hours += num(e.hours); g.statuses.push(e.status);
      const wk = weekStartKey(e.entry_date, weekStartsOn);
      const empKey = `${uid}`;
      if (!weekMap.has(empKey)) weekMap.set(empKey, new Map());
      const wm = weekMap.get(empKey)!;
      if (!wm.has(wk)) wm.set(wk, []);
      wm.get(wk)!.push(e);
    });
    weekMap.forEach((wm, empKey) => {
      const g = byEmp.get(Number(empKey));
      if (!g) return;
      g.weeks = [...wm.entries()]
        .map(([wk, es]) => ({ weekStart: wk, entries: es.sort((a, b) => a.entry_date.localeCompare(b.entry_date)), hours: es.reduce((s, e) => s + num(e.hours), 0) }))
        .sort((a, b) => b.weekStart.localeCompare(a.weekStart));
    });
    // Inbox rows.
    filteredInbox.forEach((t) => {
      const uid = t.employee_id ?? -(t.id); // negative synthetic id for unmatched inbox employees
      const name = t.employee_name ?? t.extracted_employee_name ?? '(unmatched)';
      const g = ensure(uid, name);
      g.inbox.push(t); g.inboxHours += num(t.total_hours); g.statuses.push(String(t.status));
    });
    return [...byEmp.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [filteredEntries, filteredInbox, weekStartsOn]);

  const totals = useMemo(() => ({
    employees: groups.length,
    entries: filteredEntries.length,
    inbox: filteredInbox.length,
    hours: filteredEntries.reduce((acc, e) => acc + num(e.hours), 0) + filteredInbox.reduce((acc, t) => acc + num(t.total_hours), 0),
  }), [groups, filteredEntries, filteredInbox]);

  const [expandedEmp, setExpandedEmp] = useState<Set<number>>(new Set());
  const [expandedWeek, setExpandedWeek] = useState<Set<string>>(new Set());
  const toggleEmp = (id: number) => setExpandedEmp((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleWeek = (k: string) => setExpandedWeek((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const rangeTooWide = useMemo(() => {
    if (!startDate || !endDate) return false;
    return (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000 > 31;
  }, [startDate, endDate]);

  const [viewAttachment, setViewAttachment] = useState<{ id: number; filename: string } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  const loading = q.isLoading || (showInbox && inboxQ.isLoading);
  const inputClass = 'h-9 rounded-full border border-border bg-transparent px-4 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <Input className="min-w-[200px] flex-1" placeholder="Filter by employee..." value={empSearch} onChange={(e) => setEmpSearch(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          <option value="APPROVED">Approved</option>
          <option value="SUBMITTED">Submitted</option>
          <option value="REJECTED">Rejected</option>
          <option value="DRAFT">Draft</option>
        </select>
        <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-auto" aria-label="Start date" />
        <span className="text-xs text-muted-foreground">→</span>
        <Input type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} className="w-auto" aria-label="End date" />
        <Button variant="secondary" onClick={() => setExportOpen(true)}>
          <Download className="h-4 w-4" /> Export
        </Button>
      </Card>

      {rangeTooWide ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          The selected range is over 31 days. Narrow it for faster, more readable results.
        </div>
      ) : null}

      {loading ? (
        <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>
      ) : q.isError ? (
        <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">Couldn't load timesheets. Try refreshing.</Card>
      ) : groups.length === 0 ? (
        <Empty title="No timesheets match" description="Adjust the date range, status, or employee filter." />
      ) : (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-muted-foreground">
            <span>{totals.employees} {totals.employees === 1 ? 'employee' : 'employees'} · {totals.entries} entries{totals.inbox ? ` · ${totals.inbox} inbox` : ''}</span>
            <span className="tabular-nums">{totals.hours.toFixed(2)}h total</span>
          </div>
          <div className="divide-y divide-border">
            {groups.map((g) => {
              const empOpen = expandedEmp.has(g.userId);
              const st = collapseStatus(g.statuses);
              return (
                <div key={g.userId}>
                  <button type="button" onClick={() => toggleEmp(g.userId)} className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-primary/5">
                    {empOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                    <span className="flex-1 font-medium text-foreground">{g.name}</span>
                    {g.inbox.length ? <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">Inbox</span> : null}
                    <span className="text-xs text-muted-foreground">{g.weeks.length} {g.weeks.length === 1 ? 'week' : 'weeks'} · {g.count} entries{g.inbox.length ? ` · ${g.inbox.length} submission${g.inbox.length === 1 ? '' : 's'}` : ''}</span>
                    {st.mixed ? <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">Mixed</span> : <StatusBadge status={st.key.toLowerCase()} variant="timesheet" showIcon={false} />}
                    <span className="w-20 text-right tabular-nums text-sm text-foreground">{(g.hours + g.inboxHours).toFixed(2)}h</span>
                  </button>

                  {empOpen ? (
                    <div className="bg-muted/20">
                      {/* Manual weeks */}
                      {g.weeks.map((w) => {
                        const wkey = `${g.userId}|${w.weekStart}`;
                        const wkOpen = expandedWeek.has(wkey);
                        return (
                          <div key={wkey}>
                            <button type="button" onClick={() => toggleWeek(wkey)} className="flex w-full items-center gap-2 px-4 py-2 pl-10 text-left hover:bg-primary/5">
                              {wkOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                              <span className="flex-1 text-sm text-foreground">Week of {fmtDate(w.weekStart)}</span>
                              <span className="text-xs text-muted-foreground">{w.entries.length} {w.entries.length === 1 ? 'entry' : 'entries'}</span>
                              <span className="w-20 text-right tabular-nums text-sm text-muted-foreground">{w.hours.toFixed(2)}h</span>
                            </button>
                            {wkOpen ? (
                              <div className="space-y-2 px-4 pb-3 pl-16">
                                {w.entries.map((e) => {
                                  const block = fmtTimeBlock(e.start_time, e.end_time);
                                  return (
                                    <div key={e.id} className="rounded-lg border border-border bg-card p-2.5 text-sm">
                                      <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                          <p className="font-medium text-foreground">
                                            {e.project?.name ?? `#${e.project_id}`}
                                          </p>
                                          {e.description ? <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">{e.description}</p> : null}
                                        </div>
                                        <div className="shrink-0 text-right">
                                          <p className="tabular-nums font-semibold text-foreground">{num(e.hours).toFixed(2)}h</p>
                                          {block ? <p className="text-[11px] tabular-nums text-muted-foreground">{block}</p> : null}
                                        </div>
                                      </div>
                                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
                                        <span><StatusBadge status={timesheetStatusKey(e.status)} variant="timesheet" showIcon={false} /></span>
                                        <span>{fmtDate(e.entry_date)}</span>
                                        {e.submitted_at ? <span>Submitted {fmtTs(e.submitted_at)}</span> : null}
                                        {e.approved_by_name ? <span>Approved by {e.approved_by_name}</span> : null}
                                        {e.rejected_by_name ? <span className="text-rose-600 dark:text-rose-300">Rejected by {e.rejected_by_name}{e.rejection_reason ? `: ${e.rejection_reason}` : ''}</span> : null}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}

                      {/* Inbox (PDF) submissions */}
                      {g.inbox.length ? (
                        <div className="space-y-2 px-4 py-3 pl-10">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Inbox submissions</p>
                          {g.inbox.map((t) => (
                            <div key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-2.5 text-sm">
                              <div className="min-w-0">
                                <p className="font-medium text-foreground">
                                  {t.client_name ?? t.extracted_client_name ?? 'Client'}
                                  <span className="ml-1.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-amber-700 dark:text-amber-300">Inbox</span>
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {t.period_start ? fmtDate(t.period_start) : '—'}{t.period_end ? ` – ${fmtDate(t.period_end)}` : ''}
                                  {t.extracted_supervisor_name ? ` · Supervisor: ${t.extracted_supervisor_name}` : ''}
                                </p>
                              </div>
                              <div className="flex shrink-0 items-center gap-3">
                                <span className="tabular-nums font-semibold text-foreground">{num(t.total_hours).toFixed(2)}h</span>
                                <StatusBadge status="approved" variant="timesheet" showIcon={false} label="Approved" />
                                {t.attachment_id ? (
                                  <button type="button" aria-label="View source file" title="View source file" onClick={() => setViewAttachment({ id: t.attachment_id as number, filename: t.subject ?? 'attachment' })} className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-primary/10 hover:text-primary">
                                    <Paperclip className="h-4 w-4" />
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <SourceFileViewer
        open={!!viewAttachment}
        attachmentId={viewAttachment?.id ?? null}
        filename={viewAttachment?.filename}
        onClose={() => setViewAttachment(null)}
      />
      <ApprovedExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        entries={filteredEntries}
        ingestion={filteredInbox}
        startDate={startDate}
        endDate={endDate}
      />
    </div>
  );
}
