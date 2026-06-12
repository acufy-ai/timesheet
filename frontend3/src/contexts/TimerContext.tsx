import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { clearTimerState, defaultTimerState, getTimerState, setTimerState, type TimerState } from '@/lib/timerDB';
import { notifyServiceWorker, pingServiceWorker } from '@/lib/registerTimerSW';

export interface TimerContextValue {
  status: 'idle' | 'running' | 'paused' | 'stopped';
  elapsedMs: number;
  startTimestamp: number | null;
  accumulatedMs: number;
  projectId: number | null;
  taskId: number | null;
  notes: string;
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  discard: () => void;
  setProject: (id: number | null) => void;
  setTask: (id: number | null) => void;
  setNotes: (n: string) => void;
}

export const TimerContext = createContext<TimerContextValue | null>(null);

// Live time-tracking timer. Durable in IndexedDB (timerDB), kept alive across a
// backgrounded tab by a service worker, and synced across tabs via a
// BroadcastChannel. Ported from frontend2/src/contexts/TimerContext.tsx.
export function TimerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TimerState>({ ...defaultTimerState, lastUpdated: 0 });
  const [elapsedMs, setElapsedMs] = useState(0);
  const bcRef = useRef<BroadcastChannel | null>(null);
  const stateRef = useRef(state);

  const broadcastState = useCallback((newState: TimerState) => {
    bcRef.current?.postMessage({ type: 'SYNC_STATE', state: newState });
  }, []);

  useEffect(() => {
    bcRef.current = new BroadcastChannel('acufy_timer');
    bcRef.current.onmessage = (event) => {
      if (event.data?.type === 'SYNC_STATE') setState(event.data.state);
    };

    (async () => {
      const stored = await getTimerState();
      let newElapsedMs = stored.accumulatedMs;
      if (stored.status === 'running' && stored.startTimestamp) {
        try {
          const swRes = await pingServiceWorker();
          newElapsedMs = swRes.elapsedMs;
        } catch {
          newElapsedMs = stored.accumulatedMs + (Date.now() - stored.startTimestamp);
        }
      }
      setState(stored);
      setElapsedMs(newElapsedMs);
    })();

    return () => bcRef.current?.close();
  }, []);

  // Tick the displayed elapsed time off rAF while running.
  useEffect(() => {
    let frameId: number;
    let lastUpdate = 0;
    function tick(timestamp: number) {
      if (timestamp - lastUpdate > 16) {
        if (state.status === 'running' && state.startTimestamp) {
          setElapsedMs(state.accumulatedMs + (Date.now() - state.startTimestamp));
        } else if (state.status !== 'running') {
          setElapsedMs(state.accumulatedMs);
        }
        lastUpdate = timestamp;
      }
      frameId = requestAnimationFrame(tick);
    }
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [state.status, state.startTimestamp, state.accumulatedMs]);

  useEffect(() => { stateRef.current = state; }, [state]);

  const updateState = useCallback(async (patch: Partial<TimerState>) => {
    const newState = { ...stateRef.current, ...patch, lastUpdated: Date.now() };
    setState(newState);
    stateRef.current = newState;
    await setTimerState(patch);
    broadcastState(newState);
  }, [broadcastState]);

  const start = useCallback(async () => {
    const now = Date.now();
    await updateState({ status: 'running', startTimestamp: now, accumulatedMs: 0 });
    notifyServiceWorker('TIMER_START', { startTimestamp: now, accumulatedMs: 0 });
  }, [updateState]);

  const pause = useCallback(async () => {
    const s = stateRef.current;
    const addMs = s.startTimestamp ? Date.now() - s.startTimestamp : 0;
    await updateState({ status: 'paused', startTimestamp: null, accumulatedMs: s.accumulatedMs + addMs });
    notifyServiceWorker('TIMER_PAUSE');
  }, [updateState]);

  const resume = useCallback(async () => {
    const now = Date.now();
    const s = stateRef.current;
    await updateState({ status: 'running', startTimestamp: now });
    notifyServiceWorker('TIMER_RESUME', { startTimestamp: now, accumulatedMs: s.accumulatedMs });
  }, [updateState]);

  const stop = useCallback(async () => {
    const s = stateRef.current;
    let acc = s.accumulatedMs;
    if (s.status === 'running' && s.startTimestamp) acc += Date.now() - s.startTimestamp;
    await updateState({ status: 'stopped', startTimestamp: null, accumulatedMs: acc });
    notifyServiceWorker('TIMER_STOP');
  }, [updateState]);

  const discard = useCallback(async () => {
    await clearTimerState();
    const empty: TimerState = { ...defaultTimerState, lastUpdated: Date.now() };
    setState(empty);
    setElapsedMs(0);
    broadcastState(empty);
    notifyServiceWorker('TIMER_STOP');
  }, [broadcastState]);

  const setProject = useCallback((id: number | null) => { void updateState({ projectId: id }); }, [updateState]);
  const setTask = useCallback((id: number | null) => { void updateState({ taskId: id }); }, [updateState]);
  const setNotes = useCallback((notes: string) => { void updateState({ notes }); }, [updateState]);

  const value: TimerContextValue = {
    status: state.status,
    elapsedMs,
    startTimestamp: state.startTimestamp,
    accumulatedMs: state.accumulatedMs,
    projectId: state.projectId,
    taskId: state.taskId,
    notes: state.notes,
    start, pause, resume, stop, discard, setProject, setTask, setNotes,
  };

  return <TimerContext.Provider value={value}>{children}</TimerContext.Provider>;
}
