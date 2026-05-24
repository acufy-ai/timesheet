// Small formatters shared by My Time + Approvals so the same time
// blocks render identically across both surfaces. Kept dependency-free
// (no date-fns) so they're trivially testable and safe to import from
// anywhere.

/**
 * Display ``HH:MM`` or ``HH:MM:SS`` as ``h:mm AM/PM``. Returns ``null``
 * when the input is nullish or unparseable so callers can decide what
 * to render (e.g. a dash, or omit the affordance entirely).
 */
export function formatTime12h(value: string | null | undefined): string | null {
  if (!value) return null;
  const [hStr, mStr] = value.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const period = h < 12 ? 'AM' : 'PM';
  const hour12 = ((h + 11) % 12) + 1;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

/**
 * Render an entry's start/end pair as a single readable block,
 * e.g. ``8:00 AM – 10:00 AM``. Returns ``null`` if either side is
 * missing — partially-filled blocks aren't a useful approval signal
 * so we suppress them rather than render half a span.
 */
export function formatTimeBlock(
  start: string | null | undefined,
  end: string | null | undefined,
): string | null {
  const s = formatTime12h(start);
  const e = formatTime12h(end);
  if (!s || !e) return null;
  return `${s} – ${e}`;
}
