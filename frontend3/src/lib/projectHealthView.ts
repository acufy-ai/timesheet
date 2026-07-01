// Canonical view model for the standardized Project Detail / Project Health
// page. This is the SINGLE place backend rows are normalized and every derived
// metric is computed exactly once, so the nine page sections each read a slice
// of one consistent model rather than recomputing from raw rows. The page
// component is then pure presentation.
//
// Three framings of the same data:
//   - summary cards  = high-level STATUS (Section 2)
//   - critical issues = the EXPLANATION layer (Section 3), derived from the same
//                       task/budget/schedule signals
//   - execution / financial / table sections = the SUPPORTING DATA (4-8)
// No dataset is duplicated; each section binds to its own slice of this model.

import type { ProjectHealth } from '@/lib/projectHealth';
import { fmtMoney, fmtMoneyExact } from '@/lib/format';
import type {
  PortfolioRow,
  ProjectFinancialRow,
  EvmRow,
  RevRecRow,
  ProjectTaskBreakdown,
} from '@/types/dashboard';

// ----------------------------------------------------------------------------
// Tones. RiskTone is intentionally narrower than the app Tone: a metric is only
// ever critical / watch (warning) / healthy-subtle / neutral. The Status card
// still colors via healthMeta(); RiskTone drives every other card and figure.
// ----------------------------------------------------------------------------
export type RiskTone = 'critical' | 'warning' | 'subtle' | 'neutral';

/** Map a RiskTone to the inline text color used for emphasized figures. */
export function riskText(tone: RiskTone): string {
  switch (tone) {
    case 'critical': return 'text-rose-600 dark:text-rose-400';
    case 'warning': return 'text-amber-600 dark:text-amber-400';
    case 'subtle': return 'text-emerald-600 dark:text-emerald-400';
    default: return 'text-foreground';
  }
}

/** Margin %: healthy >=40, watch >=15, else risk. */
export function marginTone(pct: number | null | undefined): RiskTone {
  if (pct == null) return 'neutral';
  if (pct >= 40) return 'subtle';
  if (pct >= 15) return 'warning';
  return 'critical';
}

/** CPI / SPI: healthy >=1, watch >=0.9, else risk. */
export function indexTone(v: number | null | undefined): RiskTone {
  if (v == null) return 'neutral';
  if (v >= 1) return 'subtle';
  if (v >= 0.9) return 'warning';
  return 'critical';
}

/** Budget used %: risk >100, watch >=80, else healthy. */
export function budgetTone(pct: number | null | undefined): RiskTone {
  if (pct == null) return 'neutral';
  if (pct > 100) return 'critical';
  if (pct >= 80) return 'warning';
  return 'subtle';
}

// Status pill tones for the Overdue-unfinished card (task lifecycle).
export const TASK_STATUS_LABEL: Record<string, string> = {
  to_do: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done',
};
export const TASK_STATUS_TONE: Record<string, RiskTone> = {
  to_do: 'neutral', in_progress: 'warning', blocked: 'critical', done: 'subtle',
};

// ----------------------------------------------------------------------------
// View-model shapes (one sub-interface per section).
// ----------------------------------------------------------------------------
export interface HeaderVM {
  projectId: number;
  projectName: string;
  clientId: number | null;
  clientName: string | null;       // null => omit the client line entirely
  health: ProjectHealth;           // raw value -> healthMeta() at render
  healthReason: string | null;
  isManualOverride: boolean;
  back: { to: string; label: string };
}

export type SummaryKey =
  | 'status' | 'task_completion' | 'logged_hours' | 'pending_approval'
  | 'schedule_variance' | 'budget_used' | 'budget_overrun' | 'budget_remaining';

export interface SummaryCardVM {
  key: SummaryKey;
  label: string;                   // canonical terminology, exact
  value: string;                   // pre-formatted ("78%", "120h", "$1.2k", "—")
  sub?: string;                    // secondary line
  tone: RiskTone;
  emphasis: boolean;               // figure rendered bold + colored
  isStatus?: boolean;              // Status card renders via healthMeta()
  health?: ProjectHealth;          // for the Status card only
}

