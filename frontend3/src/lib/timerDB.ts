// Durable timer state in IndexedDB. Native API (no `idb` dependency) — one
// object store with a single 'current' record. This is the source of truth the
// UI and the service worker rebuild from on reload / focus. Ported from
// frontend2/src/lib/timerDB.ts.

export interface TimerState {
  id: 'current';
  status: 'idle' | 'running' | 'paused' | 'stopped';
  startTimestamp: number | null;
  accumulatedMs: number;
  projectId: number | null;
  taskId: number | null;
  notes: string;
  lastUpdated: number;
}

const DB_NAME = 'acufy_timer_db';
const DB_VERSION = 1;
const STORE = 'timer_state';

export const defaultTimerState: TimerState = {
  id: 'current',
  status: 'idle',
  startTimestamp: null,
  accumulatedMs: 0,
  projectId: null,
  taskId: null,
  notes: '',
  lastUpdated: 0,
};

function openTimerDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getTimerState(): Promise<TimerState> {
  try {
    const db = await openTimerDB();
    return await new Promise<TimerState>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get('current');
      req.onsuccess = () => resolve((req.result as TimerState) ?? { ...defaultTimerState, lastUpdated: Date.now() });
      req.onerror = () => resolve({ ...defaultTimerState, lastUpdated: Date.now() });
    });
  } catch {
    return { ...defaultTimerState, lastUpdated: Date.now() };
  }
}

export async function setTimerState(patch: Partial<TimerState>): Promise<void> {
  try {
    const db = await openTimerDB();
    const current = await getTimerState();
    const next: TimerState = { ...current, ...patch, id: 'current', lastUpdated: Date.now() };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(next);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* IndexedDB unavailable (private mode etc.) — state stays in-memory only */
  }
}

export async function clearTimerState(): Promise<void> {
  await setTimerState({ ...defaultTimerState });
}
