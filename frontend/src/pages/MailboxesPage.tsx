import React from 'react';
import {
  Calendar,
  CheckCircle2,
  ChevronDown,
  Clock,
  Edit3,
  Globe,
  Lock,
  Mail,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  User as UserIcon,
  X,
} from 'lucide-react';
import axios from 'axios';

import { apiClient } from '@/api/client';
import { EmptyState, Loading } from '@/components';
import { mailboxesAPI } from '@/api/endpoints';
import {
  useAuth,
  useClients,
  useCreateMailbox,
  useDeleteMailbox,
  useMailboxes,
  useResetMailboxCursor,
  useTestMailbox,
  useUpdateMailbox,
  useTenantSettings,
  useUpdateTenantSettings,
} from '@/hooks';
import type { Mailbox, MailboxPayload, OAuthProvider } from '@/types';

// ─────────────────────────────────────────────────────────────────────
// Form state for the create / edit modal
// ─────────────────────────────────────────────────────────────────────

type FormState = {
  label: string;
  protocol: string;
  auth_type: string;
  host: string;
  port: string;
  use_ssl: boolean;
  username: string;
  password: string;
  oauth_provider: OAuthProvider | '';
  smtp_host: string;
  smtp_port: string;
  smtp_username: string;
  smtp_password: string;
  linked_client_id: string;
  is_active: boolean;
};

const createEmptyForm = (): FormState => ({
  label: '',
  protocol: 'imap',
  auth_type: 'basic',
  host: '',
  port: '993',
  use_ssl: true,
  username: '',
  password: '',
  oauth_provider: '',
  smtp_host: '',
  smtp_port: '',
  smtp_username: '',
  smtp_password: '',
  linked_client_id: '',
  is_active: true,
});

const toPayload = (form: FormState): MailboxPayload => ({
  label: form.label.trim(),
  protocol: form.protocol,
  auth_type: form.auth_type,
  host: form.auth_type === 'basic' ? (form.host.trim() || null) : null,
  port: form.port ? Number(form.port) : null,
  use_ssl: form.use_ssl,
  username: form.username.trim() || null,
  password: form.password.trim() || undefined,
  oauth_provider: form.auth_type === 'oauth2' ? (form.oauth_provider || null) : null,
  smtp_host: form.smtp_host.trim() || null,
  smtp_port: form.smtp_port ? Number(form.smtp_port) : null,
  smtp_username: form.smtp_username.trim() || null,
  smtp_password: form.smtp_password.trim() || undefined,
  linked_client_id: form.linked_client_id ? Number(form.linked_client_id) : null,
  is_active: form.is_active,
});

