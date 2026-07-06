import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

import { useProjectManagementEnabled } from '@/hooks/useProjectManagementEnabled';

// Route guard for the project-management surfaces (Clients / Projects / Tasks /
// Insights / My Work). Redirects to the dashboard when the workspace has the PM
// module disabled, so a deep link doesn't render a 403 wall. Defaults open, so
// it never blocks while the flag is loading.
export function RequirePM({ children }: { children: ReactNode }) {
  const enabled = useProjectManagementEnabled();
  if (!enabled) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
