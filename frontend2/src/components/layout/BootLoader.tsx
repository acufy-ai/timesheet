import React, { useEffect, useState } from 'react';

// First-paint loader for slow auth bootstrap, intentionally a brand
// moment rather than a generic spinner. Mirrors the v2 site's Loader
// (Acufy v2 components/Loader.tsx) — counts up 00->99% with the `%` sign
// in italic Instrument Serif, then fades. Use only for the initial
// AuthContext hydration; for in-app spinners, keep using <Loading />.
//
// Counter is decorative — the actual auth restore completes when it
// completes; the counter just runs until it does. We freeze at 99% if
// the restore is still pending when the count reaches 99%.

interface BootLoaderProps {
  message?: string;
}

export const BootLoader: React.FC<BootLoaderProps> = ({ message = 'Initialising Acufy AI' }) => {
  const [count, setCount] = useState(0);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let n = 0;
    const t = window.setInterval(() => {
      // Always leave headroom — never hit 100 while we're still mounted,
      // since the parent will swap us out when auth restore completes.
      n += Math.max(2, Math.floor(Math.random() * 9));
      if (n >= 99) n = 99;
      setCount(n);
    }, 48);
    return () => {
      window.clearInterval(t);
      // Brief fade-out when unmounting, in case the parent swap is jarring.
      setGone(true);
    };
  }, []);

  return (
    <div
      className={`fixed inset-0 z-[200] flex flex-col items-center justify-center gap-4 bg-background transition-opacity duration-300 ${
        gone ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex items-baseline gap-1 leading-none text-foreground">
        <span style={{ fontSize: 120, fontWeight: 300, letterSpacing: '-0.04em' }}>
          {String(count).padStart(2, '0')}
        </span>
        <span className="em-serif" style={{ fontSize: 96, fontWeight: 500 }}>
          %
        </span>
      </div>
      <div className="mono-label text-muted-foreground">{message}</div>
    </div>
  );
};
