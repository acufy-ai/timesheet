import { useQuery } from '@tanstack/react-query';

import { api } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';

// Whether the project-management module (Clients / Projects / Tasks / Insights)
// is enabled for the current workspace. Reads `project_management_enabled` off
// `GET /tenants/mine`.
//
// Fails OPEN (defaults to true) — unlike ingestion, PM is on for almost every
// tenant, so we don't want to hide the whole PM surface while the flag loads or
// for a user without a tenant. Only an explicit `false` disables it.
export function useProjectManagementEnabled(): boolean {
  const { user, isAuthenticated } = useAuth();
  const tenantId = user?.tenant_id ?? null;

  const { data } = useQuery({
    queryKey: ['tenant', 'mine', 'pm-enabled', tenantId],
    queryFn: () =>
      api
        .get<{ project_management_enabled?: boolean }>('/tenants/mine')
        .then((r) => r.data?.project_management_enabled),
    enabled: isAuthenticated && tenantId != null,
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Default-on: only an explicit false turns the module off.
  return data !== false;
}
