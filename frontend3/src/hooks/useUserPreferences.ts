import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { meApi } from '@/api/client';

// Per-user UI preferences, persisted server-side on ``users.preferences``.
// GET /users/me/preferences returns the EFFECTIVE preferences: for a
// brand-new user the backend merges in the tenant's customization defaults
// (theme / palette / landing / page_size), so the first value a user sees is
// the team default until they change it. PATCH merges only the sent keys.

export interface UserPreferences {
  theme?: string; // 'light' | 'dark' | 'system'
  palette?: string; // theme variant key or '' (app default)
  landing?: string; // route slug (dashboard, my-time, …)
  page_size?: number; // rows per list page
  inbox_view_mode?: string;
  holiday_calendar_country?: string | null;
  [key: string]: unknown;
}

export const PREFERENCES_QUERY_KEY = ['user', 'preferences'] as const;

export function useUserPreferences(enabled = true) {
  return useQuery<UserPreferences>({
    queryKey: PREFERENCES_QUERY_KEY,
    queryFn: () => meApi.preferences().then((r) => r.data as UserPreferences),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useUpdatePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<UserPreferences>) =>
      meApi.updatePreferences(patch).then((r) => r.data as UserPreferences),
    onSuccess: (data) => {
      qc.setQueryData(PREFERENCES_QUERY_KEY, data);
    },
  });
}

// The user's effective default page size for lists/tables, from their
// preferences (seeded from the tenant's ``default_page_size`` setting for a
// brand-new user). Falls back to ``fallback`` until prefs load or when unset.
// A paginated list adopts this as the initial rows-per-page:
//   const [pageSize, setPageSize] = useState(usePageSize());
export function usePageSize(fallback = 25): number {
  const prefs = useUserPreferences();
  const v = prefs.data?.page_size;
  return typeof v === 'number' && v > 0 ? v : fallback;
}
