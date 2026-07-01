import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, Loader2, Pencil, SlidersHorizontal, StickyNote } from 'lucide-react';

import { Toast, WorkspaceHeader } from '@/components/ui';
import { NoteModal } from '@/components/notes/NoteModal';
import { HealthRulesModal } from '@/components/dashboard/HealthRulesModal';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/cn';
import { useEvm, useManagerFinancials, usePortfolio, useProjectTaskBreakdown, useRevenueRecognition, useSetProjectHealthOverride } from '@/hooks/useDashboard';
import { healthMeta, MANUAL_HEALTH } from '@/lib/projectHealth';
import { buildProjectHealthView } from '@/lib/projectHealthView';
import {
  SummaryCardRow,
  CriticalIssuesPanel,
  ExecutionStatus,
  KpiCard,
  MetricTable,
} from '@/components/project/ProjectHealthSections';

// Standardized, data-driven Project Detail / Project Health page. The layout,
// section order and card structure are IDENTICAL for every project — only the
// bound data adapts, and sections hide/degrade gracefully when data is missing.
// All normalization + derived metrics live in buildProjectHealthView (one source
// of truth per metric); this component is pure presentation over that model.
//
// Fixed section order: Header · Health summary · Critical issues · Execution
// status · Financial summary · Effort & budget · Earned value (EVM) · Revenue
// recognition · Footer note.