export type IssueCategory =
  | 'health'
  | 'blocked' | 'estimate_overrun' | 'overdue' | 'dependency'
  | 'budget' | 'schedule' | 'approval_bottleneck' | 'resource_concentration';

export interface CriticalIssueVM {
  category: IssueCategory;
  label: string;
  detail: string;
  tone: RiskTone;                  // critical | warning
  severity: number;               // sort key, lower = surface first
}

export interface EffortTaskVM {
  taskId: number;
  name: string;
  right: string;                   // "120h" or "120h · $18k"
  pct: number;                     // 0..100 bar width
}
export interface OverdueTaskVM {
  taskId: number;
  name: string;
  statusLabel: string;
  statusTone: RiskTone;
  daysOverdue: number | null;
}
export interface WorkloadPersonVM {
  userId: number;
  name: string;
  right: string;                   // "120h · 42%"
  pct: number;
}
export interface ExecutionVM {
  highestEffort: EffortTaskVM[];
  overdueUnfinished: OverdueTaskVM[];
  workload: WorkloadPersonVM[];
}

export interface KpiVM {
  key: 'revenue' | 'cost' | 'gross_profit' | 'margin' | 'budget_used';
  label: string;
  value: string;
  tone: RiskTone;
}

export interface MetricRowVM {
  label: string;
  value: string;                   // "—" when missing
  tone?: RiskTone;
  tooltip?: boolean;               // render label via InfoLabel
}
export interface EffortBudgetVM { rows: MetricRowVM[]; }

export interface EvmVM {
  rows: MetricRowVM[];
}

export interface RevRecVM { rows: MetricRowVM[]; }

export interface VisibilityVM {
  pendingApprovalCard: boolean;
  budgetCard: 'overrun' | 'remaining' | 'none';
  execution: boolean;
  financial: boolean;
  effortBudget: boolean;
  evm: boolean;
  revRec: boolean;
}

export interface ProjectHealthView {
  header: HeaderVM;
  summaryCards: SummaryCardVM[];
  criticalIssues: CriticalIssueVM[];
  execution: ExecutionVM;
  financialKpis: KpiVM[];
  effortBudget: EffortBudgetVM;
  evm: EvmVM | null;
  revRec: RevRecVM | null;
  visibility: VisibilityVM;
  footerNote: string;
}

export const FOOTER_NOTE =
  'Based on logged time, task status, captured estimates, due dates, blockers, and project financial data.';

// ----------------------------------------------------------------------------
// Helpers.
// ----------------------------------------------------------------------------
const num = (v: string | number | null | undefined): number | null =>
  v == null || v === '' ? null : Number(v);
const round = (v: number) => Math.round(v);
const hrs = (v: number | null) => (v == null ? '—' : `${round(v)}h`);
const clampPct = (v: number) => Math.max(0, Math.min(100, v));

// ----------------------------------------------------------------------------
// Critical-issues generator. Derives the explanation layer from the SAME signals
// the execution cards display. Each category fires from a distinct trigger; the
// list is sorted by severity (lower first) and capped to protect layout.
// ----------------------------------------------------------------------------
interface IssueSignals {
  breakdown?: ProjectTaskBreakdown;
  overBudget: boolean;
  budgetUsedPct: number | null;
  pendingApproval: number | null;
  approved: number | null;
  // The project's health tier + the plain-language reason it's in that tier.
  // When the project is unhealthy, the reason IS the headline critical issue.
  health: ProjectHealth;
  healthReason: string | null;
}

// Map a health tier to the critical-issues tone. at-risk = warning, everything
// worse (critical/blocked) = critical.
function healthIssueTone(health: ProjectHealth): RiskTone {
  return health === 'at-risk' ? 'warning' : 'critical';
}
function healthIssueLabel(health: ProjectHealth): string {
  if (health === 'critical') return 'Why it’s critical';
  if (health === 'blocked') return 'Why it’s blocked';
  return 'Why it’s at risk';
}

