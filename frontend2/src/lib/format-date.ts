import { format as dfFormat, parseISO } from 'date-fns';

type DateInput = Date | string;

const toDate = (value: DateInput): Date =>
  typeof value === 'string' ? parseISO(value) : value;

// Mon, May 10. Use in tables, list rows, and small inline date displays.
export const fmtShort = (value: DateInput): string =>
  dfFormat(toDate(value), 'EEE, MMM d');

// Mon, May 10, 2026. Use in section headers and detail views where the year matters.
export const fmtLong = (value: DateInput): string =>
  dfFormat(toDate(value), 'EEE, MMM d, yyyy');

// May 10 to May 16, 2026. Use for date-range labels.
export const fmtRange = (start: DateInput, end: DateInput): string => {
  const s = toDate(start);
  const e = toDate(end);
  const sameYear = s.getFullYear() === e.getFullYear();
  return sameYear
    ? `${dfFormat(s, 'MMM d')} – ${dfFormat(e, 'MMM d, yyyy')}`
    : `${dfFormat(s, 'MMM d, yyyy')} – ${dfFormat(e, 'MMM d, yyyy')}`;
};

// Friday, May 17. Use for greetings and day-name emphasis.
export const fmtGreeting = (value: DateInput): string =>
  dfFormat(toDate(value), 'EEEE, MMM d');

// 2026-05-17T14:32:00.000Z. Reserved for technical surfaces only (audit logs, sync metadata).
export const fmtIso = (value: DateInput): string => toDate(value).toISOString();
