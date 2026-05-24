import React, { useEffect, useState } from 'react';

// 2px theme-tinted gradient bar pinned to the very top of the viewport.
// Width tracks scroll-progress through the longest scrollable element.
// Pure CSS transform, no scroll-hijacking, no animation libraries.
// Respects prefers-reduced-motion (still updates, just without easing).
export const ScrollProgress: React.FC = () => {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      const value = max > 0 ? doc.scrollTop / max : 0;
      setProgress(Math.min(1, Math.max(0, value)));
    };
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        zIndex: 100,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          height: '100%',
          width: '100%',
          transformOrigin: 'left center',
          transform: `scaleX(${progress})`,
          transition: 'transform 80ms linear',
          background:
            'linear-gradient(90deg, hsl(var(--primary)) 0%, var(--accent-hover, hsl(var(--primary))) 100%)',
          boxShadow: '0 0 12px hsl(var(--primary) / 0.6)',
        }}
      />
    </div>
  );
};
