import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Empty, RoleBadge } from '@/components/ui';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import type { ManagedUser } from '@/types/admin';

// OrgChart — a compact, client-side organizational tree. Ported from
// frontend2's OrganizationalChart, trimmed to the essentials: group users by
// manager_id, render top-level users (no/external manager) as roots, nest their
// reports recursively, and let each node collapse. The current user is
// highlighted. No API calls — everything derives from the `users` array.

interface OrgChartProps {
  users: ManagedUser[];
  currentUserId?: number;
}

// One node in the recursive tree.
function TreeNode({
  user,
  childrenByManager,
  currentUserId,
  reportsToName,
  depth,
  hasParentLine,
}: {
  user: ManagedUser;
  childrenByManager: Record<number, ManagedUser[]>;
  currentUserId?: number;
  reportsToName?: string;
  depth: number;
  hasParentLine: boolean;
}) {
  const children = childrenByManager[user.id] ?? [];
  const hasChildren = children.length > 0;
  // Deep branches start collapsed so the tree stays compact on first paint.
  const [collapsed, setCollapsed] = useState(depth >= 2);

  // Total people beneath this node (shown on the collapsed bubble).
  const descendantCount = useMemo(() => {
    const count = (uid: number): number =>
      (childrenByManager[uid] ?? []).reduce((acc, c) => acc + 1 + count(c.id), 0);
    return count(user.id);
  }, [user.id, childrenByManager]);

  const isCurrent = currentUserId != null && user.id === currentUserId;
  const showChildren = hasChildren && !collapsed;

  return (
    <div className="relative flex flex-col items-center">
      {/* Stem coming in from the parent above. */}
      {hasParentLine ? <div className="w-px bg-border" style={{ height: 26 }} /> : null}

      {/* Node card. */}
      <button
        type="button"
        onClick={hasChildren ? () => setCollapsed((c) => !c) : undefined}
        aria-expanded={hasChildren ? !collapsed : undefined}
        className={cn(
          'relative w-[200px] select-none rounded-xl border bg-card px-3 py-2.5 text-left transition',
          hasChildren && 'cursor-pointer',
          isCurrent
            ? 'border-primary ring-2 ring-primary/30'
            : 'border-border hover:border-primary/50 hover:bg-muted/30',
        )}
      >
        {/* Collapsed descendant-count bubble. */}
        {hasChildren && collapsed && descendantCount > 0 ? (
          <span className="absolute -right-2 -top-2 z-10 rounded-full border border-border bg-muted px-1.5 py-0.5 text-[9px] font-bold leading-none text-muted-foreground">
            +{descendantCount}
          </span>
        ) : null}

        <div className="flex items-start gap-2.5">
          {/* Avatar. */}
          <span
            className={cn(
              'grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-semibold',
              avatarTone(user.full_name || user.email),
            )}
          >
            {initials(user.full_name)}
          </span>

          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold leading-snug text-foreground">
              {user.full_name}
            </p>
            {user.title ? (
              <p className="truncate text-[11px] leading-tight text-muted-foreground">{user.title}</p>
            ) : null}
            {user.department ? (
              <p className="truncate text-[10px] leading-tight text-muted-foreground/70">
                {user.department}
              </p>
            ) : null}
            {reportsToName ? (
              <p className="truncate text-[9px] leading-tight text-muted-foreground/60">
                ↑ {reportsToName}
              </p>
            ) : null}

            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <RoleBadge role={user.role} />
              {isCurrent ? (
                <span className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-primary">
                  you
                </span>
              ) : null}
            </div>
          </div>

          {/* Collapse toggle. */}
          {hasChildren ? (
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-border bg-muted text-muted-foreground">
              {collapsed ? (
                <ChevronRight className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </span>
          ) : null}
        </div>
      </button>

      {/* Children subtree. */}
      {showChildren ? (
        <div className="flex flex-col items-center">
          {/* Stem down from the card to the connector bar. */}
          <div className="w-px bg-border" style={{ height: 22 }} />

          {children.length === 1 ? (
            // A single child: just a straight line, no horizontal bar.
            <TreeNode
              user={children[0]}
              childrenByManager={childrenByManager}
              currentUserId={currentUserId}
              depth={depth + 1}
              hasParentLine
            />
          ) : (
            // Multiple children: a horizontal bar with a drop to each.
            <div className="flex flex-row items-start">
              {children.map((child, i) => {
                const isFirst = i === 0;
                const isLast = i === children.length - 1;
                return (
                  <div key={child.id} className="flex flex-col items-center px-4">
                    {/* Connector row: half-bars + vertical drop. */}
                    <div className="relative flex w-full justify-center" style={{ height: 22 }}>
                      {!isFirst ? (
                        <div className="absolute bg-border" style={{ height: 2, top: 0, right: '50%', left: 0 }} />
                      ) : null}
                      {!isLast ? (
                        <div className="absolute bg-border" style={{ height: 2, top: 0, left: '50%', right: 0 }} />
                      ) : null}
                      <div
                        className="absolute bg-border"
                        style={{ width: 2, top: 0, bottom: 0, left: 'calc(50% - 1px)' }}
                      />
                    </div>

                    <TreeNode
                      user={child}
                      childrenByManager={childrenByManager}
                      currentUserId={currentUserId}
                      depth={depth + 1}
                      hasParentLine={false}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function OrgChart({ users, currentUserId }: OrgChartProps) {
  // Map of manager id -> their direct reports, name-sorted. Only active,
  // internal users participate in the hierarchy (external users have hours
  // entered for them and don't report into the tree).
  const childrenByManager = useMemo(() => {
    const map: Record<number, ManagedUser[]> = {};
    for (const u of users) {
      if (u.is_external) continue;
      if (u.manager_id == null) continue;
      (map[u.manager_id] ??= []).push(u);
    }
    for (const arr of Object.values(map)) {
      arr.sort((a, b) => a.full_name.localeCompare(b.full_name));
    }
    return map;
  }, [users]);

  // Ids of users that actually appear in the tree (internal). A user whose
  // manager isn't in this set (e.g. an external manager) is treated as a root.
  const visibleIds = useMemo(() => {
    const s = new Set<number>();
    for (const u of users) if (!u.is_external) s.add(u.id);
    return s;
  }, [users]);

  // id -> name, used to label a root that reports to someone outside the tree.
  const nameById = useMemo(() => {
    const m: Record<number, string> = {};
    for (const u of users) m[u.id] = u.full_name;
    return m;
  }, [users]);

  // Roots: internal users with no manager, or whose manager isn't in the tree.
  const roots = useMemo(
    () =>
      users
        .filter((u) => !u.is_external && (u.manager_id == null || !visibleIds.has(u.manager_id)))
        .sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [users, visibleIds],
  );

  if (roots.length === 0) {
    return <Empty title="No org chart yet" description="Add internal users with managers to build the hierarchy." />;
  }

  return (
    <div className="overflow-x-auto pb-4">
      <div className="flex w-max items-start gap-12 px-2 pt-2">
        {roots.map((u) => (
          <TreeNode
            key={u.id}
            user={u}
            childrenByManager={childrenByManager}
            currentUserId={currentUserId}
            depth={0}
            hasParentLine={false}
            reportsToName={
              u.manager_id != null && !visibleIds.has(u.manager_id)
                ? (nameById[u.manager_id] ?? 'External')
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}
