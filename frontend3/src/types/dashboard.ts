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

export type ProjectHealth = 'healthy' | 'at-risk' | 'over-budget' | 'not-set';

export interface ProjectHealthRow {
  project_id: number;
  project_name: string;
  client_name: string;
  days_until_end: number | null;
  hours_this_week: string;
  budget_pct: number | null;
  budget_hours_remaining: number | null;
  health: ProjectHealth;
}

export interface ManagerProjectHealth {
  rows: ProjectHealthRow[];
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
  total_hours: string | number;
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
