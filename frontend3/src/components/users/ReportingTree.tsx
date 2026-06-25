import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, CornerDownRight, Star, Users } from 'lucide-react';

import { RoleBadge } from '@/components/ui';
import { useAssignableUsers } from '@/hooks/useAdmin';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import type { ManagedUser } from '@/types/admin';

// Reporting tree for the User-details view: the selected person's reporting
// chain UP (who they report to, all the way to the top) and their reports DOWN
// (direct reports, expandable to reports-of-reports). The selected person is
// centered and highlighted. Works for everyone — an employee just shows the
// chain up with no reports below. Built entirely client-side from the tenant
// directory (no extra endpoint); the directory is already cached by the page.

// Resolve a user's effective single manager id (primary if multi-manager).
function managerOf(u: ManagedUser): number | null {
  return u.primary_manager_id ?? u.manager_id ?? (u.manager_ids?.[0] ?? null);
}

// All manager ids a user reports to (multi-manager aware), primary first.
function managersOf(u: ManagedUser): number[] {
  const ids = u.manager_ids && u.manager_ids.length
    ? [...u.manager_ids]
    : (u.manager_id != null ? [u.manager_id] : []);
  const primary = u.primary_manager_id ?? u.manager_id ?? ids[0];
  // Put the primary first, keep the rest in order, dedupe.
  const ordered = [primary, ...ids].filter((x): x is number => x != null);
  return [...new Set(ordered)];
}

// A compact person row used at every level of the tree.
// Highlighted card for the selected person — the anchor of the reporting line.
function SelfCard({ user }: { user: ManagedUser }) {
  const name = user.full_name || `#${user.id}`;
  return (
    <div className="flex w-full items-center gap-2.5 rounded-xl border border-primary bg-primary/[0.06] px-3 py-2">
      <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold', avatarTone(name))}>
        {initials(name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13.5px] font-bold">{name}</span>
          <RoleBadge role={user.role} />
        </span>
        {user.title ? <span className="block truncate text-[11.5px] text-muted-foreground">{user.title}</span> : null}
      </span>
    </div>
  );
}

// Compact single-line row for a report: small avatar, name, role badge, then
// the title inline (no boxes), so a long list stays scannable.
function ReportLine({
  user, trailing, onClick,
}: {
  user: ManagedUser;
  trailing?: React.ReactNode;
  onClick?: () => void;
}) {
  const name = user.full_name || `#${user.id}`;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-primary/[0.04]"
    >
      <span className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-full text-[9px] font-semibold', avatarTone(name))}>
        {initials(name)}
      </span>
      <span className="truncate text-[13px] font-semibold text-foreground">{name}</span>
      <RoleBadge role={user.role} />
      {user.title ? <span className="truncate text-[11.5px] text-muted-foreground">{user.title}</span> : null}
      {trailing ? <span className="ml-auto shrink-0">{trailing}</span> : null}
    </button>
  );
}