function buildCriticalIssues(s: IssueSignals): CriticalIssueVM[] {
  const issues: CriticalIssueVM[] = [];
  const b = s.breakdown;

  // Lead with the health reason: if the project is unhealthy, the FIRST thing
  // shown is the plain-language explanation of that exact status, so the panel
  // answers "why is this at risk/critical/blocked?" directly.
  const unhealthy = s.health === 'at-risk' || s.health === 'critical' || s.health === 'blocked';
  if (unhealthy && s.healthReason) {
    issues.push({
      category: 'health', label: healthIssueLabel(s.health),
      tone: healthIssueTone(s.health), severity: -1,
      detail: s.healthReason,
    });
  }

  if (b && b.blocked_tasks.length > 0) {
    const t = b.blocked_tasks[0];
    const n = b.blocked_tasks.length;
    issues.push({
      category: 'blocked', label: 'Blocked', tone: 'critical', severity: 0,
      detail: n > 1
        ? `${n} tasks blocked, including "${t.name}"${t.blocked_reason ? ` — ${t.blocked_reason}` : ''}`
        : `"${t.name}"${t.blocked_reason ? ` — ${t.blocked_reason}` : ''}`,
    });
  }

  if (b && b.blocking_chains.length > 0) {
    const c = b.blocking_chains[0];
    issues.push({
      category: 'dependency', label: 'Dependency issue', tone: 'critical', severity: 1,
      detail: c.dependent_started
        ? `"${c.task_name}" is in progress before its prerequisite "${c.depends_on_task_name}" is done`
        : `"${c.task_name}" is waiting on "${c.depends_on_task_name}"`,
    });
  }

  const overdueCount = b?.overdue_tasks.length ?? 0;
  if (overdueCount > 0) {
    const worst = Math.max(...b!.overdue_tasks.map((t) => t.days_overdue ?? 0));
    issues.push({
      category: 'overdue', label: 'Overdue', tone: 'critical', severity: 2,
      detail: overdueCount === 1
        ? `"${b!.overdue_tasks[0].name}" is ${worst} day${worst === 1 ? '' : 's'} past its due date`
        : `${overdueCount} tasks past their due date, up to ${worst} days late`,
    });
  }

  if (s.overBudget) {
    issues.push({
      category: 'budget', label: 'Budget issue', tone: 'critical', severity: 3,
      detail: s.budgetUsedPct != null
        ? `Over budget — ${s.budgetUsedPct}% of budget used`
        : 'Over budget',
    });
  }

  if (b && b.over_estimate_tasks.length > 0) {
    const t = b.over_estimate_tasks[0];
    issues.push({
      category: 'estimate_overrun', label: 'Estimate overrun', tone: 'warning', severity: 4,
      detail: `"${t.name}" at ${round(Number(t.hours))}h vs ${round(Number(t.estimated_hours))}h planned`
        + (t.over_estimate_pct != null ? ` (+${t.over_estimate_pct}%)` : ''),
    });
  }

  // (The old dollar-denominated "Schedule issue: −$X" item was removed: schedule
  // slippage now reads through the health reason above, and the dollar schedule
  // variance still lives in the EVM tile at the bottom of the page.)

  // Approval bottleneck: a meaningful chunk of logged time is awaiting approval.
  if (
    s.pendingApproval != null && s.approved != null &&
    s.pendingApproval >= Math.max(8, 0.25 * s.approved)
  ) {
    issues.push({
      category: 'approval_bottleneck', label: 'Approval bottleneck', tone: 'warning', severity: 6,
      detail: `${round(s.pendingApproval)}h logged is waiting for approval`,
    });
  }

  // Resource concentration: one person carries the bulk of the hours.
  if (b && b.by_person.length >= 2) {
    const top = b.by_person[0];
    if (top.pct_of_hours >= 70) {
      issues.push({
        category: 'resource_concentration', label: 'Resource concentration', tone: 'warning', severity: 7,
        detail: `${top.full_name} carries ${top.pct_of_hours}% of the logged hours`,
      });
    }
  }

  return issues.sort((a, c) => a.severity - c.severity).slice(0, 6);
}

