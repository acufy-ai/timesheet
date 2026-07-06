// Platform-admin (control-plane) shapes. Cross-tenant superuser console.

export type TenantStatus = 'active' | 'inactive' | 'suspended' | string;

export interface Tenant {
  id: number;
  name: string;
  slug: string;
  status: TenantStatus;
  ingestion_enabled: boolean;
  max_mailboxes?: number | null;
  timezone?: string | null;
  has_logo?: boolean;
  created_at: string;
  updated_at: string;
}

// Per-tenant compact stats (GET /platform/tenants/stats).
export interface TenantStatsEntry {
  user_count?: number | null;
  admin_count?: number | null;
  last_activity_at?: string | null;
  error?: string | null;
}

// A tenant's admins by multi-role membership (GET /platform/tenants/{id}/admins).
export interface TenantAdminEntry {
  id: number;
  full_name: string;
  email: string;
  is_active_role: boolean;
  last_login_at?: string | null;
}

// Per-tenant feature flags (GET/PATCH /tenants/{id}/features).
export interface TenantFeatures {
  tenant_id: number;
  custom_outbound_email: boolean;
  custom_email_template: boolean;
}

// A service token (inter-service auth). Plaintext only present on create.
export interface ServiceToken {
  id: number;
  name: string;
  tenant_id: number;
  issuer: string;
  is_active: boolean;
  last_used_at?: string | null;
  created_at?: string | null;
  token?: string; // only returned once, on create
}

export interface CreateTenantBody {
  name: string;
  slug: string;
  is_isolated?: boolean;
  // Optional first admin to seed at create time.
  admin_full_name?: string;
  admin_email?: string;
}

// GET /platform/dashboard/summary
export interface PlatformSummary {
  active_tenants: number;
  active_tenants_delta?: string | null;
  total_users: number;
  total_users_delta?: string | null;
  fetch_jobs_24h: number;
  fetch_jobs_24h_delta?: string | null;
  hours_logged_this_week: number;
  hours_logged_delta?: string | null;
}

// GET /platform/dashboard/health
export interface HealthWidget {
  key: string;
  label: string;
  value: string;
  status: 'good' | 'warn' | 'bad' | string;
  detail?: string | null;
}
export interface PlatformHealth {
  widgets: HealthWidget[];
  refreshed_at: string;
}

// GET /platform/audit
export type PlatformAuditCategory =
  | 'tenant'
  | 'feature'
  | 'admin'
  | 'credentials'
  | 'migration'
  | 'system'
  | string;

export type PlatformAuditSeverity = 'info' | 'warn' | 'warning' | 'critical' | 'error' | string;

export interface PlatformAuditRow {
  id: number;
  created_at: string;
  category: PlatformAuditCategory;
  event: string;
  severity: PlatformAuditSeverity;
  summary: string;
  actor_user_id?: number | null;
  actor_email?: string | null;
  actor_label?: string | null;
  tenant_id?: number | null;
  tenant_slug?: string | null;
  tenant_name?: string | null;
  request_ip?: string | null;
  route?: string | null;
}
export interface PlatformAuditList {
  items: PlatformAuditRow[];
  total: number;
  limit: number;
  offset: number;
}

// GET /platform/audit/{id} — the list row plus the heavy JSON payloads.
export interface PlatformAuditEventDetail extends PlatformAuditRow {
  user_agent?: string | null;
  before_state?: Record<string, unknown> | null;
  after_state?: Record<string, unknown> | null;
}

// Query params accepted by GET /platform/audit (all AND-combined, server-side).
export interface PlatformAuditParams {
  limit?: number;
  offset?: number;
  category?: string;
  tenant_id?: number;
  search?: string;
  range_start?: string;
  range_end?: string;
}

// GET /platform/calendar/events
export interface PlatformCalendarEvent {
  id: string;
  date: string;
  type: string;
  title: string;
  tenant_slug?: string | null;
  tenant_name?: string | null;
  detail?: string | null;
}
export interface PlatformCalendarResponse {
  range_start: string;
  range_end: string;
  events: PlatformCalendarEvent[];
}

// GET/PUT /platform/settings/smtp — field names mirror the backend
// SmtpConfigResponse (app/api/platform_settings.py). `source` tells the UI
// whether the live config comes from env vars or the DB; `smtp_password_set`
// is the masked indicator (the password itself is never returned).
export interface SmtpConfig {
  smtp_host: string;
  smtp_port: number;
  smtp_username: string;
  smtp_password_set: boolean;
  smtp_from_address: string;
  smtp_from_name: string;
  smtp_use_tls: boolean;
  source: 'database' | 'environment' | string;
}

// PUT body — `smtp_password: null` (or omitted) keeps the existing password.
export interface SmtpConfigUpdate {
  smtp_host: string;
  smtp_port: number;
  smtp_username: string;
  smtp_password?: string | null;
  smtp_from_address: string;
  smtp_from_name: string;
  smtp_use_tls: boolean;
}
