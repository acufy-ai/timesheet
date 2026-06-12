import { useQuery } from '@tanstack/react-query';

import { api } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';

// Whether email ingestion (the inbox / mailboxes surface) is enabled for the
// current workspace. In frontend2 this came off `tenant.ingestion_enabled`
// from the auth context, which was populated from `GET /tenants/mine`. The
// frontend3 auth context does not carry the tenant object, so we fetch the
// flag directly from the same endpoint and cache it.
//
// Returns `false` until the tenant record loads, while the user is logged
// out, or if the request fails — i.e. it fails closed.
export function useIngestionEnabled(): boolean {
  const { user, isAuthenticated } = useAuth();
  const tenantId = user?.tenant_id ?? null;

  const { data } = useQuery({
    queryKey: ['tenant', 'mine', 'ingestion-enabled', tenantId],
    queryFn: () =>
      api
        .get<{ ingestion_enabled?: boolean }>('/tenants/mine')
        .then((r) => Boolean(r.data?.ingestion_enabled)),
    enabled: isAuthenticated && tenantId != null,
    staleTime: 5 * 60_000,
    retry: false,
  });

  return Boolean(data);
}
