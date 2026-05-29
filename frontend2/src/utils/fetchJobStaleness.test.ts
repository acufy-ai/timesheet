import { describe, expect, it } from 'vitest';

import {
  FETCH_STALE_THRESHOLD_MS,
  isFetchJobStale,
} from './fetchJobStaleness';
import type { FetchJobStatus } from '@/types';

const NOW = Date.parse('2026-05-29T16:00:00Z');

const make = (overrides: Partial<FetchJobStatus> = {}): FetchJobStatus => ({
  status: 'in_progress',
  job_id: 'fetch_tenant_1',
  progress: 45,
  message: 'Processing...',
  tenant_id: 1,
  mode: 'fetch',
  result: null,
  error: null,
  started_at: '2026-05-29T15:55:00Z',
  updated_at: '2026-05-29T15:59:30Z', // 30s before NOW
  ...overrides,
});

describe('isFetchJobStale', () => {
  it('returns false when there is no active job', () => {
    expect(isFetchJobStale(make(), false, NOW)).toBe(false);
  });

  it('returns false when status is missing', () => {
    expect(isFetchJobStale(null, true, NOW)).toBe(false);
    expect(isFetchJobStale(undefined, true, NOW)).toBe(false);
  });

  it('returns false for terminal statuses regardless of updated_at age', () => {
    const ancient = '2026-05-28T00:00:00Z';
    for (const status of ['complete', 'failed', 'cancelled', 'not_found']) {
      expect(
        isFetchJobStale(
          make({ status, updated_at: ancient }),
          true,
          NOW,
        ),
      ).toBe(false);
    }
  });

  it('returns false when updated_at is recent', () => {
    expect(isFetchJobStale(make(), true, NOW)).toBe(false);
  });

  it('returns true when updated_at is older than the threshold', () => {
    // 7 min ago = 420_000 ms, threshold is 360_000 ms
    const sevenMinutesAgo = new Date(NOW - 7 * 60 * 1000).toISOString();
    expect(
      isFetchJobStale(make({ updated_at: sevenMinutesAgo }), true, NOW),
    ).toBe(true);
  });

  it('returns false exactly at the threshold boundary', () => {
    // Exactly at threshold = not yet stale (strict >, not >=).
    const exactlyAtThreshold = new Date(
      NOW - FETCH_STALE_THRESHOLD_MS,
    ).toISOString();
    expect(
      isFetchJobStale(make({ updated_at: exactlyAtThreshold }), true, NOW),
    ).toBe(false);
  });

  it('returns false when updated_at is missing (graceful degrade)', () => {
    expect(
      isFetchJobStale(make({ updated_at: null }), true, NOW),
    ).toBe(false);
  });

  it('returns false when updated_at is unparseable', () => {
    expect(
      isFetchJobStale(make({ updated_at: 'not a date' }), true, NOW),
    ).toBe(false);
  });

  it('catches stale queued status (not just in_progress)', () => {
    const ancient = new Date(NOW - 10 * 60 * 1000).toISOString();
    expect(
      isFetchJobStale(
        make({ status: 'queued', updated_at: ancient }),
        true,
        NOW,
      ),
    ).toBe(true);
  });
});
