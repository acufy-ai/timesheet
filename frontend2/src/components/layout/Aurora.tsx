import React, { useEffect, useRef, useState } from 'react';

// Acufy v2 aurora backdrop: three drifting color blobs + a soft mouse-tracked
// spotlight (handled by #bgAurora::after in index.css). The blobs derive
// their colors from the active theme's --violet-2 / --magenta / --violet
// tokens so they retint per Acufy theme automatically.
//
// Rendered as a fixed-position, pointer-events:none, z-index:0 element so
// the entire authenticated shell sits on top of it without any layout
// changes to AppLayout / TopNavBar / Sidebar.
export const Aurora: React.FC = () => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [isFine, setIsFine] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 901px)');
    setIsFine(mq.matches);
    const u = () => setIsFine(mq.matches);
    mq.addEventListener('change', u);
    return () => mq.removeEventListener('change', u);
  }, []);

  useEffect(() => {
    if (!isFine) return;
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let tx = 0.5, ty = 0.5, cx = 0.5, cy = 0.5;
    let dirty = false;

    const onMove = (e: MouseEvent) => {
      tx = e.clientX / window.innerWidth;
      ty = e.clientY / window.innerHeight;
      dirty = true;
    };
    const loop = () => {
      if (dirty || Math.abs(tx - cx) > 0.001 || Math.abs(ty - cy) > 0.001) {
        cx += (tx - cx) * 0.05;
        cy += (ty - cy) * 0.05;
        el.style.setProperty('--mx', `${cx * 100}%`);
        el.style.setProperty('--my', `${cy * 100}%`);
        dirty = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove);
    };
  }, [isFine]);

  return (
    <div id="bgAurora" ref={ref} aria-hidden>
      <div
        className="aurora-blob aurora-blob-1"
        style={{
          left: '-12%', top: '-8%',
          height: '50vmax', width: '50vmax',
          background: 'radial-gradient(circle, var(--violet-2) 0%, transparent 60%)',
          opacity: 0.35,
        }}
      />
      <div
        className="aurora-blob aurora-blob-2"
        style={{
          right: '-18%', top: '8%',
          height: '55vmax', width: '55vmax',
          background: 'radial-gradient(circle, var(--magenta) 0%, transparent 60%)',
          opacity: 0.28,
        }}
      />
      <div
        className="aurora-blob aurora-blob-3"
        style={{
          left: '8%', bottom: '-18%',
          height: '45vmax', width: '45vmax',
          background: 'radial-gradient(circle, var(--violet) 0%, transparent 60%)',
          opacity: 0.22,
        }}
      />
      {/* Soft vignette so the blobs fade into the app surface */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 0%, color-mix(in srgb, hsl(var(--background)) 55%, transparent) 60%, color-mix(in srgb, hsl(var(--background)) 92%, transparent) 100%)',
        }}
      />
    </div>
  );
};
