import { useMemo } from 'react';
import { FolderPlus, UserCheck } from 'lucide-react';

import { Button, Empty, Modal } from '@/components/ui';
import { avatarTone, initials } from '@/lib/avatar';
import type { ManagedUser } from '@/types/admin';

// "Employees Without Project Access" (ported from frontend2 AdminPage).
//
// Surfaces every active EMPLOYEE who has zero project access so an admin can
// jump straight into assigning them. The list is derived from the `users` prop
// (no API call) — the parent already holds the roster. Each row offers an
// "Assign Projects" action that hands the user back to the caller (which opens
// the edit modal pre-scrolled to project access).

function displayEmail(email: string | null | undefined): string {
  if (!email || email.toLowerCase().endsWith('@local.invalid')) return 'N/A';
  return email;
}

export function NoProjectAccessModal({
  open,
  users,
  onClose,
  onAssign,
}: {
  open: boolean;
  users: ManagedUser[];
  onClose: () => void;
  onAssign: (u: ManagedUser) => void;
}) {
  // Active employees with no project access. Same predicate as frontend2's
  // `employeesWithoutProjects`.
  const rows = useMemo(
    () =>
      users.filter(
        (u) =>
          u.role === 'EMPLOYEE' &&
          u.is_active &&
          (u.project_ids?.length ?? 0) === 0,
      ),
    [users],
  );

  const subtitle =
    rows.length === 1
      ? '1 active employee with no projects assigned'
      : `${rows.length} active employees with no projects assigned`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Employees without project access"
      className="max-w-2xl"
    >
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">{subtitle}</p>

        {rows.length === 0 ? (
          <Empty
            Icon={UserCheck}
            title="Everyone is covered"
            description="All active employees have at least one project assigned."
          />
        ) : (
          <div className="max-h-[60vh] overflow-y-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Email</th>
                  <th className="px-4 py-2.5 font-medium">Department</th>
                  <th className="px-4 py-2.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((u) => (
                  <tr key={u.id} className="transition-colors hover:bg-foreground/[0.03]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={
                            'grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold ' +
                            avatarTone(u.full_name || u.email || String(u.id))
                          }
                        >
                          {initials(u.full_name)}
                        </span>
                        <span className="font-medium text-foreground">{u.full_name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{displayEmail(u.email)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{u.department || 'N/A'}</td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        onClick={() => onAssign(u)}
                      >
                        <FolderPlus className="h-3.5 w-3.5" />
                        Assign projects
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex justify-end border-t border-border pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
