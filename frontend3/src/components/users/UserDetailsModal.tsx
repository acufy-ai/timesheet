import { useMemo } from 'react';
import { Pencil, CalendarClock } from 'lucide-react';

import { Button, Modal, RoleBadge, StatusBadge, TonePill } from '@/components/ui';
import { useAdminProjects } from '@/hooks/useAdmin';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import type { ManagedUser } from '@/types/admin';

// Read-only User Details modal. Ported from frontend2's AdminPage user-details
// dialog (the "view" counterpart to the editable UserEditModal). It only
// DISPLAYS the user; both footer actions delegate upward so the parent owns the
// edit form and the timesheet drill-in. No mutations live here.
//
// Manager and default-client display names are resolved by the parent (it has
// the roster + client list) and passed in as `managerName` / `clientName`,
// which keeps this component free of extra data dependencies. Project names for
// the access list are resolved here from the active-projects query so the list
// reads with names instead of bare ids.

interface UserDetailsModalProps {
  open: boolean;
  user: ManagedUser | null;
  onClose: () => void;
  onEdit: (u: ManagedUser) => void;
  onViewTimesheets: (u: ManagedUser) => void;
  managerName?: string;
  clientName?: string;
}

// Treat a synthetic placeholder address as "no email" (matches frontend2).
function displayEmail(email: string | undefined): string {
  if (!email || email.endsWith('@local.invalid')) return 'N/A';
  return email;
}

// `created_at` is not on the trimmed frontend3 ManagedUser type, but the wire
// payload carries it. Read it defensively so the row renders when present and
// is simply omitted when it isn't, without a type error or a crash.
function createdAt(user: ManagedUser): string | null {
  const raw = (user as ManagedUser & { created_at?: string }).created_at;
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5 text-sm font-medium text-foreground">{children}</div>
    </div>
  );
}

export function UserDetailsModal({
  open,
  user,
  onClose,
  onEdit,
  onViewTimesheets,
  managerName,
  clientName,
}: UserDetailsModalProps) {
  // Only fetch projects while the modal is open and we actually have ids to map.
  const hasProjects = !!user?.project_ids && user.project_ids.length > 0;
  const projectsQ = useAdminProjects(open && hasProjects);

  const projectNames = useMemo(() => {
    const ids = user?.project_ids ?? [];
    if (ids.length === 0) return [] as string[];
    const byId = new Map<number, string>((projectsQ.data ?? []).map((p) => [p.id, p.name]));
    return ids.map((id) => byId.get(id) ?? `Project #${id}`);
  }, [user?.project_ids, projectsQ.data]);

  if (!user) return null;

  const created = createdAt(user);
  const projectCount = user.project_ids?.length ?? 0;

  return (
    <Modal open={open} onClose={onClose} title="User details" className="max-w-3xl">
      <div className="space-y-5">
        <div className="space-y-5">
          {/* Identity header: avatar + name + role/status pills. */}
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'grid h-12 w-12 shrink-0 place-items-center rounded-full text-sm font-semibold',
                avatarTone(user.full_name || user.email || String(user.id)),
              )}
            >
              {initials(user.full_name)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold text-foreground">{user.full_name}</p>
              <p className="truncate text-sm text-muted-foreground">{displayEmail(user.email)}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <RoleBadge role={user.role} />
                <StatusBadge
                  status={user.is_active ? 'approved' : 'rejected'}
                  label={user.is_active ? 'Active' : 'Inactive'}
                  showIcon={false}
                />
                {user.is_external ? <TonePill tone="neutral">External</TonePill> : null}
              </div>
            </div>
          </div>

          {/* Core attributes. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Title">{user.title || 'N/A'}</Field>
            {!user.is_external ? (
              <>
                <Field label="Department">{user.department || 'N/A'}</Field>
                <Field label="Reports to">{managerName || 'N/A'}</Field>
              </>
            ) : null}
            <Field label="Default client">{clientName || 'N/A'}</Field>
            {created ? (
              <Field label="Created">
                <span className="inline-flex items-center gap-1.5">
                  <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
                  {created}
                </span>
              </Field>
            ) : null}
          </div>

          {/* Project access. Hidden entirely for external users (they don't
              carry login-scoped project access in this product). */}
          {!user.is_external ? (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">Project access</h3>
                <span className="rounded-full bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {projectCount} {projectCount === 1 ? 'project' : 'projects'}
                </span>
              </div>
              {projectCount === 0 ? (
                <p className="text-sm text-muted-foreground">No project access assigned.</p>
              ) : (
                <div className="space-y-1.5">
                  {projectNames.map((name, idx) => (
                    <div
                      key={`${user.project_ids?.[idx] ?? idx}`}
                      className="rounded-xl border border-border bg-muted/10 px-3 py-2 text-sm font-medium text-foreground"
                    >
                      {name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* Footer actions. Both delegate to the parent; this modal stays
            read-only. The parent typically closes this and opens the edit form
            or the timesheet drill-in. */}
        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button variant="secondary" size="sm" onClick={() => onViewTimesheets(user)}>
            <CalendarClock className="h-3.5 w-3.5" /> Timesheets
          </Button>
          <Button size="sm" onClick={() => onEdit(user)}>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </Button>
        </div>
      </div>
    </Modal>
  );
}
