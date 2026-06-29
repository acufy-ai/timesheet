import { Building2, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { useMyTenant } from '@/hooks/useMyTenant';
import { isClientUser } from '@/lib/clientRole';
import { AcufyLogo } from './AcufyLogo';
import { NotificationsBell } from './NotificationsBell';
import { ThemePicker } from './ThemePicker';
import { TopbarTimer } from '@/components/timer/TopbarTimer';
import { UserMenu } from './UserMenu';
import { roleLabel } from '@/lib/roleLabels';

// The always-present top utility bar: brand · global search · role switch ·
// theme · notifications · account. Sits above BOTH nav modes so the brand and
// global actions never move when the user switches nav layout. The logo links
// home. Mirrors the target CRM shell.
export function UtilityBar() {
  const { user, openRoleInNewTab } = useAuth();
  // Clients have no timer or notifications surface (and those calls 403 for
  // them), and the portal isn't part of the timer context. Covers all three
  // client roles (CLIENT / CLIENT_MANAGER / CLIENT_EMPLOYEE).
  const isClient = isClientUser(user);
  const tenantQ = useMyTenant();
  const workspaceName = tenantQ.data?.name;

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
    <header className="flex h-[96px] shrink-0 items-center gap-3 border-b border-border bg-card pl-3 pr-2 sm:gap-5 sm:pl-6 sm:pr-4">
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

      <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2.5">
        {/* Multi-role switch (e.g. "Switch to Manager") lives up here. On
            narrow screens it collapses to an icon-only button (label kept on
            aria-label) so the header never overflows past the account menu. */}
        {otherRoles.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => void doSwitch(r)}
            aria-label={`Switch to ${roleLabel(r)}`}
            title={`Switch to ${roleLabel(r)}`}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10 sm:px-3.5"
          >
            <ExternalLink className="h-4 w-4 shrink-0" />
            <span className="hidden lg:inline">Switch to {roleLabel(r)}</span>
          </button>
        ))}
        {/* Workspace (tenant) name. Sits with the global actions so it's always
            visible next to the timer / theme controls. */}
        {workspaceName ? (
          <span
            className="mr-1 hidden items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground sm:inline-flex"
            title={`Workspace: ${workspaceName}`}
          >
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <span className="max-w-[160px] truncate">{workspaceName}</span>
          </span>
        ) : null}
        {!isClient ? <TopbarTimer /> : null}
        <ThemePicker />
        {!isClient ? <NotificationsBell /> : null}
        <div className="mx-0.5 hidden h-7 w-px bg-border sm:block sm:ml-1" />
        <UserMenu expanded />
      </div>
    </header>
  );
}
