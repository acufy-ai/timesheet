import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { HolidayCountryFilter } from './HolidayCountryFilter';

// Mock the data hooks so the component renders without a live API.
// useHolidayCountries returns the list, useMyPreferences returns the
// stored value, useUpdateMyPreferences records what got written.
const mutate = vi.fn();

vi.mock('@/hooks', async () => {
  return {
    useHolidayCountries: () => ({ data: ['IN', 'US'] }),
    useMyPreferences: () => ({ data: { holiday_calendar_country: 'US' } }),
    useUpdateMyPreferences: () => ({ mutate }),
  };
});

const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

beforeEach(() => {
  mutate.mockReset();
});

describe('HolidayCountryFilter', () => {
  it('lists each tenant country plus an All option', () => {
    wrap(<HolidayCountryFilter />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.text);
    expect(labels).toEqual(['All locations', 'IN', 'US']);
  });

  it('reflects the stored preference as the current value', () => {
    wrap(<HolidayCountryFilter />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('US');
  });

  it('writes the new country and fires onChange when the selection changes', () => {
    const onChange = vi.fn();
    wrap(<HolidayCountryFilter onChange={onChange} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'IN' } });
    expect(mutate).toHaveBeenCalledWith({ holiday_calendar_country: 'IN' });
    expect(onChange).toHaveBeenCalledWith('IN');
  });

  it('clears the preference when "All locations" is chosen', () => {
    wrap(<HolidayCountryFilter />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });
    expect(mutate).toHaveBeenCalledWith({ holiday_calendar_country: null });
  });
});
