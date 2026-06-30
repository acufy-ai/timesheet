// Dashboard response shapes. Mirror the live backend payloads from
// /dashboard/manager-team-overview and /dashboard/manager-project-health
// (verified against manager1@example.com on 2026-06-05).

export interface TeamMemberOverview {
  user_id: number;
  full_name: string;
  working_days_in_week: number;
  submitted_days: number;
  // Days with ANY entry (draft + submitted + approved). Drives the "X/5 days
  // logged" display; status (on-track/behind) still uses submitted_days.
  // Optional + defaulted for back-compat with an older API.
  logged_days?: number;
  is_on_pto_today: boolean;
  is_on_pto_this_week: boolean;
  upcoming_pto_starts_at: string | null;
  is_repeatedly_late: boolean;
}

export interface ManagerTeamOverview {
  week_start: string;
  week_end: string;
  today: string;
  team_size: number;
  members: TeamMemberOverview[];
  pending_approvals_count: number;
  pending_time_off_count: number;
  rejected_recent_count: number;
  pending_approvals_oldest_hours: number | null;
  pending_approvals_avg_hours: number | null;
  capacity_this_week: unknown[];
  capacity_next_week: unknown[];
}

// The health model lives in lib/projectHealth.ts (single source of truth for
// labels/tones/sort). Re-exported here so existing type imports keep working.
export type { ProjectHealth } from '@/lib/projectHealth';
import type { ProjectHealth } from '@/lib/projectHealth';

export interface ProjectHealthRow {
  project_id: number;
  project_name: string;
  code?: string | null;
  status?: string | null;
  client_id?: number | null;
  client_name: string;
  days_until_end: number | null;
  hours_this_week: string;
  budget_pct: number | null;
  budget_hours_remaining: number | null;
  health: ProjectHealth;
  health_reason?: string | null;
}

export interface ManagerProjectHealth {
  rows: ProjectHealthRow[];
}

// GET /dashboard/manager-financials — real financials from approved time x rates.
export interface ProjectFinancialRow {
  project_id: number;
  project_name: string;
  client_id?: number | null;
  client_name: string;
  currency: string;
  approved_hours: string | number;
  // Logged = submitted (awaiting approval) + approved. pending approval = logged - approved.
  logged_hours?: string | number | null;
  billable_hours: string | number;
  revenue: string | number;
  cost?: string | number;
  margin?: string | number;
  margin_pct?: number | null;
  budget_amount?: string | number | null;
  budget_used_pct?: number | null;
  budget_remaining?: string | number | null;
  contract_id?: number | null;
  contract_title?: string | null;
  contract_value?: string | number | null;
  contract_used_pct?: number | null;
}
export interface FinancialSummary {
  total_revenue: string | number;
  total_budget: string | number;
  total_approved_hours: string | number;
  billable_hours: string | number;
  nonbillable_hours: string | number;
  utilization_pct?: number | null;
  total_cost?: string | number;
  total_margin?: string | number;
  total_margin_pct?: number | null;
  currency: string;
}
export interface ResourcingAllocRow {
  project_id: number;
  project_name: string;
  percent: number;
  start_date: string;
  end_date: string;
}
export interface ResourcingRow {
  user_id: number;
  full_name: string;
  title?: string | null;
  capacity_hours: string | number;
  allocated_pct: number;
  state: 'over' | 'ok' | 'under';
  allocations: ResourcingAllocRow[];
}
export interface TeamResourcing {
  weeks_ahead: number;
  team_size: number;
  over_allocated: number;
  under_utilized: number;
  rows: ResourcingRow[];
}

