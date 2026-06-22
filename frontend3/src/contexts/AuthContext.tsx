import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { REFRESH_KEY, SESSION_EXPIRED_EVENT, TOKEN_KEY, authApi } from '@/api/client';
import { withOrigin } from '@/lib/basePath';
import type { LoginResponse, User } from '@/types/user';

interface AuthContextValue {
  user: User | null;
  // True only during the initial session-restore probe on first mount.
  // After that, login/logout transitions don't set this — they update
  // `user` synchronously when the request resolves.
  isInitializing: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  // Force a re-fetch of /auth/me — useful after role switches in later
  // phases.
  refreshUser: () => Promise<User | null>;
  // Multi-role: switch the active role (must be in user.roles). Swaps in the
  // fresh token pair and updated user IN THIS TAB.
  switchRole: (role: string) => Promise<User>;
  // Multi-role: open the chosen role in a NEW TAB, leaving this tab untouched.
  // Mints a fresh token for the role, parks it in a one-time localStorage
  // handoff, and opens /dashboard in a new tab which adopts the handoff on boot.
  openRoleInNewTab: (role: string) => Promise<void>;
  // True right after a FRESH login by a user with >1 role: the portal picker
  // should block the dashboard until they choose where to land. Not set on a
  // passive session-restore (/auth/me on mount).
  needsRolePick: boolean;
  // Dismiss the picker (user accepted the role they logged in as).
  dismissRolePick: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const USER_CACHE_KEY = 'acufy-cached-user-v3';
// One-time cross-tab handoff for "open role in new tab". sessionStorage is
// per-tab, so we stage the new tab's tokens in localStorage; the new tab reads
// + deletes them on boot.
const HANDOFF_KEY = 'acufy:role-handoff';

// Decode the active_role claim from a JWT (no verification — display only).
// The backend carries the real authority in the signed token; this is purely
// so the UI renders the correct role view for multi-role users.
function activeRoleFromToken(token: string | null): string | null {
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.active_role === 'string' ? payload.active_role : null;
  } catch {
    return null;
  }
}

// Overlay the token's active_role onto the user object so the UI's role-driven
// rendering matches the token the API is actually authorizing against.
function applyActiveRole(user: User | null, token: string | null): User | null {
  if (!user) return user;
  const active = activeRoleFromToken(token);
  return active && active !== user.role ? { ...user, role: active as User['role'] } : user;
}

