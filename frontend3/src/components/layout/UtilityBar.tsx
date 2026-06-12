import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { AcufyLogo } from './AcufyLogo';
import { NotificationsBell } from './NotificationsBell';
import { ThemePicker } from './ThemePicker';
import { TopbarTimer } from '@/components/timer/TopbarTimer';
import { UserMenu } from './UserMenu';

const ROLE_LABEL: Record<string, string> = {
  MANAGER: 'Manager',
  VIEWER: 'Viewer',
  ADMIN: 'Admin',
  EMPLOYEE: 'Employee',
};

// The always-present top utility bar: brand · global search · role switch ·
// theme · notifications · account. Sits above BOTH nav modes so the brand and
// global actions never move when the user switches nav layout. The logo links
// home. Mirrors the target CRM shell.
export function UtilityBar() {
  const { user, openRoleInNewTab } = useAuth();

  // Other roles this multi-role user can switch into.
  const otherRoles = (user?.roles ?? []).filter((r) => r !== user?.role);

  async function doSwitch(role: string) {
    try {
      await openRoleInNewTab(role);
    } catch {
      /* popup blocked or mint failed — silent; the button can be retried */
    }
  }

  return (
    <header className="flex h-[96px] shrink-0 items-center gap-5 border-b border-border bg-card pl-6 pr-4">
      <Link to="/dashboard" aria-label="Go to dashboard" className="shrink-0">
        <AcufyLogo height={84} />
      </Link>

      {/* Global search is DISABLED app-wide until it's wired to a real backend
          search (it was non-functional). Hidden rather than shown-but-dead to
          avoid the impression it works. Restore this block when search lands. */}
      {/* <div className="relative hidden min-w-0 max-w-3xl flex-1 md:block">
        <svg className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
        <input
          type="search"
          placeholder="Search people, clients, projects…"
          className="h-11 w-full rounded-full border border-border bg-background pl-12 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div> */}

      <div className="ml-auto flex items-center gap-2.5">
        {/* Multi-role switch (e.g. "Switch to Manager") lives up here. */}
        {otherRoles.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => void doSwitch(r)}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-3.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10"
          >
            <ExternalLink className="h-4 w-4" />
            Switch to {ROLE_LABEL[r] ?? r}
          </button>
        ))}
        <TopbarTimer />
        <ThemePicker />
        <NotificationsBell />
        <div className="ml-1 mr-0.5 h-7 w-px bg-border" />
        <UserMenu expanded />
      </div>
    </header>
  );
}
