import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AppShell } from '@/components/layout/AppShell';
import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { ApprovalsPage } from '@/pages/ApprovalsPage';
import { AuditTrailPage } from '@/pages/AuditTrailPage';
import { CalendarPage } from '@/pages/CalendarPage';
import { ClientsPage } from '@/pages/ClientsPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { InboxPage } from '@/pages/InboxPage';
import { LoginPage } from '@/pages/LoginPage';
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage';
import { SetPasswordPage } from '@/pages/SetPasswordPage';
import { VerifyAccountPage } from '@/pages/VerifyAccountPage';
import { MyTimePage } from '@/pages/MyTimePage';
import { ProfilePage } from '@/pages/ProfilePage';
import { SettingsPage } from '@/pages/SettingsPage';
import { TimeOffPage } from '@/pages/TimeOffPage';
import { UsersPage } from '@/pages/UsersPage';
import { UserTimesheetsPage } from '@/pages/UserTimesheetsPage';
import { MailboxesPage } from '@/pages/MailboxesPage';
import { ReviewPanelPage } from '@/pages/ReviewPanelPage';
import { PlatformDashboardPage } from '@/pages/platform/PlatformDashboardPage';
import { PlatformTenantsPage } from '@/pages/platform/PlatformTenantsPage';
import { PlatformTenantDetailPage } from '@/pages/platform/PlatformTenantDetailPage';
import { PlatformSettingsPage } from '@/pages/platform/PlatformSettingsPage';
import { PlatformAuditPage } from '@/pages/platform/PlatformAuditPage';
import { PlatformCalendarPage } from '@/pages/platform/PlatformCalendarPage';
import { PrimitivesPage } from '@/pages/PrimitivesPage';

// App: AppShell with dual-mode nav wraps the authenticated routes. All
// nav destinations are real, data-wired pages. /primitives stays as a
// dev-only design playground. Role gating happens in navigation.ts (which
// links render) and inside each page (which data it scopes to).

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Don't retry auth/permission failures (401/403/404) — they won't
      // succeed on retry and retrying just delays the error state. Retry
      // other failures (network blips, 5xx) up to twice.
      retry: (failureCount, error) => {
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status && [401, 403, 404].includes(status)) return false;
        return failureCount < 2;
      },
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          {/* basename = Vite's base path (import.meta.env.BASE_URL), minus the
              trailing slash, so routes resolve under a sub-path deploy
              (prod: /apps/timesheet/). Empty string at root. */}
          <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Routes>
              {/* Public */}
              <Route path="/login" element={<LoginPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/set-password" element={<SetPasswordPage />} />
              <Route path="/verify-account" element={<VerifyAccountPage />} />

              {/* Dev-only design playground */}
              <Route path="/primitives" element={<PrimitivesPage />} />

              {/* Authenticated app shell */}
              <Route element={<AppShell />}>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/my-time" element={<MyTimePage />} />
                <Route path="/time-off" element={<TimeOffPage />} />
                <Route path="/calendar" element={<CalendarPage />} />
                <Route path="/approvals" element={<ApprovalsPage />} />
                <Route path="/user-management" element={<UsersPage />} />
                <Route path="/user-management/:userId/timesheets" element={<UserTimesheetsPage />} />
                <Route path="/client-management" element={<ClientsPage />} />
                <Route path="/audit-trail" element={<AuditTrailPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/mailboxes" element={<MailboxesPage />} />
                <Route path="/ingestion/inbox" element={<InboxPage />} />
                <Route path="/ingestion/review/:timesheetId" element={<ReviewPanelPage />} />
                <Route path="/profile" element={<ProfilePage />} />
                {/* Platform-admin console */}
                <Route path="/platform" element={<PlatformDashboardPage />} />
                <Route path="/platform/tenants" element={<PlatformTenantsPage />} />
                <Route path="/platform/tenants/:slug" element={<PlatformTenantDetailPage />} />
                <Route path="/platform/settings" element={<PlatformSettingsPage />} />
                <Route path="/platform/audit" element={<PlatformAuditPage />} />
                <Route path="/platform/calendar" element={<PlatformCalendarPage />} />
              </Route>

              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
