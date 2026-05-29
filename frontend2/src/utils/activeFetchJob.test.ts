import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readActiveFetchJobId, writeActiveFetchJobId } from './activeFetchJob';

describe('activeFetchJob session persistence', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('round-trips a job id for a given tenant', () => {
    writeActiveFetchJobId(7, 'fetch_tenant_7');
    expect(readActiveFetchJobId(7)).toBe('fetch_tenant_7');
  });

  it('returns null when no job is persisted', () => {
    expect(readActiveFetchJobId(7)).toBeNull();
  });

  it('returns null when tenant id is null or undefined', () => {
    writeActiveFetchJobId(7, 'fetch_tenant_7');
    expect(readActiveFetchJobId(null)).toBeNull();
    expect(readActiveFetchJobId(undefined)).toBeNull();
  });

  it('does NOT cross tenants', () => {
    writeActiveFetchJobId(7, 'fetch_tenant_7');
    expect(readActiveFetchJobId(99)).toBeNull();
  });

  it('clear via null write removes the key', () => {
    writeActiveFetchJobId(7, 'fetch_tenant_7');
    writeActiveFetchJobId(7, null);
    expect(readActiveFetchJobId(7)).toBeNull();
  });

  it('write with null tenant id is a no-op (never throws)', () => {
    writeActiveFetchJobId(null, 'x');
    writeActiveFetchJobId(undefined, 'x');
    // No assertion needed beyond "didn't throw" — but verify nothing
    // leaked into storage with a synthesized key.
    expect(window.sessionStorage.length).toBe(0);
  });

  it('survives sessionStorage throwing on read', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = vi.fn(() => {
      throw new Error('quota / blocked');
    });
    try {
      expect(readActiveFetchJobId(7)).toBeNull();
    } finally {
      Storage.prototype.getItem = original;
    }
  });

  it('survives sessionStorage throwing on write', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('quota exceeded');
    });
    try {
      // Must NOT throw.
      writeActiveFetchJobId(7, 'fetch_tenant_7');
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
