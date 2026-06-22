import { Check, ChevronLeft, ChevronRight, Mail, Trash2, UserX, X } from 'lucide-react';

import { RoleBadge } from '@/components/ui';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import type { ManagedUser } from '@/types/admin';

// Numbered-pager windowing: first, last, current +/-1, with gaps.
function pageWindow(page: number, pages: number): (number | '...')[] {
  const set = new Set<number>([1, pages, page, page - 1, page + 1]);
  const seq = [...set].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const out: (number | '...')[] = [];
  let prev = 0;
  for (const p of seq) {
    if (p - prev > 1) out.push('...');
    out.push(p);
    prev = p;
  }
  return out;
}

type Props = {
  users: ManagedUser[];
  total: number;
  page: number;
  pageSize: number;
  onPage: (p: number) => void;
  loading: boolean;
  activeId: number | null;
  onSelectUser: (u: ManagedUser) => void;
  currentUserId?: number;
  // Admin bulk-select (omit in manager mode for read-only roster).
  bulk?: {
    selected: Set<number>;
    onToggle: (id: number) => void;
    onSelectAllPage: () => void;
    onClear: () => void;
    onSendInvite: () => void;
    onDeactivate: () => void;
    onDelete: () => void;
    busy?: boolean;
  };
};

export function UserRail({
  users, total, page, pageSize, onPage, loading,
  activeId, onSelectUser, currentUserId, bulk,
}: Props) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);
  const sel = bulk?.selected;
  const allPageSelected = users.length > 0 && users.every((u) => sel?.has(u.id));

  return (
    <div className="flex min-h-0 flex-col">
      {/* Bulk action bar (admin) — fits the rail width with icon actions. */}
      {bulk && sel && sel.size > 0 ? (
        <div className="flex items-center gap-1.5 border-b border-border bg-primary/5 px-3 py-2">
          <button type="button" className="icon-btn-sm" title="Clear selection" onClick={bulk.onClear}>
            <X className="h-4 w-4" />
          </button>
          <span className="text-xs font-bold text-primary">{sel.size} selected</span>
          <span className="mx-1 h-4 w-px self-stretch bg-primary/20" />
          <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={bulk.onSelectAllPage}>
            {allPageSelected ? 'Deselect page' : 'Select page'}
          </button>
          <div className="ml-auto flex items-center gap-1">
            <button type="button" className="icon-btn-sm" title="Send invite" disabled={bulk.busy} onClick={bulk.onSendInvite}>
              <Mail className="h-4 w-4" />
            </button>
            <button type="button" className="icon-btn-sm" title="Deactivate" disabled={bulk.busy} onClick={bulk.onDeactivate}>
              <UserX className="h-4 w-4" />
            </button>
            <button type="button" className="icon-btn-sm icon-btn-danger" title="Delete" disabled={bulk.busy} onClick={bulk.onDelete}>
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}

      {/* Scrolling rows */}
      <div className={cn('min-h-0 flex-1 overflow-y-auto px-2.5 py-1', loading && 'opacity-60')}>
        {users.length === 0 ? (
          <div className="px-3 py-10 text-center text-sm text-muted-foreground">No users match.</div>
        ) : (
          users.map((u) => {
            const checked = sel?.has(u.id);
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => onSelectUser(u)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-1.5 text-left transition-colors',
                  u.id === activeId ? 'border-primary/30 bg-primary/10' : 'hover:bg-primary/5',
                )}
              >
                {bulk ? (
                  <span
                    role="checkbox"
                    aria-checked={!!checked}
                    onClick={(e) => { e.stopPropagation(); bulk.onToggle(u.id); }}
                    className={cn(
                      'grid h-4 w-4 flex-shrink-0 place-items-center rounded border',
                      checked ? 'border-primary bg-primary text-white' : 'border-border text-transparent',
                    )}
                  >
                    <Check className="h-3 w-3" />
                  </span>
                ) : null}
                <span className={cn('grid h-7 w-7 flex-shrink-0 place-items-center rounded-lg text-[10.5px] font-semibold', avatarTone(u.full_name))}>
                  {initials(u.full_name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-semibold leading-tight">{u.full_name}</span>
                    {u.id === currentUserId ? (
                      <span className="rounded-full bg-primary/12 px-1.5 text-[9.5px] font-bold text-primary">you</span>
                    ) : null}
                    {u.is_external ? (
                      <span className="rounded-full bg-amber-400/18 px-1.5 text-[9.5px] font-bold text-amber-700">External</span>
                    ) : null}
                  </span>
                  <span className="block truncate text-[11px] leading-tight text-muted-foreground">{u.email}</span>
                </span>
                {!u.is_active ? (
                  <span className="flex-shrink-0 rounded-full bg-muted px-2 text-[10.5px] font-semibold text-muted-foreground">Inactive</span>
                ) : null}
                <RoleBadge role={u.role} />
              </button>
            );
          })
        )}
      </div>

      {/* Pinned numbered pager */}
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-border bg-card px-3.5 py-2 text-[11.5px] text-muted-foreground">
        <span className="tabular-nums">
          {start.toLocaleString()}–{end.toLocaleString()} of {total.toLocaleString()}
        </span>
        <div className="flex items-center gap-1">
          <button type="button" className="pager-btn" disabled={page <= 1} title="Previous" onClick={() => onPage(page - 1)}>
            <ChevronLeft className="h-[15px] w-[15px]" />
          </button>
          {pageWindow(page, pages).map((p, i) =>
            p === '...' ? (
              <span key={`gap-${i}`} className="px-1 text-muted-foreground">…</span>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => onPage(p)}
                className={cn('pager-num', p === page && 'pager-num-active')}
              >
                {p}
              </button>
            ),
          )}
          <button type="button" className="pager-btn" disabled={page >= pages} title="Next" onClick={() => onPage(page + 1)}>
            <ChevronRight className="h-[15px] w-[15px]" />
          </button>
        </div>
      </div>
    </div>
  );
}
