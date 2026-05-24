import { useCallback, useEffect, useState } from 'react';
import { adminAPI } from '@/api/endpoints';
import { useAuth } from './useAuth';

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
 * - Returns null when has_logo is false or the fetch fails.
 * - `refresh()` re-fetches; call after upload / delete.
 */
export const useTenantLogo = () => {
  const { tenant } = useAuth();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const hasLogo = Boolean(tenant?.has_logo);

  const refresh = useCallback(async () => {
    if (!hasLogo) {
      setDataUrl(null);
      return;
    }
    setLoading(true);
    try {
      const response = await adminAPI.getTenantLogoBlob();
      const url = await blobToDataUrl(response.data as unknown as Blob);
      setDataUrl(url);
    } catch {
      setDataUrl(null);
    } finally {
      setLoading(false);
    }
  }, [hasLogo]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { dataUrl, loading, refresh };
};
