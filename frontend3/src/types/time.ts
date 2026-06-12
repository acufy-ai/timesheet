// Time-entry + project shapes. Mirror the live backend payloads from
// /timesheets/my and /projects (verified against manager1@example.com on
// 2026-06-05). Only the fields the UI consumes are typed; the wire payload
// has more.

export type TimeEntryStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

export interface Project {
  id: number;
  name: string;
  client_id: number;
  code?: string | null;
  billable_rate?: string | null;
  is_active: boolean;
}

// Tasks belong to a project; an entry may optionally reference one.
// Mirrors frontend2's Task shape (src/types/index.ts).
export interface Task {
  id: number;
  project_id: number;
  name: string;
  code?: string | null;
  description?: string | null;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
  project?: Project;
}

// Whether the current user is allowed to submit this week's drafts, with a
// reason when blocked. From GET /timesheets/weekly-submit-status.
export interface WeeklySubmissionStatus {
  can_submit: boolean;
  reason: string | null;
  due_date: string;
}

// Minimal user shape eager-loaded onto entries in the approvals feed.
export interface EntryUser {
  id: number;
  email: string;
  full_name: string;
  role?: string;
}

export interface TimeEntry {
  id: number;
  user_id: number;
  project_id: number;
  task_id?: number | null;
  entry_date: string; // YYYY-MM-DD
  start_time?: string | null;
  end_time?: string | null;
  hours: string | number;
  description: string;
  notes?: string | null;
  is_billable: boolean;
  status: TimeEntryStatus;
  submitted_at: string | null;
  approved_at?: string | null;
  approved_by_name?: string | null;
  rejected_by_name?: string | null;
  rejection_reason: string | null;
  project?: Project;
  // Present on the approvals feed (/approvals/pending, /approvals/history).
  user?: EntryUser;
  created_at: string;
  updated_at: string;
}

// Payload for POST /timesheets. tenant_id is injected server-side.
// start_time/end_time are wire-format HH:MM or HH:MM:SS, both nullable so the
// caller can log hours-only entries when no time block is known. Matches
// frontend2's timeentriesAPI.create contract exactly.
export interface CreateTimeEntry {
  project_id: number;
  task_id?: number | null;
  entry_date: string;
  start_time?: string | null;
  end_time?: string | null;
  hours: number;
  description: string;
  notes?: string | null;
  is_billable?: boolean;
}

// Payload for PUT /timesheets/{id}. The backend's update gate requires
// edit_reason + history_summary for the audit trail; the inline editor
// supplies fixed defaults (frontend2 does the same).
export interface UpdateTimeEntry {
  project_id?: number;
  task_id?: number | null;
  entry_date?: string;
  start_time?: string | null;
  end_time?: string | null;
  hours?: number;
  description?: string;
  notes?: string | null;
  is_billable?: boolean;
  edit_reason?: string;
  history_summary?: string;
}

// One parsed row from POST /timesheets/parse-natural. The backend resolves
// project/task/client from the user's assignments; error is per-row.
export interface ParsedEntry {
  project_id: number | null;
  project_name: string;
  task_id: number | null;
  task_name: string;
  client_name: string;
  client_id: number | null;
  entry_date: string;
  hours: number | null;
  // The NL parser may extract a time block ("9-5"); these round-trip to the
  // saved entry even though the preview UI doesn't expose them for editing.
  start_time?: string | null;
  end_time?: string | null;
  description: string;
  notes?: string | null;
  is_billable: boolean;
  error: string | null;
  // When the same task name exists in multiple projects (ambiguous), the parser
  // returns candidates so the user can pick the right project/task.
  alternatives?: Array<{ project_id: number; project_name: string; task_id: number; task_name: string }>;
}

export interface ParseNaturalResult {
  entries: ParsedEntry[];
  raw_input?: string;
  error?: string;
}

// Query params for GET /timesheets/my (mirrors frontend2's timeentriesAPI.list).
export interface ListEntriesParams {
  start_date?: string;
  end_date?: string;
  status?: string;
  search?: string;
  sort_by?: 'entry_date' | 'created_at' | 'hours' | 'status';
  sort_order?: 'asc' | 'desc';
  skip?: number;
  limit?: number;
}

// One entry inside an approval-history group (GET /approvals/history-grouped).
// Flattened/denormalised by the backend (project_name/task_name strings).
export interface HistoryEntry {
  id: number;
  entry_date: string;
  hours: number;
  description: string;
  status: TimeEntryStatus;
  rejection_reason: string | null;
  project_name: string | null;
  task_name: string | null;
  start_time: string | null;
  end_time: string | null;
}

// One employee-week of decided entries from GET /approvals/history-grouped.
export interface HistoryGroup {
  employee_id: number;
  employee_name: string;
  week_start: string;
  week_end: string;
  total_hours: number;
  entry_count: number;
  approved_count: number;
  rejected_count: number;
  status: 'approved' | 'rejected' | 'mixed';
  entries: HistoryEntry[];
}

// Map the wire status (uppercase) to the StatusBadge meta keys (lowercase).
export function timesheetStatusKey(status: TimeEntryStatus): string {
  return status.toLowerCase();
}
