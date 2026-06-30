// Lightweight inline-SVG chart primitives (no chart library). Theme-aware via
// CSS vars / passed colors. Used by the dashboard chart widgets.
//
// Hovering any value (a donut segment/legend row, a bar, a line point) shows a
// small native tooltip with that item's label + formatted value, so a value
// explains itself — `title` on the element drives it, plus `tip` for richer
// per-item summaries the widgets can pass in.

import { Tooltip } from '@/components/ui';

export interface Slice { label: string; value: number; color?: string; tip?: React.ReactNode }

// Donut: proportional ring (or a full pie when `pie` is set). Hovering a segment
// or its legend row reveals the label + value (or a richer `tip`).
export function Donut({ slices, size = 140, thickness = 18, format = String, pie = false }: {
  slices: Slice[]; size?: number; thickness?: number; format?: (v: number) => string; pie?: boolean;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  // A pie is just a donut whose stroke is as thick as the radius (no hole).
  if (pie) thickness = size / 2;
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
            <circle key={s.label} cx={cx} cy={cx} r={r} fill="none" stroke={s.color ?? 'currentColor'} strokeWidth={thickness}
              strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={-offset}
              transform={`rotate(-90 ${cx} ${cx})`} strokeLinecap="butt" className="cursor-help">
              <title>{`${s.label}: ${format(s.value)}`}</title>
            </circle>
          );
          offset += dash;
          return el;
        })}
        {!pie ? <text x={cx} y={cx} textAnchor="middle" dominantBaseline="central" className="fill-foreground text-lg font-bold">{total}</text> : null}
      </svg>
      <ul className="space-y-1 text-xs">
        {slices.filter((s) => s.value > 0).map((s) => (
          <ValueRow key={s.label} tip={s.tip ?? `${s.label}: ${format(s.value)}`}>
            <li className="flex cursor-help items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color ?? 'currentColor' }} />
              <span className="text-muted-foreground">{s.label}</span>
              <span className="ml-auto font-semibold tabular-nums text-foreground">{format(s.value)}</span>
            </li>
          </ValueRow>
        ))}
      </ul>
    </div>
  );
}

// Wraps a value element so hovering it shows a per-item summary tooltip.
function ValueRow({ tip, children }: { tip: React.ReactNode; children: React.ReactNode }) {
  return <Tooltip label={tip} side="top" maxWidth={240}>{children}</Tooltip>;
}

export interface Bar { label: string; value: number; sub?: string; tip?: React.ReactNode }

// Horizontal bars, sorted as given. Width scaled to the max value. Hovering a
// row reveals its label + value (or a richer `tip`).
export function Bars({ bars, color = 'hsl(var(--primary))', format }: { bars: Bar[]; color?: string; format?: (v: number) => string }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const fmt = (v: number) => (format ? format(v) : String(v));
  return (
    <ul className="space-y-2">
      {bars.map((b) => (
        <ValueRow key={b.label} tip={b.tip ?? `${b.label}: ${fmt(b.value)}`}>
          <li className="cursor-help">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="min-w-0 truncate text-foreground">{b.label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{fmt(b.value)}{b.sub ? ` · ${b.sub}` : ''}</span>
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: `${(b.value / max) * 100}%`, background: color }} />
            </div>
          </li>
        </ValueRow>
      ))}
    </ul>
  );
}

// Vertical bars (columns). Heights scale to the max; labels sit beneath, value
// on top. Hovering a column reveals its label + value (or a richer `tip`).
export function Columns({ bars, color = 'hsl(var(--primary))', format }: { bars: Bar[]; color?: string; format?: (v: number) => string }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const fmt = (v: number) => (format ? format(v) : String(v));
  return (
    <div className="flex h-36 items-end gap-2">
      {bars.map((b) => (
        <ValueRow key={b.label} tip={b.tip ?? `${b.label}: ${fmt(b.value)}`}>
          <div className="flex min-w-0 flex-1 cursor-help flex-col items-center justify-end gap-1">
            <span className="text-[10px] tabular-nums text-muted-foreground">{fmt(b.value)}</span>
            <div className="w-full rounded-t-md" style={{ height: `${Math.max(4, (b.value / max) * 100)}%`, background: color }} />
            <span className="w-full truncate text-center text-[10px] text-muted-foreground" title={b.label}>{b.label}</span>
          </div>
        </ValueRow>
      ))}
    </div>
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
  const fmt = (v: number) => (format ? format(v) : String(v));
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-28 w-full">
        <path d={area} fill={color} opacity={0.12} />
        <path d={path} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {/* Hoverable point markers: each shows its label + value. */}
        {points.map((p, i) => (
          <circle key={`${p.label}-${i}`} cx={x(i)} cy={y(p.value)} r={2.5} fill={color}
            vectorEffect="non-scaling-stroke" className="cursor-help">
            <title>{`${p.label}: ${fmt(p.value)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{points[0].label}</span>
        <span className="tabular-nums">{fmt(max)} peak</span>
        <span>{points[points.length - 1].label}</span>
      </div>
    </div>
  );
}
