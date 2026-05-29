import { describe, expect, it } from 'vitest';

import {
  FETCH_STALE_THRESHOLD_MS,
  formatFetchProgressText,
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

describe('formatFetchProgressText (F-09)', () => {
  it('prefers messages counters when both processed and total are present', () => {
    const status = make({
      counters: {
        messages_processed: 7,
        messages_total: 12,
        mailboxes_processed: 1,
        mailboxes_total: 3,
      },
    });
    expect(formatFetchProgressText(status, 50)).toBe('7 of 12 emails');
  });

  it('falls back to mailbox counters when message_total is missing', () => {
    const status = make({
      counters: {
        mailboxes_processed: 2,
        mailboxes_total: 5,
      },
    });
    expect(formatFetchProgressText(status, 40)).toBe('2 of 5 mailboxes');
  });

  it('falls back to mailbox counters when message_total is zero', () => {
    const status = make({
      counters: {
        messages_processed: 0,
        messages_total: 0,
        mailboxes_processed: 1,
        mailboxes_total: 2,
      },
    });
    expect(formatFetchProgressText(status, 25)).toBe('1 of 2 mailboxes');
  });

  it('falls back to percentage when counters are absent', () => {
    expect(formatFetchProgressText(make({ counters: null }), 45)).toBe('45%');
    expect(formatFetchProgressText(make({ counters: undefined }), 45)).toBe('45%');
  });

  it('falls back to percentage when status is null/undefined', () => {
    expect(formatFetchProgressText(null, 30)).toBe('30%');
    expect(formatFetchProgressText(undefined, 30)).toBe('30%');
  });

  it('falls back to percentage when messages_total is 0', () => {
    // Edge case: queued state with totals set but no work yet. The
    // fallback should NOT divide by zero or show "0 of 0 emails".
    const status = make({
      counters: { messages_processed: 0, messages_total: 0 },
    });
    expect(formatFetchProgressText(status, 5)).toBe('5%');
  });

  it('handles non-numeric counter values gracefully', () => {
    // A future bug or schema drift writing strings shouldn't crash —
    // we just fall through.
    const status = make({
      counters: { messages_processed: 'oops' as unknown as number,
                  messages_total: 12 },
    });
    expect(formatFetchProgressText(status, 33)).toBe('33%');
  });
});
