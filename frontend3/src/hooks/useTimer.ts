import { useContext } from 'react';

import { TimerContext, type TimerContextValue } from '@/contexts/TimerContext';

export function useTimer(): TimerContextValue {
  const ctx = useContext(TimerContext);
  if (!ctx) throw new Error('useTimer must be used within a TimerProvider');
  return ctx;
}

// "1:23:45" when >= 1h, else "23:45".
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mStr = String(m).padStart(2, '0');
  const sStr = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mStr}:${sStr}` : `${mStr}:${sStr}`;
}
