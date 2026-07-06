import {
  Briefcase,
  Building2,
  CalendarDays,
  ClipboardCheck,
  ClipboardList,
  Clock3,
  Home,
  Inbox,
  ListChecks,
  Settings,
  ShieldCheck,
  TrendingUp,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

import type { User } from '@/types/user';

// Ported from frontend2/src/components/layout/navigation.ts. Same role model
// and section shape; trimmed to frontend3's User type. This is the single
// source of truth for nav structure shared by both Sidebar (vertical) and
// TopNav (horizontal) modes.

export type NavItem = {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Extra path prefixes that should mark this item active. */
  match?: string[];
  /**
   * When true, this item is active only on an EXACT path match — not when the
   * pathname merely starts with `to`. Needed for index-style links whose path is
   * a prefix of sibling routes (e.g. /platform vs /platform/tenants), so the
   * index link doesn't stay highlighted on every child page.
   */
  exact?: boolean;
  visible: boolean;
};

export type NavSection = {
  title: string;
  items: NavItem[];
};

// Admin is intentionally excluded from manager/reviewer surfaces. A human
// who is both an admin and a manager logs in with the manager account for
// approval and review work; the admin portal handles admin duties only.
const isManager = (user: User | null) => Boolean(user && user.role === 'MANAGER');
const isAdmin = (user: User | null) => user?.role === 'ADMIN';
const isPlatformAdmin = (user: User | null) => user?.role === 'PLATFORM_ADMIN';
const canReview = (user: User | null) =>
  Boolean(user && user.role !== 'ADMIN' && user.can_review);

export const buildNavigation = (
  user: User | null,
  ingestionEnabled: boolean,
  pmEnabled: boolean = true,
): NavSection[] => {
  // Client personas are fail-closed: they see ONLY the client portal, never the
  // workspace/ops/platform sections. Returning early guarantees an unmapped or
  // client role can't fall through to the default Dashboard/My Time/etc. nav.
  // Covers the legacy CLIENT plus the two-tier CLIENT_MANAGER / CLIENT_EMPLOYEE.
  if (user?.role === 'CLIENT' || user?.role === 'CLIENT_MANAGER' || user?.role === 'CLIENT_EMPLOYEE') {
    const label = user.role === 'CLIENT_MANAGER' ? 'Client portal' : 'My Projects';
    return [{
      title: 'Client',
      items: [{ label, to: '/portal', icon: Briefcase, visible: true, match: ['/portal'] }],
    }];
  }
  // Pure managers (no admin role) get a flatter nav: each Operations entry
  // renders as its own top-level link instead of nesting under an
  // "Operations" group. Their action surface is small. Admins keep the
  // grouped Operations menu because they have 4+ items.
  const flattenOps = !isAdmin(user) && isManager(user);

  // For a user who holds BOTH admin and manager, surface which role is acting
  // when they open shared pages (e.g. Client Management) via a ?role= query
  // param. The active role is user.role (already overlaid from the token's
  // active_role). Single-role users get a clean URL (no param).
  const hasBothRoles = Boolean(
    user?.roles?.includes('ADMIN') && user?.roles?.includes('MANAGER'),
  );
  const roleSuffix = hasBothRoles && (user?.role === 'ADMIN' || user?.role === 'MANAGER')
    ? `?role=${user.role.toLowerCase()}`
    : '';

  const opsItems: NavItem[] = [
    { label: 'Approvals', to: '/approvals', icon: ShieldCheck, visible: isManager(user) },
    // Admins (workspace-wide view) see "Users". Pure managers
    // (direct-reports only) see "My Team".
    {
      label: isAdmin(user) ? 'Users' : 'My Team',
      to: '/user-management',
      icon: UsersRound,
      visible: isAdmin(user) || isManager(user),
    },
    // Clients + Insights are project-management module surfaces — hidden when
    // the workspace has PM disabled.
    { label: 'Clients', to: `/client-management${roleSuffix}`, icon: Briefcase, visible: pmEnabled && (isAdmin(user) || isManager(user)), match: ['/client-management'] },
    // PSA Insights (financials, resourcing, portfolio, forecasts). Managers +
    // viewers only — admin manages the workspace, not the money/analytics.
    { label: 'Insights', to: '/insights', icon: TrendingUp, visible: pmEnabled && Boolean(user && (user.role === 'MANAGER' || user.role === 'VIEWER')), match: ['/insights'] },
    { label: 'Audit Trail', to: '/audit-trail', icon: ClipboardList, visible: isAdmin(user) },
    { label: 'Settings', to: '/settings', icon: Settings, visible: isAdmin(user) },
  ];

  const opsSections: NavSection[] = flattenOps
    ? opsItems.map((item) => ({ title: item.label, items: [item] }))
    : [{ title: 'Operations', items: opsItems }];

  const sections: NavSection[] = [
    {
      title: 'Workspace',
      items: [
        // Workspace is the TENANT-user surface. Platform admins have no tenant
        // and get their own Platform section below — so none of these should
        // show for a PA (otherwise the Workspace Dashboard/Calendar duplicate
        // the Platform Dashboard/Calendar).
        { label: 'Dashboard', to: '/dashboard', icon: Home, visible: Boolean(user && user.role !== 'PLATFORM_ADMIN') },
        {
          label: 'My Time',
          to: '/my-time',
          icon: Clock3,
          visible: Boolean(user && user.role !== 'PLATFORM_ADMIN'),
        },
        {
          label: 'My Work',
          to: '/my-work',
          icon: ListChecks,
          // People who get assigned to projects/tasks (employees, managers,
          // viewers). Admins manage rather than get assigned. Part of the PM
          // module — hidden when the workspace has PM disabled.
          visible: pmEnabled && Boolean(user && ['EMPLOYEE', 'MANAGER', 'VIEWER'].includes(user.role)),
          match: ['/my-work'],
        },
        {
          label: 'Time Off',
          to: '/time-off',
          icon: ClipboardCheck,
          visible: Boolean(user && user.role !== 'PLATFORM_ADMIN'),
        },
        { label: 'Calendar', to: '/calendar', icon: CalendarDays, visible: Boolean(user && user.role !== 'PLATFORM_ADMIN') },
      ],
    },
    ...opsSections,
    {
      // Flat "Inbox" link (matches frontend2). Mailboxes is NOT a top-level
      // nav entry; it lives under Settings -> Integrations -> Mailboxes,
      // because mailbox configuration is a one-time admin task, not a
      // daily-use destination.
      title: 'Emails',
      items: [
        {
          label: 'Inbox',
          to: '/ingestion/inbox',
          icon: Inbox,
          visible: ingestionEnabled && canReview(user),
          match: ['/ingestion/inbox', '/ingestion/review'],
        },
      ],
    },
    // Platform-admin entries: each in its own single-item section so they
    // render as flat top-level nav links (not a dropdown).
    {
      title: 'Platform Dashboard',
      items: [{ label: 'Dashboard', to: '/platform', icon: Home, visible: isPlatformAdmin(user), match: ['/platform'], exact: true }],
    },
    {
      title: 'Platform Tenants',
      items: [{ label: 'Tenants', to: '/platform/tenants', icon: Building2, visible: isPlatformAdmin(user), match: ['/platform/tenants'] }],
    },
    {
      title: 'Platform Calendar',
      items: [{ label: 'Calendar', to: '/platform/calendar', icon: CalendarDays, visible: isPlatformAdmin(user) }],
    },
    {
      title: 'Platform Audit',
      items: [{ label: 'Audit', to: '/platform/audit', icon: ClipboardList, visible: isPlatformAdmin(user) }],
    },
    {
      title: 'Platform Settings',
      items: [{ label: 'Settings', to: '/platform/settings', icon: Settings, visible: isPlatformAdmin(user) }],
    },
  ];

  return sections
    .map((section) => ({ ...section, items: section.items.filter((item) => item.visible) }))
    .filter((section) => section.items.length > 0);
};

// Whether a nav item should render as active for the current pathname.
export function isItemActive(item: NavItem, pathname: string): boolean {
  const candidates = item.match ?? [item.to];
  // Exact items match only the precise path (so an index link like /platform
  // doesn't stay active on /platform/tenants, /platform/audit, etc.).
  if (item.exact) return candidates.some((p) => pathname === p);
  return candidates.some(
    (p) => pathname === p || pathname.startsWith(p + '/'),
  );
}

// A section renders as a flat top-level link (no group header) when it holds
// exactly one item. Used by the sidebar to collapse single-item sections
// (multi-item sections become a collapsible group).
export function isFlatSection(section: NavSection): boolean {
  return section.items.length === 1;
}

// Topbar flattening rule (ported from frontend2 TopNavBar): Workspace is
// always rendered inline because it's the user's primary navigation — a
// dropdown for its 2-4 items adds a click for no gain. Single-item sections
// also flatten (so Emails -> a flat "Inbox" pill, and each Platform entry is
// its own top-level pill). Multi-item admin "Operations" stays a dropdown.
export function isTopbarFlat(section: NavSection): boolean {
  return section.items.length === 1 || section.title === 'Workspace';
}
