/**
 * Persist the currently-tracked fetch job_id across page reloads so the
 * UI re-attaches its polling display when the user comes back to a long-
 * running fetch (audit F-03).
 *
 * Storage:
 *   - sessionStorage (cleared when the tab closes; not shared across tabs)
 *   - Tenant-scoped key so a user switching between tenants doesn't see a
 *     stale job from a different workspace
 *   - Best-effort: any sessionStorage error (private browsing quota,
 *     blocked by extension, etc) is swallowed and the page degrades to
 *     today's behavior (no restore on reload)
 */

const STORAGE_PREFIX = 'inbox.activeFetchJob.';

const _key = (tenantId: number | null | undefined): string | null =>
  tenantId == null ? null : `${STORAGE_PREFIX}${tenantId}`;

/**
 * Read the persisted active job_id for a tenant. Returns null if nothing
 * is stored, tenantId is missing, or sessionStorage is unavailable.
 */
export const readActiveFetchJobId = (
  tenantId: number | null | undefined,
): string | null => {
  const key = _key(tenantId);
  if (key == null) return null;
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

/**
 * Persist (or clear, when ``jobId`` is null) the active fetch job for a
 * tenant. Calls are idempotent and never throw.
 */
export const writeActiveFetchJobId = (
  tenantId: number | null | undefined,
  jobId: string | null,
): void => {
  const key = _key(tenantId);
  if (key == null) return;
  if (typeof window === 'undefined') return;
  try {
    if (jobId == null) {
      window.sessionStorage.removeItem(key);
    } else {
      window.sessionStorage.setItem(key, jobId);
    }
  } catch {
    // Quota exceeded / private mode / blocked — degrade silently.
  }
};
