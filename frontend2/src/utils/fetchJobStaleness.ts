/**
 * Stalled-fetch-job detection.
 *
 * Backend audit F-04 (2026-05-29): when the worker container crashes
 * mid-job, the last-written status row sits in Redis for up to 24h and
 * the UI spins forever. We now stamp ``updated_at`` on every status
 * write, and this helper compares it against the wall clock to decide
 * whether to flip the UI into a "stalled" state with a recovery action.
 *
 * Threshold matches the backend's lock TTL (``worker_job_timeout +
 * 60s``, ~6 min). Kept as a constant export so it's easy to tune from
 * one place if either side moves.
 */
import type { FetchJobStatus } from '@/types';

export const FETCH_STALE_THRESHOLD_MS = 6 * 60 * 1000;

/**
 * Returns true if the job is a polling target (i.e. queued/in_progress)
 * AND its ``updated_at`` hasn't moved in longer than the threshold.
 *
 * Terminal statuses (complete/failed/cancelled/not_found) are never
 * stale by definition — the UI should already be showing the outcome.
 *
 * Missing ``updated_at`` returns false (degrade gracefully on older
 * backends that don't stamp it; the existing in-progress UX still
 * works, just without staleness detection).
 *
 * @param status the latest status payload (or null when nothing fetched)
 * @param hasActiveJob whether the UI considers the user actively tied
 *                     to a job (typically ``Boolean(activeJobId)``).
 * @param now wall clock in ms; defaulted to ``Date.now()`` but pluggable
 *            for unit tests.
 */
export const isFetchJobStale = (
  status: FetchJobStatus | null | undefined,
  hasActiveJob: boolean,
  now: number = Date.now(),
): boolean => {
  if (!status || !hasActiveJob) return false;
  const s = status.status;
  if (s === 'complete' || s === 'failed' || s === 'cancelled' || s === 'not_found') {
    return false;
  }
  if (!status.updated_at) return false;
  const updatedAt = Date.parse(status.updated_at);
  if (Number.isNaN(updatedAt)) return false;
  return now - updatedAt > FETCH_STALE_THRESHOLD_MS;
};

/**
 * Render-ready progress text for an in-flight fetch job. Prefers the
 * honest counters from the backend (audit F-09) and falls back to the
 * rough percentage when no counters are available.
 *
 * Pure function — pulled out of the InboxPage JSX so it can be unit-
 * tested without rendering the page.
 *
 * @param status the latest status payload (may be null/undefined)
 * @param progress the bar percentage to fall back to (0-100)
 * @returns short display text like "5 of 12 emails" or "45%"
 */
export const formatFetchProgressText = (
  status: FetchJobStatus | null | undefined,
  progress: number,
): string => {
  const c = status?.counters ?? null;
  if (c) {
    const mp = c.messages_processed;
    const mt = c.messages_total;
    if (typeof mp === 'number' && typeof mt === 'number' && mt > 0) {
      return `${mp} of ${mt} emails`;
    }
    const bp = c.mailboxes_processed;
    const bt = c.mailboxes_total;
    if (typeof bp === 'number' && typeof bt === 'number' && bt > 0) {
      return `${bp} of ${bt} mailboxes`;
    }
  }
  return `${progress}%`;
};
