import { useEffect, useRef, useState } from 'react';
import { Bell, Check, CheckCheck, Loader2, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import {
  useDeleteAllNotifications,
  useDeleteNotification,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from '@/hooks/useNotifications';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/cn';

const SEVERITY_DOT: Record<string, string> = {
  error: 'bg-rose-500',
  warning: 'bg-amber-500',
  success: 'bg-emerald-500',
  info: 'bg-sky-500',
};

function relTime(iso?: string | null): string {
  if (!iso) return '';
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Notification bell + dropdown panel. Live unread badge, per-item mark-read /
// delete, mark-all-read, clear-all, and click-through to the item's route.
// Gated off for PLATFORM_ADMIN (no notification surface).
export function NotificationsBell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const enabled = Boolean(user) && user?.role !== 'PLATFORM_ADMIN';
  const q = useNotifications(enabled);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const del = useDeleteNotification();
  const delAll = useDeleteAllNotifications();

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, []);

  const items = q.data?.items ?? [];
  const unread = items.filter((i) => !i.is_read).length;

  function openItem(id: string, route: string, isRead: boolean) {
    if (!isRead) markRead.mutate(id);
    setOpen(false);
    if (route) navigate(route);
  }

  if (!enabled) {
    return (
      <button type="button" aria-label="Notifications" disabled className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground/50">
        <Bell className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Notifications"
        onClick={() => setOpen((v) => !v)}
        className="relative grid h-9 w-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-11 z-50 w-[360px] overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <p className="text-sm font-semibold">Notifications</p>
            <div className="flex items-center gap-2">
              {unread > 0 ? (
                <button type="button" onClick={() => markAll.mutate()} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  <CheckCheck className="h-3.5 w-3.5" /> Mark all read
                </button>
              ) : null}
              {items.length > 0 ? (
                <button type="button" onClick={() => delAll.mutate()} className="text-xs text-muted-foreground hover:text-rose-500">Clear all</button>
              ) : null}
            </div>
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {q.isLoading ? (
              <div className="grid place-items-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" /></div>
            ) : items.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">You're all caught up.</p>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((n) => (
                  <li key={n.id} className={cn('group relative flex items-start gap-3 px-4 py-3 hover:bg-foreground/[0.03]', !n.is_read && 'bg-primary/[0.04]')}>
                    <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', SEVERITY_DOT[n.severity] ?? 'bg-sky-500', n.is_read && 'opacity-30')} />
                    <button type="button" onClick={() => openItem(n.id, n.route, n.is_read)} className="min-w-0 flex-1 text-left">
                      <p className={cn('truncate text-sm', n.is_read ? 'text-muted-foreground' : 'font-medium text-foreground')}>
                        {n.title}{n.count > 1 ? <span className="ml-1 text-xs text-muted-foreground">×{n.count}</span> : null}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{n.message}</p>
                    </button>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-[11px] text-muted-foreground">{relTime(n.created_at)}</span>
                      <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        {!n.is_read ? (
                          <button type="button" aria-label="Mark read" onClick={() => markRead.mutate(n.id)} className="grid h-6 w-6 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"><Check className="h-3.5 w-3.5" /></button>
                        ) : null}
                        <button type="button" aria-label="Delete" onClick={() => del.mutate(n.id)} className="grid h-6 w-6 place-items-center rounded-full text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
