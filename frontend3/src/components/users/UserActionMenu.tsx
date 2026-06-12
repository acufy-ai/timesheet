import { useEffect, useRef, useState } from 'react';
import {
  MoreVertical,
  Pencil,
  KeyRound,
  LockOpen,
  Send,
  UserX,
  UserCheck,
  Trash2,
  CalendarClock,
} from 'lucide-react';

import type { ManagedUser } from '@/types/admin';

// Per-row kebab menu mirroring frontend2's UserActionMenu: Edit, Reset
// password, Send invite, Activate/Deactivate, Delete. Closes on outside click
// or Escape.
export function UserActionMenu({
  user,
  onEdit,
  onResetPassword,
  onSendInvite,
  onToggleActive,
  onDelete,
  onViewTimesheets,
  onUnlock,
}: {
  user: ManagedUser;
  onEdit: () => void;
  onResetPassword: () => void;
  onSendInvite: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  onViewTimesheets?: () => void;
  onUnlock?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (fn: () => void) => () => { setOpen(false); fn(); };

  const item = 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted';

  return (
    <div className="relative inline-block text-left" ref={ref}>
      <button
        type="button"
        aria-label="User actions"
        onClick={() => setOpen((v) => !v)}
        className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open ? (
        <div className="absolute right-0 z-30 mt-1 w-52 rounded-xl border border-border bg-card p-1 shadow-xl">
          <button type="button" className={item} onClick={run(onEdit)}>
            <Pencil className="h-4 w-4 text-muted-foreground" /> Edit
          </button>
          {onViewTimesheets ? (
            <button type="button" className={item} onClick={run(onViewTimesheets)}>
              <CalendarClock className="h-4 w-4 text-muted-foreground" /> View timesheets
            </button>
          ) : null}
          <button type="button" className={item} onClick={run(onResetPassword)}>
            <KeyRound className="h-4 w-4 text-muted-foreground" /> Reset password
          </button>
          {user.timesheet_locked && onUnlock ? (
            <button type="button" className={item} onClick={run(onUnlock)} title={user.timesheet_locked_reason ?? 'Timesheet locked'}>
              <LockOpen className="h-4 w-4 text-amber-600 dark:text-amber-300" /> Unlock timesheet
            </button>
          ) : null}
          {!user.is_external ? (
            <button type="button" className={item} onClick={run(onSendInvite)}>
              <Send className="h-4 w-4 text-muted-foreground" /> Send invite
            </button>
          ) : null}
          <button type="button" className={item} onClick={run(onToggleActive)}>
            {user.is_active ? (
              <><UserX className="h-4 w-4 text-muted-foreground" /> Deactivate</>
            ) : (
              <><UserCheck className="h-4 w-4 text-muted-foreground" /> Activate</>
            )}
          </button>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            className={item + ' text-rose-600 hover:bg-rose-500/10 dark:text-rose-300'}
            onClick={run(onDelete)}
          >
            <Trash2 className="h-4 w-4" /> Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}
