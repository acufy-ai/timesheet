import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  PanelTop,
} from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { clientPortalApi } from '@/api/client';
import { isClientUser } from '@/lib/clientRole';
import { cn } from '@/lib/cn';
import { Tooltip } from '@/components/ui';
import {
  buildNavigation,
  isFlatSection,
  isItemActive,
  type NavItem,
  type NavSection,
} from './navigation';

// Vertical primary navigation with two click-to-pin states:
//   pinned (w-64)  — full panel: section headers, collapsible groups, labels
//   rail   (w-16)  — icon-only rail: grouped sections are FLATTENED into
//                    individual icon links with a thin divider between
//                    sections; each icon shows its label as a side tooltip.
//
// The rail does NOT expand on hover. Only the toggle button at the top
// switches between the two states, and the choice persists (useNavMode →
// localStorage). The sidebar is in-flow at its current width, so content
// simply sits beside it.
export function Sidebar({
  collapsed,
  onToggleCollapsed,
  onSwitchToTopbar,
  ingestionEnabled,
  canSwitch = true,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSwitchToTopbar: () => void;
  ingestionEnabled: boolean;
  // When the user may not change their layout, hide the switch controls.
  canSwitch?: boolean;
}) {
  const { user } = useAuth();
  const sections = buildNavigation(user, ingestionEnabled);
  const expanded = !collapsed;
  const isClient = isClientUser(user);

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200',
        expanded ? 'w-64' : 'w-16',
      )}
    >
      {/* Top controls: collapse toggle + switch-to-topbar. No brand here —
          the UtilityBar above owns the logo, so the sidebar starts with its
          view controls and goes straight into nav. */}
      {expanded ? (
        <div className="flex h-14 items-center justify-between gap-2 border-b border-border px-3">
          {canSwitch ? (
            <button
              type="button"
              onClick={onToggleCollapsed}
              title="Collapse to icons"
              aria-label="Collapse sidebar"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          ) : (
            <span className="h-8 w-8" />
          )}
          {canSwitch && (
            <button
              type="button"
              onClick={onSwitchToTopbar}
              title="Switch to top bar"
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
            >
              <PanelTop className="h-3.5 w-3.5" /> Top bar
            </button>
          )}
        </div>
      ) : (
        <div className="flex h-14 items-center justify-center border-b border-border">
          {canSwitch ? (
            <Tooltip label="Pin sidebar open" side="right">
              <button
                type="button"
                onClick={onToggleCollapsed}
                aria-label="Pin sidebar open"
                className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </button>
            </Tooltip>
          ) : (
            <span className="h-8 w-8" />
          )}
        </div>
      )}

      {/* Nav body */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {expanded
          ? sections.map((section, idx) => (
              <SidebarSection key={section.title} section={section} showDivider={idx > 0} />
            ))
          : sections.map((section, idx) => (
              <CollapsedSection key={section.title} section={section} showDivider={idx > 0} />
            ))}
        {/* Client users get their granted projects listed beneath "My Projects". */}
        {isClient && expanded ? <ClientProjectsNav /> : null}
      </nav>
      {/* No footer: the account menu lives in the top nav, and the collapsed-rail
          expand control is the toggle at the top of the sidebar. */}
    </aside>
  );
}

// Client users: the projects they've been granted, listed under "My Projects"
// and linking to each project's detail page. Shares the portal's query cache so
// it doesn't double-fetch. Renders nothing until there's at least one project.
function ClientProjectsNav() {
  const { pathname } = useLocation();
  const q = useQuery({
    queryKey: ['client-portal', 'projects'],
    queryFn: () => clientPortalApi.myProjects().then((r) => r.data),
  });
  const projects = q.data ?? [];
  if (!projects.length) return null;
  return (
    <div className="mt-1 space-y-0.5 pl-3">
      {projects.map((p) => {
        const to = `/portal/projects/${p.id}`;
        const active = pathname === to;
        // Attention badge: overdue (red) wins over plain attention (amber).
        const badge = (p.overdue_count ?? 0) > 0
          ? { n: p.overdue_count, cls: 'bg-rose-500/15 text-rose-600' }
          : (p.attention_count ?? 0) > 0
            ? { n: p.attention_count, cls: 'bg-amber-500/15 text-amber-600' }
            : null;
        return (
          <NavLink
            key={p.id}
            to={to}
            title={p.name}
            className={cn(
              'flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] transition-colors',
              active ? 'bg-primary/10 font-semibold text-primary'
                : 'text-muted-foreground hover:bg-primary/10 hover:text-primary',
            )}
          >
            {/* Client-facing health dot disabled while the client-health
                surface is off across the app (was clientHealthDot()). */}
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {p.progress?.total ? (
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/80">{p.progress.pct}%</span>
            ) : null}
            {badge ? (
              <span className={cn('shrink-0 rounded-full px-1.5 text-[10px] font-bold tabular-nums', badge.cls)}>{badge.n}</span>
            ) : null}
          </NavLink>
        );
      })}
    </div>
  );
}

