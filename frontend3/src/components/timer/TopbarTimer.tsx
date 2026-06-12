import { Pause, Play, Square, Timer } from 'lucide-react';

import { formatElapsed, useTimer } from '@/hooks/useTimer';

// Top-bar timer control: a start button when idle, a live elapsed display with
// pause/stop while running, and resume/stop while paused. Stopping flips the
// timer to 'stopped', which the always-mounted LogEntryModal picks up to
// prompt for project/notes and create the time entry. Ported from frontend2.
export function TopbarTimer() {
  const { status, elapsedMs, start, pause, resume, stop } = useTimer();

  if (status === 'idle' || status === 'stopped') {
    return (
      <button
        type="button"
        onClick={start}
        title="Start live timer"
        aria-label="Start live timer"
        className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
      >
        <Timer className="h-4 w-4" />
      </button>
    );
  }

  if (status === 'running') {
    return (
      <div className="flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1">
        <span className="font-mono text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-300">{formatElapsed(elapsedMs)}</span>
        <button type="button" onClick={pause} title="Pause" aria-label="Pause timer" className="text-emerald-600 hover:opacity-80 dark:text-emerald-300"><Pause className="h-4 w-4 fill-current" /></button>
        <button type="button" onClick={stop} title="Stop" aria-label="Stop timer" className="text-rose-600 hover:opacity-80 dark:text-rose-400"><Square className="h-4 w-4 fill-current" /></button>
      </div>
    );
  }

  // paused
  return (
    <div className="flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1">
      <span className="font-mono text-sm font-bold tabular-nums text-amber-600 opacity-80 dark:text-amber-300">{formatElapsed(elapsedMs)}</span>
      <button type="button" onClick={resume} title="Resume" aria-label="Resume timer" className="text-amber-600 hover:opacity-80 dark:text-amber-300"><Play className="h-4 w-4 fill-current" /></button>
      <button type="button" onClick={stop} title="Stop" aria-label="Stop timer" className="text-rose-600 hover:opacity-80 dark:text-rose-400"><Square className="h-4 w-4 fill-current" /></button>
    </div>
  );
}
