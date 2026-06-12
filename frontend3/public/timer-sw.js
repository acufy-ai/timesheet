// Timer service worker.
//
// Keeps timer state alive in the service-worker scope so the running
// elapsedMs survives a backgrounded / throttled tab. The page's
// requestAnimationFrame loop pauses when the tab loses focus, which
// would make the UI clock drift; this worker is the source of truth
// the UI rebuilds from on focus / reload.
//
// Protocol (defined by frontend2/src/lib/registerTimerSW.ts):
//
//   page -> sw  { type: 'TIMER_PING' }          via MessageChannel port
//   sw -> page  { type: 'TIMER_PONG', elapsedMs, status }
//
//   page -> sw  { type: 'TIMER_START', startTimestamp, accumulatedMs }
//   page -> sw  { type: 'TIMER_PAUSE' }
//   page -> sw  { type: 'TIMER_RESUME', startTimestamp, accumulatedMs }
//   page -> sw  { type: 'TIMER_STOP' }
//
// State lives in memory on the SW. A service worker can be terminated
// by the browser when idle; on the next event it restarts with empty
// state. That's fine — the page's IndexedDB copy (lib/timerDB) is the
// durable record and seeds the SW back on the next TIMER_START or
// TIMER_RESUME message.

const STATE = {
  status: 'idle', // 'idle' | 'running' | 'paused' | 'stopped'
  startTimestamp: null,
  accumulatedMs: 0,
};

function currentElapsed() {
  if (STATE.status === 'running' && typeof STATE.startTimestamp === 'number') {
    return STATE.accumulatedMs + (Date.now() - STATE.startTimestamp);
  }
  return STATE.accumulatedMs;
}

self.addEventListener('install', (event) => {
  // Activate as soon as install finishes. The page registers the worker
  // on every load, so a deploy that ships a new timer-sw.js takes effect
  // on the next page load instead of after a tab close.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event && event.data;
  if (!data || typeof data !== 'object') return;

  switch (data.type) {
    case 'TIMER_PING': {
      // Reply via the MessageChannel port if provided, otherwise via
      // the source client. The page uses MessageChannel so prefer that.
      const reply = {
        type: 'TIMER_PONG',
        elapsedMs: currentElapsed(),
        status: STATE.status,
      };
      const port = event.ports && event.ports[0];
      if (port) {
        port.postMessage(reply);
      } else if (event.source && typeof event.source.postMessage === 'function') {
        event.source.postMessage(reply);
      }
      return;
    }
    case 'TIMER_START': {
      STATE.status = 'running';
      STATE.startTimestamp = typeof data.startTimestamp === 'number'
        ? data.startTimestamp
        : Date.now();
      STATE.accumulatedMs = typeof data.accumulatedMs === 'number'
        ? data.accumulatedMs
        : 0;
      return;
    }
    case 'TIMER_PAUSE': {
      STATE.accumulatedMs = currentElapsed();
      STATE.status = 'paused';
      STATE.startTimestamp = null;
      return;
    }
    case 'TIMER_RESUME': {
      // Page sends the authoritative {startTimestamp, accumulatedMs}
      // so we don't double-count if the SW was terminated and reloaded
      // without state.
      STATE.status = 'running';
      STATE.startTimestamp = typeof data.startTimestamp === 'number'
        ? data.startTimestamp
        : Date.now();
      if (typeof data.accumulatedMs === 'number') {
        STATE.accumulatedMs = data.accumulatedMs;
      }
      return;
    }
    case 'TIMER_STOP': {
      STATE.accumulatedMs = currentElapsed();
      STATE.status = 'stopped';
      STATE.startTimestamp = null;
      return;
    }
    default:
      return;
  }
});
