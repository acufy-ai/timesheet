import React, { useState } from 'react';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  parseISO,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';

interface DatePickerSingleProps {
  value: string;
  onChange: (date: string) => void;
  min?: string;
  max?: string;
  placeholder?: string;
  required?: boolean;
  className?: string;
}

export const DatePickerSingle: React.FC<DatePickerSingleProps> = ({
  value,
  onChange,
  min,
  max,
  placeholder = 'Select date',
  className = '',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [currentMonth, setCurrentMonth] = useState<Date>(value ? parseISO(value) : new Date());

  const selected = value ? parseISO(value) : null;
  const minDate = min ? parseISO(min) : null;
  const maxDate = max ? parseISO(max) : null;

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const gridStart = startOfWeek(monthStart);
  const gridEnd = endOfWeek(monthEnd);
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });

  const isOutOfBounds = (day: Date) => {
    if (minDate && day < minDate) return true;
    if (maxDate && day > maxDate) return true;
    return false;
  };

  const handleDayClick = (day: Date) => {
    if (isOutOfBounds(day) || !isSameMonth(day, currentMonth)) return;
    onChange(format(day, 'yyyy-MM-dd'));
    setIsOpen(false);
  };

  const handleToggleOpen = () => {
    if (!isOpen && selected) setCurrentMonth(selected);
    setIsOpen((prev) => !prev);
  };

  const displayLabel = selected ? format(selected, 'EEE, MMM d, yyyy') : placeholder;

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={handleToggleOpen}
        className="field-input flex items-center gap-2 text-left"
      >
        <Calendar className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className={selected ? '' : 'text-muted-foreground'}>{displayLabel}</span>
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute z-50 top-full mt-2 left-0 bg-card border rounded-lg shadow-lg p-4 min-w-max">
            <div className="flex items-center justify-between mb-3">
              <button
                type="button"
                onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
                className="p-1 hover:bg-muted rounded"
                aria-label="Previous month"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <h3 className="text-sm font-semibold min-w-[140px] text-center">
                {format(currentMonth, 'MMMM yyyy')}
              </h3>
              <button
                type="button"
                onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
                className="p-1 hover:bg-muted rounded"
                aria-label="Next month"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-7 gap-1 mb-2">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                <div
                  key={day}
                  className="text-center text-xs font-medium text-muted-foreground w-8"
                >
                  {day}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {days.map((day) => {
                const isFromThisMonth = isSameMonth(day, currentMonth);
                const isSelected = selected ? isSameDay(day, selected) : false;
                const isTodayFlag = isToday(day);
                const disabled = !isFromThisMonth || isOutOfBounds(day);
                return (
                  <button
                    key={day.toISOString()}
                    type="button"
                    onClick={() => handleDayClick(day)}
                    disabled={disabled}
                    className={`
                      w-8 h-8 text-xs rounded transition
                      ${!isFromThisMonth && 'text-muted-foreground/40'}
                      ${isSelected && 'bg-primary text-primary-foreground font-bold'}
                      ${isTodayFlag && !isSelected && 'border border-primary'}
                      ${!isSelected && isFromThisMonth && !isOutOfBounds(day) && 'hover:bg-muted'}
                      ${disabled && 'cursor-not-allowed opacity-50'}
                    `}
                  >
                    {format(day, 'd')}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
