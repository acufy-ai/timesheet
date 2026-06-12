import { useCallback, useEffect, useState } from 'react';
import { api, brandingApi } from '@/api/client';

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });

/**
 * Loads the current tenant's logo as a data URL when available.
 *
 * - Uses the auth-attached API client, so the request is tenant-scoped
 *   server-side. The data URL never travels through an unauthenticated
 *   static mount.
 * - Returns null when no logo is set (the endpoint 404s) or the fetch fails.
 * - `refresh()` re-fetches; call after upload / delete.
 *
 * NOTE (f3 port): frontend3's `useAuth()` does not expose a `tenant` object,
 * so unlike frontend2 there is no `tenant.has_logo` flag to gate on. We always
 * attempt the fetch; a 404 (no logo set) falls through the catch to `null`,
 * preserving the original "null when absent or on failure" contract.
 */
export const useTenantLogo = () => {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<Blob>(brandingApi.logoUrl, { responseType: 'blob' });
      const url = await blobToDataUrl(response.data as unknown as Blob);
      setDataUrl(url);
    } catch {
      setDataUrl(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { dataUrl, loading, refresh };
};
