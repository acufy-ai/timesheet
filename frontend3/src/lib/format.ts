// Shared formatters. Kept tiny and dependency-free so any surface (dashboard
// tiles, report views, future shareable report routes) renders numbers the
// same way.

/** Compact money: $1.2k / $3M for large values, exact for small. */
export function fmtMoney(value: string | number | null | undefined, currency = 'USD'): string {
  const n = Number(value ?? 0);
  const sym = currency === 'USD' ? '$' : `${currency} `;
  if (Math.abs(n) >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1_000) return `${sym}${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return `${sym}${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** Full money, no compacting — for report tables where exact figures matter. */
export function fmtMoneyExact(value: string | number | null | undefined, currency = 'USD'): string {
  const n = Number(value ?? 0);
  const sym = currency === 'USD' ? '$' : `${currency} `;
  return `${sym}${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
