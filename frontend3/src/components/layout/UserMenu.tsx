import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut, User as UserIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/cn';
import { roleLabel } from '@/lib/roleLabels';

// Avatar button → dropdown with the user's name/role and a logout action.
// Shared by both nav modes. When `expanded` is true (the UtilityBar) the
// trigger shows the name + role + caret beside the avatar; the sidebar footer
// uses the compact avatar-only trigger. The sidebar footer passes side="top"
// so the menu opens upward instead of clipping off the bottom of the viewport.
export function UserMenu({
  align = 'right',
  side = 'bottom',
  expanded = false,
}: {
  align?: 'left' | 'right';
  side?: 'top' | 'bottom';
  expanded?: boolean;
}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  if (!user) return null;

  const initials = (user.full_name || user.email)
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const onLogout = async () => {
    setOpen(false);
    await logout();
    navigate('/login', { replace: true });
  };

  const roleText = roleLabel(user.role);

  return (
    <div ref={ref} className="relative">
      {expanded ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex items-center gap-2 rounded-full border border-border bg-card py-1 pl-1 pr-2.5 transition-colors hover:border-primary/40"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {initials}
          </span>
          <span className="hidden text-left leading-tight sm:block">
            <span className="block text-sm font-semibold text-foreground">{user.full_name}</span>
            <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{roleText}</span>
          </span>
          <ChevronDown className={cn('hidden h-4 w-4 text-muted-foreground transition-transform sm:block', open && 'rotate-180')} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Account menu"
          className="grid h-9 w-9 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground transition-transform hover:scale-105"
        >
          {initials}
        </button>
      )}

      {open ? (
        <div
          role="menu"
          className={cn(
            'absolute z-50 w-60 rounded-2xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl',
            align === 'right' ? 'right-0' : 'left-0',
            side === 'top' ? 'bottom-11' : 'top-11',
          )}
        >
          <div className="flex items-center gap-3 px-2.5 py-2">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              {initials}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{user.full_name}</p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
            </div>
          </div>
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              navigate('/profile');
            }}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
          >
            <UserIcon className="h-4 w-4" />
            <span>Profile</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void onLogout()}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-rose-500 transition-colors hover:bg-rose-500/10"
          >
            <LogOut className="h-4 w-4" />
            <span>Log out</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
