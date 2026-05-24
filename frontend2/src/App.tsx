import React from 'react';
import { BrowserRouter as Router, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';

import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { TimerProvider } from '@/contexts/TimerContext';
import { AppLayout } from '@/components';
import { BootLoader } from '@/components/layout/BootLoader';
import { useAuth, useCanReview, useIngestionEnabled } from '@/hooks';
import {
  AdminPage,
  AdminSettingsPage,
  ApprovalsPage,
  AuditTrailPage,
  CalendarPage,
  ClientManagementPage,
  DashboardPage,
  InboxPage,
  LoginPage,
  MyTimePage,
  UserTimesheetsPage,
  PlatformAdminPage,
  PlatformAuditPage,
  PlatformCalendarPage,
  PlatformDashboardPage,
  PlatformSettingsPage,
  PlatformTenantDetailPage,
  ProfilePage,
  ReviewPanelPage,
  TimeOffPage,
  VerifyAccountPage,
  SetPasswordPage,
  ForgotPasswordPage,
} from '@/pages';

import { queryClient } from '@/lib/queryClient';

// Both PA and tenant users land on /dashboard after login. The route
// switcher in App.tsx renders PlatformDashboardPage for PA and
// DashboardPage for everyone else, so this is one route for both.
const getPostLoginRoute = (_role?: string) => '/dashboard';

const HomeRedirect: React.FC = () => {
  const { user } = useAuth();
  return <Navigate to={getPostLoginRoute(user?.role)} replace />;
};

const ProtectedRoute: React.FC = () => {
  const { user, isLoading, accessToken } = useAuth();

  console.log('[ProtectedRoute]', { hasUser: !!user, isLoading, hasToken: !!accessToken, role: user?.role });

  if (isLoading) {
    return <BootLoader message="Restoring your workspace" />;
  }

  if (!user) {
    console.warn('[ProtectedRoute] No user, redirecting to login. Token in localStorage:', !!localStorage.getItem('accessToken'));
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
};

const AnonymousOnlyRoute: React.FC = () => {
  const { user } = useAuth();

  if (user) {
    return <Navigate to={getPostLoginRoute(user.role)} replace />;
  }

  return <LoginPage />;
};

const PlatformAdminGuard: React.FC = () => {
  const { user } = useAuth();
  return user?.role === 'PLATFORM_ADMIN' ? <Outlet /> : <Navigate to="/dashboard" replace />;
};

const ManagerGuard: React.FC = () => {
  const { user } = useAuth();
  // Admin is excluded: per-role separation means an admin who is also
  // a manager logs in with their manager account for approvals.
  return user && user.role === 'MANAGER'
    ? <Outlet />
    : <Navigate to="/dashboard" replace />;
};

const IngestionEnabledGuard: React.FC = () => {
  return useIngestionEnabled() ? <Outlet /> : <Navigate to="/dashboard" replace />;
};

const ReviewGuard: React.FC = () => {
  return useCanReview() ? <Outlet /> : <Navigate to="/dashboard" replace />;
};

const TenantAdminGuard: React.FC = () => {
  const { user } = useAuth();
  return user?.role === 'ADMIN' ? <Outlet /> : <Navigate to="/dashboard" replace />;
};

const AdminOrManagerGuard: React.FC = () => {
  const { user } = useAuth();
  return user && ['ADMIN', 'MANAGER', 'VIEWER'].includes(user.role)
    ? <Outlet />
    : <Navigate to="/dashboard" replace />;
};

// ── Redirect helper that merges extra search params ───────────────
// react-router's <Navigate> doesn't natively combine the incoming URL's
// search string with extras you want to add. We use this for the
// /platform/audit -> /platform/settings?tab=logs back-compat redirect
// while preserving any ?tenant_id= or ?event_id= the caller carried.
const RedirectPreservingSearch: React.FC<{ to: string; extraParams?: Record<string, string> }> = ({ to, extraParams }) => {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(extraParams ?? {})) {
    params.set(k, v);
  }
  const search = params.toString();
  return <Navigate to={search ? `${to}?${search}` : to} replace />;
};

// ── Role-aware route switchers ────────────────────────────────────
// /dashboard and /calendar are shared paths every authenticated user
// can hit. The tenant-scoped pages 400 for platform admins because
// PA tokens carry tenant_id=null and the backend's get_tenant_db dep
// rejects them. These switchers render the PA-specific page when the
// caller is a PLATFORM_ADMIN, the tenant page otherwise.
const DashboardRouteSwitch: React.FC = () => {
  const { user } = useAuth();
  if (user?.role === 'PLATFORM_ADMIN') return <PlatformDashboardPage />;
  return <DashboardPage />;
};

const CalendarRouteSwitch: React.FC = () => {
  const { user } = useAuth();
  if (user?.role === 'PLATFORM_ADMIN') return <PlatformCalendarPage />;
  return <CalendarPage />;
};

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<AnonymousOnlyRoute />} />
      <Route path="/verify-account" element={<VerifyAccountPage />} />
      <Route path="/set-password" element={<SetPasswordPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<HomeRedirect />} />
          <Route path="/dashboard" element={<DashboardRouteSwitch />} />
          <Route path="/my-time" element={<MyTimePage />} />
          <Route path="/time-off" element={<TimeOffPage />} />
          <Route path="/calendar" element={<CalendarRouteSwitch />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route element={<AdminOrManagerGuard />}>
            <Route path="/user-management" element={<AdminPage />} />
            <Route path="/user-management/:userId/timesheets" element={<UserTimesheetsPage />} />
          </Route>
          <Route element={<TenantAdminGuard />}>
            <Route path="/client-management" element={<ClientManagementPage />} />
            <Route path="/audit-trail" element={<AuditTrailPage />} />
            <Route path="/settings" element={<AdminSettingsPage />} />
          </Route>

          <Route element={<ManagerGuard />}>
            <Route path="/approvals" element={<ApprovalsPage />} />
          </Route>

          <Route element={<PlatformAdminGuard />}>
            <Route path="/platform/tenants" element={<PlatformAdminPage />} />
            <Route path="/platform/tenants/:slug" element={<PlatformTenantDetailPage />} />
            <Route path="/platform/settings" element={<PlatformSettingsPage />} />
            {/* /platform/audit is now a sub-tab inside Settings. Keep the
                route as a redirect so deep links from the tenant detail
                page (?tab=audit click-through) and any external bookmarks
                land in the right place. URL search params survive the
                Navigate so ?tenant_id=&event_id= flow through. */}
            <Route
              path="/platform/audit"
              element={<RedirectPreservingSearch to="/platform/settings" extraParams={{ tab: 'logs' }} />}
            />
            <Route path="/platform-admin" element={<Navigate to="/platform/tenants" replace />} />
            <Route path="/platform-settings" element={<Navigate to="/platform/settings" replace />} />
          </Route>

          {/* Legacy /mailboxes route. The page itself moved under
              Settings → Integrations → Mailboxes; this redirect keeps
              old bookmarks, the Inbox "Mailboxes" CTA, and any
              external links pointing here landing in the right place.
              Both guards (ingestion + admin) still apply via the
              Settings route's own gating downstream. */}
          <Route path="/mailboxes" element={<Navigate to="/settings?section=mailboxes" replace />} />

          <Route element={<IngestionEnabledGuard />}>
            <Route element={<ReviewGuard />}>
              <Route path="/ingestion/inbox" element={<InboxPage />} />
              <Route path="/ingestion/email/:emailId" element={<ReviewPanelPage />} />
              <Route path="/ingestion/review/:timesheetId" element={<ReviewPanelPage />} />
            </Route>
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<HomeRedirect />} />
    </Routes>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <Router basename={import.meta.env.BASE_URL}>
          <AuthProvider>
            <TimerProvider>
              <AppRoutes />
            </TimerProvider>
          </AuthProvider>
        </Router>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
