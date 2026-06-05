import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  InboxPage,
  STALE_BUSINESS_DAYS,
  domainOf,
  formatRelativeReceived,
  getInitials,
  isActionableSkippedEmail,
  isPersonalDomain,
  isStaleReceived,
  suggestNameFromDomain,
} from './InboxPage';
import type { IngestionTimesheetSummary } from '@/types';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useIsManager: vi.fn(),
  useIsViewer: vi.fn(),
  useBulkReprocessEmails: vi.fn(),
  useBulkDeleteIngestedEmails: vi.fn(),
  useClients: vi.fn(),
  useCreateClient: vi.fn(),
  useCreateClientFromDomain: vi.fn(),
  useDeleteIngestedEmail: vi.fn(),
  useFetchJobStatus: vi.fn(),
  useIngestionTimesheets: vi.fn(),
  useMailboxes: vi.fn(),
  useReprocessIngestionEmail: vi.fn(),
  useReprocessSkippedEmails: vi.fn(),
  useSkippedEmails: vi.fn(),
  useTriggerFetchEmails: vi.fn(),
  useUpdateIngestionTimesheetData: vi.fn(),
  useAssignableUsers: vi.fn(),
  useAssignChainCandidate: vi.fn(),
  useMyPreferences: vi.fn(),
  useUpdateMyPreferences: vi.fn(),
  reprocessMutate: vi.fn(),
  cascadeMutate: vi.fn(),
  createClientMutate: vi.fn(),
  updateTimesheetMutate: vi.fn(),
  updatePreferencesMutate: vi.fn(),
}));

// importOriginal so any hook the page references but this test
// doesn't explicitly stub falls back to the real export rather
// than blowing up at render time.
vi.mock('@/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks')>();
  return {
    ...actual,
    useAuth: mocks.useAuth,
    useIsManager: mocks.useIsManager,
    useIsViewer: mocks.useIsViewer,
    useBulkReprocessEmails: mocks.useBulkReprocessEmails,
    useBulkDeleteIngestedEmails: mocks.useBulkDeleteIngestedEmails,
    useClients: mocks.useClients,
    useCreateClient: mocks.useCreateClient,
    useCreateClientFromDomain: mocks.useCreateClientFromDomain,
    useDeleteIngestedEmail: mocks.useDeleteIngestedEmail,
    useFetchJobStatus: mocks.useFetchJobStatus,
    useIngestionTimesheets: mocks.useIngestionTimesheets,
    useMailboxes: mocks.useMailboxes,
    useReprocessIngestionEmail: mocks.useReprocessIngestionEmail,
    useReprocessSkippedEmails: mocks.useReprocessSkippedEmails,
    useSkippedEmails: mocks.useSkippedEmails,
    useTriggerFetchEmails: mocks.useTriggerFetchEmails,
    useUpdateIngestionTimesheetData: mocks.useUpdateIngestionTimesheetData,
    useAssignableUsers: mocks.useAssignableUsers,
    useAssignChainCandidate: mocks.useAssignChainCandidate,
    useMyPreferences: mocks.useMyPreferences,
    useUpdateMyPreferences: mocks.useUpdateMyPreferences,
  };
});