const getApiErrorMessage = (error: unknown, fallback: string): string => {
  if (axios.isAxiosError(error) && typeof error.response?.data?.detail === 'string') {
    return error.response.data.detail;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
};

// ─────────────────────────────────────────────────────────────────────
// MailboxesPage
// ─────────────────────────────────────────────────────────────────────

export const MailboxesPage: React.FC = () => {
  const { data: mailboxes = [], isLoading, refetch: refetchMailboxes } = useMailboxes();
  const { tenant } = useAuth();
  const maxMailboxes = tenant?.max_mailboxes ?? null;
  const activeMailboxCount = mailboxes.filter((m) => m.is_active).length;
  const totalConnections = mailboxes.length;
  const googleConnections = mailboxes.filter((m) => m.oauth_provider === 'google').length;
  const microsoftConnections = mailboxes.filter((m) => m.oauth_provider === 'microsoft').length;
  const atCap = maxMailboxes != null && activeMailboxCount >= maxMailboxes;

  const { data: clients = [] } = useClients();
  const createMailbox = useCreateMailbox();
  const updateMailbox = useUpdateMailbox();
  const deleteMailbox = useDeleteMailbox();
  const testMailbox = useTestMailbox();
  const resetCursor = useResetMailboxCursor();
  const { data: tenantSettings = {} } = useTenantSettings();
  const updateSettings = useUpdateTenantSettings();

  // ── Fetch schedule (per-tenant settings) ──────────────────────────
  const [fetchEnabled, setFetchEnabled] = React.useState(false);
  const [fetchInterval, setFetchInterval] = React.useState('60');
  const [fetchDays, setFetchDays] = React.useState('mon,tue,wed,thu,fri');
  const [fetchStartTime, setFetchStartTime] = React.useState('08:00');
  const [fetchEndTime, setFetchEndTime] = React.useState('20:00');
  const [fetchSaved, setFetchSaved] = React.useState(false);

  React.useEffect(() => {
    if (!tenantSettings || Object.keys(tenantSettings).length === 0) return;
    // Post-catalog endpoints return typed values; coerce defensively.
    if (tenantSettings.fetch_emails_enabled != null)
      setFetchEnabled(tenantSettings.fetch_emails_enabled === true || tenantSettings.fetch_emails_enabled === 'true');
    if (tenantSettings.fetch_emails_interval_minutes != null)
      setFetchInterval(String(tenantSettings.fetch_emails_interval_minutes));
    if (tenantSettings.fetch_emails_days != null)
      setFetchDays(String(tenantSettings.fetch_emails_days));
    if (tenantSettings.fetch_emails_start_time != null)
      setFetchStartTime(String(tenantSettings.fetch_emails_start_time));
    if (tenantSettings.fetch_emails_end_time != null)
      setFetchEndTime(String(tenantSettings.fetch_emails_end_time));
  }, [tenantSettings]);

  // ── Modal + per-row state ─────────────────────────────────────────
  const [isPanelOpen, setIsPanelOpen] = React.useState(false);
  const [editingMailbox, setEditingMailbox] = React.useState<Mailbox | null>(null);
  const [form, setForm] = React.useState<FormState>(createEmptyForm());
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);
  const [statusTone, setStatusTone] = React.useState<'success' | 'danger' | 'info'>('info');

  const backendOrigin = React.useMemo(
    () => new URL(apiClient.defaults.baseURL ?? window.location.origin).origin,
    [],
  );

  // Listen for OAuth popup completion → refetch + status banner.
  React.useEffect(() => {
    const handleOAuthMessage = (event: MessageEvent) => {
      if (event.origin !== backendOrigin) return;
      const payload = event.data as {
        type?: string;
        status?: 'success' | 'danger';
        message?: string;
      };
      if (payload?.type !== 'mailbox-oauth') return;
      setStatusTone(payload.status === 'success' ? 'success' : 'danger');
      setStatusMessage(payload.message ?? 'Mailbox OAuth completed.');
      if (payload.status === 'success') void refetchMailboxes();
    };
    window.addEventListener('message', handleOAuthMessage);
    return () => window.removeEventListener('message', handleOAuthMessage);
  }, [backendOrigin, refetchMailboxes]);

  if (isLoading) {
    return <Loading message="Loading mailbox configuration..." />;
  }

  const openCreate = () => {
    setEditingMailbox(null);
    setForm(createEmptyForm());
    setIsPanelOpen(true);
    setStatusMessage(null);
  };

  const openEdit = (mailbox: Mailbox) => {
    setEditingMailbox(mailbox);
    setForm({
      label: mailbox.label,
      protocol: String(mailbox.protocol),
      auth_type: String(mailbox.auth_type) === 'oauth' ? 'oauth2' : String(mailbox.auth_type),
      host: mailbox.host ?? '',
      port: mailbox.port ? String(mailbox.port) : '',
      use_ssl: mailbox.use_ssl,
      username: mailbox.username ?? '',
      password: '',
      oauth_provider: (mailbox.oauth_provider as OAuthProvider | null) ?? '',
      smtp_host: mailbox.smtp_host ?? '',
      smtp_port: mailbox.smtp_port ? String(mailbox.smtp_port) : '',
      smtp_username: mailbox.smtp_username ?? '',
      smtp_password: '',
      linked_client_id: mailbox.linked_client_id ? String(mailbox.linked_client_id) : '',
      is_active: mailbox.is_active,
    });
    setIsPanelOpen(true);
    setStatusMessage(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const payload = toPayload(form);
    try {
      if (editingMailbox) {
        await updateMailbox.mutateAsync({ id: editingMailbox.id, data: payload });
        setStatusTone('success');
        setStatusMessage(`Updated ${payload.label}.`);
      } else {
        await createMailbox.mutateAsync(payload);
        setStatusTone('success');
        setStatusMessage(`Created ${payload.label}.`);
      }
      setIsPanelOpen(false);
    } catch (error) {
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, 'Mailbox save failed.'));
    }
  };

  const handleDelete = async (mailbox: Mailbox) => {
    if (!window.confirm(`Delete mailbox "${mailbox.label}"?`)) return;
    try {
      await deleteMailbox.mutateAsync(mailbox.id);
      setStatusTone('success');
      setStatusMessage(`Deleted ${mailbox.label}.`);
    } catch (error) {
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, 'Delete failed.'));
    }
  };

  const handleTest = async (mailbox: Mailbox) => {
    try {
      const result = await testMailbox.mutateAsync(mailbox.id);
      setStatusTone(result.success ? 'success' : 'danger');
      setStatusMessage(
        result.success
          ? `${mailbox.label} connected in ${result.latency_ms}ms and found ${result.message_count} messages.`
          : `${mailbox.label} test failed: ${result.error || 'unknown error'}`,
      );
    } catch (error) {
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, 'Connection test failed.'));
    }
  };

  const handleResetCursor = async (mailbox: Mailbox) => {
    if (!window.confirm(`Re-fetch all emails for "${mailbox.label}"? The next fetch will pull all emails from the last 30 days again.`)) return;
    try {
      await resetCursor.mutateAsync(mailbox.id);
      setStatusTone('success');
      setStatusMessage(`Fetch cursor reset for ${mailbox.label}. Next fetch will pull all emails.`);
    } catch (error) {
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, 'Failed to reset fetch cursor.'));
    }
  };

  const handleOAuthConnect = async (provider: OAuthProvider) => {
    try {
      const response = await mailboxesAPI.oauthConnect(provider);
      window.open(response.data.auth_url, 'mailbox-oauth', 'popup,width=720,height=820');
    } catch (error) {
      setStatusTone('danger');
      setStatusMessage(getApiErrorMessage(error, `Unable to start ${provider} OAuth.`));
    }
  };

  const handleOAuthReconnect = async (mailbox: Mailbox) => {
    const provider = mailbox.oauth_provider as OAuthProvider | null;
    if (!provider) {
      setStatusTone('danger');
      setStatusMessage('This mailbox has no OAuth provider to reconnect.');
      return;
    }
    await handleOAuthConnect(provider);
  };

  const isOAuthMailbox = (mailbox: Mailbox): boolean =>
    (mailbox.auth_type === 'oauth' || mailbox.auth_type === 'oauth2') && !!mailbox.oauth_provider;

  // ── Render ────────────────────────────────────────────────────────
  const connectedLabel = maxMailboxes != null
    ? `${activeMailboxCount} of ${maxMailboxes} connected`
    : `${activeMailboxCount} connected`;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Mailboxes</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Configure intake mailboxes for timesheet submissions. Passwords never come back from the API once saved.
          </p>
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
            {connectedLabel}
            {atCap && (
              <span className="ml-1 text-amber-600 dark:text-amber-400">
                · contact your platform admin to raise the limit
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="action-button disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={atCap}
          title={atCap ? 'Mailbox limit reached' : 'Add a new mailbox'}
        >
          <Plus className="mr-2 h-4 w-4" />
          New Mailbox
        </button>
      </div>

      {/* Status banner */}
      {statusMessage && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            statusTone === 'success'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : statusTone === 'danger'
              ? 'border-destructive/40 bg-destructive/5 text-destructive'
              : 'border-border bg-muted/40 text-muted-foreground'
          }`}
        >
          {statusMessage}
        </div>
      )}

      {/* Mailbox cards */}
      {mailboxes.length === 0 ? (
        <EmptyState message="No mailboxes yet. Add one to start receiving timesheets." />
      ) : (
        <div className="space-y-3">
          {mailboxes.map((mailbox) => (
            <MailboxCard
              key={mailbox.id}
              mailbox={mailbox}
              isOAuth={isOAuthMailbox(mailbox)}
              onEdit={() => openEdit(mailbox)}
              onTest={() => handleTest(mailbox)}
              onReconnect={() => void handleOAuthReconnect(mailbox)}
              onResetCursor={() => void handleResetCursor(mailbox)}
              onDelete={() => handleDelete(mailbox)}
            />
          ))}
        </div>
      )}

      {/* OAuth Connections — single horizontal strip */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">OAuth Connections</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect Google Workspace or Microsoft 365 accounts for delegated mailbox access.
            </p>
          </div>
          <div className="flex flex-wrap items-stretch gap-2">
            <OAuthConnectButton
              provider="google"
              count={googleConnections}
              disabled={atCap}
              onClick={() => handleOAuthConnect('google')}
            />
            <OAuthConnectButton
              provider="microsoft"
              count={microsoftConnections}
              disabled={atCap}
              onClick={() => handleOAuthConnect('microsoft')}
            />
            <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-muted/30 px-4 py-2 min-w-[120px]">
              <p className="text-lg font-semibold text-foreground leading-none">{totalConnections}</p>
              <p className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">total connections</p>
            </div>
          </div>
        </div>
      </div>

      {/* Auto-Fetch Schedule */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-foreground">Auto-Fetch Schedule</h3>
            <p className="mt-1 text-sm text-muted-foreground">Automatically fetch emails on a schedule.</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-muted-foreground">
              {fetchEnabled ? 'Enabled' : 'Disabled'}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={fetchEnabled}
              onClick={() => {
                const next = !fetchEnabled;
                setFetchEnabled(next);
                updateSettings.mutate({ fetch_emails_enabled: String(next) });
              }}
              className={`relative inline-flex h-[22px] w-[42px] shrink-0 rounded-full transition-colors ${
                fetchEnabled ? 'bg-primary' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`absolute top-[2px] left-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform ${
                  fetchEnabled ? 'translate-x-[20px]' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>

        {fetchEnabled && (
          <div className="mt-5 grid grid-cols-1 gap-4 border-t border-border pt-5 lg:grid-cols-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">Interval</label>
              <div className="relative">
                <Clock className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <select
                  className="field-input pl-8 w-full"
                  value={fetchInterval}
                  onChange={(e) => setFetchInterval(e.target.value)}
                >
                  <option value="5">Every 5 minutes</option>
                  <option value="10">Every 10 minutes</option>
                  <option value="15">Every 15 minutes</option>
                  <option value="30">Every 30 minutes</option>
                  <option value="60">Every hour</option>
                  <option value="120">Every 2 hours</option>
                  <option value="240">Every 4 hours</option>
                  <option value="480">Every 8 hours</option>
                  <option value="1440">Once daily</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">Active days</label>
              <div className="flex flex-wrap gap-1">
                {(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const).map((day) => {
                  const active = fetchDays.split(',').map((d) => d.trim()).includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => {
                        const days = fetchDays.split(',').map((d) => d.trim()).filter(Boolean);
                        const next = active ? days.filter((d) => d !== day) : [...days, day];
                        setFetchDays(next.join(','));
                      }}
                      className={`px-2.5 py-1.5 rounded-md text-xs font-medium border transition ${
                        active
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-card text-muted-foreground border-border hover:border-foreground/40'
                      }`}
                    >
                      {day.charAt(0).toUpperCase() + day.slice(1)}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">Start time</label>
              <div className="relative">
                <Clock className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="time"
                  className="field-input pl-8 w-full"
                  value={fetchStartTime}
                  onChange={(e) => setFetchStartTime(e.target.value)}
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">End time</label>
              <div className="relative">
                <Clock className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="time"
                  className="field-input pl-8 w-full"
                  value={fetchEndTime}
                  onChange={(e) => setFetchEndTime(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}
        <div className="flex justify-end mt-4">
          <button
            type="button"
            className="action-button disabled:opacity-50"
            disabled={updateSettings.isPending}
            onClick={() => {
              updateSettings.mutate(
                {
                  fetch_emails_enabled: String(fetchEnabled),
                  fetch_emails_interval_minutes: fetchInterval,
                  fetch_emails_days: fetchDays,
                  fetch_emails_start_time: fetchStartTime,
                  fetch_emails_end_time: fetchEndTime,
                },
                {
                  onSuccess: () => {
                    setFetchSaved(true);
                    setTimeout(() => setFetchSaved(false), 2000);
                  },
                },
              );
            }}
          >
            <Calendar className="mr-2 h-4 w-4" />
            {fetchSaved ? 'Saved!' : 'Save Schedule'}
          </button>
        </div>
      </div>

      {/* Create / Edit modal */}
      {isPanelOpen && (
        <MailboxFormModal
          mode={editingMailbox ? 'edit' : 'create'}
          mailboxLabel={editingMailbox?.label}
          form={form}
          setForm={setForm}
          clients={clients}
          onClose={() => setIsPanelOpen(false)}
          onSubmit={handleSubmit}
          isSaving={createMailbox.isPending || updateMailbox.isPending}
        />
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────
// MailboxCard
// ─────────────────────────────────────────────────────────────────────

interface MailboxCardProps {
  mailbox: Mailbox;
  isOAuth: boolean;
  onEdit: () => void;
  onTest: () => void;
  onReconnect: () => void;
  onResetCursor: () => void;
  onDelete: () => void;
}

const MailboxCard: React.FC<MailboxCardProps> = ({
  mailbox, isOAuth, onEdit, onTest, onReconnect, onResetCursor, onDelete,
}) => {
  const [expanded, setExpanded] = React.useState(true);

  const subtitle = isOAuth
    ? 'OAuth mailbox'
    : `${mailbox.host ?? 'Host pending'}:${mailbox.port ?? 'N/A'} via ${mailbox.protocol}`;

  const connectionLabel = isOAuth
    ? `Connected via ${mailbox.oauth_provider === 'google' ? 'Google OAuth' : 'Microsoft OAuth'}`
    : `${mailbox.protocol?.toUpperCase() ?? ''} ${mailbox.use_ssl ? '· SSL' : ''}`;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="w-full flex items-center justify-between gap-3 px-5 py-4 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Mail className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-foreground truncate">{mailbox.label}</h3>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  mailbox.is_active
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {mailbox.is_active ? 'Active' : 'Paused'}
              </span>
              {mailbox.last_fetch_error && (
                <span
                  className="inline-flex items-center rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive"
                  title={mailbox.last_fetch_error}
                >
                  Fetch error
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{subtitle}</p>
          </div>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
        />
      </button>

      {expanded && (
        <div className="border-t border-border px-5 py-4 space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <InfoTile
              icon={<UserIcon className="h-4 w-4" />}
              label="Connected account"
              value={mailbox.username || mailbox.oauth_email || 'Not set'}
            />
            <InfoTile
              icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" />}
              label="Credentials"
              value={mailbox.has_password ? 'Saved securely' : 'Awaiting secret'}
              valueAccent={mailbox.has_password ? 'emerald' : 'amber'}
            />
            <InfoTile
              icon={<ProviderIcon provider={mailbox.oauth_provider} fallback={<Globe className="h-4 w-4" />} />}
              label="Connection"
              value={connectionLabel}
            />
          </div>

          {mailbox.last_fetch_error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.22em] text-destructive">Last fetch failed</p>
              <p className="mt-1 text-sm text-destructive/80">{mailbox.last_fetch_error}</p>
              {mailbox.last_fetch_failed_at && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {new Date(mailbox.last_fetch_failed_at).toLocaleString()}
                </p>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <CardActionButton onClick={onEdit} icon={<Pencil className="h-3.5 w-3.5" />} label="Edit" />
            <CardActionButton onClick={onTest} icon={<Play className="h-3.5 w-3.5" />} label="Test" />
            {isOAuth && (
              <CardActionButton
                onClick={onReconnect}
                icon={<Plug className="h-3.5 w-3.5" />}
                label="Reconnect"
                title="Re-authorize this OAuth mailbox"
              />
            )}
            <CardActionButton onClick={onResetCursor} icon={<RefreshCw className="h-3.5 w-3.5" />} label="Re-fetch all" />
            <CardActionButton
              onClick={onDelete}
              icon={<Trash2 className="h-3.5 w-3.5" />}
              label="Delete"
              tone="danger"
            />
          </div>
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Small UI helpers
// ─────────────────────────────────────────────────────────────────────

const InfoTile: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  valueAccent?: 'emerald' | 'amber';
}> = ({ icon, label, value, valueAccent }) => (
  <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 px-3 py-3">
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      {icon}
    </div>
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={`mt-0.5 text-sm font-medium truncate ${
          valueAccent === 'emerald'
            ? 'text-emerald-700 dark:text-emerald-300'
            : valueAccent === 'amber'
            ? 'text-amber-700 dark:text-amber-400'
            : 'text-foreground'
        }`}
      >
        {valueAccent === 'emerald' && <CheckCircle2 className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />}
        {value}
      </p>
    </div>
  </div>
);

const CardActionButton: React.FC<{
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  title?: string;
  tone?: 'default' | 'danger';
}> = ({ onClick, icon, label, title, tone = 'default' }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition ${
      tone === 'danger'
        ? 'border-destructive/30 text-destructive hover:bg-destructive/10'
        : 'border-border text-foreground hover:bg-muted/60'
    }`}
  >
    {icon}
    {label}
  </button>
);

const ProviderIcon: React.FC<{ provider: string | null | undefined; fallback: React.ReactNode }> = ({
  provider,
  fallback,
}) => {
  if (provider === 'google') {
    // Inline Google G mark — multi-color svg from the brand guidelines.
    return (
      <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden>
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 16 19 13 24 13c3 0 5.8 1.1 7.9 3l5.7-5.7C34.6 7.1 29.6 5 24 5 16.3 5 9.7 9.4 6.3 14.7z" />
        <path fill="#4CAF50" d="M24 44c5.5 0 10.5-2.1 14.3-5.5l-6.6-5.6C29.7 34.4 27 35 24 35c-5.3 0-9.7-3.4-11.3-8l-6.5 5C9.5 39.4 16.2 44 24 44z" />
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.4 4.3-4.5 5.6l6.6 5.6C41.4 36.6 44 30.7 44 24c0-1.3-.1-2.4-.4-3.5z" />
      </svg>
    );
  }
  if (provider === 'microsoft') {
    // Inline Microsoft four-square logo.
    return (
      <svg viewBox="0 0 23 23" className="h-4 w-4" aria-hidden>
        <rect x="1" y="1" width="10" height="10" fill="#F25022" />
        <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
        <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
        <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
      </svg>
    );
  }
  return <>{fallback}</>;
};

const OAuthConnectButton: React.FC<{
  provider: 'google' | 'microsoft';
  count: number;
  disabled: boolean;
  onClick: () => void;
}> = ({ provider, count, disabled, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={disabled ? 'Mailbox limit reached' : undefined}
    className="inline-flex items-center gap-2.5 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:border-foreground/40 disabled:opacity-50 disabled:cursor-not-allowed transition"
  >
    <ProviderIcon provider={provider} fallback={null} />
    Connect {provider === 'google' ? 'Google' : 'Microsoft'}
    <span className="inline-flex items-center justify-center rounded-md bg-muted/70 px-1.5 py-0.5 text-xs font-semibold text-foreground">
      {count}
    </span>
  </button>
);

// ─────────────────────────────────────────────────────────────────────
// Create / Edit modal
// ─────────────────────────────────────────────────────────────────────

interface MailboxFormModalProps {
  mode: 'create' | 'edit';
  mailboxLabel?: string;
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  clients: { id: number; name: string }[];
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => void;
  isSaving: boolean;
}

const MailboxFormModal: React.FC<MailboxFormModalProps> = ({
  mode, mailboxLabel, form, setForm, clients, onClose, onSubmit, isSaving,
}) => (
  <div
    className="fixed inset-0 z-[90] flex items-center justify-center bg-[rgba(0,0,0,0.45)] px-4 py-8 overflow-y-auto"
    onClick={onClose}
  >
    <div
      className="w-full max-w-[760px] my-auto rounded-xl bg-card shadow-[0_4px_24px_rgba(0,0,0,0.18)] border border-border"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Modal header */}
      <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-border">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Mail className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground leading-tight">
              {mode === 'edit' ? `Edit ${mailboxLabel ?? 'Mailbox'}` : 'New Mailbox'}
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5 leading-snug">
              Connect a mailbox for inbound timesheet processing and optional outbound email sending.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label="Close modal"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <form onSubmit={onSubmit}>
        <div className="px-6 py-5 space-y-4 max-h-[calc(100vh-220px)] overflow-y-auto">
          {/* 1. Identity */}
          <FormSection
            number={1}
            title="Identity"
            desc="Help you identify this mailbox and associate it with a client."
            icon={<UserIcon className="h-4 w-4" />}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <ModalField label="Label" hint="A friendly name for this mailbox.">
                <input
                  className="field-input"
                  value={form.label}
                  onChange={(e) => setForm((c) => ({ ...c, label: e.target.value }))}
                  required
                />
              </ModalField>
              <ModalField label="Linked client" hint="Associate this mailbox with a client (optional).">
                <select
                  className="field-input"
                  value={form.linked_client_id}
                  onChange={(e) => setForm((c) => ({ ...c, linked_client_id: e.target.value }))}
                >
                  <option value="">No linked client</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              </ModalField>
            </div>
          </FormSection>

          {/* 2. Connection settings */}
          <FormSection
            number={2}
            title="Connection settings"
            desc="Configure how to connect to the incoming mail server."
            icon={<Globe className="h-4 w-4" />}
          >
            <div className="grid gap-4 md:grid-cols-3 mb-4">
              <ModalField label="Protocol" hint="Choose the protocol for incoming mail.">
                <select
                  className="field-input"
                  value={form.protocol}
                  onChange={(e) => setForm((c) => ({ ...c, protocol: e.target.value }))}
                >
                  <option value="imap">IMAP</option>
                  <option value="pop3">POP3</option>
                  <option value="graph">Microsoft Graph</option>
                </select>
              </ModalField>
              <ModalField label="Authentication" hint="Select the authentication method.">
                <select
                  className="field-input"
                  value={form.auth_type}
                  onChange={(e) => setForm((c) => ({ ...c, auth_type: e.target.value }))}
                >
                  <option value="basic">Basic</option>
                  <option value="oauth2">OAuth</option>
                </select>
              </ModalField>
              <div className="space-y-3">
                <ModalCheckbox
                  label="Active mailbox"
                  hint="Enable this mailbox for processing."
                  checked={form.is_active}
                  onChange={(v) => setForm((c) => ({ ...c, is_active: v }))}
                />
                {form.auth_type === 'basic' && (
                  <ModalCheckbox
                    label="Use SSL"
                    hint="Encrypt the connection using SSL."
                    checked={form.use_ssl}
                    onChange={(v) => setForm((c) => ({ ...c, use_ssl: v }))}
                  />
                )}
              </div>
            </div>

            {form.auth_type === 'basic' ? (
              <div className="grid gap-4 md:grid-cols-2">
                <ModalField label="Host" hint="Incoming mail server (IMAP) host.">
                  <input
                    className="field-input"
                    value={form.host}
                    onChange={(e) => setForm((c) => ({ ...c, host: e.target.value }))}
                    required
                  />
                </ModalField>
                <ModalField label="Port" hint="Incoming mail server port.">
                  <input
                    className="field-input"
                    value={form.port}
                    onChange={(e) => setForm((c) => ({ ...c, port: e.target.value }))}
                  />
                </ModalField>
              </div>
            ) : (
              <ModalField label="OAuth provider" hint="Select the OAuth provider for this mailbox.">
                <select
                  className="field-input"
                  value={form.oauth_provider}
                  onChange={(e) =>
                    setForm((c) => ({ ...c, oauth_provider: e.target.value as OAuthProvider | '' }))
                  }
                >
                  <option value="">Select provider</option>
                  <option value="google">Google</option>
                  <option value="microsoft">Microsoft</option>
                </select>
              </ModalField>
            )}
          </FormSection>

          {/* 3. Login credentials */}
          <FormSection
            number={3}
            title="Login credentials"
            desc="Credentials used to sign in to the mailbox."
            icon={<Lock className="h-4 w-4" />}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <ModalField label="Username" hint="Mailbox username or email address.">
                <input
                  className="field-input"
                  value={form.username}
                  onChange={(e) => setForm((c) => ({ ...c, username: e.target.value }))}
                />
              </ModalField>
              <ModalField label="Password / App Secret" hint="Mailbox password or app-specific password.">
                <input
                  type="password"
                  className="field-input"
                  value={form.password}
                  onChange={(e) => setForm((c) => ({ ...c, password: e.target.value }))}
                />
              </ModalField>
            </div>
          </FormSection>

          {/* 4. SMTP (optional) */}
          <FormSection
            number={4}
            title="SMTP (optional)"
            desc="Only required if outbound email uses different SMTP settings."
            icon={<Send className="h-4 w-4" />}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <ModalField label="SMTP host" hint="Outgoing mail server (SMTP) host.">
                <input
                  className="field-input"
                  value={form.smtp_host}
                  onChange={(e) => setForm((c) => ({ ...c, smtp_host: e.target.value }))}
                />
              </ModalField>
              <ModalField label="SMTP port" hint="Outgoing mail server port.">
                <input
                  className="field-input"
                  value={form.smtp_port}
                  onChange={(e) => setForm((c) => ({ ...c, smtp_port: e.target.value }))}
                />
              </ModalField>
              <ModalField label="SMTP username" hint="Username for SMTP authentication.">
                <input
                  className="field-input"
                  value={form.smtp_username}
                  onChange={(e) => setForm((c) => ({ ...c, smtp_username: e.target.value }))}
                />
              </ModalField>
              <ModalField label="SMTP password" hint="Password for SMTP authentication.">
                <input
                  type="password"
                  className="field-input"
                  value={form.smtp_password}
                  onChange={(e) => setForm((c) => ({ ...c, smtp_password: e.target.value }))}
                />
              </ModalField>
            </div>
          </FormSection>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4 bg-muted/20">
          <button type="button" onClick={onClose} className="action-button-secondary">
            Cancel
          </button>
          <button type="submit" className="action-button" disabled={isSaving}>
            <Edit3 className="mr-2 h-4 w-4" />
            {isSaving ? 'Saving…' : mode === 'edit' ? 'Save Mailbox' : 'Create Mailbox'}
          </button>
        </div>
      </form>
    </div>
  </div>
);

const FormSection: React.FC<{
  number: number;
  title: string;
  desc: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}> = ({ number, title, desc, icon, children }) => (
  <div className="rounded-xl border border-border bg-muted/10 p-5">
    <div className="flex items-start gap-3 pb-4 mb-4 border-b border-border/60">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
        {icon}
      </div>
      <div>
        <h3 className="text-sm font-semibold text-foreground leading-tight">
          {number}. {title}
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{desc}</p>
      </div>
    </div>
    {children}
  </div>
);

const ModalField: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label, hint, children,
}) => (
  <div>
    <label className="block text-sm font-medium text-foreground mb-0.5">{label}</label>
    {hint && <p className="text-xs text-muted-foreground mb-1.5">{hint}</p>}
    {children}
  </div>
);

const ModalCheckbox: React.FC<{
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ label, hint, checked, onChange }) => (
  <label className="flex items-start gap-2.5 cursor-pointer">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
    />
    <div>
      <p className="text-sm font-medium text-foreground leading-tight">{label}</p>
      {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  </label>
);
