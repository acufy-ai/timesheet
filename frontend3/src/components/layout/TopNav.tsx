import { useEffect, useRef, useState } from 'react';
import { ChevronDown, PanelLeft } from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/cn';
import {
  buildNavigation,
  isItemActive,
  isTopbarFlat,
  type NavItem,
  type NavSection,
} from './navigation';

// Horizontal primary navigation ROW. Lives directly under the always-present
// UtilityBar (which owns brand + search + actions). Centered pill group;
// flattened single-item sections render as pills, multi-item sections as
// dropdowns. A "Sidebar" toggle on the right flips to vertical nav.
export function TopNav({
  onDockToSidebar,
  ingestionEnabled,
  enforced = false,
}: {
  onDockToSidebar: () => void;
  ingestionEnabled: boolean;
  // When the admin has locked the nav layout, hide the "Sidebar" switch.
  enforced?: boolean;
}) {
  const { user } = useAuth();
  const sections = buildNavigation(user, ingestionEnabled);

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-5 sm:px-6">
      <div className="flex-1" />
      <nav className="flex items-center gap-0.5 rounded-full border border-border bg-muted/40 p-1">
        {sections.map((section) =>
          isTopbarFlat(section) ? (
            section.items.map((item) => <TopNavPill key={item.to} item={item} />)
          ) : (
            <TopNavDropdown key={section.title} section={section} />
          ),
        )}
      </nav>
      <div className="flex flex-1 items-center justify-end">
        {!enforced && (
          <>
            <div className="mr-2 h-6 w-px bg-border" />
            <button
              type="button"
              onClick={onDockToSidebar}
              title="Switch to sidebar"
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
            >
              <PanelLeft className="h-3.5 w-3.5" />
              Sidebar
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function TopNavPill({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        cn('pill', isActive ? 'pill-active' : 'pill-idle')
      }
    >
      <Icon className="h-4 w-4" />
      <span>{item.label}</span>
    </NavLink>
  );
}

function TopNavDropdown({ section }: { section: NavSection }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const anyActive = section.items.some((i) => isItemActive(i, pathname));

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // Close the menu whenever the route changes (a link was followed).
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn('pill', anyActive ? 'pill-active' : 'pill-idle')}
      >
        <span>{section.title}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute left-1/2 top-12 z-50 w-56 -translate-x-1/2 rounded-2xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
        >
          {section.items.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                role="menuitem"
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors',
                    isActive
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
                  )
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
