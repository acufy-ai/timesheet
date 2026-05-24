import React from 'react';

interface SparkBarProps {
  values: number[];
  width?: number;
  height?: number;
  label?: string;
}

// Small inline SVG bar chart for compact row-level trends.
// Renders bars proportional to max(values). Zero values render as a 1px baseline tick.
export const SparkBar: React.FC<SparkBarProps> = ({
  values,
  width = 80,
  height = 24,
  label,
}) => {
  if (!values.length) {
    return <span className="text-muted-foreground/60 text-xs">N/A</span>;
  }
  const max = Math.max(...values, 0.0001);
  const gap = 1;
  const barWidth = Math.max(2, (width - gap * (values.length - 1)) / values.length);
  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={label ?? `Trend across ${values.length} buckets`}
      className="text-primary"
    >
      {values.map((v, i) => {
        const ratio = v > 0 ? v / max : 0;
        const barHeight = v > 0 ? Math.max(2, ratio * height) : 1;
        const x = i * (barWidth + gap);
        const y = height - barHeight;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barWidth}
            height={barHeight}
            rx={1}
            fill={v > 0 ? 'currentColor' : 'hsl(var(--muted-foreground) / 0.3)'}
          />
        );
      })}
    </svg>
  );
};
