import type { User, UserRole } from '@/types/user';

// The client-side roles: the legacy flat CLIENT plus the two-tier
// CLIENT_MANAGER / CLIENT_EMPLOYEE. They all live entirely in the portal and
// must never fire workspace prefetches (timer, notifications, tenant settings).
const CLIENT_ROLES: UserRole[] = ['CLIENT', 'CLIENT_MANAGER', 'CLIENT_EMPLOYEE'];

export function isClientRole(role?: UserRole | null): boolean {
  return !!role && CLIENT_ROLES.includes(role);
}

export function isClientUser(user?: Pick<User, 'role'> | null): boolean {
  return isClientRole(user?.role);
}
