import { useState } from 'react';
import {
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  PanelTop,
} from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/cn';
import {
  buildNavigation,
  isFlatSection,
  isItemActive,
  type NavItem,
  type NavSection,
} from './navigation';
import { UserMenu } from './UserMenu';

// Vertical primary navigation with three states:
//   pinned (w-64)  — full panel, section headers, collapsible groups
//   rail   (w-16)  — icon-only; section dividers preserved
//   rail + hover   — full panel floats over content (absolute, shadow lift)
//
// The in-flow width is always the rail width when collapsed so the page
// content never shifts when the flyout opens.
export function Sidebar({
  collapsed,
  onToggleCollapsed,
  onSwitchToTopbar,
  ingestionEnabled,
  enforced = false,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSwitchToTopbar: () => void;
  ingestionEnabled: boolean;
  // When the admin has locked the nav layout, hide the "Top bar" switch.
  enforced?: boolean;
}) {
  const { user } = useAuth();
  const sections = buildNavigation(user, ingestionEnabled);
  const [hovering, setHovering] = useState(false);

  // The rail collapses content but a hover temporarily expands to the full
  // panel. When pinned, it's always expanded.
  const expanded = !collapsed || hovering;

  return (
    <>
      {/* In-flow spacer: reserves the rail/panel width so content sits beside it. */}
      <div className={cn('shrink-0 transition-[width] duration-200', collapsed ? 'w-16' : 'w-64')} />

      <aside
        onMouseEnter={() => collapsed && setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        className={cn(
          'absolute inset-y-0 left-0 z-30 flex flex-col border-r border-border bg-card transition-[width] duration-200',
          expanded ? 'w-64' : 'w-16',
          // Lift the panel above content only when it's floating (rail+hover).
          collapsed && hovering ? 'shadow-2xl' : '',
        )}
      >
        {/* Top controls: collapse toggle + switch-to-topbar. No brand here —
            the UtilityBar above owns the logo, so the sidebar starts with its
            view controls and goes straight into nav. */}
        {expanded ? (
          <div className="flex h-14 items-center justify-between gap-2 border-b border-border px-3">
            <button
              type="button"
              onClick={onToggleCollapsed}
              title="Collapse to icons"
              aria-label="Collapse sidebar"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
            {!enforced && (
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
            <button
              type="button"
              onClick={onToggleCollapsed}
              title="Pin sidebar open"
              aria-label="Pin sidebar open"
              className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Nav body */}
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {sections.map((section, idx) => (
            <SidebarSection
              key={section.title}
              section={section}
              expanded={expanded}
              showDivider={idx > 0}
            />
          ))}
        </nav>

        {/* Footer: account */}
        <div className={cn('border-t border-border p-2.5', expanded ? '' : 'flex justify-center')}>
          {expanded ? (
            <UserMenu align="left" side="top" />
          ) : (
            <button
              type="button"
              onClick={onToggleCollapsed}
              title="Pin sidebar open"
              aria-label="Pin sidebar open"
              className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}
        </div>
      </aside>
    </>
  );
}

function SidebarSection({
  section,
  expanded,
  showDivider,
}: {
  section: NavSection;
  expanded: boolean;
  showDivider: boolean;
}) {
  const { pathname } = useLocation();
  const flat = isFlatSection(section);
  const groupActive = section.items.some((i) => isItemActive(i, pathname));
  // Grouped (multi-item) sections start open if a child is active.
  const [groupOpen, setGroupOpen] = useState(groupActive);

  return (
    <div>
      {showDivider ? <div className="mx-2 my-2 h-px bg-border/70" /> : null}

      {/* Group header (only for multi-item sections in expanded mode) */}
      {!flat && expanded ? (
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
          !flat && expanded ? 'ml-2 mt-1 border-l border-border/70 pl-2' : '',
          !flat && expanded && !groupOpen ? 'hidden' : '',
        )}
      >
        {section.items.map((item) => (
          <li key={item.to}>
            <SidebarLink item={item} expanded={expanded} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SidebarLink({ item, expanded }: { item: NavItem; expanded: boolean }) {
  const Icon = item.icon;
  const { pathname } = useLocation();
  const active = isItemActive(item, pathname);

  if (!expanded) {
    // Icon-rail rendering: centered round button, label via tooltip.
    return (
      <NavLink
        to={item.to}
        title={item.label}
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
    );
  }

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
