import { useCallback, useEffect, useState } from 'react';

// Persisted dual-mode primary navigation state.
//
//   mode      — 'sidebar' (vertical) | 'topbar' (horizontal pills)
//   collapsed — sidebar-only: icon rail (true) vs full panel (false)
//
// Both persist to localStorage so a user's own choice survives reloads. Keys
// are namespaced under acufy:timesheet:*. When no value has been stored yet,
// the initial mode/collapsed come from the TEAM DEFAULT (the tenant's
// `default_nav_layout` customization setting), passed in by AppShell.
//
// The team's navigation-switch policy decides whether a user may change their
// layout at all. AppShell computes `canSwitch` (admins always can; otherwise
// it depends on `nav_switch_enabled` and the per-user exception list). When
// `canSwitch` is false the hook FORCES the team default and turns setMode /
// toggleCollapsed into no-ops, so the UI can hide the switch controls. A
// locked user's own stored preference is left untouched (not overwritten), so
// if the policy later re-opens, their previous choice returns.

export type NavMode = 'topbar' | 'sidebar';

const MODE_KEY = 'acufy:timesheet:nav:mode';
const COLLAPSED_KEY = 'acufy:timesheet:nav:collapsed';

// Read the stored mode, or null when the user has never chosen one (so the
// caller can fall back to the team default).
function readStoredMode(): NavMode | null {
  if (typeof window === 'undefined') return null;
  const v = window.localStorage.getItem(MODE_KEY);
  if (v === 'topbar' || v === 'sidebar') return v;
  return null;
}

// Read the stored collapsed flag, or null when unset. Stored as '1'/'0'.
function readStoredCollapsed(): boolean | null {
  if (typeof window === 'undefined') return null;
  const v = window.localStorage.getItem(COLLAPSED_KEY);
  if (v === '1') return true;
  if (v === '0') return false;
  return null;
}

export interface NavModeOptions {
  /** Whether this user is allowed to change their own nav layout. */
  canSwitch: boolean;
  /** Team default mode for a user who has never chosen one. */
  defaultMode: NavMode;
  /** Team default collapsed state for a user who has never chosen one. */
  defaultCollapsed: boolean;
}

export interface NavModeState {
  mode: NavMode;
  collapsed: boolean;
  /** True when the user may switch layout (drives switch-control visibility). */
  canSwitch: boolean;
  setMode: (mode: NavMode) => void;
  toggleMode: () => void;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
}

export function useNavMode({
  canSwitch,
  defaultMode,
  defaultCollapsed,
}: NavModeOptions): NavModeState {
  const [mode, setModeState] = useState<NavMode>(() => readStoredMode() ?? defaultMode);
  const [collapsed, setCollapsedState] = useState<boolean>(
    () => readStoredCollapsed() ?? defaultCollapsed,
  );

  // Reconcile against the policy + team default. When the user can't switch,
  // pin to the team default (state only — never persist, so their own stored
  // choice survives a later policy change). When they can switch but have no
  // stored choice yet, seed from the team default.
  useEffect(() => {
    if (!canSwitch) {
      setModeState(defaultMode);
      setCollapsedState(defaultCollapsed);
      return;
    }
    if (readStoredMode() === null) setModeState(defaultMode);
    if (readStoredCollapsed() === null) setCollapsedState(defaultCollapsed);
  }, [canSwitch, defaultMode, defaultCollapsed]);

  const setMode = useCallback(
    (next: NavMode) => {
      if (!canSwitch) return;
      window.localStorage.setItem(MODE_KEY, next);
      setModeState(next);
    },
    [canSwitch],
  );

  const toggleMode = useCallback(() => {
    if (!canSwitch) return;
    setMode((readStoredMode() ?? mode) === 'sidebar' ? 'topbar' : 'sidebar');
  }, [canSwitch, setMode, mode]);

  const setCollapsed = useCallback(
    (next: boolean) => {
      if (!canSwitch) return;
      window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      setCollapsedState(next);
    },
    [canSwitch],
  );

  const toggleCollapsed = useCallback(() => {
    if (!canSwitch) return;
    setCollapsed(!(readStoredCollapsed() ?? collapsed));
  }, [canSwitch, setCollapsed, collapsed]);

  // Keep multiple tabs / the two nav components in sync if either key changes
  // elsewhere (e.g. a second tab toggles the mode).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === MODE_KEY) setModeState(readStoredMode() ?? defaultMode);
      if (e.key === COLLAPSED_KEY) setCollapsedState(readStoredCollapsed() ?? defaultCollapsed);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [defaultMode, defaultCollapsed]);

  return {
    mode,
    collapsed,
    canSwitch,
    setMode,
    toggleMode,
    setCollapsed,
    toggleCollapsed,
  };
}
