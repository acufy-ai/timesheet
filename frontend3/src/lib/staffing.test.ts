import { describe, expect, it } from 'vitest';
import { staffingPool } from './staffing';
import type { ManagedUser } from '@/types/admin';

// Minimal ManagedUser factory — only the fields staffingPool reads matter.
function u(partial: Partial<ManagedUser> & { id: number; full_name: string }): ManagedUser {
  return {
    email: `${partial.id}@example.com`,
    role: 'EMPLOYEE',
    is_active: true,
    ...partial,
  } as ManagedUser;
}

describe('staffingPool', () => {
  it('returns nobody when no eligible managers are given', () => {
    const users = [u({ id: 1, full_name: 'A', manager_id: 9 })];
    expect(staffingPool(users, { pmIds: [], clientPmIds: [], allowCrossTeam: false })).toEqual([]);
  });

  it('includes an employee reporting to the PM via legacy single manager_id', () => {
    const users = [
      u({ id: 1, full_name: 'Reports to 9', manager_id: 9 }),
      u({ id: 2, full_name: 'Reports to 8', manager_id: 8 }),
    ];
    const pool = staffingPool(users, { pmIds: [9], clientPmIds: [], allowCrossTeam: false });
    expect(pool.map((x) => x.id)).toEqual([1]);
  });

  it('includes a multi-manager employee when the PM is a NON-PRIMARY manager', () => {
    // Sophia reports to both 7 (primary) and 9 (secondary). PM is 9.
    const sophia = u({ id: 1, full_name: 'Sophia', manager_id: 7, manager_ids: [7, 9], primary_manager_id: 7 });
    const pool = staffingPool([sophia], { pmIds: [9], clientPmIds: [], allowCrossTeam: false });
    expect(pool.map((x) => x.id)).toEqual([1]);
  });

  it('still includes a multi-manager employee when the PM is their primary', () => {
    const sophia = u({ id: 1, full_name: 'Sophia', manager_id: 7, manager_ids: [7, 9], primary_manager_id: 7 });
    const pool = staffingPool([sophia], { pmIds: [7], clientPmIds: [], allowCrossTeam: false });
    expect(pool.map((x) => x.id)).toEqual([1]);
  });

  it('excludes an employee whose managers do not include any eligible PM', () => {
    const sophia = u({ id: 1, full_name: 'Sophia', manager_id: 7, manager_ids: [7, 9] });
    const pool = staffingPool([sophia], { pmIds: [5], clientPmIds: [], allowCrossTeam: false });
    expect(pool).toEqual([]);
  });

  it('widens to every client PM when cross-team staffing is on', () => {
    const sophia = u({ id: 1, full_name: 'Sophia', manager_id: 7, manager_ids: [7] });
    const other = u({ id: 2, full_name: 'Other', manager_id: 99, manager_ids: [99] });
    // PM list is empty, but cross-team uses clientPmIds (7 is a client PM).
    const pool = staffingPool([sophia, other], { pmIds: [], clientPmIds: [7], allowCrossTeam: true });
    expect(pool.map((x) => x.id)).toEqual([1]);
  });
});
