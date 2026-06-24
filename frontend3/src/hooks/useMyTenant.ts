import { useQuery } from '@tanstack/react-query';

import { brandingApi } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';

// The caller's own tenant (workspace). Used for the top-nav workspace label.
// Only fetched for users that belong to a tenant — platform admins have no
// tenant (tenant_id null) and the endpoint 404s for them, so we skip it.
export function useMyTenant() {
  const { user } = useAuth();
  const enabled = Boolean(user && user.tenant_id != null);
  return useQuery({
    queryKey: ['tenant', 'mine'],
    queryFn: () => brandingApi.mine().then((r) => r.data),
    enabled,
    staleTime: 5 * 60_000,
  });
}
