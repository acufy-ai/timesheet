import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { EmployeeMultiSelectPicker } from './EmployeeMultiSelectPicker';
import type { User } from '@/types';

const mkEmployee = (id: number, name: string): User => ({
  id,
  email: `${name.toLowerCase().replace(/ /g, '.')}@example.io`,
  username: name.toLowerCase().replace(/ /g, ''),
  full_name: name,
  role: 'EMPLOYEE',
  is_active: true,
  has_changed_password: true,
  email_verified: true,
  tenant_id: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

const EMPLOYEES = [
  mkEmployee(1, 'Alice Apple'),
  mkEmployee(2, 'Bob Banana'),
  mkEmployee(3, 'Carol Cherry'),
];

describe('EmployeeMultiSelectPicker', () => {
  it('shows "All employees" label when nothing is selected', () => {
    render(
      <EmployeeMultiSelectPicker
        allEmployees={EMPLOYEES}
        selectedIds={[]}
        onChange={vi.fn()}
        open={false}
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByText('All employees')).toBeInTheDocument();
  });

  it('shows the single employee name when one is selected', () => {
    render(
      <EmployeeMultiSelectPicker
        allEmployees={EMPLOYEES}
        selectedIds={[2]}
        onChange={vi.fn()}
        open={false}
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Bob Banana')).toBeInTheDocument();
  });

  it('shows the count when multiple are selected', () => {
    render(
      <EmployeeMultiSelectPicker
        allEmployees={EMPLOYEES}
        selectedIds={[1, 3]}
        onChange={vi.fn()}
        open={false}
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByText('2 employees')).toBeInTheDocument();
  });

  it('toggles an employee when a row is clicked while open', () => {
    const onChange = vi.fn();
    render(
      <EmployeeMultiSelectPicker
        allEmployees={EMPLOYEES}
        selectedIds={[]}
        onChange={onChange}
        open={true}
        onOpenChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Bob Banana'));
    expect(onChange).toHaveBeenCalledWith([2]);
  });

  it('removes an employee when a selected row is clicked again', () => {
    const onChange = vi.fn();
    render(
      <EmployeeMultiSelectPicker
        allEmployees={EMPLOYEES}
        selectedIds={[1, 2]}
        onChange={onChange}
        open={true}
        onOpenChange={vi.fn()}
      />,
    );
    // Click Bob (id 2) — should drop to [1].
    fireEvent.click(screen.getByText('Bob Banana'));
    expect(onChange).toHaveBeenCalledWith([1]);
  });

  it('Clear button empties the selection', () => {
    const onChange = vi.fn();
    render(
      <EmployeeMultiSelectPicker
        allEmployees={EMPLOYEES}
        selectedIds={[1, 2]}
        onChange={onChange}
        open={true}
        onOpenChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Clear'));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
