import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalsPage } from './ApprovalsPage';
import type { TimeEntry } from '@/types';

/**
 * D-061 regression tests. The Pending tab body is now a
 * <PendingMasterDetail/> master-detail layout instead of the legacy
 * stacked employee+week cards. These tests pin the new rendering
 * contract: page title, tab strip, stat tiles, employee list, and
 * the right-side detail pane.
 *
 * Legacy assertions for "Filter by employee" / "Approve Week" /
 * "submitted entries" no longer apply — those affordances were
 * intentionally retired by the redesign and are covered by the
 * dedicated unit tests in ``approvalsGrouping.test.ts`` instead.
 */

const hookMocks = vi.hoisted(() => ({
  usePendingApprovals: vi.fn(),
  useApprovalHistoryGrouped: vi.fn(),
  useApproveTimeEntryBatch: vi.fn(),
  useRejectTimeEntryBatch: vi.fn(),
  useRejectTimeEntry: vi.fn(),
  useRevertTimeEntryRejection: vi.fn(),
  usePendingTimeOffApprovals: vi.fn(),
  useApproveTimeOffRequest: vi.fn(),
  useRejectTimeOffRequest: vi.fn(),
  useWeekStartsOn: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock('@/hooks', () => hookMocks);

vi.mock('@/components', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/components');
  return {
    ...actual,
    Header: () => <div>Header</div>,
    Loading: () => <div>Loading</div>,
    Error: ({ message }: { message: string }) => <div>{message}</div>,
    EmptyState: ({ message }: { message: string }) => <div>{message}</div>,
    SearchInput: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    ),
  };
});

function makeEntry(over: Partial<TimeEntry>): TimeEntry {
  return {
    id: 1,
    user_id: 22,
    project_id: 101,
    task_id: null,
    entry_date: '2026-03-16',
    hours: '8',
    description: 'Pending',
    is_billable: true,
    status: 'SUBMITTED',
    submitted_at: '2026-03-16T12:00:00Z',
    approved_by: null,
    approved_at: null,
    rejection_reason: null,
    quickbooks_time_activity_id: null,
    created_at: '2026-03-16T08:00:00Z',
    updated_at: '2026-03-16T12:00:00Z',
    user: {
      id: 22,
      full_name: 'Employee One',
      email: 'employee@example.com',
    } as unknown as TimeEntry['user'],
    ...over,
  } as TimeEntry;
}

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ApprovalsPage (D-061 master-detail)', () => {
  beforeEach(() => {
    hookMocks.usePendingApprovals.mockReturnValue({
      data: [makeEntry({})],
      isLoading: false,
      error: null,
    });
    hookMocks.useApprovalHistoryGrouped.mockReturnValue({ data: [], isLoading: false, error: null });
    hookMocks.useApproveTimeEntryBatch.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    hookMocks.useRejectTimeEntryBatch.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    hookMocks.useRejectTimeEntry.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    hookMocks.useRevertTimeEntryRejection.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    hookMocks.usePendingTimeOffApprovals.mockReturnValue({ data: [], isLoading: false, error: null });
    hookMocks.useApproveTimeOffRequest.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    hookMocks.useRejectTimeOffRequest.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    hookMocks.useWeekStartsOn.mockReturnValue(0);
    hookMocks.useAuth.mockReturnValue({ user: { id: 2, role: 'MANAGER' } });
  });

  it('renders the page header and three top tabs', () => {
    renderWithProviders(<ApprovalsPage />);
    expect(screen.getByText('Pending Approvals')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Timesheets$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Time Off/ })).toBeInTheDocument();
    // The "Approved" button may collide with stat-tile labels; use getAllByRole.
    const approvedButtons = screen.getAllByRole('button', { name: /^Approved$/ });
    expect(approvedButtons.length).toBeGreaterThan(0);
  });

  it('renders the master-detail body with the employee card and detail header', () => {
    renderWithProviders(<ApprovalsPage />);
    // Left list shows the employee bucket
    expect(screen.getAllByText('Employee One').length).toBeGreaterThan(0);
    // Stat tiles surface the right counts
    expect(screen.getByText('Employees awaiting review')).toBeInTheDocument();
    expect(screen.getByText('Weeks pending')).toBeInTheDocument();
    // "Entries" appears on the stat tile and inside the employee card sub-line.
    expect(screen.getAllByText(/Entries/).length).toBeGreaterThan(0);
  });

  it('shows an empty-state when no pending entries are present', () => {
    hookMocks.usePendingApprovals.mockReturnValue({ data: [], isLoading: false, error: null });
    renderWithProviders(<ApprovalsPage />);
    expect(screen.getByText('All caught up.')).toBeInTheDocument();
  });
});