vi.mock('@/components', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Loading: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock('@/components/ui/BulkSelectBar', () => ({
  BulkSelectBar: () => <div data-testid="bulk-select-bar" />,
}));

const TENANT_ID = 42;

const makeSkippedSummary = (overrides: Partial<IngestionTimesheetSummary> = {}): IngestionTimesheetSummary => ({
  id: overrides.id ?? Math.floor(Math.random() * 1_000_000),
  tenant_id: TENANT_ID,
  email_id: overrides.email_id ?? Math.floor(Math.random() * 1_000_000),
  attachment_id: null,
  subject: 'Timesheet (skipped)',
  sender_email: 'someone@example.com',
  sender_name: null,
  employee_id: null,
  employee_name: null,
  extracted_employee_name: null,
  extracted_supervisor_name: null,
  client_id: null,
  client_name: null,
  extracted_client_name: null,
  period_start: null,
  period_end: null,
  total_hours: null,
  status: 'skipped',
  push_status: null,
  time_entries_created: false,
  llm_anomalies: null,
  llm_match_suggestions: null,
  received_at: null,
  submitted_at: null,
  reviewed_at: null,
  created_at: '2026-04-22T00:00:00Z',
  ...overrides,
});

const setupHooks = (opts: {
  skippedCount: number;
  isBusy?: boolean;
} = { skippedCount: 0 }) => {
  const skippedTimesheets = Array.from({ length: opts.skippedCount }, (_, i) =>
    makeSkippedSummary({ id: i + 1, email_id: 1000 + i }),
  );

  mocks.useAuth.mockReturnValue({ user: { tenant_id: TENANT_ID, role: 'ADMIN' } });
  // Default: shortcut not visible. Per-test override flips these on.
  mocks.useIsManager.mockReturnValue(false);
  mocks.useIsViewer.mockReturnValue(false);
  mocks.useIngestionTimesheets.mockReturnValue({
    data: skippedTimesheets,
    isLoading: false,
  });
  mocks.useSkippedEmails.mockReturnValue({
    data: { emails: [], total: 0 },
    isLoading: false,
  });
  mocks.useMailboxes.mockReturnValue({ data: [] });
  mocks.useClients.mockReturnValue({ data: [] });
  mocks.useFetchJobStatus.mockReturnValue({ data: null });

  const noopMutation = (isPending = false) => ({
    mutateAsync: vi.fn().mockResolvedValue({ job_id: 'job-1', message: 'ok' }),
    mutate: vi.fn(),
    isPending,
  });
  mocks.useTriggerFetchEmails.mockReturnValue(noopMutation());
  mocks.useReprocessSkippedEmails.mockReturnValue({
    mutateAsync: mocks.reprocessMutate.mockResolvedValue({ job_id: 'job-reprocess-all' }),
    mutate: vi.fn(),
    isPending: Boolean(opts.isBusy),
  });
  mocks.useReprocessIngestionEmail.mockReturnValue(noopMutation());
  mocks.useDeleteIngestedEmail.mockReturnValue(noopMutation());
  mocks.useBulkReprocessEmails.mockReturnValue(noopMutation());
  mocks.useBulkDeleteIngestedEmails.mockReturnValue(noopMutation());
  mocks.useCreateClientFromDomain.mockReturnValue({
    mutateAsync: mocks.cascadeMutate.mockResolvedValue({
      client: { id: 99, name: 'DXC Technology' },
      domain: 'dxc.com',
      cascaded_count: 0,
    }),
    mutate: vi.fn(),
    isPending: false,
  });
  mocks.useCreateClient.mockReturnValue({
    mutateAsync: mocks.createClientMutate.mockResolvedValue({ id: 555, name: 'Stub' }),
    mutate: vi.fn(),
    isPending: false,
  });
  mocks.useUpdateIngestionTimesheetData.mockReturnValue({
    mutateAsync: mocks.updateTimesheetMutate.mockResolvedValue({ status: 'updated' }),
    mutate: vi.fn(),
    isPending: false,
  });
  mocks.useAssignableUsers.mockReturnValue({ data: [], isLoading: false });
  mocks.useAssignChainCandidate.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  });
  mocks.useMyPreferences.mockReturnValue({ data: undefined, isLoading: false });
  mocks.useUpdateMyPreferences.mockReturnValue({
    mutate: mocks.updatePreferencesMutate,
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  });
};

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <InboxPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

