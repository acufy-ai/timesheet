import { useMemo } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';

import { WorkspaceHeader } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/cn';
import { useEvm, useManagerFinancials, usePortfolio, useProjectTaskBreakdown, useRevenueRecognition } from '@/hooks/useDashboard';
import { InfoLabel } from '@/components/dashboard/InfoLabel';
import { fmtMoney } from '@/lib/format';
import type { ProjectTaskBreakdown } from '@/types/dashboard';

// Dedicated per-project dossier — the "View report" target. Assembles a full
// picture from the same data the Insights tables use (portfolio, financials,
// EVM, rev-rec), keyed by project_id, so the numbers reconcile with the lists.

const HEALTH_META: Record<string, { label: string; dot: string; text: string }> = {
  'needs-attention': { label: 'Needs attention', dot: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400' },
  'at-risk': { label: 'At risk', dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  good: { label: 'Good', dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
  'not-set': { label: 'Not set', dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
};

function marginColor(pct: number | null | undefined): string {
  if (pct == null) return 'text-muted-foreground';
  if (pct >= 40) return 'text-emerald-600 dark:text-emerald-400';
  if (pct >= 15) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}
function indexTone(v: number | null | undefined): string {
  if (v == null) return 'text-muted-foreground';
  if (v >= 1) return 'text-emerald-600 dark:text-emerald-400';
  if (v >= 0.9) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}

export function ProjectReportPage() {
  const { user } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projectId = Number(id);

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

  const data = useMemo(() => {
    const p = portfolio.data?.rows.find((r) => r.project_id === projectId);
    const f = financials.data?.projects.find((r) => r.project_id === projectId);
    const e = evm.data?.rows.find((r) => r.project_id === projectId);
    const rr = revrec.data?.rows.find((r) => r.project_id === projectId);
    return { p, f, e, rr };
  }, [portfolio.data, financials.data, evm.data, revrec.data, projectId]);

  if (!user || (user.role !== 'MANAGER' && user.role !== 'VIEWER')) {
    return <Navigate to="/dashboard" replace />;
  }

  const loading = portfolio.isLoading || financials.isLoading;
  const { p, f, e, rr } = data;
  const name = p?.project_name ?? f?.project_name ?? `Project ${projectId}`;
  const clientName = p?.client_name ?? f?.client_name ?? '';
  const clientId = p?.client_id ?? f?.client_id ?? null;
  const currency = p?.currency ?? f?.currency ?? 'USD';
  const h = HEALTH_META[p?.health ?? 'not-set'] ?? HEALTH_META['not-set'];

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={() => navigate(back.to)}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> {back.label}
      </button>

      <WorkspaceHeader
        title={name}
        description={
          clientId
            ? undefined
            : clientName
        }
      />
      {clientId ? (
        <button
          type="button"
          onClick={() => navigate(`/client-management?client=${clientId}`)}
          className="-mt-3 text-sm text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
        >
          {clientName}
        </button>
      ) : null}

      {loading ? (
        <div className="grid place-items-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : !p && !f ? (
        <div className="rounded-2xl border border-border bg-card px-6 py-16 text-center text-sm text-muted-foreground">
          No data for this project yet. It may have no approved time in your scope.
        </div>
      ) : (
        <>
          {/* Health banner */}
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3">
            <span className="inline-flex items-center gap-2">
              <span className={cn('h-2.5 w-2.5 rounded-full', h.dot)} />
              <span className={cn('text-sm font-semibold', h.text)}>{h.label}</span>
            </span>
            {p?.health_reason ? <span className="text-sm text-muted-foreground">{p.health_reason}</span> : null}
          </div>

          {/* Why this status — task-level detail, shown when the project needs
              a closer look. Built from logged time + task status (real data). */}
          {(p?.health === 'at-risk' || p?.health === 'needs-attention') ? (
            <WhySection data={breakdown.data} loading={breakdown.isLoading} currency={currency} />
          ) : null}

          {/* Financial summary */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Revenue" value={fmtMoney(f?.revenue ?? p?.revenue ?? 0, currency)} />
            <Stat label="Cost" value={fmtMoney(f?.cost ?? p?.cost ?? 0, currency)} />
            <Stat
              label="Margin"
              value={(f?.margin_pct ?? p?.margin_pct) != null ? `${f?.margin_pct ?? p?.margin_pct}%` : 'N/A'}
              valueClass={marginColor(f?.margin_pct ?? p?.margin_pct)}
            />
            <Stat
              label="Budget burn"
              value={(f?.budget_used_pct ?? p?.budget_used_pct) != null ? `${f?.budget_used_pct ?? p?.budget_used_pct}%` : '—'}
            />
          </div>

          {/* Hours + budget detail */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Effort & budget">
              <Row label={<InfoLabel label="Hours" />} value={`${Math.round(Number(f?.approved_hours ?? p?.approved_hours ?? 0))}h approved`} />
              {f?.billable_hours != null ? <Row label="Billable hours" value={`${Math.round(Number(f.billable_hours))}h`} /> : null}
              {f?.budget_amount != null ? <Row label="Budget" value={fmtMoney(f.budget_amount, currency)} /> : null}
              {f?.budget_remaining != null ? <Row label="Budget remaining" value={fmtMoney(f.budget_remaining, currency)} /> : null}
              {f?.contract_value != null ? (
                <Row label="Contract" value={`${fmtMoney(f.contract_value, currency)}${f.contract_used_pct != null ? ` · ${f.contract_used_pct}% used` : ''}`} />
              ) : null}
              {p?.days_until_end != null ? (
                <Row label="Timeline" value={p.days_until_end < 0 ? `${Math.abs(p.days_until_end)} days overdue` : `${p.days_until_end} days to end date`} />
              ) : null}
            </Panel>

            {/* Earned value */}
            {e ? (
              <Panel title="Earned value (EVM)">
                <Row label={<InfoLabel label="% done" />} value={`${e.percent_complete}%`} />
                <Row label={<InfoLabel label="Planned (PV)" />} value={fmtMoney(e.pv, currency)} />
                <Row label={<InfoLabel label="Earned (EV)" />} value={fmtMoney(e.ev, currency)} />
                <Row label={<InfoLabel label="Actual (AC)" />} value={fmtMoney(e.ac, currency)} />
                <Row label={<InfoLabel label="CPI" />} value={<span className={indexTone(e.cpi)}>{e.cpi != null ? e.cpi.toFixed(2) : '—'}</span>} />
                <Row label={<InfoLabel label="SPI" />} value={<span className={indexTone(e.spi)}>{e.spi != null ? e.spi.toFixed(2) : '—'}</span>} />
                <Row
                  label={<InfoLabel label="Forecast (EAC)" />}
                  value={<span>{fmtMoney(e.eac, currency)}{e.projected_overrun_pct > 0 ? <span className="ml-1 text-xs text-rose-600 dark:text-rose-400">+{e.projected_overrun_pct}%</span> : null}</span>}
                />
              </Panel>
            ) : (
              <Panel title="Earned value (EVM)">
                <p className="py-4 text-sm text-muted-foreground">No baseline set for this project, so earned value can't be computed. Set planned hours, cost and dates on the project to enable EVM.</p>
              </Panel>
            )}
          </div>

          {/* Revenue recognition */}
          {rr ? (
            <Panel title="Revenue recognition">
              <Row label="Method" value={rr.method === 'percent_complete' ? '% complete' : 'As billed'} />
              {rr.percent_complete != null ? <Row label="% complete" value={`${rr.percent_complete}%`} /> : null}
              <Row label={<InfoLabel label="Billed" />} value={fmtMoney(rr.billed, currency)} />
              <Row label={<InfoLabel label="Recognized" />} value={fmtMoney(rr.recognized, currency)} />
            </Panel>
          ) : null}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3">
      <InfoLabel label={label} className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground" />
      <p className={cn('mt-1 text-xl font-bold tabular-nums text-foreground', valueClass)}>{value}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card">
      <div className="border-b border-border px-4 py-2.5"><p className="text-sm font-semibold text-foreground">{title}</p></div>
      <div className="divide-y divide-border/60 px-4">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums font-medium text-foreground">{value}</span>
    </div>
  );
}

const TASK_STATUS_LABEL: Record<string, string> = {
  to_do: 'To do', in_progress: 'In progress', done: 'Done',
};
const TASK_STATUS_TONE: Record<string, string> = {
  to_do: 'text-muted-foreground', in_progress: 'text-amber-600 dark:text-amber-400', done: 'text-emerald-600 dark:text-emerald-400',
};

// "Why it needs a closer look" — task-level cause from real logged time + task
// status. Honest about its limits: it shows where effort went and what's
// unfinished, not invented blockers (that needs task estimates/blockers we don't
// capture yet).
function WhySection({ data, loading, currency }: { data?: ProjectTaskBreakdown; loading: boolean; currency: string }) {
  if (loading) {
    return (
      <div className="rounded-2xl border border-border bg-card px-4 py-6 text-center text-muted-foreground">
        <Loader2 className="mx-auto h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (!data || data.total_tasks === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card px-4 py-4 text-sm text-muted-foreground">
        No tasks on this project yet, so there’s no task-level detail to explain the status.
      </div>
    );
  }

  const hasUnfinished = data.unfinished_at_deadline.length > 0;
  const hasStalled = data.stalled_tasks.length > 0;

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <p className="text-sm font-semibold text-foreground">Why it needs a closer look</p>
        <p className="text-xs text-muted-foreground">
          {data.done_tasks} of {data.total_tasks} tasks done · {Math.round(Number(data.total_hours))}h logged
        </p>
      </div>

      {/* Headline notes — the data-derived cause in one line each. */}
      {data.notes.length ? (
        <ul className="space-y-1.5 border-b border-border px-4 py-3">
          {data.notes.map((n, i) => (
            <li key={i} className="flex gap-2 text-sm text-foreground">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-px bg-border md:grid-cols-2">
        {/* Where the hours/$ went */}
        <div className="bg-card px-4 py-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Where the time went</p>
          {data.top_tasks.length ? (
            <ul className="space-y-2">
              {data.top_tasks.map((t) => (
                <li key={t.task_id}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-foreground" title={t.name}>{t.name}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {Math.round(Number(t.hours))}h · {fmtMoney(t.cost, currency)}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.min(100, t.pct_of_hours)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">No time logged against tasks.</p>}
        </div>

        {/* What's unfinished + who's carrying it */}
        <div className="space-y-3 bg-card px-4 py-3">
          {hasUnfinished ? (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Still open {data.is_overdue ? 'past the deadline' : 'near the deadline'}
              </p>
              <ul className="space-y-1">
                {data.unfinished_at_deadline.map((t) => (
                  <li key={t.task_id} className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-foreground" title={t.name}>{t.name}</span>
                    <span className={cn('shrink-0 text-xs font-medium', TASK_STATUS_TONE[t.status])}>{TASK_STATUS_LABEL[t.status] ?? t.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {hasStalled ? (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Not started</p>
              <p className="text-sm text-muted-foreground">
                {data.stalled_tasks.map((t) => t.name).join(', ')}
              </p>
            </div>
          ) : null}

          {data.by_person.length ? (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Who’s carrying it</p>
              <ul className="space-y-1">
                {data.by_person.slice(0, 4).map((p) => (
                  <li key={p.user_id} className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-foreground">{p.full_name}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{Math.round(Number(p.hours))}h · {p.pct_of_hours}%</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        Based on logged time and task status. Blocker and estimate-overrun detail will appear once tasks capture due dates, estimates and blockers.
      </p>
    </div>
  );
}
