import { ArrowRight, Briefcase, Eye, ShieldCheck } from 'lucide-react';

import type { UserRole } from '@/types/user';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/roleLabels';

const LABEL = ROLE_LABELS;
const DESC = ROLE_DESCRIPTIONS;
const ICON: Partial<Record<UserRole, typeof Briefcase>> = {
  ADMIN: Briefcase, MANAGER: ShieldCheck, VIEWER: Eye, EMPLOYEE: Briefcase,
};

// Portal picker for multi-role users on fresh login. One button per role the
// user can act as; picking drives the caller's /auth/switch-role round-trip
// (or just dismiss if they accept the role they logged in as). Ported from
// frontend2 — this is what prevents a stale persisted role silently dropping
// an admin into the empty manager dashboard.
export function PortalPickerModal({
  isOpen,
  roles,
  currentRole,
  onPick,
  pending = false,
}: {
  isOpen: boolean;
  roles: UserRole[];
  currentRole?: UserRole;
  onPick: (role: UserRole) => void;
  pending?: boolean;
}) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <h2 className="text-xl font-semibold text-foreground">Choose your portal</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          You have access to more than one role. Pick where to start; you can switch later from the top bar.
        </p>
        <div className="mt-5 space-y-2">
          {roles.map((role) => {
            const Icon = ICON[role] ?? Briefcase;
            const isCurrent = currentRole === role;
            return (
              <button
                key={role}
                type="button"
                onClick={() => onPick(role)}
                disabled={pending}
                className="group flex w-full items-center gap-3 rounded-xl border border-border bg-background/40 px-4 py-3 text-left transition hover:border-primary/40 hover:bg-primary/5 disabled:opacity-60"
              >
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="block truncate text-sm font-semibold text-foreground">Continue as {LABEL[role] ?? role}</span>
                    {isCurrent ? <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">last used</span> : null}
                  </span>
                  {DESC[role] ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{DESC[role]}</span> : null}
                </span>
                <ArrowRight className="ml-2 hidden h-4 w-4 shrink-0 text-primary group-hover:inline-block" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
