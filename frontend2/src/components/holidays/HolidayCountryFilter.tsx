import React from 'react';
import { Globe } from 'lucide-react';

import { useHolidayCountries, useMyPreferences, useUpdateMyPreferences } from '@/hooks';

const PREFERENCE_KEY = 'holiday_calendar_country';

interface Props {
  /** Called on each change so the parent can refresh dependent
   *  queries (e.g. ``useHolidays``) with the new country. */
  onChange?: (country: string | null) => void;
}

/** Per-user display filter — picks which country's public holidays
 *  show on the calendar. Org-wide holidays (country IS NULL on the
 *  row) always appear regardless of selection. The choice is
 *  persisted to ``users.preferences.holiday_calendar_country`` so
 *  the next login reuses the same view. */
export const HolidayCountryFilter: React.FC<Props> = ({ onChange }) => {
  const { data: countries } = useHolidayCountries();
  const { data: preferences } = useMyPreferences();
  const updatePrefs = useUpdateMyPreferences();

  const current = (preferences?.[PREFERENCE_KEY] as string | undefined) ?? '';

  // Don't render anything until there's something to choose from.
  // A tenant with no imported public-holiday rows (only manual
  // org-wide adds) doesn't need a country filter. Array guard also
  // protects against an error-body landing in cache (e.g. 401/403
  // returning a non-array payload).
  const safeCountries = Array.isArray(countries) ? countries : [];
  if (safeCountries.length === 0) return null;

  const handleChange = (value: string) => {
    const next = value || null;
    updatePrefs.mutate({ [PREFERENCE_KEY]: next });
    onChange?.(next);
  };

  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <Globe className="h-4 w-4 text-muted-foreground" />
      <span className="sr-only">Holiday country</span>
      <select
        value={current}
        onChange={(e) => handleChange(e.target.value)}
        className="px-3 py-1.5 rounded-lg border border-border bg-card text-sm focus:ring-1 focus:ring-primary focus:border-primary"
      >
        <option value="">All locations</option>
        {safeCountries.map((code) => (
          <option key={code} value={code}>{code}</option>
        ))}
      </select>
    </label>
  );
};

export { PREFERENCE_KEY as HOLIDAY_COUNTRY_PREFERENCE_KEY };