// ----------------------------------------------------------------------------
// The normalizer. Pure: backend rows in, one consistent view model out.
// ----------------------------------------------------------------------------
export function buildProjectHealthView(
  portfolio: PortfolioRow | undefined,
  financials: ProjectFinancialRow | undefined,
  evm: EvmRow | undefined,
  revrec: RevRecRow | undefined,
  breakdown: ProjectTaskBreakdown | undefined,
  ctx: { projectId: number; back: { to: string; label: string } },
): ProjectHealthView {
  // ---- 0. Shared scalars, coerced once. ----
  const currency = financials?.currency ?? portfolio?.currency ?? 'USD';
  const revenue = num(financials?.revenue ?? portfolio?.revenue);
  const cost = num(financials?.cost ?? portfolio?.cost);
  const marginPct = financials?.margin_pct ?? portfolio?.margin_pct ?? null;
  const budgetAmt = num(financials?.budget_amount ?? portfolio?.budget_amount);
  const budgetUsed = financials?.budget_used_pct ?? portfolio?.budget_used_pct ?? null;
  const budgetRem = num(financials?.budget_remaining);
  const approved = num(financials?.approved_hours ?? portfolio?.approved_hours);
  const billable = num(financials?.billable_hours);
  const logged = num(financials?.logged_hours);
  const daysToEnd = portfolio?.days_until_end ?? null;
  const health = (portfolio?.health ?? 'not-set') as ProjectHealth;

  // ---- 1. Derived metrics, computed once. ----
  const hasApprovalConcept = logged != null;
  const pendingApproval =
    logged != null && approved != null && logged >= approved ? logged - approved : null;

  const taskCompletionPct =
    breakdown && breakdown.total_tasks > 0
      ? round((100 * breakdown.done_tasks) / breakdown.total_tasks)
      : evm?.percent_complete ?? null;

  const overBudget = budgetUsed != null && budgetUsed > 100;
  const budgetOverrunAmt =
    overBudget && budgetAmt != null ? round((budgetAmt * (budgetUsed! - 100)) / 100) : null;
  const budgetCard: VisibilityVM['budgetCard'] =
    budgetAmt == null && budgetUsed == null ? 'none' : overBudget ? 'overrun' : 'remaining';

  // Schedule variance: prefer EVM dollar variance, else days-to-end framing.
  const evmSchedVar = num(evm?.schedule_variance);
  let scheduleLabel: string | null;
  let scheduleLate: boolean;
  if (evm && evmSchedVar != null) {
    scheduleLabel = `${evmSchedVar < 0 ? '−' : '+'}${fmtMoney(Math.abs(evmSchedVar), currency)}`;
    scheduleLate = evmSchedVar < 0;
  } else if (daysToEnd != null) {
    scheduleLabel = daysToEnd < 0 ? `${Math.abs(daysToEnd)} days overdue` : `${daysToEnd} days to end date`;
    scheduleLate = daysToEnd < 0;
  } else {
    scheduleLabel = null;
    scheduleLate = false;
  }

  const grossProfit = revenue != null && cost != null ? revenue - cost : null;

  // ---- 2. Summary cards. Build all, then drop missing-data cards. ----
  const cards: SummaryCardVM[] = [];

  cards.push({
    key: 'status', label: 'Status', value: '', tone: 'neutral', emphasis: false,
    isStatus: true, health,
    // The plain-language "why this status" (e.g. "Behind pace, 60% done at 80%
    // elapsed"), so the manager sees the reason, not just the colour.
    sub: portfolio?.health_reason ?? undefined,
  });

  if (taskCompletionPct != null) {
    cards.push({
      key: 'task_completion', label: 'Task completion',
      value: `${taskCompletionPct}%`,
      sub: breakdown && breakdown.total_tasks > 0
        ? `${breakdown.done_tasks}/${breakdown.total_tasks} tasks` : undefined,
      tone: 'neutral', emphasis: false,
    });
  }

  if (logged != null || approved != null) {
    cards.push({
      key: 'logged_hours', label: 'Logged hours',
      value: hrs(logged ?? approved),
      sub: approved != null ? `${round(approved)}h approved` : undefined,
      tone: 'neutral', emphasis: false,
    });
  }

  if (hasApprovalConcept && pendingApproval != null) {
    const pendTone: RiskTone =
      approved != null && pendingApproval >= Math.max(8, 0.25 * approved) ? 'warning' : 'neutral';
    cards.push({
      key: 'pending_approval', label: 'Pending approval hours',
      value: hrs(pendingApproval), tone: pendTone, emphasis: pendTone !== 'neutral',
    });
  }

  // (The top-row "Schedule variance" summary card was removed: schedule status
  // now reads through the health reason + the "Why it's at risk" critical issue.
  // The dollar variance still lives in the Effort & budget and EVM tiles below.)

  if (budgetUsed != null) {
    const t = budgetTone(budgetUsed);
    cards.push({
      key: 'budget_used', label: 'Budget used',
      value: `${budgetUsed}%`, tone: t, emphasis: t === 'critical' || t === 'warning',
    });
  }

  if (budgetCard === 'overrun') {
    cards.push({
      key: 'budget_overrun', label: 'Budget overrun',
      value: budgetOverrunAmt != null ? fmtMoney(budgetOverrunAmt, currency)
        : budgetUsed != null ? `${budgetUsed - 100}% over` : '—',
      tone: 'critical', emphasis: true,
    });
  } else if (budgetCard === 'remaining' && budgetRem != null) {
    cards.push({
      key: 'budget_remaining', label: 'Budget remaining',
      value: fmtMoney(budgetRem, currency),
      tone: budgetRem < 0 ? 'critical' : 'subtle', emphasis: budgetRem < 0,
    });
  }

  // ---- 3. Critical issues. ----
  const criticalIssues = buildCriticalIssues({
    breakdown, overBudget, budgetUsedPct: budgetUsed,
    pendingApproval, approved,
    health, healthReason: portfolio?.health_reason ?? null,
  });

  // ---- 4. Execution status (map breakdown slices, no recompute). ----
  const showCost = !!breakdown?.top_tasks.some((t) => num(t.cost) != null && Number(t.cost) > 0);
  const highestEffort: EffortTaskVM[] = (breakdown?.top_tasks ?? []).map((t) => ({
    taskId: t.task_id, name: t.name,
    right: showCost ? `${round(Number(t.hours))}h · ${fmtMoney(t.cost, currency)}` : `${round(Number(t.hours))}h`,
    pct: clampPct(t.pct_of_hours),
  }));
  // Prefer the explicit overdue list; else unfinished-at-deadline (still unfinished).
  const overdueSource = breakdown
    ? (breakdown.overdue_tasks.length > 0
      ? breakdown.overdue_tasks
      : breakdown.unfinished_at_deadline.filter((t) => t.status !== 'done'))
    : [];
  const overdueUnfinished: OverdueTaskVM[] = overdueSource.map((t) => ({
    taskId: t.task_id, name: t.name,
    statusLabel: TASK_STATUS_LABEL[t.status] ?? t.status,
    statusTone: TASK_STATUS_TONE[t.status] ?? 'neutral',
    daysOverdue: t.days_overdue ?? null,
  }));
  const workload: WorkloadPersonVM[] = (breakdown?.by_person ?? []).map((p) => ({
    userId: p.user_id, name: p.full_name,
    right: `${round(Number(p.hours))}h · ${p.pct_of_hours}%`,
    pct: clampPct(p.pct_of_hours),
  }));

  // ---- 5. Financial KPIs. ----
  const financialKpis: KpiVM[] = [
    { key: 'revenue', label: 'Revenue', value: revenue != null ? fmtMoney(revenue, currency) : '—', tone: 'neutral' },
    { key: 'cost', label: 'Cost', value: cost != null ? fmtMoney(cost, currency) : '—', tone: 'neutral' },
    {
      key: 'gross_profit', label: 'Gross profit',
      value: grossProfit != null ? fmtMoney(grossProfit, currency) : '—',
      tone: grossProfit == null ? 'neutral' : grossProfit >= 0 ? 'subtle' : 'critical',
    },
    {
      key: 'margin', label: 'Margin',
      value: marginPct != null ? `${marginPct}%` : '—', tone: marginTone(marginPct),
    },
    {
      key: 'budget_used', label: 'Budget used',
      value: budgetUsed != null ? `${budgetUsed}%` : '—', tone: budgetTone(budgetUsed),
    },
  ];

  // ---- 6. Effort & budget table. ----
  const ebRows: MetricRowVM[] = [
    { label: 'Hours', value: approved != null ? `${round(approved)}h approved` : '—', tooltip: true },
    { label: 'Billable hours', value: billable != null ? `${round(billable)}h` : '—', tooltip: true },
    { label: 'Budget', value: budgetAmt != null ? fmtMoneyExact(budgetAmt, currency) : '—' },
  ];
  if (budgetCard === 'overrun') {
    ebRows.push({
      label: 'Budget overrun',
      value: budgetOverrunAmt != null ? fmtMoneyExact(budgetOverrunAmt, currency)
        : budgetUsed != null ? `${budgetUsed - 100}% over` : '—',
      tone: 'critical',
    });
  } else if (budgetRem != null) {
    ebRows.push({
      label: 'Budget remaining', value: fmtMoneyExact(budgetRem, currency),
      tone: budgetRem < 0 ? 'critical' : undefined,
    });
  }
  ebRows.push({
    label: scheduleLate ? 'Schedule variance' : 'Timeline',
    value: scheduleLabel ?? '—', tone: scheduleLate ? 'critical' : undefined,
  });

  // ---- 7. EVM. ----
  let evmVM: EvmVM | null = null;
  if (evm) {
    evmVM = {
      rows: [
        { label: '% done', value: `${evm.percent_complete}%`, tooltip: true },
        { label: 'Planned (PV)', value: fmtMoney(evm.pv, currency), tooltip: true },
        { label: 'Earned (EV)', value: fmtMoney(evm.ev, currency), tooltip: true },
        { label: 'Actual (AC)', value: fmtMoney(evm.ac, currency), tooltip: true },
        {
          label: 'Cost variance', value: fmtMoney(evm.cost_variance, currency), tooltip: false,
          tone: Number(evm.cost_variance) < 0 ? 'critical' : 'subtle',
        },
        { label: 'CPI', value: evm.cpi != null ? evm.cpi.toFixed(2) : '—', tone: indexTone(evm.cpi), tooltip: true },
        { label: 'SPI', value: evm.spi != null ? evm.spi.toFixed(2) : '—', tone: indexTone(evm.spi), tooltip: true },
        {
          label: 'Forecast (EAC)',
          value: `${fmtMoney(evm.eac, currency)}${evm.projected_overrun_pct > 0 ? ` (+${evm.projected_overrun_pct}%)` : ''}`,
          tone: evm.projected_overrun_pct > 0 ? 'critical' : undefined, tooltip: true,
        },
      ],
    };
  }

  // ---- 8. Revenue recognition. ----
  let revRecVM: RevRecVM | null = null;
  if (revrec) {
    const rows: MetricRowVM[] = [
      { label: 'Method', value: revrec.method === 'percent_complete' ? '% complete' : 'As billed' },
    ];
    if (revrec.percent_complete != null) rows.push({ label: '% complete', value: `${revrec.percent_complete}%` });
    rows.push({ label: 'Billed', value: fmtMoney(revrec.billed, currency), tooltip: true });
    rows.push({ label: 'Recognized', value: fmtMoney(revrec.recognized, currency), tooltip: true });
    revRecVM = { rows };
  }

  // ---- Header + visibility. ----
  const header: HeaderVM = {
    projectId: ctx.projectId,
    projectName: portfolio?.project_name ?? financials?.project_name ?? `Project ${ctx.projectId}`,
    clientId: portfolio?.client_id ?? financials?.client_id ?? null,
    clientName: portfolio?.client_name ?? financials?.client_name ?? null,
    health, healthReason: portfolio?.health_reason ?? null,
    isManualOverride: (portfolio?.health_reason ?? '').startsWith('Manually set'),
    back: ctx.back,
  };

  const visibility: VisibilityVM = {
    pendingApprovalCard: hasApprovalConcept && pendingApproval != null,
    budgetCard,
    execution: !!breakdown && breakdown.total_tasks > 0,
    financial: revenue != null || cost != null || budgetAmt != null,
    effortBudget: !!financials || !!portfolio,
    evm: !!evm,
    revRec: !!revrec,
  };

  return {
    header, summaryCards: cards, criticalIssues,
    execution: { highestEffort, overdueUnfinished, workload },
    financialKpis, effortBudget: { rows: ebRows },
    evm: evmVM, revRec: revRecVM, visibility, footerNote: FOOTER_NOTE,
  };
}
