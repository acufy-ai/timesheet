import { useCallback, useMemo } from 'react';

import { useUserPreferences, useUpdatePreferences } from '@/hooks/useUserPreferences';

// Per-user customization of the MANAGER dashboard: which tiles show, the order
// they appear in, and (for column-bearing tiles) which columns are visible.
// Persisted server-side under the free-form `manager_dashboard` key on
// users.preferences, so it follows the user across devices. No backend change:
// it rides the existing GET/PATCH /users/me/preferences endpoints.

// Stable identity for every customizable manager tile. The stat strip is fixed
// (always first) and intentionally not in the registry.
export type ManagerTileKey =
  | 'project-health'
  | 'project-matrix'
  | 'financials'
  | 'clients-projects'
  | 'daily'
  | 'quality'
  | 'roster';

export interface ManagerTileDef {
  key: ManagerTileKey;
  label: string;
  /** Column-bearing tiles expose toggleable columns; others omit this. */
  columns?: { key: string; label: string; locked?: boolean }[];
}

// The registry: the source of truth for tile identity, default order, labels,
// and per-tile columns. Order here is the DEFAULT order.
export const MANAGER_TILES: ManagerTileDef[] = [
  {
    key: 'project-health',
    label: 'Project health',
    columns: [
      { key: 'project', label: 'Project', locked: true },
      { key: 'client', label: 'Client' },
      { key: 'hours_this_week', label: 'Hours this week' },
      { key: 'budget', label: 'Budget' },
      { key: 'health', label: 'Health', locked: true },
    ],
  },
  {
    key: 'project-matrix',
    label: 'Project hours by person',
    columns: [
      { key: 'person', label: 'Person', locked: true },
      { key: 'projects', label: 'Project columns' },
      { key: 'total', label: 'Total', locked: true },
      { key: 'revenue', label: 'Revenue' },
    ],
  },
  {
    key: 'financials',
    label: 'Financials',
    columns: [
      { key: 'project', label: 'Project', locked: true },
      { key: 'hours', label: 'Hours' },
      { key: 'revenue', label: 'Revenue' },
      { key: 'budget_used', label: 'Budget burn' },
      { key: 'contract_used', label: 'Contract billed' },
    ],
  },
  { key: 'clients-projects', label: 'Clients & projects' },
  { key: 'daily', label: 'Daily check-in' },
  { key: 'quality', label: 'Team quality (billable + on-time)' },
  { key: 'roster', label: 'Team roster' },
];

const DEFAULT_ORDER = MANAGER_TILES.map((t) => t.key);
const ALL_KEYS = new Set<ManagerTileKey>(DEFAULT_ORDER);

export interface ManagerDashboardPrefs {
  order: ManagerTileKey[];
  hidden: ManagerTileKey[];
  /** tileKey -> hidden column keys for that tile. */
  hiddenColumns: Partial<Record<ManagerTileKey, string[]>>;
}

function defaults(): ManagerDashboardPrefs {
  return { order: [...DEFAULT_ORDER], hidden: [], hiddenColumns: {} };
}

// Validate + merge whatever is stored against the current registry, so a stale
// or partial blob (e.g. a tile that was renamed/removed, or a new tile added
// after the prefs were saved) degrades gracefully instead of breaking.
function normalize(raw: unknown): ManagerDashboardPrefs {
  const out = defaults();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<ManagerDashboardPrefs>;

  if (Array.isArray(r.order)) {
    const stored = r.order.filter((k): k is ManagerTileKey => ALL_KEYS.has(k as ManagerTileKey));
    // Append any registry keys missing from the stored order (new tiles).
    for (const k of DEFAULT_ORDER) if (!stored.includes(k)) stored.push(k);
    out.order = stored;
  }
  if (Array.isArray(r.hidden)) {
    out.hidden = r.hidden.filter((k): k is ManagerTileKey => ALL_KEYS.has(k as ManagerTileKey));
  }
  if (r.hiddenColumns && typeof r.hiddenColumns === 'object') {
    const hc: Partial<Record<ManagerTileKey, string[]>> = {};
    for (const t of MANAGER_TILES) {
      const stored = (r.hiddenColumns as Record<string, unknown>)[t.key];
      if (Array.isArray(stored) && t.columns) {
        const valid = new Set(t.columns.filter((c) => !c.locked).map((c) => c.key));
        const kept = stored.filter((c): c is string => typeof c === 'string' && valid.has(c));
        if (kept.length) hc[t.key] = kept;
      }
    }
    out.hiddenColumns = hc;
  }
  return out;
}

export function useManagerDashboardPrefs() {
  const prefsQ = useUserPreferences();
  const update = useUpdatePreferences();

  const prefs = useMemo(
    () => normalize((prefsQ.data as Record<string, unknown> | undefined)?.manager_dashboard),
    [prefsQ.data],
  );

  const persist = useCallback(
    (next: ManagerDashboardPrefs) => {
      update.mutate({ manager_dashboard: next } as Record<string, unknown>);
    },
    [update],
  );

  const setOrder = useCallback(
    (order: ManagerTileKey[]) => persist({ ...prefs, order }),
    [prefs, persist],
  );

  const toggleHidden = useCallback(
    (key: ManagerTileKey) => {
      const hidden = prefs.hidden.includes(key)
        ? prefs.hidden.filter((k) => k !== key)
        : [...prefs.hidden, key];
      persist({ ...prefs, hidden });
    },
    [prefs, persist],
  );

  const moveTile = useCallback(
    (key: ManagerTileKey, dir: -1 | 1) => {
      const order = [...prefs.order];
      const i = order.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      persist({ ...prefs, order });
    },
    [prefs, persist],
  );

  const toggleColumn = useCallback(
    (tile: ManagerTileKey, col: string) => {
      const cur = prefs.hiddenColumns[tile] ?? [];
      const next = cur.includes(col) ? cur.filter((c) => c !== col) : [...cur, col];
      const hiddenColumns = { ...prefs.hiddenColumns, [tile]: next };
      if (next.length === 0) delete hiddenColumns[tile];
      persist({ ...prefs, hiddenColumns });
    },
    [prefs, persist],
  );

  const reset = useCallback(() => persist(defaults()), [persist]);

  // Convenience selectors used by the dashboard renderer.
  const isHidden = useCallback((key: ManagerTileKey) => prefs.hidden.includes(key), [prefs.hidden]);
  const isColumnHidden = useCallback(
    (tile: ManagerTileKey, col: string) => (prefs.hiddenColumns[tile] ?? []).includes(col),
    [prefs.hiddenColumns],
  );

  return {
    prefs,
    loading: prefsQ.isLoading,
    saving: update.isPending,
    setOrder,
    toggleHidden,
    moveTile,
    toggleColumn,
    reset,
    isHidden,
    isColumnHidden,
  };
}
