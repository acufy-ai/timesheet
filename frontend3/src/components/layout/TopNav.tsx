import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Briefcase, ChevronDown, Folder, PanelLeft } from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { useProjectManagementEnabled } from '@/hooks/useProjectManagementEnabled';
import { clientPortalApi } from '@/api/client';
import { isClientUser } from '@/lib/clientRole';
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
  canSwitch = true,
}: {
  onDockToSidebar: () => void;
  ingestionEnabled: boolean;
  // When the user may not change their layout, hide the "Sidebar" switch.
  canSwitch?: boolean;
}) {
  const { user } = useAuth();
  const pmEnabled = useProjectManagementEnabled();
  const sections = buildNavigation(user, ingestionEnabled, pmEnabled);
  const isClient = isClientUser(user);

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-5 sm:px-6">
      <div className="flex-1" />
      <nav className="flex items-center gap-0.5 rounded-full border border-border bg-muted/40 p-1">
        {/* Client users get a "My Projects" dropdown listing their projects
            (the sidebar shows them inline; the top bar needs a menu). */}
        {isClient ? <ClientProjectsTopNav /> : sections.map((section) =>
          isTopbarFlat(section) ? (
            section.items.map((item) => <TopNavPill key={item.to} item={item} />)
          ) : (
            <TopNavDropdown key={section.title} section={section} />
          ),
        )}
      </nav>
      <div className="flex flex-1 items-center justify-end">
        {canSwitch && (
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

// Client "My Projects" menu for the top bar: a pill that opens a dropdown of
// the client's granted projects, each linking to its detail page. Mirrors the
// sidebar's ClientProjectsNav. Shares the portal's project query cache.
function ClientProjectsTopNav() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ['client-portal', 'projects'],
    queryFn: () => clientPortalApi.myProjects().then((r) => r.data),
  });
  const projects = q.data ?? [];
  const onPortal = pathname.startsWith('/portal');

  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, []);
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className={cn('pill', onPortal ? 'pill-active' : 'pill-idle')}>
        <Briefcase className="h-4 w-4" />
        <span>My Projects</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div className="absolute left-1/2 top-[calc(100%+8px)] z-50 w-64 -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-card p-1 shadow-xl">
          <NavLink to="/portal" className={({ isActive }) =>
            cn('flex items-center gap-2 rounded-lg px-3 py-2 text-[13px]', isActive ? 'bg-primary/10 font-semibold text-primary' : 'text-muted-foreground hover:bg-primary/[0.06] hover:text-foreground')}>
            <Briefcase className="h-4 w-4 shrink-0" /> All projects
          </NavLink>
          <div className="my-1 h-px bg-border" />
          {projects.length === 0 ? (
            <p className="px-3 py-2 text-[12.5px] text-muted-foreground">No projects shared yet.</p>
          ) : projects.map((p) => {
            const to = `/portal/projects/${p.id}`;
            return (
              <NavLink key={p.id} to={to} title={p.name}
                className={({ isActive }) =>
                  cn('flex items-center gap-2 rounded-lg px-3 py-2 text-[13px]', isActive ? 'bg-primary/10 font-semibold text-primary' : 'text-foreground hover:bg-primary/[0.06]')}>
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{p.name}</span>
              </NavLink>
            );
          })}
        </div>
      ) : null}
    </div>
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
