import { useCallback, useSyncExternalStore } from 'react';

// Per-user dashboard widget layout: column SPAN per widget (resize) and the
// ORDER widgets appear in (drag-to-reorder). Persisted to localStorage so the
// layout sticks across reloads. Visibility (show/hide) is owned separately by
// the existing hidden-widgets set in EmployeeWidgets; this store is layout-only.
//
// The grid is 12 columns (matches frontend2). Each widget declares the set of
// spans it may take; the resize control steps through that set and is disabled
// at the ends (so you can both grow AND shrink).

export type WidgetKey =
  | 'total' | 'today' | 'utilization' | 'overtime' | 'topproject'
  | 'productivity' | 'daily' | 'projects' | 'activities' | 'timeoff';

// Allowed column spans (out of 12) per widget, smallest -> largest.
export const ALLOWED_SIZES: Record<WidgetKey, number[]> = {
  total:        [3, 4, 6],
  today:        [3, 4],
  utilization:  [3, 4],
  overtime:     [3, 4],
  topproject:   [4, 6, 8],
  productivity: [6, 8, 12],
  daily:        [6, 8, 12],
  projects:     [6, 8, 12],
  activities:   [6, 12],
  timeoff:      [4, 6, 8],
};

// Default span (first entry that reads well) + default order.
const DEFAULT_SPAN: Record<WidgetKey, number> = {
  total: 3, today: 3, utilization: 3, overtime: 3,
  topproject: 6, productivity: 6, timeoff: 6,
  daily: 6, projects: 6, activities: 12,
};
const DEFAULT_ORDER: WidgetKey[] = [
  'total', 'today', 'utilization', 'overtime',
  'topproject', 'productivity', 'timeoff',
  'daily', 'projects', 'activities',
];

export interface DashboardLayout {
  order: WidgetKey[];
  sizes: Record<WidgetKey, number>;
}

const STORAGE_KEY = 'acufy:timesheet:dash:layout';

function getDefaults(): DashboardLayout {
  return { order: [...DEFAULT_ORDER], sizes: { ...DEFAULT_SPAN } };
}

function readStore(): DashboardLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaults();
    const parsed = JSON.parse(raw) as Partial<DashboardLayout>;
    const out = getDefaults();
    if (parsed.sizes) {
      for (const k of Object.keys(out.sizes) as WidgetKey[]) {
        const v = parsed.sizes[k];
        // Only accept a stored size that's still an allowed span for the key.
        if (typeof v === 'number' && ALLOWED_SIZES[k]?.includes(v)) out.sizes[k] = v;
      }
    }
    if (Array.isArray(parsed.order)) {
      const valid = new Set(Object.keys(out.sizes) as WidgetKey[]);
      const stored = parsed.order.filter((k): k is WidgetKey => valid.has(k as WidgetKey));
      // Append any keys missing from the stored order (e.g. a new widget).
      for (const k of out.order) if (!stored.includes(k)) stored.push(k);
      out.order = stored;
    }
    return out;
  } catch {
    return getDefaults();
  }
}

let currentState = readStore();
const listeners = new Set<() => void>();

function setState(next: DashboardLayout) {
  currentState = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function getSnapshot() { return currentState; }

export function useDashboardPrefs() {
  const state = useSyncExternalStore(subscribe, getSnapshot);

  const setOrder = useCallback((order: WidgetKey[]) => {
    setState({ ...currentState, order });
  }, []);

  const setSize = useCallback((key: WidgetKey, size: number) => {
    if (!ALLOWED_SIZES[key]?.includes(size)) return;
    setState({ ...currentState, sizes: { ...currentState.sizes, [key]: size } });
  }, []);

  // Step a widget's span up (+1) or down (-1) through its allowed set. No-op at
  // the ends — callers disable the button so the user sees the limit.
  const stepSize = useCallback((key: WidgetKey, dir: 1 | -1) => {
    const allowed = ALLOWED_SIZES[key];
    if (!allowed || allowed.length <= 1) return;
    const idx = allowed.indexOf(currentState.sizes[key]);
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= allowed.length) return;
    setState({ ...currentState, sizes: { ...currentState.sizes, [key]: allowed[nextIdx] } });
  }, []);

  const canGrow = useCallback((key: WidgetKey) => {
    const allowed = ALLOWED_SIZES[key];
    return allowed.indexOf(state.sizes[key]) < allowed.length - 1;
  }, [state]);

  const canShrink = useCallback((key: WidgetKey) => {
    const allowed = ALLOWED_SIZES[key];
    return allowed.indexOf(state.sizes[key]) > 0;
  }, [state]);

  const resetLayout = useCallback(() => { setState(getDefaults()); }, []);

  return { layout: state, setOrder, setSize, stepSize, canGrow, canShrink, resetLayout };
}
