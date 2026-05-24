import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HolidayBadge } from './HolidayBadge';
import type { Holiday } from '@/types';

const mk = (overrides: Partial<Holiday> = {}): Holiday => ({
  id: 1,
  tenant_id: 1,
  date: '2026-12-25',
  name: 'Christmas Day',
  holiday_type: 'PUBLIC',
  country: 'US',
  created_by: 1,
  created_at: '2026-05-20T00:00:00Z',
  ...overrides,
});

describe('HolidayBadge', () => {
  it('renders the holiday name with a celebration emoji', () => {
    render(<HolidayBadge holiday={mk()} />);
    expect(screen.getByText(/Christmas Day/)).toBeInTheDocument();
  });

  it('applies the rose palette for PUBLIC holidays', () => {
    const { container } = render(<HolidayBadge holiday={mk({ holiday_type: 'PUBLIC' })} />);
    const node = container.firstChild as HTMLElement;
    expect(node.className).toMatch(/rose/);
  });

  it('applies the violet palette for COMPANY holidays', () => {
    const { container } = render(<HolidayBadge holiday={mk({ holiday_type: 'COMPANY' })} />);
    const node = container.firstChild as HTMLElement;
    expect(node.className).toMatch(/violet/);
  });

  it('switches to the row variant when requested', () => {
    render(<HolidayBadge holiday={mk({ name: 'Memorial Day' })} variant="row" />);
    expect(screen.getByText('🎉 Memorial Day')).toBeInTheDocument();
    expect(screen.getByText(/public holiday/i)).toBeInTheDocument();
  });
});