export function ProjectReportPage() {
  const { user } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projectId = Number(id);
  const [noteOpen, setNoteOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [toast, setToast] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  // Where "Back" returns: the tab/screen the user came from. Defaults to the
  // Projects tab. 'dashboard' = the manager dashboard (e.g. clients widget).
  const from = params.get('from');
  const back = from === 'dashboard'
    ? { to: '/dashboard', label: 'Back to dashboard' }
    : from && ['financials', 'resourcing', 'portfolio', 'forecasts'].includes(from)
      ? { to: `/insights?tab=${from}`, label: 'Back' }
      : { to: '/insights?tab=portfolio', label: 'Back' };

  const portfolio = usePortfolio();
  const financials = useManagerFinancials();
  const evm = useEvm();
  const revrec = useRevenueRecognition();
  const breakdown = useProjectTaskBreakdown(projectId);

  const rows = useMemo(() => {
    const p = portfolio.data?.rows.find((r) => r.project_id === projectId);
    const f = financials.data?.projects.find((r) => r.project_id === projectId);
    const e = evm.data?.rows.find((r) => r.project_id === projectId);
    const rr = revrec.data?.rows.find((r) => r.project_id === projectId);
    return { p, f, e, rr };
  }, [portfolio.data, financials.data, evm.data, revrec.data, projectId]);

  const view = useMemo(
    () => buildProjectHealthView(rows.p, rows.f, rows.e, rows.rr, breakdown.data, { projectId, back }),
    [rows, breakdown.data, projectId, back],
  );

  if (!user || (user.role !== 'MANAGER' && user.role !== 'VIEWER')) {
    return <Navigate to="/dashboard" replace />;
  }

  const loading = portfolio.isLoading || financials.isLoading;
  const hasData = !!rows.p || !!rows.f;
  const { header, visibility } = view;
  const canOverride = ['MANAGER', 'VIEWER', 'ADMIN', 'PLATFORM_ADMIN'].includes(user.role) && !!rows.p;

  return (
    <div className="space-y-5">
      {/* Section 1: Header */}
      <button
        type="button"
        onClick={() => navigate(back.to)}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> {back.label}
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <WorkspaceHeader title={header.projectName} />
          {header.clientName ? (
            header.clientId ? (
              <button
                type="button"
                onClick={() => navigate(`/client-management?client=${header.clientId}`)}
                className="mt-1 text-sm text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
              >
                {header.clientName}
              </button>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{header.clientName}</p>
            )
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {header.clientId ? (
            <button
              type="button"
              onClick={() => setNoteOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <StickyNote className="h-3.5 w-3.5" /> Add note
            </button>
          ) : null}
          {canOverride ? (
            <button
              type="button"
              onClick={() => setRulesOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" /> Project Health
            </button>
          ) : null}
          {canOverride ? (
            <HealthOverrideMenu
              projectId={projectId}
              current={header.health}
              isManual={header.isManualOverride}
            />
          ) : null}
        </div>
      </div>

      {canOverride ? (
        <HealthRulesModal open={rulesOpen} onClose={() => setRulesOpen(false)} />
      ) : null}

      {header.clientId ? (
        <NoteModal
          open={noteOpen}
          clientId={header.clientId}
          target={{ mode: 'locked', projectId, projectName: header.projectName }}
          onClose={() => setNoteOpen(false)}
          onSaved={(m) => setToast({ tone: 'ok', text: m })}
          onError={(m) => setToast({ tone: 'err', text: m })}
        />
      ) : null}
      {toast ? <Toast tone={toast.tone} message={toast.text} onDismiss={() => setToast(null)} /> : null}

      {loading ? (
        <div className="grid place-items-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : !hasData ? (
        <div className="rounded-2xl border border-border bg-card px-6 py-16 text-center text-sm text-muted-foreground">
          No data for this project yet. It may have no approved time in your scope.
        </div>
      ) : (
        <>
          {/* Section 2: Project health summary */}
          <SummaryCardRow cards={view.summaryCards} />

          {/* Section 3: Critical issues requiring attention */}
          <CriticalIssuesPanel issues={view.criticalIssues} />

          {/* Section 4: Execution status */}
          {visibility.execution ? (
            <ExecutionStatus
              tasks={view.execution.tasks}
              effortTotal={view.execution.effortTotal}
              workload={view.execution.workload}
              projectId={projectId}
              projectName={header.projectName}
              managerName={breakdown.data?.manager_name}
              clientName={header.clientName}
              clientId={header.clientId}
            />
          ) : null}

          {/* Section 5: Financial summary */}
          {visibility.financial ? (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-foreground">Financial summary</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {view.financialKpis.map((k) => <KpiCard key={k.key} kpi={k} />)}
              </div>
            </section>
          ) : null}

          {/* Sections 6 + 7: Effort & budget · Earned value (EVM) */}
          <div className="grid gap-4 lg:grid-cols-2">
            {visibility.effortBudget ? (
              <MetricTable title="Effort & budget" rows={view.effortBudget.rows} />
            ) : null}
            {visibility.evm && view.evm ? (
              <MetricTable title="Earned value (EVM)" rows={view.evm.rows} />
            ) : null}
          </div>

          {/* Section 8: Revenue recognition */}
          {visibility.revRec && view.revRec ? (
            <MetricTable title="Revenue recognition" rows={view.revRec.rows} />
          ) : null}

          {/* Section 9: Footer note */}
          <p className="border-t border-border pt-3 text-[11px] text-muted-foreground">
            {view.footerNote}
          </p>
        </>
      )}
    </div>
  );
}

// Manual health-override menu on the project header. Lets a manager set this
// project's tier (Excellent / On track / At risk / Critical) or clear back to
// the auto-computed value. Mirrors the backend: 'blocked'/'not-set' aren't
// settable. A live override shows a "Manually set" pencil affordance.
function HealthOverrideMenu({
  projectId, current, isManual,
}: {
  projectId: number; current: string; isManual: boolean;
}) {
  const setOverride = useSetProjectHealthOverride();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (health: string | null) => {
    setOpen(false);
    setOverride.mutate({ projectId, health });
  };

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={setOverride.isPending}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
      >
        {isManual ? <Pencil className="h-3 w-3" aria-hidden /> : null}
        {isManual ? 'Status set manually' : 'Set status'}
      </button>
      {open ? (
        <div className="absolute right-0 top-9 z-50 w-48 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl">
          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Set status</p>
          {MANUAL_HEALTH.map((opt) => {
            const m = healthMeta(opt.value);
            const active = current === opt.value && isManual;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => pick(opt.value)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-primary/5"
              >
                <span className={cn('h-2 w-2 rounded-full', m.dot)} />
                <span className="flex-1">{opt.label}</span>
                {active ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
              </button>
            );
          })}
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={() => pick(null)}
            disabled={!isManual}
            className="w-full rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-primary/5 disabled:opacity-40"
          >
            Clear override (auto)
          </button>
        </div>
      ) : null}
    </div>
  );
}