describe('InboxPage — reprocess-all-skipped controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('does not render the banner when there are no skipped emails', () => {
    setupHooks({ skippedCount: 0 });
    renderPage();
    expect(screen.queryByTestId('skipped-emails-banner')).toBeNull();
  });

  it('renders the banner when skipped emails exist and the user is not already on the skipped view', () => {
    setupHooks({ skippedCount: 5 });
    renderPage();

    const banner = screen.getByTestId('skipped-emails-banner');
    expect(banner).toBeInTheDocument();
    // The count is rendered as bold inside the banner body — the action button
    // also carries "5", so scope the text match to the banner *and* look for
    // the specific "5 emails were skipped" phrasing.
    expect(within(banner).getByText(/emails were skipped/i)).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: /Reprocess 5 skipped/i })).toBeInTheDocument();
  });

  it('clicking the banner action calls the reprocess-skipped mutation', async () => {
    setupHooks({ skippedCount: 3 });
    renderPage();

    const banner = screen.getByTestId('skipped-emails-banner');
    const button = within(banner).getByRole('button', { name: /Reprocess 3 skipped/i });
    fireEvent.click(button);

    await Promise.resolve();
    expect(mocks.reprocessMutate).toHaveBeenCalled();
  });

  it('dismissing the banner hides it and persists the dismissed count per tenant', () => {
    setupHooks({ skippedCount: 7 });
    const { unmount } = renderPage();

    const banner = screen.getByTestId('skipped-emails-banner');
    const dismiss = within(banner).getByLabelText(/Dismiss skipped emails banner/i);
    fireEvent.click(dismiss);

    expect(screen.queryByTestId('skipped-emails-banner')).toBeNull();
    expect(
      window.localStorage.getItem(`inbox.skippedBannerDismissedCount.${TENANT_ID}`),
    ).toBe('7');

    // Remount with the same skipped count — dismissed state should survive.
    unmount();
    setupHooks({ skippedCount: 7 });
    renderPage();
    expect(screen.queryByTestId('skipped-emails-banner')).toBeNull();
  });

  it('banner reappears when the skipped count grows past the dismissed count', () => {
    // Simulate a prior session that dismissed at 4.
    window.localStorage.setItem(`inbox.skippedBannerDismissedCount.${TENANT_ID}`, '4');
    setupHooks({ skippedCount: 9 });
    renderPage();

    const banner = screen.getByTestId('skipped-emails-banner');
    expect(banner).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: /Reprocess 9 skipped/i })).toBeInTheDocument();
  });

  it('shows the inline "Reprocess all" button inside the filter bar only on the Skipped view', () => {
    setupHooks({ skippedCount: 6 });
    renderPage();

    // showFilters auto-opens when there's data, so the pills are already
    // visible. On the default (All) view, the inline reprocess button is not
    // shown.
    expect(screen.queryByTestId('reprocess-all-skipped')).toBeNull();

    // Switch to Skipped by clicking the filter pill. The banner body also
    // contains the word "skipped", so scope the match to buttons that render
    // a standalone "Skipped" label plus a count badge (the filter pill text
    // collapses to "Skipped N" under accessible-name computation).
    const buttons = screen.getAllByRole('button', { name: /^Skipped\s+\d+$/i });
    expect(buttons.length).toBe(1);
    fireEvent.click(buttons[0]);

    const inlineButton = screen.getByTestId('reprocess-all-skipped');
    expect(inlineButton).toBeInTheDocument();
    expect(inlineButton).toHaveTextContent(/Reprocess 6 skipped/i);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Inbox redesign helpers (per-cell attention + relative time + initials)
// ───────────────────────────────────────────────────────────────────────

describe('getInitials', () => {
  it('returns first+last initial for "Last, First" form', () => {
    expect(getInitials('Rajendran, R.')).toBe('RR');
    expect(getInitials('Davis, Amanda')).toBe('AD');
  });
  it('returns first+last initial for "First Last" form', () => {
    expect(getInitials('Sarah Lee')).toBe('SL');
    expect(getInitials('Mike Garcia')).toBe('MG');
  });
  it('returns the first two characters for a single name', () => {
    expect(getInitials('Acuent')).toBe('AC');
  });
  it('falls back to email local-part when name is empty', () => {
    expect(getInitials(null, 'r.rajendran3@dxc.com')).toBe('R.');
    expect(getInitials('', 'admin@example.com')).toBe('AD');
  });
  it('returns ? when nothing usable is available', () => {
    expect(getInitials(null, null)).toBe('?');
    expect(getInitials('', '')).toBe('?');
  });
});

describe('domainOf and isPersonalDomain', () => {
  it('extracts the lowercased bare domain from an email', () => {
    expect(domainOf('Foo@DXC.com')).toBe('dxc.com');
    expect(domainOf('alice@aegon.com')).toBe('aegon.com');
  });
  it('returns "" for malformed input', () => {
    expect(domainOf('')).toBe('');
    expect(domainOf(null)).toBe('');
    expect(domainOf('not-an-email')).toBe('');
  });
  it('flags canonical personal email providers', () => {
    expect(isPersonalDomain('gmail.com')).toBe(true);
    expect(isPersonalDomain('GMAIL.COM')).toBe(true);
    expect(isPersonalDomain('outlook.com')).toBe(true);
    expect(isPersonalDomain('proton.me')).toBe(true);
  });
  it('does not flag real client domains', () => {
    expect(isPersonalDomain('dxc.com')).toBe(false);
    expect(isPersonalDomain('aegon.com')).toBe(false);
  });
});

describe('suggestNameFromDomain', () => {
  it('uppercases short stems', () => {
    expect(suggestNameFromDomain('dxc.com')).toBe('DXC');
    expect(suggestNameFromDomain('ibm.com')).toBe('IBM');
  });
  it('title-cases longer stems', () => {
    expect(suggestNameFromDomain('aegon.com')).toBe('Aegon');
    expect(suggestNameFromDomain('accenture.com')).toBe('Accenture');
  });
  it('returns "" for empty input', () => {
    expect(suggestNameFromDomain('')).toBe('');
  });
});

describe('formatRelativeReceived', () => {
  it('returns "--" for empty input', () => {
    expect(formatRelativeReceived(null)).toBe('--');
    expect(formatRelativeReceived(undefined)).toBe('--');
    expect(formatRelativeReceived('')).toBe('--');
  });
  it('formats minutes/hours/days correctly', () => {
    const now = Date.now();
    expect(formatRelativeReceived(new Date(now - 30_000).toISOString())).toMatch(/Just now/);
    expect(formatRelativeReceived(new Date(now - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(formatRelativeReceived(new Date(now - 3 * 60 * 60_000).toISOString())).toBe('3h ago');
    expect(formatRelativeReceived(new Date(now - 26 * 60 * 60_000).toISOString())).toBe('Yesterday');
    expect(formatRelativeReceived(new Date(now - 3 * 24 * 60 * 60_000).toISOString())).toBe('3d ago');
  });
  it('falls back to absolute date past one week', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    const out = formatRelativeReceived(eightDaysAgo);
    // Localized; we just check it does not match the 'Nd ago' or 'Yesterday' patterns.
    expect(out).not.toBe('--');
    expect(out).not.toMatch(/^\d+d ago$/);
    expect(out).not.toBe('Yesterday');
  });
});

describe('isStaleReceived', () => {
  it('returns false for fresh timestamps', () => {
    const now = new Date().toISOString();
    expect(isStaleReceived(now)).toBe(false);
    const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    expect(isStaleReceived(yesterday)).toBe(false);
  });
  it('returns true for timestamps older than the stale threshold', () => {
    // 12 calendar days ago is well past 5 business days, regardless of weekend math.
    const twelveDaysAgo = new Date(Date.now() - 12 * 24 * 60 * 60_000).toISOString();
    expect(isStaleReceived(twelveDaysAgo)).toBe(true);
  });
  it('returns false for empty input', () => {
    expect(isStaleReceived(null)).toBe(false);
    expect(isStaleReceived('')).toBe(false);
  });
  it('exports a documented threshold constant', () => {
    expect(STALE_BUSINESS_DAYS).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Inbox table layout regression
// ───────────────────────────────────────────────────────────────────────

describe('InboxPage — table layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  const renderWithRow = (overrides: Partial<IngestionTimesheetSummary> = {}) => {
    const row = makeSkippedSummary({
      id: 1,
      email_id: 1000,
      status: 'pending',
      subject: 'Weekly timesheet',
      sender_name: 'Rajendran, R.',
      sender_email: 'r.rajendran3@dxc.com',
      received_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      ...overrides,
    });
    setupHooks({ skippedCount: 0 });
    mocks.useIngestionTimesheets.mockReturnValue({ data: [row], isLoading: false });
    // Pre-seed server prefs so InboxPage hydrates into table mode (the
    // tests in this block assert on table-specific markup like column
    // headers). Cards mode is the default for first-time visitors.
    mocks.useMyPreferences.mockReturnValue({
      data: { inbox_view_mode: 'table' },
      isLoading: false,
    });
    renderPage();
  };

  it('does not render an "AI Flags" column header', () => {
    renderWithRow();
    expect(screen.queryByRole('columnheader', { name: /AI Flags/i })).toBeNull();
  });

  it('renders Sender, Subject, Client, Employee, Week, Hours, Status, Received, Actions', () => {
    renderWithRow();
    for (const name of ['Sender', 'Subject', 'Client', 'Employee', 'Week', 'Hours', 'Status', 'Received', 'Actions']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(`^${name}$`, 'i') })).toBeInTheDocument();
    }
  });

  it('shows the inline cascade-create button when no client is assigned and the sender is on a real domain', () => {
    renderWithRow({ client_name: null, sender_email: 'r.rajendran3@dxc.com' });
    // Button label is now "+ Add client from <domain>" (dashed-outline
    // affordance pattern). Match by the domain since variant B keeps
    // it in the accessible name.
    const button = screen.getByRole('button', { name: /Add client from\s+dxc\.com/i });
    expect(button).toBeInTheDocument();
  });

  it('shows the dashed-outline "Add client" button on personal-domain rows', () => {
    renderWithRow({ client_name: null, sender_email: 'forwarder@gmail.com' });
    // Personal-domain rows surface the inline picker via "+ Add client";
    // the non-personal-domain cascade variant is suppressed for gmail/etc.
    expect(screen.getByRole('button', { name: /^Add client$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add client from\s+gmail\.com/i })).toBeNull();
  });

  it('shows the dashed-outline "Add employee" button when no employee is assigned', () => {
    renderWithRow({
      client_name: null,
      employee_name: null,
      extracted_employee_name: null,
    });
    expect(screen.getByRole('button', { name: /^Add employee$/i })).toBeInTheDocument();
  });

  it('opens the cascade popover when the inline create button is clicked', () => {
    renderWithRow({ client_name: null, sender_email: 'alice@dxc.com' });
    const button = screen.getByRole('button', { name: /Add client from\s+dxc\.com/i });
    fireEvent.click(button);

    // The popover renders as a dialog with the matching aria-label.
    expect(screen.getByRole('dialog', { name: /Assign client from domain/i })).toBeInTheDocument();
    // The pre-filled input contains the smart-guess derived from the domain.
    const input = screen.getByLabelText(/Client name/i) as HTMLInputElement;
    expect(input.value).toBe('DXC');
    // The primary button shows the "Create" label since no existing client matches.
    expect(screen.getByRole('button', { name: /Create "DXC"/i })).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Inline client picker — editable "Create new client" flow on personal-domain rows
// ───────────────────────────────────────────────────────────────────────

describe('InboxPage — inline picker editable create flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  const renderPersonalDomainRow = (extractedClientName: string | null) => {
    const row = makeSkippedSummary({
      id: 42,
      email_id: 9000,
      status: 'pending',
      subject: 'Weekly timesheet',
      sender_name: 'Mary K.',
      sender_email: 'mary@gmail.com',
      client_name: null,
      extracted_client_name: extractedClientName,
      received_at: new Date(Date.now() - 60_000).toISOString(),
    });
    setupHooks({ skippedCount: 0 });
    mocks.useIngestionTimesheets.mockReturnValue({ data: [row], isLoading: false });
    mocks.useClients.mockReturnValue({
      data: [{ id: 1, name: 'Acme Corp' }],
      isLoading: false,
    });
    renderPage();
  };

  it('reveals an editable name field prefilled with the AI suggestion when Create is clicked', () => {
    renderPersonalDomainRow('Webilent Tech');

    // Open the inline picker via the "+ Add client" dashed-outline button.
    fireEvent.click(screen.getByRole('button', { name: /^Add client$/i }));

    // Click the suggestion-create button — should NOT call the mutation yet.
    fireEvent.click(screen.getByRole('button', { name: /Create new client \(suggested: "Webilent Tech"\)/i }));
    expect(mocks.createClientMutate).not.toHaveBeenCalled();

    // Editable input is revealed, prefilled with the suggestion.
    const input = screen.getByPlaceholderText(/Client name/i) as HTMLInputElement;
    expect(input.value).toBe('Webilent Tech');

    // Primary action button switches to "Create & assign", not auto-create.
    expect(screen.getByRole('button', { name: /Create & assign/i })).toBeInTheDocument();
    // Back button lets the user retreat to the picker.
    expect(screen.getByRole('button', { name: /^Back$/i })).toBeInTheDocument();
  });

  it('lets the user replace the suggestion and uses the typed name on confirm', async () => {
    renderPersonalDomainRow('Webilent Tech');

    fireEvent.click(screen.getByRole('button', { name: /^Add client$/i }));
    fireEvent.click(screen.getByRole('button', { name: /Create new client/i }));

    const input = screen.getByPlaceholderText(/Client name/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'My Custom Client' } });
    expect(input.value).toBe('My Custom Client');

    fireEvent.click(screen.getByRole('button', { name: /Create & assign/i }));
    await Promise.resolve();

    expect(mocks.createClientMutate).toHaveBeenCalledWith({ name: 'My Custom Client' });
  });

  it('falls back to the domain-derived guess when no AI extraction is present', () => {
    renderPersonalDomainRow(null); // extracted_client_name = null

    fireEvent.click(screen.getByRole('button', { name: /^Add client$/i }));
    // gmail.com domain -> Gmail suggestion (title-cased, >4 chars)
    expect(screen.getByRole('button', { name: /Create new client \(suggested: "Gmail"\)/i })).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Cards/Table view toggle + card-mode rendering
// ───────────────────────────────────────────────────────────────────────

describe('InboxPage — view mode toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  const renderTwoRows = (preferenceOverride?: 'cards' | 'table') => {
    const rows = [
      makeSkippedSummary({
        id: 1,
        email_id: 1000,
        status: 'pending',
        subject: 'April timesheet',
        sender_name: 'Alice',
        sender_email: 'alice@dxc.com',
        client_name: 'DXC',
        employee_name: 'Alice',
      }),
      makeSkippedSummary({
        id: 2,
        email_id: 1001,
        status: 'pending',
        subject: 'May timesheet',
        sender_name: 'Bob',
        sender_email: 'bob@acme.com',
        client_name: 'Acme',
        employee_name: 'Bob',
      }),
    ];
    setupHooks({ skippedCount: 0 });
    mocks.useIngestionTimesheets.mockReturnValue({ data: rows, isLoading: false });
    if (preferenceOverride) {
      mocks.useMyPreferences.mockReturnValue({
        data: { inbox_view_mode: preferenceOverride },
        isLoading: false,
      });
    }
    renderPage();
  };

  it('defaults new users to Cards view (no server pref, no localStorage)', () => {
    renderTwoRows();
    expect(screen.getByTestId('inbox-cards-view')).toBeInTheDocument();
    expect(screen.getAllByTestId('inbox-card').length).toBe(2);
    // Table mode is suppressed: no column headers visible.
    expect(screen.queryByRole('columnheader', { name: /Subject/i })).toBeNull();
  });

  it('renders both Cards and Table toggle buttons in the header', () => {
    renderTwoRows();
    const toggle = screen.getByTestId('inbox-view-toggle');
    expect(within(toggle).getByRole('tab', { name: /Cards/i })).toBeInTheDocument();
    expect(within(toggle).getByRole('tab', { name: /Table/i })).toBeInTheDocument();
  });

  it('switches to Table view when the Table toggle is clicked and persists the choice', async () => {
    renderTwoRows();
    const toggle = screen.getByTestId('inbox-view-toggle');
    fireEvent.click(within(toggle).getByRole('tab', { name: /Table/i }));

    // Table renders with column headers; cards are gone.
    expect(screen.getByRole('columnheader', { name: /^Subject$/i })).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-cards-view')).toBeNull();

    // localStorage was updated for the fast-path fallback on next mount.
    expect(window.localStorage.getItem('inbox.viewMode')).toBe('table');
    // The server-persistence mutation was fired so the choice follows
    // the user across browsers.
    await Promise.resolve();
    expect(mocks.updatePreferencesMutate).toHaveBeenCalledWith({ inbox_view_mode: 'table' });
  });

  it('honors a server-persisted preference on mount (table mode forced)', () => {
    renderTwoRows('table');
    expect(screen.queryByTestId('inbox-cards-view')).toBeNull();
    expect(screen.getByRole('columnheader', { name: /^Subject$/i })).toBeInTheDocument();
  });

  it('honors a localStorage fallback when no server pref is present', () => {
    window.localStorage.setItem('inbox.viewMode', 'table');
    renderTwoRows();
    // No server preference, but localStorage said 'table' — hydrate into table mode.
    expect(screen.queryByTestId('inbox-cards-view')).toBeNull();
    expect(screen.getByRole('columnheader', { name: /^Subject$/i })).toBeInTheDocument();
  });
});

describe('InboxPage — card-mode rendering variants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('renders the dashed-outline "Add client" button on personal-domain card rows', () => {
    setupHooks({ skippedCount: 0 });
    mocks.useIngestionTimesheets.mockReturnValue({
      data: [makeSkippedSummary({
        id: 7, email_id: 7000, status: 'pending', subject: 'X',
        sender_email: 'forwarder@gmail.com', client_name: null,
      })],
      isLoading: false,
    });
    renderPage();
    // Cards view (default). The Add client button should render
    // inline inside the card body.
    expect(screen.getByTestId('inbox-cards-view')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Add client$/i })).toBeInTheDocument();
  });

  it('renders the "+ Add client from <domain>" button on real-domain card rows', () => {
    setupHooks({ skippedCount: 0 });
    mocks.useIngestionTimesheets.mockReturnValue({
      data: [makeSkippedSummary({
        id: 8, email_id: 8000, status: 'pending', subject: 'X',
        sender_email: 'alice@dxc.com', client_name: null,
      })],
      isLoading: false,
    });
    renderPage();
    expect(screen.getByRole('button', { name: /Add client from\s+dxc\.com/i })).toBeInTheDocument();
  });

  it('omits the Delete icon on approved/rejected cards (final state)', () => {
    setupHooks({ skippedCount: 0 });
    mocks.useIngestionTimesheets.mockReturnValue({
      data: [makeSkippedSummary({
        id: 9, email_id: 9000, status: 'approved', subject: 'Final',
        sender_email: 'alice@dxc.com', client_name: 'DXC', employee_name: 'Alice',
      })],
      isLoading: false,
    });
    renderPage();
    expect(screen.getByTestId('inbox-card')).toBeInTheDocument();
    // Open should be present, Delete should be hidden for final-state cards.
    expect(screen.getByRole('button', { name: /^Open submission/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete email/i })).toBeNull();
  });
});

