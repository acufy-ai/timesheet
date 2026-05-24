import type { User } from '@/types';

const SYSTEM_EMAIL_DOMAIN = '@system.internal';

export const isSystemBotUser = (u: Pick<User, 'email'>): boolean =>
  (u.email ?? '').toLowerCase().endsWith(SYSTEM_EMAIL_DOMAIN);

export const isPendingInvite = (
  u: Pick<User, 'is_active' | 'is_external' | 'email_verified' | 'email'>,
): boolean =>
  Boolean(u.is_active) && !u.is_external && !u.email_verified && !isSystemBotUser(u);
