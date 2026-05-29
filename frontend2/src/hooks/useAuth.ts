import { useContext } from 'react';

import {
  AuthActionsContext,
  AuthContext,
  AuthStateContext,
} from '@/contexts/AuthContext';

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

/**
 * Narrower hook for components that only read auth state and never
 * call any of the action callbacks. Re-renders only when state
 * changes, not when callback identities churn.
 */
export const useAuthState = () => {
  const context = useContext(AuthStateContext);
  if (!context) {
    throw new Error('useAuthState must be used within AuthProvider');
  }
  return context;
};

/**
 * Narrower hook for components that only call auth actions (login,
 * logout, etc.) and don't read state. Re-renders only when callback
 * identities change, not on every user/tenant update.
 */
export const useAuthActions = () => {
  const context = useContext(AuthActionsContext);
  if (!context) {
    throw new Error('useAuthActions must be used within AuthProvider');
  }
  return context;
};

export const useIsAuthenticated = () => {
  const { user } = useAuth();
  return Boolean(user);
};

export const useUserRole = () => {
  const { user } = useAuth();
  return user?.role;
};

export const useHasRole = (requiredRoles: string[]) => {
  const role = useUserRole();
  return role ? requiredRoles.includes(role) : false;
};

export const useIsAdmin = () => useHasRole(['ADMIN']);
export const useIsPlatformAdmin = () => useHasRole(['PLATFORM_ADMIN']);
export const useIsViewer = () => useHasRole(['VIEWER']);
export const useIsManager = () => useHasRole(['MANAGER']);
export const useIsEmployee = () => useHasRole(['EMPLOYEE', 'MANAGER', 'VIEWER', 'ADMIN']);

export const useCanReview = () => {
  const { user } = useAuth();
  // Admin role is intentionally excluded from the reviewer surface.
  // A user who is both admin and a manager / reviewer logs in with
  // their manager account for review and approval work.
  return Boolean(user && user.role !== 'ADMIN' && user.can_review);
};

export const useIsReviewer = () => useCanReview();

export const useIngestionEnabled = () => {
  const { tenant } = useAuth();
  return Boolean(tenant?.ingestion_enabled);
};
