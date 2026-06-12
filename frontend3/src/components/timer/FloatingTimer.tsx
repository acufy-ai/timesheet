import { useEffect, useRef, useState } from 'react';
import { GripHorizontal, Minus, Pause, Play, Square, X } from 'lucide-react';

import { formatElapsed, useTimer } from '@/hooks/useTimer';
import { useProjects } from '@/hooks/useTime';
import { cn } from '@/lib/cn';
import { LogEntryModal } from './LogEntryModal';

const POS_KEY = 'acufy:timer:float-pos';

// Draggable floating timer, visible whenever a timer is running or paused.
// Position persists in localStorage. Also mounts the LogEntryModal so the
// stop -> log flow is available app-wide. Ported from frontend2's FloatingTimer.
export function FloatingTimer() {
  const { status, elapsedMs, projectId, pause, resume, stop, discard } = useTimer();
  const projectsQ = useProjects();
  const [minimized, setMinimized] = useState(false);
  const [pos, setPos] = useState({ x: 24, y: 24 });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  // Restore saved position (clamped to the viewport).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        setPos({
          x: Math.max(0, Math.min(p.x ?? 24, window.innerWidth - 240)),
          y: Math.max(0, Math.min(p.y ?? 24, window.innerHeight - 120)),
        });
      } else {
        setPos({ x: window.innerWidth - 260, y: window.innerHeight - 150 });
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const next = {
        x: Math.max(0, Math.min(dragRef.current.ox + (e.clientX - dragRef.current.sx), window.innerWidth - 240)),
        y: Math.max(0, Math.min(dragRef.current.oy + (e.clientY - dragRef.current.sy), window.innerHeight - 80)),
      };
      setPos(next);
    }
    function onUp() {
      if (dragRef.current) { try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* ignore */ } }
      dragRef.current = null;
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [pos]);

  const active = status === 'running' || status === 'paused';
  const projectName = (projectsQ.data ?? []).find((p) => p.id === projectId)?.name;

  return (
    <>
      {active ? (
        <div
          className="fixed z-[70] w-60 overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
          style={{ left: pos.x, top: pos.y }}
        >
          <div
            className="flex cursor-grab items-center justify-between border-b border-border bg-muted/40 px-3 py-1.5 active:cursor-grabbing"
            onMouseDown={(e) => { dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y }; }}
          >
            <GripHorizontal className="h-4 w-4 text-muted-foreground" />
            <span className={cn('text-[11px] font-semibold uppercase tracking-wide', status === 'running' ? 'text-emerald-600 dark:text-emerald-300' : 'text-amber-600 dark:text-amber-300')}>
              {status === 'running' ? 'Tracking' : 'Paused'}
            </span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setMinimized((v) => !v)} aria-label="Minimize" className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-foreground/10"><Minus className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={discard} aria-label="Discard timer" className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"><X className="h-3.5 w-3.5" /></button>
            </div>
          </div>
          {!minimized ? (
            <div className="p-3">
              <p className="font-mono text-2xl font-bold tabular-nums text-foreground">{formatElapsed(elapsedMs)}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{projectName ?? 'No project yet'}</p>
              <div className="mt-3 flex gap-2">
                {status === 'running' ? (
                  <button type="button" onClick={pause} className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-border py-1.5 text-xs font-medium hover:bg-foreground/5"><Pause className="h-3.5 w-3.5" /> Pause</button>
                ) : (
                  <button type="button" onClick={resume} className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-border py-1.5 text-xs font-medium hover:bg-foreground/5"><Play className="h-3.5 w-3.5" /> Resume</button>
                )}
                <button type="button" onClick={stop} className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-rose-500 py-1.5 text-xs font-medium text-white hover:bg-rose-600"><Square className="h-3.5 w-3.5" /> Stop</button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Always mounted; renders itself only when status === 'stopped'. */}
      <LogEntryModal />
    </>
  );
}
