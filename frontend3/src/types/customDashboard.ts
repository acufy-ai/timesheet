// Configurable Insights dashboards (Smartsheet-style). The `layout` is an array
// of widget instances; the frontend owns its shape (the backend stores it as
// opaque JSONB).

export type WidgetType =
  | 'kpi' | 'chart' | 'table' | 'health'
  | 'evm' | 'revrec' | 'utilization' | 'ontime';

// Per-type config. Loosely typed; each widget validates what it needs.
export interface WidgetConfig {
  // kpi
  metric?: string;        // 'revenue' | 'margin_pct' | 'at_risk' | 'utilization' | 'hours' | 'cost' | 'projects'
  // chart
  source?: string;        // 'health' | 'revenue_by_project' | 'margin_by_project'
  chartKind?: 'donut' | 'bar' | 'line';
  // table
  table?: string;         // 'top_projects' | 'financials' | 'overdue'
  [k: string]: unknown;
}

export interface WidgetInstance {
  id: string;             // client-generated stable id
  type: WidgetType;
  x: number;              // grid column (0..11)
  y: number;              // grid row
  w: number;              // column span (1..12)
  h: number;              // row span
  title?: string;
  config?: WidgetConfig;
}

export interface CustomDashboard {
  id: number;
  name: string;
  is_shared: boolean;
  owner_user_id?: number | null;
  owner_name?: string | null;
  is_owner: boolean;
  layout: WidgetInstance[];
  // Public-share state (only populated for the owner). Null token = not shared.
  share_token?: string | null;
  share_mode?: 'live' | 'snapshot';
  share_snapshot_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type ShareMode = 'live' | 'snapshot';

export interface DashboardShareResult {
  share_token: string;
  share_mode: ShareMode;
  share_snapshot_at?: string | null;
}

// What the public (no-login) endpoint returns: the layout + the metric bundles
// the widgets read from (keyed by bundle name: portfolio/financials/evm/...).
export interface PublicDashboard {
  name: string;
  layout: WidgetInstance[];
  owner_name?: string | null;
  mode: ShareMode;
  data: Record<string, unknown>;
  captured_at?: string | null;
}

export interface CustomDashboardBody {
  name?: string;
  is_shared?: boolean;
  layout?: WidgetInstance[];
}
