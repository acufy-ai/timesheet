import React from 'react';
import type { Holiday } from '@/types';
import { HolidayBadge } from './HolidayBadge';

interface Props {
  holiday: Holiday;
  canManage: boolean;
  onDelete?: (id: number) => void;
}

/** Used inside the day-detail panel: holiday card with an optional
 *  Remove button (admin-only). */
export const HolidayDetailRow: React.FC<Props> = ({ holiday, canManage, onDelete }) => {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1">
        <HolidayBadge holiday={holiday} variant="row" />
      </div>
      {canManage && onDelete && (
        <button
          type="button"
          onClick={() => onDelete(holiday.id)}
          className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-muted font-medium transition"
        >
          Remove
        </button>
      )}
    </div>
  );
};