// One report node (compact single line), expandable to its own reports. The
// nested reports-of-reports start collapsed to keep the list short.
function ReportNode({
  user, childrenByManager, depth, clickFor,
}: {
  user: ManagedUser;
  childrenByManager: Map<number, ManagedUser[]>;
  depth: number;
  // Returns an onClick only for openable ids (gates the data-leak fix).
  clickFor: (id: number) => (() => void) | undefined;
}) {
  const kids = childrenByManager.get(user.id) ?? [];
  const [open, setOpen] = useState(false);
  const descendantCount = useMemo(() => {
    const count = (uid: number): number =>
      (childrenByManager.get(uid) ?? []).reduce((acc, c) => acc + 1 + count(c.id), 0);
    return count(user.id);
  }, [user.id, childrenByManager]);

  return (
    <div>
      <div className="flex items-center">
        {kids.length ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={open ? 'Collapse' : 'Expand'}
            className="grid h-6 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted/60"
          >
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="h-6 w-5 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <ReportLine
            user={user}
            onClick={clickFor(user.id)}
            trailing={kids.length ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {descendantCount}
              </span>
            ) : undefined}
          />
        </div>
      </div>
      {open && kids.length ? (
        <div className="ml-2.5 mt-0.5 space-y-0.5 border-l border-border pl-2">
          {kids.map((k) => (
            <ReportNode key={k.id} user={k} childrenByManager={childrenByManager} depth={depth + 1} clickFor={clickFor} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ReportingTree({
  user, onSelectUser, openableIds = null,
}: {
  user: ManagedUser;
  // Optional: jump the detail pane to another person when their row is clicked.
  onSelectUser?: (id: number) => void;
  // Ids the viewer may open. null = anyone (admin). A Set restricts clicks to
  // those ids (a manager's own scope) — clicking anyone else is a no-op, so the
  // tree can SHOW the org context without leaking access to it.
  openableIds?: Set<number> | null;
}) {
  const dirQ = useAssignableUsers();
  const directory = (dirQ.data ?? []) as ManagedUser[];
  // Returns an onClick only when the target id is openable by the viewer.
  const clickFor = (id: number): (() => void) | undefined =>
    onSelectUser && (openableIds === null || openableIds.has(id)) ? () => onSelectUser(id) : undefined;

  const byId = useMemo(() => {
    const m = new Map<number, ManagedUser>();
    directory.forEach((u) => m.set(u.id, u));
    return m;
  }, [directory]);

  // Children grouped by their effective manager id.
  const childrenByManager = useMemo(() => {
    const m = new Map<number, ManagedUser[]>();
    directory.forEach((u) => {
      // A report appears under EVERY manager they report to, not just their
      // primary — so a co-manager sees them in their direct reports too.
      managersOf(u).forEach((mid) => {
        if (!m.has(mid)) m.set(mid, []);
        m.get(mid)!.push(u);
      });
    });
    // Stable, name-sorted children.
    m.forEach((list) => list.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '')));
    return m;
  }, [directory]);

  // The user's direct managers (all of them when multi-manager), primary first.
  const directManagers = useMemo(
    () => managersOf(user).map((id) => byId.get(id)).filter((m): m is ManagedUser => !!m),
    [user, byId],
  );
  const primaryManagerId = managerOf(user);

  // Spine UP: from the PRIMARY manager's own manager to the top. The direct
  // managers are rendered as their own group just above the selected person, so
  // the spine starts one level higher to avoid duplicating the primary. Showing
  // every ancestor of every co-manager would explode into a graph, so the spine
  // follows the primary line for a single readable backbone. Cycle-guarded.
  const spineUp = useMemo(() => {
    const chain: ManagedUser[] = [];
    const seen = new Set<number>([user.id, ...directManagers.map((m) => m.id)]);
    const primary = primaryManagerId != null ? byId.get(primaryManagerId) : undefined;
    let mid = primary ? managerOf(primary) : null;
    while (mid != null && !seen.has(mid)) {
      const mgr = byId.get(mid);
      if (!mgr) break;
      chain.push(mgr);
      seen.add(mgr.id);
      mid = managerOf(mgr);
    }
    return chain.reverse(); // top-most first
  }, [user, byId, directManagers, primaryManagerId]);

  const directReports = childrenByManager.get(user.id) ?? [];

  // Paginate just the direct-reports list so a big team doesn't make the whole
  // panel scroll. Reset to page 0 whenever the selected user changes.
  const PAGE_SIZE = 8;
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [user.id]);
  const pageCount = Math.max(1, Math.ceil(directReports.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pagedReports = directReports.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  if (dirQ.isLoading) {
    return (
      <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground">
        <Users className="h-5 w-5 animate-pulse" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Users className="h-4 w-4 text-primary" />
        <p className="text-sm font-bold text-foreground">Reporting tree</p>
      </div>

      <div className="space-y-1.5 p-4">
        {directManagers.length > 1 ? (
          /* CO-MANAGERS: the user reports to several managers INDEPENDENTLY, so
             a single indented chain would wrongly imply they report to each
             other. Render them as an equal-level sibling group under a "Reports
             to" label, each its own row (primary starred). No shared spine, as
             co-managers can have different chains of their own. */
          <div>
            <p className="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              Reports to · {directManagers.length} managers
            </p>
            <div className="space-y-1.5 rounded-xl border border-dashed border-border p-1.5">
              {directManagers.map((m) => {
                const isPrimary = m.id === primaryManagerId;
                return (
                  <ReportLine
                    key={m.id}
                    user={m}
                    onClick={clickFor(m.id)}
                    trailing={isPrimary ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
                        <Star className="h-3 w-3 fill-current" /> Primary
                      </span>
                    ) : undefined}
                  />
                );
              })}
            </div>
            {/* All managers converge on the selected person. */}
            <div className="mt-1.5 flex items-center gap-1.5">
              <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1"><SelfCard user={user} /></div>
            </div>
          </div>
        ) : (
          /* SINGLE-MANAGER (or none): a linear spine reads correctly. */
          <>
            {spineUp.map((m, i) => (
              <div key={m.id} className="flex items-center gap-1.5" style={{ paddingLeft: i * 14 }}>
                {i > 0 ? <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <span className="h-3.5 w-3.5 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <ReportLine user={m} onClick={clickFor(m.id)} />
                </div>
              </div>
            ))}
            {directManagers.length === 1 ? (
              <div className="flex items-center gap-1.5" style={{ paddingLeft: spineUp.length * 14 }}>
                <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <ReportLine user={directManagers[0]} onClick={clickFor(directManagers[0].id)} />
                </div>
              </div>
            ) : (
              <p className="px-1 pb-1 text-[12px] text-muted-foreground">
                {user.is_external ? 'External user — no internal reporting tree.' : 'Top of the reporting tree (no manager).'}
              </p>
            )}
            <div className="flex items-start gap-1.5" style={{ paddingLeft: (spineUp.length + (directManagers.length ? 1 : 0)) * 14 }}>
              {directManagers.length ? <CornerDownRight className="mt-2.5 h-3.5 w-3.5 shrink-0 text-primary" /> : <span className="h-3.5 w-3.5 shrink-0" />}
              <div className="min-w-0 flex-1">
                <SelfCard user={user} />
              </div>
            </div>
          </>
        )}

        {/* Reports down — compact single-line rows, paginated. */}
        <div className="pt-1">
          <div className="mb-1.5 flex items-center justify-between px-1">
            <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              Direct reports {directReports.length ? `· ${directReports.length}` : ''}
            </p>
            {pageCount > 1 ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  aria-label="Previous page"
                  className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-muted/60 disabled:opacity-40"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-[11px] tabular-nums text-muted-foreground">{safePage + 1}/{pageCount}</span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={safePage >= pageCount - 1}
                  aria-label="Next page"
                  className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-muted/60 disabled:opacity-40"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            ) : null}
          </div>
          {directReports.length === 0 ? (
            <p className="px-1 text-[12px] text-muted-foreground">No direct reports.</p>
          ) : (
            <div className="space-y-0.5">
              {pagedReports.map((r) => (
                <ReportNode key={r.id} user={r} childrenByManager={childrenByManager} depth={0} clickFor={clickFor} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
