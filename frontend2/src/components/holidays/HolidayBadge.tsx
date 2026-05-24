import React from 'react';
import type { Holiday } from '@/types';

type BadgeVariant = 'cell' | 'row';

interface Props {
  holiday: Holiday;
  variant?: BadgeVariant;
}

const TYPE_CLASSES: Record<Holiday['holiday_type'], string> = {
  PUBLIC: 'bg-rose-500/15 text-rose-400 border-rose-500/20',
  COMPANY: 'bg-violet-500/15 text-violet-400 border-violet-500/20',
};

/** Calendar-cell badge ("🎉 Memorial Day") and detail-row pill share
 *  the same colour treatment; only the surrounding container differs. */
export const HolidayBadge: React.FC<Props> = ({ holiday, variant = 'cell' }) => {
  const palette = TYPE_CLASSES[holiday.holiday_type];
  if (variant === 'cell') {
    return (
      <div
        className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-md border mb-1 truncate ${palette}`}
        title={`${holiday.name} (${holiday.holiday_type.toLowerCase()} holiday)`}
      >
        🎉 {holiday.name}
      </div>
    );
  }
  return (
    <div className={`rounded-xl px-4 py-3 border ${palette}`}>
      <p className="text-sm font-semibold">🎉 {holiday.name}</p>
      <p className="text-xs opacity-70 capitalize">
        {holiday.holiday_type.toLowerCase()} holiday
      </p>
    </div>
  );
};