// Per-employee detail for the resourcing slide-over panel.
export interface ResourceProjectRow {
  project_id: number;
  project_name: string;
  client_name?: string | null;
  hours: string | number;
  billable_hours: string | number;
  billed: string | number;
  untasked_hours: string | number;
  planned_pct?: number | null;
}
export interface ResourceTaskRow {
  task_id?: number | null;
  task_name: string;
  project_id: number;
  project_name: string;
  client_name?: string | null;
  hours: string | number;
  assigned: boolean;
}
export interface ResourceDetail {
  user_id: number;
  full_name: string;
  title?: string | null;
  cost_rate?: string | number | null;
  submitted_hours: string | number;
  approved_hours: string | number;
  billable_hours: string | number;
  billed: string | number;
  cost: string | number;
  days_back: number;
  allocated_pct: number;
  capacity_state: 'over' | 'ok' | 'under';
  capacity_summary: string;
  projects: ResourceProjectRow[];
  tasks: ResourceTaskRow[];
}
export interface PortfolioRow {
  project_id: number;
  project_name: string;
  client_id?: number | null;
  client_name: string;
  health: ProjectHealth;
  health_reason?: string | null;
  approved_hours: string | number;
  revenue: string | number;
  cost: string | number;
  margin: string | number;
  margin_pct?: number | null;
  budget_amount?: string | number | null;
  budget_used_pct?: number | null;
  days_until_end?: number | null;
  currency: string;
}
export interface Portfolio {
  project_count: number;
  excellent: number;
  on_track: number;
  at_risk: number;
  critical: number;
  blocked: number;
  not_set: number;
  total_revenue: string | number;
  total_cost: string | number;
  total_margin_pct?: number | null;
  rows: PortfolioRow[];
}
export interface EvmRow {
  project_id: number;
  project_name: string;
  client_name: string;
  bac: string | number;
  pv: string | number;
  ev: string | number;
  ac: string | number;
  cpi?: number | null;
  spi?: number | null;
  cost_variance: string | number;
  schedule_variance: string | number;
  percent_complete: number;
  eac: string | number;
  vac: string | number;
  projected_overrun_pct: number;
  risk: 'low' | 'medium' | 'high';
  currency: string;
}
export interface EvmData {
  rows: EvmRow[];
}
export interface RevRecRow {
  project_id: number;
  project_name: string;
  client_name: string;
  method: 'as_billed' | 'percent_complete';
  billed: string | number;
  recognized: string | number;
  percent_complete?: number | null;
  currency: string;
}
export interface RevRec {
  total_billed: string | number;
  total_recognized: string | number;
  rows: RevRecRow[];
}
export interface ManagerFinancials {
  summary: FinancialSummary;
  projects: ProjectFinancialRow[];
}

// Configurable project-health thresholds (GET/PUT /dashboard/health-config).
export interface HealthConfigBody {
  budget_enabled: boolean;
  over_budget_pct: number;
  high_burn_pct: number;
  excellent_under_pct: number;
  schedule_enabled: boolean;
  ending_soon_days: number;
  overdue_days: number;
  margin_enabled: boolean;
  low_margin_pct: number;
}
export interface HealthConfigResponse {
  workspace: HealthConfigBody;
  override: HealthConfigBody | null;
  effective_scope: 'workspace' | 'override';
  can_edit_workspace: boolean;
}

// GET /dashboard/project/:id/task-breakdown — task-level "why" for a project.
export interface TaskBreakdownTask {
  task_id: number;
  name: string;
  status: string;
  hours: string | number;
  cost: string | number;
  revenue: string | number;
  pct_of_hours: number;
  assignees: string[];
  // Phase 2 causal fields. null = not captured (unknown), never zero/overdue.
  estimated_hours?: string | number | null;
  due_date?: string | null;
  blocked_reason?: string | null;
  over_estimate_hours?: string | number | null;
  over_estimate_pct?: number | null;
  days_overdue?: number | null;
}
export interface TaskBreakdownPerson {
  user_id: number;
  full_name: string;
  hours: string | number;
  pct_of_hours: number;
}
export interface TaskBlockingEdge {
  task_id: number;
  task_name: string;
  depends_on_task_id: number;
  depends_on_task_name: string;
  reason?: string | null;
  blocker_open: boolean;
  dependent_started?: boolean;
}
export interface ProjectTaskBreakdown {
  project_id: number;
  project_name: string;
  total_tasks: number;
  done_tasks: number;
  open_tasks: number;
  total_hours: string | number;
  is_overdue: boolean;
  days_overdue: number;
  top_tasks: TaskBreakdownTask[];
  unfinished_at_deadline: TaskBreakdownTask[];
  stalled_tasks: TaskBreakdownTask[];
  by_person: TaskBreakdownPerson[];
  // Phase 2 cause signals (empty until the data is captured).
  blocked_tasks: TaskBreakdownTask[];
  over_estimate_tasks: TaskBreakdownTask[];
  overdue_tasks: TaskBreakdownTask[];
  blocking_chains: TaskBlockingEdge[];
  has_causal_data: boolean;
  notes: string[];
}

// GET /dashboard/manager-clients — the manager's clients + the projects they run.
export interface ManagerClientProject {
  project_id: number;
  project_name: string;
  status?: string | null;
}
export interface ManagerClientRow {
  client_id: number;
  client_name: string;
  project_count: number;
  projects: ManagerClientProject[];
}
export interface ManagerClients {
  client_count: number;
  rows: ManagerClientRow[];
}

// GET /dashboard/my-work — an employee's assigned work grouped by client.
export interface MyWorkTask {
  task_id: number;
  name: string;
  status?: string | null;
  priority?: string | null;
  description?: string | null;
  can_edit?: boolean;
}
export interface MyWorkProject {
  project_id: number;
  project_name: string;
  code?: string | null;
  status?: string | null;
  my_hours: string | number;
  approved_hours: string | number;
  tasks: MyWorkTask[];
}
export interface MyWorkClient {
  client_id: number;
  client_name: string;
  projects: MyWorkProject[];
}
export interface MyWork {
  clients: MyWorkClient[];
  total_projects: number;
  total_tasks: number;
  total_hours: string | number;
}

