import {
  Briefcase,
  Building2,
  ClipboardList,
  CalendarDays,
  ClipboardCheck,
  Clock3,
  Home,
  Inbox,
  Settings,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';

import type { LucideIcon } from 'lucide-react';
import type { User } from '@/types';

export type NavItem = {
  label: string;
  to: string;
  icon: LucideIcon;
  match?: string[];
  visible: boolean;
};

export type NavSection = {
  title: string;
  items: NavItem[];
};

// Admin is intentionally excluded from manager/reviewer surfaces. A
// human who is both an admin and a manager logs in with the manager
// account for approval and review work; the admin portal handles
// admin duties only (user / client / project / settings management).
const isManager = (user: User | null) => Boolean(user && user.role === 'MANAGER');
const isAdmin = (user: User | null) => user?.role === 'ADMIN';
const isPlatformAdmin = (user: User | null) => user?.role === 'PLATFORM_ADMIN';
const canReview = (user: User | null) => Boolean(user && user.role !== 'ADMIN' && user.can_review);

export const buildNavigation = (user: User | null, ingestionEnabled: boolean): NavSection[] => {
  // Pure managers (no admin role) get a flatter top-bar: each Operations
  // entry renders as its own top-level link instead of nesting under an
  // "Operations" dropdown. Their action surface is small (Approvals, My
  // Team, optionally Inbox) so a dropdown is pure overhead. Admins still
  // get the grouped Operations menu because they have 4+ items.
  const flattenOps = !isAdmin(user) && isManager(user);

  const opsItems: NavItem[] = [
    { label: 'Approvals', to: '/approvals', icon: ShieldCheck, visible: isManager(user) },
    // Label varies by role so the manager portal stops looking
    // like the admin portal. Admins (workspace-wide view) see
    // "Users". Pure managers (direct-reports only) see "My Team".
    // A user with both roles sees "Users" because the workspace
    // scope dominates the page they actually land on.
    { label: isAdmin(user) ? 'Users' : 'My Team', to: '/user-management', icon: UsersRound, visible: isAdmin(user) || isManager(user) },
    { label: 'Clients', to: '/client-management', icon: Briefcase, visible: isAdmin(user) },
    { label: 'Audit Trail', to: '/audit-trail', icon: ClipboardList, visible: isAdmin(user) },
    { label: 'Settings', to: '/settings', icon: Settings, visible: isAdmin(user) },
  ];

  const opsSections: NavSection[] = flattenOps
    // One section per item so the topbar's "single-item sections flatten"
    // rule lifts each link to a top-level entry.
    ? opsItems.map((item) => ({ title: item.label, items: [item] }))
    : [{ title: 'Operations', items: opsItems }];

  const sections: NavSection[] = [
    {
      title: 'Workspace',
      items: [
        { label: 'Dashboard', to: '/dashboard', icon: Home, visible: Boolean(user) },
        { label: 'My Time', to: '/my-time', icon: Clock3, visible: Boolean(user && user.role !== 'PLATFORM_ADMIN') },
        { label: 'Time Off', to: '/time-off', icon: ClipboardCheck, visible: Boolean(user && user.role !== 'PLATFORM_ADMIN') },
        { label: 'Calendar', to: '/calendar', icon: CalendarDays, visible: Boolean(user) },
      ],
    },
    ...opsSections,
    {
      title: 'Emails',
      items: [
        // Mailboxes lives under Settings → Integrations → Mailboxes. The
        // top-nav entry was removed because mailbox configuration is a
        // one-time admin task, not a daily-use destination.
        { label: 'Inbox', to: '/ingestion/inbox', icon: Inbox, visible: ingestionEnabled && canReview(user), match: ['/ingestion/inbox', '/ingestion/review'] },
      ],
    },
    // Platform-admin entries. Each in its own section so they render
    // as top-level nav links (single-item sections collapse to a flat
    // link in the topbar). Audit is intentionally NOT a top-level
    // entry anymore - it lives as a sub-tab inside Settings now.
    // ``match`` covers the legacy /platform/audit URL so the Settings
    // entry highlights when an operator deep-links to a single event.
    {
      title: 'Platform - Tenants',
      items: [
        {
          label: 'Tenants',
          to: '/platform/tenants',
          icon: Building2,
          visible: isPlatformAdmin(user),
          match: ['/platform/tenants'],
        },
      ],
    },
    {
      title: 'Platform - Settings',
      items: [
        {
          label: 'Settings',
          to: '/platform/settings',
          icon: Settings,
          visible: isPlatformAdmin(user),
          // Highlight Settings when the operator is on the Logs sub-tab,
          // including the legacy /platform/audit URL which redirects to
          // /platform/settings?tab=logs.
          match: ['/platform/settings', '/platform/audit'],
        },
      ],
    },
  ];

  return sections
    .map((section) => ({ ...section, items: section.items.filter((item) => item.visible) }))
    .filter((section) => section.items.length > 0);
};
