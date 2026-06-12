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