// GET /dashboard/team-daily-overview — "daily standup" view of the previous
// working day: who submitted, who's still drafting (only while the deadline
// hasn't passed), and who missed it. Mirrors the live backend payload
// (TeamDailyOverviewResponse). Members are full User rows; we read the fields
// the widget needs.
export interface DailyOverviewMember {
  id: number;
  full_name: string;
}

// GET /dashboard/team-rejection-stats — per-employee rejection rate and the
// team's top rejection reasons over a lookback window. Computed from existing
// time entries; no PSA data. rejection_rate_pct is null when an employee had
// no decided entries (undefined, not zero).
export interface TeamRejectionReason {
  reason: string;
  count: number;
}
export interface TeamRejectionRow {
  user_id: number;
  full_name: string;
  decided_count: number;
  rejected_count: number;
  rejection_rate_pct: number | null;
}
export interface TeamRejectionStats {
  days_back: number;
  rows: TeamRejectionRow[];
  top_reasons: TeamRejectionReason[];
  team_rejection_rate_pct: number | null;
}

// GET /dashboard/team-billable-stats — per-employee billable share of approved
// hours over a window. An hours ratio, not revenue (no rates involved).
// billable_pct is null when the employee logged no approved hours.
export interface TeamBillableRow {
  user_id: number;
  full_name: string;
  approved_hours: string | number;
  billable_hours: string | number;
  billable_pct: number | null;
}
export interface TeamBillableStats {
  days_back: number;
  rows: TeamBillableRow[];
  team_billable_pct: number | null;
  team_approved_hours: string | number;
  team_billable_hours: string | number;
}

// GET /dashboard/team-on-time-stats — per-employee on-time submission trend
// at weekly grain. on_time_pct is null when the employee had no active weeks.
export interface TeamOnTimeWeek {
  week_start: string; // YYYY-MM-DD (Monday)
  status: 'on_time' | 'late' | 'none';
}
export interface TeamOnTimeRow {
  user_id: number;
  full_name: string;
  weeks_with_activity: number;
  on_time_weeks: number;
  on_time_pct: number | null;
  recent_weeks: TeamOnTimeWeek[];
}
export interface TeamOnTimeStats {
  days_back: number;
  rows: TeamOnTimeRow[];
  team_on_time_pct: number | null;
}

// GET /dashboard/team-project-matrix — approved hours per employee per project.
export interface TeamProjectMatrixProject {
  project_id: number;
  project_name: string;
  client_name: string;
  total_hours: string | number;
}
export interface TeamProjectMatrixCell {
  project_id: number;
  hours: string | number;
}
export interface TeamProjectMatrixRow {
  user_id: number;
  full_name: string;
  title?: string | null;
  total_hours: string | number;
  revenue?: string | number;
  cells: TeamProjectMatrixCell[];
}
export interface TeamProjectMatrix {
  days_back: number;
  projects: TeamProjectMatrixProject[];
  rows: TeamProjectMatrixRow[];
  grand_total_hours: string | number;
}

export interface TeamDailyOverview {
  date: string;
  submission_deadline_at: string;
  has_time_remaining_until_deadline: boolean;
  team_size: number;
  submitted_yesterday_count: number;
  submitted_yesterday: DailyOverviewMember[];
  draft_yesterday_count: number;
  draft_yesterday: DailyOverviewMember[];
  missing_yesterday_count: number;
  missing_yesterday: DailyOverviewMember[];
  pending_approvals_count: number;
  pending_time_entries_count: number;
  pending_time_off_count: number;
  total_hours_logged_yesterday: string | number;
}

// Personal/scope summary (GET /dashboard/summary). Decimals serialise as
// strings on the wire.
export interface DashboardSummary {
  hours_logged: string | number;
  approved_hours: string | number;
  pending_hours: string | number;
  pending_approvals: number;
  team_members: number;
}

// GET /dashboard/analytics — powers the employee widget grid.
export interface DayBreakdown {
  entry_date: string;
  hours: string | number;
  formatted_date: string;
}
export interface ProjectBreakdownRow {
  project_id: number;
  project_name: string;
  client_name: string;
  hours: string | number;
  percentage: number;
}
export interface ActivityRow {
  description: string;
  project_name: string;
  hours: string | number;
}
export interface DashboardAnalytics {
  total_hours: string | number;
  billable_hours: string | number;
  non_billable_hours: string | number;
  top_project_name: string | null;
  top_client_name: string | null;
  daily_breakdown: DayBreakdown[];
  project_breakdown: ProjectBreakdownRow[];
  top_activities: ActivityRow[];
}
