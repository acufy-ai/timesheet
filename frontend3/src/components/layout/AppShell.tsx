import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { useNavMode } from '@/hooks/useNavMode';
import { usePublicTenantSettings } from '@/hooks/useAdmin';
import { TimerProvider } from '@/contexts/TimerContext';
import { registerTimerSW } from '@/lib/registerTimerSW';
import { UtilityBar } from './UtilityBar';
import { TopNav } from './TopNav';
import { Sidebar } from './Sidebar';
import { PortalPickerModal } from './PortalPickerModal';
import { PreferencesDefaultsSync } from './PreferencesDefaultsSync';
import { FloatingTimer } from '@/components/timer/FloatingTimer';
import type { UserRole } from '@/types/user';

// Authenticated app shell with dual-mode primary navigation. Renders either
// TopNav (horizontal, default) or Sidebar (vertical), persisted via
// useNavMode (localStorage 'acufy:timesheet:nav:mode'). Unauthenticated users
// are bounced to /login; the initial session-restore probe shows a spinner.
export function AppShell() {
  const { isAuthenticated, isInitializing, user, needsRolePick, dismissRolePick, switchRole } = useAuth();
  // Team navigation policy (customization settings). Read from the PUBLIC
  // settings endpoint so it applies to every role, not just admins (the full
  // /tenant-settings endpoint is admin-only):
  //   default_nav_layout   — the layout new users start with
  //   nav_switch_enabled   — whether non-admins may change their own layout
  //   nav_switch_user_ids  — per-user exceptions when switching is off
  // canSwitch = admin OR switching allowed for all OR user is an exception.
  // When a user can't switch, useNavMode pins them to the team default and the
  // nav components hide the switch controls.
  const tenantSettings = usePublicTenantSettings(isAuthenticated);
  const settings = tenantSettings.data ?? {};
  const teamLayout =
    typeof settings.default_nav_layout === 'string'
      ? (settings.default_nav_layout as string)
      : 'sidebar';
  const switchAllowed = settings.nav_switch_enabled !== false; // default on
  const exceptionIds = Array.isArray(settings.nav_switch_user_ids)
    ? (settings.nav_switch_user_ids as unknown[]).map((v) => String(v))
    : [];
  const isAdminRole = user?.role === 'ADMIN' || user?.role === 'PLATFORM_ADMIN';
  const inException = Boolean(user && exceptionIds.includes(String(user.id)));
  const canSwitch = Boolean(isAdminRole || switchAllowed || inException);
  const defaultMode = teamLayout === 'topbar' ? 'topbar' : 'sidebar';
  const defaultCollapsed = teamLayout === 'sidebar_collapsed';
  const { mode, collapsed, setMode, toggleCollapsed } = useNavMode({
    canSwitch,
    defaultMode,
    defaultCollapsed,
  });
  const location = useLocation();
  const navigate = useNavigate();
  const [pickPending, setPickPending] = useState(false);

  // Ingestion is enabled when the user can review (mailbox config is a
  // separate concern). For step 5 we derive it from can_review; later phases
  // can swap in a tenant-features query.
  const ingestionEnabled = Boolean(user && user.role !== 'ADMIN' && user.can_review);

  async function handlePick(role: UserRole) {
    if (!user) return;
    setPickPending(true);
    try {
      // Accepting the role they logged in as: just dismiss, no round-trip.
      if (user.role === role) dismissRolePick();
      else await switchRole(role);
      navigate('/dashboard', { replace: true });
    } catch {
      /* leave the picker open; the switch can be retried */
    } finally {
      setPickPending(false);
    }
  }

  // Register the timer service worker once (keeps a running timer alive when
  // the tab is backgrounded). Safe no-op where SW is unsupported.
  useEffect(() => { void registerTimerSW(); }, []);

  if (isInitializing) {
    return (
      <div className="grid h-screen place-items-center bg-background text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  // Shell layout for both modes: the UtilityBar is always on top. Below it,
  // either a horizontal nav row (topbar) over full-width content, or a vertical
  // sidebar beside the content. The sidebar is in-flow (click-to-pin; it no
  // longer floats on hover), so the content simply sits beside it.
  return (
    <TimerProvider>
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <UtilityBar />

      {mode === 'sidebar' ? (
        <div className="flex min-h-0 flex-1">
          <Sidebar
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            onSwitchToTopbar={() => setMode('topbar')}
            ingestionEnabled={ingestionEnabled}
            canSwitch={canSwitch}
          />
          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="w-full px-5 py-6 sm:px-6 lg:px-8">
              <Outlet />
            </div>
          </main>
        </div>
      ) : (
        <>
          <TopNav onDockToSidebar={() => setMode('sidebar')} ingestionEnabled={ingestionEnabled} canSwitch={canSwitch} />
          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1800px] px-5 py-6 sm:px-6 lg:px-8">
              <Outlet />
            </div>
          </main>
        </>
      )}

      {/* Multi-role users pick their portal right after a fresh login, before
          touching the dashboard. Overlay lives at the shell level so it
          survives the post-login redirect. */}
      <PortalPickerModal
        isOpen={Boolean(user) && needsRolePick}
        roles={(user?.roles ?? []) as UserRole[]}
        currentRole={user?.role}
        onPick={handlePick}
        pending={pickPending}
      />

      {/* Live timer floating widget (visible whenever a timer is active). */}
      <FloatingTimer />

      {/* Applies the tenant's appearance defaults (theme/palette) to a
          brand-new user once their preferences load. Renders nothing. */}
      <PreferencesDefaultsSync enabled={isAuthenticated} />
    </div>
    </TimerProvider>
  );
}