describe('InboxPage — Team Timesheets shortcut role gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('renders the shortcut for MANAGER role', () => {
    setupHooks({ skippedCount: 0 });
    mocks.useIsManager.mockReturnValue(true);
    mocks.useIsViewer.mockReturnValue(false);
    renderPage();
    expect(screen.getByRole('button', { name: /Approved Timesheets/i })).toBeInTheDocument();
  });

  it('renders the shortcut for VIEWER role', () => {
    setupHooks({ skippedCount: 0 });
    mocks.useIsManager.mockReturnValue(false);
    mocks.useIsViewer.mockReturnValue(true);
    renderPage();
    expect(screen.getByRole('button', { name: /Approved Timesheets/i })).toBeInTheDocument();
  });

  it('does not render the shortcut for EMPLOYEE reviewers', () => {
    setupHooks({ skippedCount: 0 });
    mocks.useIsManager.mockReturnValue(false);
    mocks.useIsViewer.mockReturnValue(false);
    renderPage();
    expect(screen.queryByRole('button', { name: /Approved Timesheets/i })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// isActionableSkippedEmail — body-only timesheet override (2026-06-04)
//
// Mirrors the backend's _is_actionable_skipped_email regression suite.
// When the LLM classifier explicitly says this IS a submission, the
// row must be surfaced as actionable regardless of attachment state.
// Without that override, body-only timesheets get filtered out as
// "noise" (no_candidate_timesheet_attachment is a no-attachment skip
// reason classified as noise by isNoiseSkipReason).
// ─────────────────────────────────────────────────────────────────────
describe('isActionableSkippedEmail — classifier-yes override', () => {
  // Local helper. The function's signature only reads a small subset
  // of SkippedEmail fields, but TypeScript demands the full type, so
  // we cast through unknown to keep the assertions terse.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const make = (partial: any) => partial as Parameters<typeof isActionableSkippedEmail>[0];

  const baseEmail = {
    id: 1,
    subject: '',
    sender_email: 'anon@example.com',
    sender_name: null,
    received_at: '2026-06-04T00:00:00Z',
    mailbox_label: null,
    has_attachments: false,
    timesheet_attachment_count: 0,
    classification_intent: null,
    classification_confidence: 0.0,
    skip_reason: 'no_candidate_timesheet_attachment',
    skip_detail: null,
    reprocessable_attachments: [],
  };

  it('classifier intent=new_submission overrides no_candidate_timesheet_attachment', () => {
    // The Kalpana case: forwarded month, body has weekly date ranges
    // + hour totals, no attachments. New prompt -> intent=new_submission.
    // Filter must keep the row visible despite the noise skip reason.
    expect(isActionableSkippedEmail(make({
      ...baseEmail,
      classification_intent: 'new_submission',
    }))).toBe(true);
  });

  it('classifier intent=resubmission also qualifies', () => {
    expect(isActionableSkippedEmail(make({
      ...baseEmail,
      classification_intent: 'resubmission',
    }))).toBe(true);
  });

  it('classifier intent=correction also qualifies', () => {
    expect(isActionableSkippedEmail(make({
      ...baseEmail,
      classification_intent: 'correction',
    }))).toBe(true);
  });

  it('classifier intent=unrelated with no attachments stays filtered', () => {
    // Negative case: the override is intentionally narrow. A non-
    // submission intent + no attachments + a noise skip reason is
    // still noise. Without this assertion a sloppy override could
    // re-surface garbage emails.
    expect(isActionableSkippedEmail(make({
      ...baseEmail,
      classification_intent: 'unrelated',
    }))).toBe(false);
  });

  it('classifier intent=query with no attachments stays filtered', () => {
    expect(isActionableSkippedEmail(make({
      ...baseEmail,
      classification_intent: 'query',
    }))).toBe(false);
  });

  it('null classification_intent with no attachments stays filtered', () => {
    expect(isActionableSkippedEmail(make({
      ...baseEmail,
      classification_intent: null,
    }))).toBe(false);
  });

  it('subject keyword alone does NOT trigger the override', () => {
    // 'Timesheet question' is a common shape for non-submission
    // emails. Without classifier-yes, subject-only keyword match is
    // not enough to override the noise filter.
    expect(isActionableSkippedEmail(make({
      ...baseEmail,
      subject: 'Timesheet question',
      classification_intent: 'query',
    }))).toBe(false);
  });
});
