import { Loader2 } from 'lucide-react';
import { Navigate } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import { buildNavigation } from './navigation';

// Resolves the index route ("/") to the user's preferred landing page (the
// tenant's ``default_landing`` customization setting, seeded into each user's
// preferences and overridable per-user). Falls back to /dashboard when the
// preference is unset OR points at a page the user's role can't see.
//
// Platform admins are handled upstream (LoginPage sends them straight to
// /platform), so this only runs for tenant users.

const LANDING_TO_PATH: Record<string, string> = {
  dashboard: '/dashboard',
  'my-time': '/my-time',
  'time-off': '/time-off',
  calendar: '/calendar',
  approvals: '/approvals',
};

export function LandingRedirect() {
  const { user } = useAuth();

  // CLIENT users live entirely in the portal; never resolve to a workspace page.
  if (user?.role === 'CLIENT') return <Navigate to="/portal" replace />;

  const prefs = useUserPreferences(Boolean(user));

  // Wait for the preference to load so we don't bounce to /dashboard first and
  // then jump — a single redirect reads cleaner. Show the same spinner the
  // shell uses while it resolves.
  if (prefs.isLoading) {
    return (
      <div className="grid h-full place-items-center py-20 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
      </div>
    );
  }

  const landing = typeof prefs.data?.landing === 'string' ? prefs.data.landing : undefined;
  const target = landing ? LANDING_TO_PATH[landing] : undefined;

  // Only honor the preference if the destination is actually reachable for
  // this role (its nav item is visible). Otherwise fall back to the dashboard.
  let dest = '/dashboard';
  if (target) {
    const reachable = buildNavigation(user, true)
      .flatMap((s) => s.items)
      .some((i) => i.to === target);
    if (reachable || target === '/dashboard') dest = target;
  }

  return <Navigate to={dest} replace />;
}
