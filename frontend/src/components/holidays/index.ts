/**
 * Org-wide holidays component module.
 *
 * Self-contained: components consume the holiday hooks directly and
 * the API hooks invalidate the manager-team-overview query so the
 * "late" signal flips on holiday changes. To relocate this UI (e.g.
 * Settings → Workforce Setup → Holidays), import these symbols from
 * the new page — no logic changes required.
 */
export { HolidayBadge } from './HolidayBadge';
export { HolidayDetailRow } from './HolidayDetailRow';
export { AddHolidayModal } from './AddHolidayModal';
export {
  HolidayCountryFilter,
  HOLIDAY_COUNTRY_PREFERENCE_KEY,
} from './HolidayCountryFilter';
