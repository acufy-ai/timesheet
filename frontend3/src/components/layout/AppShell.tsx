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
import { FloatingTimer } from '@/components/timer/FloatingTimer';
import type { UserRole } from '@/types/user';

// Authenticated app shell with dual-mode primary navigation. Renders either
// TopNav (horizontal, default) or Sidebar (vertical), persisted via
// useNavMode (localStorage 'acufy:timesheet:nav:mode'). Unauthenticated users
// are bounced to /login; the initial session-restore probe shows a spinner.
export function AppShell() {
  const { isAuthenticated, isInitializing, user, needsRolePick, dismissRolePick, switchRole } = useAuth();
  // Admins can lock the nav layout via the `enforced_nav_mode` tenant setting
  // ('off' | 'sidebar' | 'topbar'). When locked, useNavMode forces that mode
  // and reports `enforced`, which hides the in-app switch control. Read from
  // the PUBLIC settings endpoint so enforcement applies to every role, not
  // just admins (the full /tenant-settings endpoint is admin-only).
  const tenantSettings = usePublicTenantSettings(isAuthenticated);
  const enforcedNavMode =
    typeof tenantSettings.data?.enforced_nav_mode === 'string'
      ? (tenantSettings.data.enforced_nav_mode as string)
      : null;
  const { mode, collapsed, enforced, setMode, toggleCollapsed } = useNavMode(enforcedNavMode);
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
  // sidebar beside the content. The sidebar row is `relative` so the sidebar's
  // absolute hover-flyout is bounded to the content area, not the viewport.
  return (
    <TimerProvider>
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <UtilityBar />

      {mode === 'sidebar' ? (
        <div className="relative flex min-h-0 flex-1">
          <Sidebar
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            onSwitchToTopbar={() => setMode('topbar')}
            ingestionEnabled={ingestionEnabled}
            enforced={enforced}
          />
          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="w-full px-5 py-6 sm:px-6 lg:px-8">
              <Outlet />
            </div>
          </main>
        </div>
      ) : (
        <>
          <TopNav onDockToSidebar={() => setMode('sidebar')} ingestionEnabled={ingestionEnabled} enforced={enforced} />
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
    </div>
    </TimerProvider>
  );
}