function readCachedUser(): User | null {
  try {
    const raw = window.sessionStorage.getItem(USER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as User;
    if (parsed && typeof parsed === 'object' && typeof parsed.id === 'number') {
      return parsed;
    }
  } catch {
    /* corrupt cache — ignore */
  }
  return null;
}

function writeCachedUser(user: User | null) {
  if (user) {
    window.sessionStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
  } else {
    window.sessionStorage.removeItem(USER_CACHE_KEY);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Adopt a pending role-handoff (from a "Switch to X in new tab" click)
  // synchronously, before anything else reads the session, so this tab boots
  // straight into the switched role.
  const adoptHandoff = () => {
    try {
      const raw = window.localStorage.getItem(HANDOFF_KEY);
      if (!raw) return;
      window.localStorage.removeItem(HANDOFF_KEY);
      // Only the access token + user need to cross tabs now: the refresh token
      // lives in the HttpOnly cookie, which is shared across tabs of the same
      // origin, so the new tab can already refresh on its own.
      const h = JSON.parse(raw) as { access_token: string; user: User };
      if (h?.access_token) {
        window.sessionStorage.setItem(TOKEN_KEY, h.access_token);
        window.sessionStorage.removeItem(REFRESH_KEY);
        const u = applyActiveRole(h.user, h.access_token);
        writeCachedUser(u);
      }
    } catch {
      /* malformed handoff — ignore */
    }
  };
  // Run once during module init for this provider instance.
  if (typeof window !== 'undefined') adoptHandoff();

  const [user, setUser] = useState<User | null>(() => applyActiveRole(readCachedUser(), window.sessionStorage.getItem(TOKEN_KEY)));
  // Only true on first mount, and only if there's a token to validate.
  const [isInitializing, setIsInitializing] = useState<boolean>(() => {
    return Boolean(window.sessionStorage.getItem(TOKEN_KEY));
  });
  const [needsRolePick, setNeedsRolePick] = useState(false);
  const dismissRolePick = useCallback(() => setNeedsRolePick(false), []);

  // On mount: if a token exists, re-fetch /auth/me to make sure it's
  // still valid and to pick up any changes the backend has on the user
  // record since the last cache write. If the token is bad, the
  // interceptor will clear it and we'll land in a logged-out state.
  useEffect(() => {
    const token = window.sessionStorage.getItem(TOKEN_KEY);
    if (!token) {
      setIsInitializing(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await authApi.me();
        if (cancelled) return;
        // Overlay the token's active_role so the UI renders the role the token
        // actually authorizes (users.role may still be the primary role).
        const me = applyActiveRole(res.data as User, window.sessionStorage.getItem(TOKEN_KEY));
        setUser(me);
        writeCachedUser(me);
      } catch {
        if (cancelled) return;
        // Token rejected — interceptor already cleared sessionStorage.
        setUser(null);
        writeCachedUser(null);
      } finally {
        if (!cancelled) setIsInitializing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // When the API client determines the session is unrecoverable (refresh failed,
  // or a dead token that /auth/me rejects), it dispatches SESSION_EXPIRED_EVENT.
  // Clear `user` so the router bounces to /login instead of leaving the page on
  // a dead session that 4xx-es every call.
  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      writeCachedUser(null);
      setNeedsRolePick(false);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<User> => {
    const res = await authApi.login(email, password);
    const data = res.data as LoginResponse;
    window.sessionStorage.setItem(TOKEN_KEY, data.access_token);
    // Refresh token is set as an HttpOnly cookie by the backend; nothing to
    // store in JS. Purge any refresh token left by an older build.
    window.sessionStorage.removeItem(REFRESH_KEY);
    writeCachedUser(data.user);
    setUser(data.user);
    // Fresh login: multi-role users must pick a portal before the dashboard
    // renders (prevents a stale persisted role landing them in the wrong view).
    setNeedsRolePick((data.user.roles?.length ?? 0) > 1);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      // The refresh cookie (sent via withCredentials) is what the backend
      // revokes + clears; no token to pass in the body.
      await authApi.logout();
    } catch {
      /* best-effort */
    }
    window.sessionStorage.removeItem(TOKEN_KEY);
    window.sessionStorage.removeItem(REFRESH_KEY);
    writeCachedUser(null);
    setUser(null);
    setNeedsRolePick(false);
  }, []);

  const switchRole = useCallback(async (role: string): Promise<User> => {
    const res = await authApi.switchRole(role);
    const data = res.data as LoginResponse;
    window.sessionStorage.setItem(TOKEN_KEY, data.access_token);
    // switch-role also refreshes the HttpOnly cookie server-side.
    const u = applyActiveRole(data.user, data.access_token) as User;
    writeCachedUser(u);
    setUser(u);
    setNeedsRolePick(false);
    return u;
  }, []);

  const openRoleInNewTab = useCallback(async (role: string): Promise<void> => {
    // Open the tab synchronously (inside the click handler) so the browser
    // doesn't block it as a popup; we fill it after the token mints.
    const tab = window.open('', '_blank');
    try {
      const res = await authApi.switchRole(role);
      const data = res.data as LoginResponse;
      // Don't stage the refresh token in localStorage — the new tab shares the
      // HttpOnly refresh cookie. Only the access token + user need to hand off.
      window.localStorage.setItem(HANDOFF_KEY, JSON.stringify({ access_token: data.access_token, user: data.user }));
      // Include the deploy base path so the new tab lands on
      // /apps/timesheet/dashboard, not the host root /dashboard.
      const dest = withOrigin('/dashboard');
      if (tab) tab.location.href = dest;
      else window.open(dest, '_blank');
    } catch {
      // Mint failed — close the blank tab so we don't leave an empty one.
      if (tab) tab.close();
      throw new Error('Could not switch role.');
    }
  }, []);

  const refreshUser = useCallback(async (): Promise<User | null> => {
    try {
      const res = await authApi.me();
      const me = res.data as User;
      setUser(me);
      writeCachedUser(me);
      return me;
    } catch {
      return null;
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isInitializing,
      isAuthenticated: Boolean(user),
      login,
      logout,
      refreshUser,
      switchRole,
      openRoleInNewTab,
      needsRolePick,
      dismissRolePick,
    }),
    [user, isInitializing, login, logout, refreshUser, switchRole, openRoleInNewTab, needsRolePick, dismissRolePick],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

// Convenience role helpers. Pages can either useAuth() and read user.role
// directly or use these to avoid the optional-chaining noise.
export function useIsAdmin(): boolean {
  const { user } = useAuth();
  return user?.role === 'ADMIN' || user?.role === 'PLATFORM_ADMIN';
}
export function useIsManager(): boolean {
  const { user } = useAuth();
  return user?.role === 'MANAGER';
}
export function useIsPlatformAdmin(): boolean {
  const { user } = useAuth();
  return user?.role === 'PLATFORM_ADMIN';
}
export function useCanReview(): boolean {
  const { user } = useAuth();
  return Boolean(user && user.role !== 'ADMIN' && user.can_review);
}
