// Minimal date helpers for the timesheet week views. Monday-based weeks to
// match the deck (Mon–Sun). All functions operate on local time and use a
// YYYY-MM-DD wire format for the API. No external date library — these are the
// only operations the time pages need.

/** YYYY-MM-DD in local time (not UTC — avoids off-by-one near midnight). */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse a YYYY-MM-DD string to a local Date at midnight. */
export function fromISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Monday of the week containing `d`. */
export function startOfWeek(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (r.getDay() + 6) % 7; // Mon=0 … Sun=6
  r.setDate(r.getDate() - dow);
  return r;
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** The seven dates Mon–Sun for the week containing `d`. */
export function weekDays(d: Date): Date[] {
  const start = startOfWeek(d);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function isSameDay(a: Date, b: Date): boolean {
  return toISODate(a) === toISODate(b);
}

/** "May 31 – Jun 6, 2026" for a week starting at `start` (Mon). */
export function formatWeekRange(start: Date): string {
  const end = addDays(start, 6);
  const sM = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const eM = end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${sM} – ${eM}, ${end.getFullYear()}`;
}

/** "Mon · Jun 1" */
export function formatDayShort(d: Date): string {
  const wd = d.toLocaleDateString(undefined, { weekday: 'short' });
  const md = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${wd} · ${md}`;
}

/** "Friday, Jun 5" */
export function formatDayLong(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

/** "May 28" — short month + day, no weekday/year. Accepts an ISO date or
 * timestamp string; returns '' for nullish input so callers can skip it. */
export function formatDateShort(value: string | null | undefined): string {
  if (!value) return '';
  // Date-only ("YYYY-MM-DD") parses as local; timestamps ("...T...Z") as UTC.
  const d = value.length === 10 ? fromISODate(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Format a wire time string ("HH:MM" or "HH:MM:SS") as 12-hour clock
 * ("9:00 AM"). Returns null for nullish/blank input so callers can show a
 * placeholder. Mirrors frontend2's formatTime12h display contract.
 */
export function formatTime12h(value: string | null | undefined): string | null {
  if (!value) return null;
  const [hStr, mStr] = value.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/** Truncate "HH:MM:SS" to "HH:MM" for <input type="time">; '' for nullish. */
export function trimSeconds(value: string | null | undefined): string {
  if (!value) return '';
  return value.length >= 5 ? value.slice(0, 5) : value;
}

/** Coerce "HH:MM" to the wire "HH:MM:SS" the backend's time field expects. */
export function toApiTime(value: string): string {
  if (!value) return value;
  return value.length === 5 ? `${value}:00` : value;
}

/**
 * Hour difference for an end time after a start time, both "HH:MM". Does not
 * support wrapping past midnight (those belong to two days). Returns 0 on bad
 * input or non-positive spans.
 */
export function diffHours(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if (![sh, sm, eh, em].every(Number.isFinite)) return 0;
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (endMin <= startMin) return 0;
  return Math.round(((endMin - startMin) / 60) * 100) / 100;
}
