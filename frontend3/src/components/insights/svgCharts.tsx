// Lightweight inline-SVG chart primitives (no chart library). Theme-aware via
// CSS vars / passed colors. Used by the dashboard chart widgets.

export interface Slice { label: string; value: number; color: string }

// Donut: proportional ring. `colorClass` strings are tailwind text-* so the SVG
// strokes inherit theme colors via currentColor per segment.
export function Donut({ slices, size = 140, thickness = 18 }: { slices: Slice[]; size?: number; thickness?: number }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <circle cx={cx} cy={cx} r={r} fill="none" stroke="currentColor" strokeWidth={thickness} className="text-muted/40" />
        {total > 0 && slices.map((s) => {
          const frac = s.value / total;
          const dash = frac * c;
          const el = (
            <circle key={s.label} cx={cx} cy={cx} r={r} fill="none" stroke={s.color} strokeWidth={thickness}
              strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={-offset}
              transform={`rotate(-90 ${cx} ${cx})`} strokeLinecap="butt" />
          );
          offset += dash;
          return el;
        })}
        <text x={cx} y={cx} textAnchor="middle" dominantBaseline="central" className="fill-foreground text-lg font-bold">{total}</text>
      </svg>
      <ul className="space-y-1 text-xs">
        {slices.filter((s) => s.value > 0).map((s) => (
          <li key={s.label} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
            <span className="text-muted-foreground">{s.label}</span>
            <span className="ml-auto font-semibold tabular-nums text-foreground">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface Bar { label: string; value: number; sub?: string }

// Horizontal bars, sorted as given. Width scaled to the max value.
export function Bars({ bars, color = 'hsl(var(--primary))', format }: { bars: Bar[]; color?: string; format?: (v: number) => string }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <ul className="space-y-2">
      {bars.map((b) => (
        <li key={b.label}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="min-w-0 truncate text-foreground" title={b.label}>{b.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{format ? format(b.value) : b.value}{b.sub ? ` · ${b.sub}` : ''}</span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full" style={{ width: `${(b.value / max) * 100}%`, background: color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface Point { label: string; value: number }

// Simple line chart over a series. SVG polyline; area fill under it.
export function Line({ points, height = 120, color = 'hsl(var(--primary))', format }: { points: Point[]; height?: number; color?: string; format?: (v: number) => string }) {
  if (points.length < 2) return <p className="py-6 text-center text-xs text-muted-foreground">Not enough data.</p>;
  const W = 100; const H = height;
  const max = Math.max(...points.map((p) => p.value));
  const min = Math.min(...points.map((p) => p.value));
  const span = max - min || 1;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - ((v - min) / span) * (H - 12) - 6;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.value)}`).join(' ');
  const area = `${path} L ${W} ${H} L 0 ${H} Z`;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-28 w-full">
        <path d={area} fill={color} opacity={0.12} />
        <path d={path} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{points[0].label}</span>
        <span className="tabular-nums">{format ? format(max) : max} peak</span>
        <span>{points[points.length - 1].label}</span>
      </div>
    </div>
  );
}
