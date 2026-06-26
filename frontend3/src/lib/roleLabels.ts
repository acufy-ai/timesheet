// Single source of truth for how a UserRole VALUE maps to the human-readable
// label shown in the UI. The stored/compared value stays 'EMPLOYEE' everywhere
// (enum, comparisons, API payloads); only the displayed text changes — the
// EMPLOYEE role is presented to users as "Resource".
//
// Use roleLabel(value) anywhere you render a role to a person. Never title-case
// the raw enum value for display, or EMPLOYEE will read as "Employee".

export const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  EMPLOYEE: 'Resource',
  VIEWER: 'Viewer',
  PLATFORM_ADMIN: 'Platform admin',
};

// Plain-language description of what each role can do (portal picker, etc.).
export const ROLE_DESCRIPTIONS: Record<string, string> = {
  ADMIN: 'Workspace settings, users, clients, projects, and audit trail.',
  MANAGER: 'Approvals, reviewer inbox, and team oversight.',
  VIEWER: 'Workspace-wide read-only oversight.',
  EMPLOYEE: 'Your own time entries, time off, and calendar.',
};

export function roleLabel(role: string | null | undefined): string {
  if (!role) return '';
  return ROLE_LABELS[role] ?? role;
}