// Health dot color for a client-facing health value. Null (not set) = muted.
export function clientHealthDot(h?: string | null): string {
  if (h === 'on_track') return 'bg-emerald-500';
  if (h === 'at_risk') return 'bg-amber-500';
  if (h === 'off_track') return 'bg-rose-500';
  return 'bg-muted-foreground/30';
}

// Expanded panel: a section is either a flat top-level link (single item) or a
// collapsible group (multiple items), with a divider above every section but
// the first.
function SidebarSection({
  section,
  showDivider,
}: {
  section: NavSection;
  showDivider: boolean;
}) {
  const { pathname } = useLocation();
  const flat = isFlatSection(section);
  const groupActive = section.items.some((i) => isItemActive(i, pathname));
  // Grouped (multi-item) sections start open by default.
  const [groupOpen, setGroupOpen] = useState(true);

  return (
    <div>
      {showDivider ? <div className="mx-2 my-2 h-px bg-border/70" /> : null}

      {/* Group header (only for multi-item sections) */}
      {!flat ? (
        <button
          type="button"
          onClick={() => setGroupOpen((v) => !v)}
          className={cn(
            'flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm transition-colors',
            groupActive
              ? 'text-foreground'
              : 'text-muted-foreground hover:bg-primary/10 hover:text-primary',
          )}
        >
          <span className="flex-1 text-left font-medium">{section.title}</span>
          <ChevronRight
            className={cn('h-4 w-4 transition-transform', groupOpen && 'rotate-90')}
          />
        </button>
      ) : null}

      <ul
        className={cn(
          'space-y-1',
          // Indent nested items of an open group; flat sections sit at root.
          !flat ? 'ml-2 mt-1 border-l border-border/70 pl-2' : '',
          !flat && !groupOpen ? 'hidden' : '',
        )}
      >
        {section.items.map((item) => (
          <li key={item.to}>
            <SidebarLink item={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// Collapsed rail: a section's items are flattened into individual icon links
// (no group header), with a thin divider above every section but the first.
function CollapsedSection({
  section,
  showDivider,
}: {
  section: NavSection;
  showDivider: boolean;
}) {
  return (
    <div>
      {showDivider ? <div className="mx-auto my-1.5 h-px w-6 rounded bg-border/70" /> : null}
      <ul className="space-y-1">
        {section.items.map((item) => (
          <li key={item.to}>
            <CollapsedLink item={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// Expanded link: full pill with icon + label.
function SidebarLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  const { pathname } = useLocation();
  const active = isItemActive(item, pathname);

  return (
    <NavLink
      to={item.to}
      className={cn('pill w-full justify-start', active ? 'pill-active' : 'pill-idle')}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </NavLink>
  );
}

// Collapsed link: a centered round icon button that navigates directly, with
// the label shown as a side tooltip on hover/focus.
function CollapsedLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  const { pathname } = useLocation();
  const active = isItemActive(item, pathname);

  return (
    <Tooltip label={item.label} side="right">
      <NavLink
        to={item.to}
        aria-label={item.label}
        className={cn(
          'mx-auto grid h-10 w-10 place-items-center rounded-full transition-colors',
          active
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-primary/10 hover:text-primary',
        )}
      >
        <Icon className="h-4 w-4" />
      </NavLink>
    </Tooltip>
  );
}
