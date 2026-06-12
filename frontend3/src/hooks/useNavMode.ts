import { useCallback, useEffect, useState } from 'react';

// Persisted dual-mode primary navigation state.
//
//   mode      — 'sidebar' (vertical, default) | 'topbar' (horizontal pills)
//   collapsed — sidebar-only: icon rail (true, default) vs full panel (false)
//
// Both persist to localStorage so the choice survives reloads. Keys are
// namespaced under acufy:timesheet:* per the design spec. When no value has
// been stored yet, the app opens in the collapsed sidebar.
//
// An optional `enforced` argument (driven by the tenant setting
// `enforced_nav_mode`) can LOCK the mode for every user: when it is
// 'sidebar' or 'topbar' the hook forces that mode, `enforced` is reported
// true, and setMode/toggleMode become no-ops so the UI can hide/disable the
// switch control. 'off' (the default) restores per-user choice.

export type NavMode = 'topbar' | 'sidebar';

const MODE_KEY = 'acufy:timesheet:nav:mode';
const COLLAPSED_KEY = 'acufy:timesheet:nav:collapsed';

// The collapsible sidebar is the default nav. When no value is stored, open
// in sidebar mode, collapsed to the icon rail.
function readMode(): NavMode {
  if (typeof window === 'undefined') return 'sidebar';
  const v = window.localStorage.getItem(MODE_KEY);
  return v === 'topbar' ? 'topbar' : 'sidebar';
}

function readCollapsed(): boolean {
  if (typeof window === 'undefined') return true;
  const v = window.localStorage.getItem(COLLAPSED_KEY);
  // Unset → default collapsed (icon rail). Only an explicit '0' pins it open.
  return v !== '0';
}

export interface NavModeState {
  mode: NavMode;
  collapsed: boolean;
  /** True when an admin has locked the mode (mode/toggle are no-ops). */
  enforced: boolean;
  setMode: (mode: NavMode) => void;
  toggleMode: () => void;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
}

/**
 * @param enforcedMode tenant setting `enforced_nav_mode`. 'sidebar' | 'topbar'
 *   force that mode and disable switching; 'off' / undefined = user choice.
 */
export function useNavMode(enforcedMode?: string | null): NavModeState {
  const [mode, setModeState] = useState<NavMode>(readMode);
  const [collapsed, setCollapsedState] = useState<boolean>(readCollapsed);

  const locked = enforcedMode === 'sidebar' || enforcedMode === 'topbar';
  const effectiveMode: NavMode = locked ? (enforcedMode as NavMode) : mode;

  const setMode = useCallback(
    (next: NavMode) => {
      if (locked) return; // admin-enforced: ignore user changes
      window.localStorage.setItem(MODE_KEY, next);
      setModeState(next);
    },
    [locked],
  );

  const toggleMode = useCallback(() => {
    if (locked) return;
    setMode(readMode() === 'sidebar' ? 'topbar' : 'sidebar');
  }, [locked, setMode]);

  const setCollapsed = useCallback((next: boolean) => {
    window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    setCollapsedState(next);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(!readCollapsed());
  }, [setCollapsed]);

  // Keep multiple tabs / the two nav components in sync if either key
  // changes elsewhere (e.g. a second tab toggles the mode).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === MODE_KEY) setModeState(readMode());
      if (e.key === COLLAPSED_KEY) setCollapsedState(readCollapsed());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return {
    mode: effectiveMode,
    collapsed,
    enforced: locked,
    setMode,
    toggleMode,
    setCollapsed,
    toggleCollapsed,
  };
}
