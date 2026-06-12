import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Mail, Lock, ExternalLink, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import axios from 'axios';

import { brandingApi, tenantSettingsApi } from '@/api/client';
import { withBase } from '@/lib/basePath';
import { useMailboxes, useTenantSettings, useUpdateTenantSettings } from '@/hooks/useAdmin';
import { SectionWrapper, Card } from '@/components/settings/SettingsPrimitives';
import { TenantSettingsForm } from '@/components/TenantSettingsForm';

type OutboundSource = 'platform' | 'oauth_mailbox' | 'custom_smtp';

const apiError = (err: unknown): string => {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail;
    if (typeof detail === 'string') return detail;
  }
  if (err instanceof Error) return err.message;
  return 'Save failed.';
};

export const OutboundEmailSettings: React.FC = () => {
  // Read this tenant's feature flags so we know whether to render the
  // upgrade hint or the full radio control. Reads /tenants/mine/features
  // which is gated to the user's own tenant on the backend.
  const featuresQuery = useQuery({
    queryKey: ['tenant-features-mine'],
    queryFn: () => brandingApi.features().then((r) => r.data),
  });

  const mailboxesQuery = useMailboxes();
  const settingsQuery = useTenantSettings();
  const updateSettings = useUpdateTenantSettings();

  const hasActiveMailbox = useMemo(
    () => (mailboxesQuery.data ?? []).some((m) => m.is_active),
    [mailboxesQuery.data],
  );
  const activeMailboxAddress = useMemo(
    () => (mailboxesQuery.data ?? []).find((m) => m.is_active)?.oauth_email ?? null,
    [mailboxesQuery.data],
  );

  const serverValue = (settingsQuery.data?.outbound_email_source as OutboundSource | undefined) ?? 'platform';

  const [selected, setSelected] = useState<OutboundSource>(serverValue);
  const [saveError, setSaveError] = useState<string>('');
  const [saveFlash, setSaveFlash] = useState<'idle' | 'saved'>('idle');
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testDetail, setTestDetail] = useState<string>('');

  // Re-seed when the server data arrives or changes (avoids stale UI
  // after a different page wrote the same setting).
  useEffect(() => {
    setSelected(serverValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsQuery.data?.outbound_email_source]);

  const featureEnabled = featuresQuery.data?.custom_outbound_email ?? false;
  const isLoading = featuresQuery.isLoading || settingsQuery.isLoading || mailboxesQuery.isLoading;
  const isSaving = updateSettings.isPending;
  const dirty = selected !== serverValue;

  const handleTestSmtp = async () => {
    setTestState('testing');
    setTestDetail('');
    try {
      const res = await tenantSettingsApi.smtpTest();
      if (res.data.ok) {
        setTestState('ok');
      } else {
        setTestState('fail');
        setTestDetail(res.data.detail ?? 'Connection failed.');
      }
    } catch (err) {
      setTestState('fail');
      setTestDetail(apiError(err));
    }
    setTimeout(() => setTestState('idle'), 8000);
  };

  const handleSave = async () => {
    setSaveError('');
    setSaveFlash('idle');
    try {
      await updateSettings.mutateAsync({ outbound_email_source: selected });
      setSaveFlash('saved');
      setTimeout(() => setSaveFlash('idle'), 2000);
    } catch (err) {
      setSaveError(apiError(err));
    }
  };

  return (
    <SectionWrapper
      title="Outbound Email"
      desc="Where invitation, password-reset, and notification emails are sent from. Affects emails leaving your tenant only."
    >
      {!featureEnabled && (
        <div className="rounded-xl border border-amber-300/40 bg-amber-50 dark:bg-amber-950/20 p-4 flex items-start gap-3">
          <Lock className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
              Custom Outbound Email is a paid feature
            </p>
            <p className="text-xs text-amber-800/80 dark:text-amber-200/80 mt-1 leading-relaxed">
              Your emails are currently sent through the Acufy platform. Contact your account manager
              to enable sending from your own mailbox or SMTP server.
            </p>
          </div>
        </div>
      )}

      <Card
        title="Email source"
        desc="Select which channel Acufy uses to deliver outbound emails on behalf of your tenant."
      >
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-2">Loading…</p>
        ) : (
          <div className="space-y-2.5">
            <RadioOption
              checked={selected === 'platform'}
              disabled={isSaving}
              onSelect={() => setSelected('platform')}
              label="Platform default"
              hint="Emails sent from the Acufy infrastructure. No setup required."
            />
            <RadioOption
              checked={selected === 'oauth_mailbox'}
              disabled={isSaving || !featureEnabled || !hasActiveMailbox}
              onSelect={() => setSelected('oauth_mailbox')}
              label={
                hasActiveMailbox && activeMailboxAddress
                  ? `Use my connected mailbox (${activeMailboxAddress})`
                  : 'Use a connected mailbox'
              }
              hint={
                hasActiveMailbox
                  ? 'Send via the Google or Microsoft mailbox you connected for email ingestion. Emails appear to come from that address.'
                  : 'No mailbox connected. Connect one in the Mailboxes page first.'
              }
              rightSlot={
                !hasActiveMailbox ? (
                  <a
                    href={withBase('/settings?section=mailboxes')}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline whitespace-nowrap"
                  >
                    Connect <ExternalLink className="w-3 h-3" />
                  </a>
                ) : null
              }
            />
            <RadioOption
              checked={selected === 'custom_smtp'}
              disabled={isSaving || !featureEnabled}
              onSelect={() => { setSelected('custom_smtp'); setTestState('idle'); setTestDetail(''); }}
              label="Use my own SMTP server"
              hint="Enter your SMTP credentials below. The Test connection button is enabled once a host is set and your selection is saved."
              rightSlot={
                selected === 'custom_smtp' && featureEnabled ? (
                  <SmtpTestButton
                    state={testState}
                    detail={testDetail}
                    onTest={handleTestSmtp}
                    disabled={dirty || !(settingsQuery.data?.smtp_host && String(settingsQuery.data.smtp_host).trim() !== '')}
                  />
                ) : null
              }
            />

            {selected === 'custom_smtp' && featureEnabled && (
              <div className="ml-7 mt-3 rounded-lg border border-border bg-background/40">
                <div className="px-4 py-2 border-b border-border">
                  <p className="text-xs font-medium text-foreground">SMTP credentials</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Stored encrypted. Save your "Use my own SMTP server" choice above before testing the connection.
                  </p>
                </div>
                <TenantSettingsForm filterCategories={['email']} showHeader={false} />
              </div>
            )}
          </div>
        )}

        {saveError && (
          <p className="text-sm text-rose-600 mt-3">{saveError}</p>
        )}

        <div className="flex items-center justify-between mt-4">
          <p className="text-xs text-muted-foreground">
            {saveFlash === 'saved' ? 'Saved.' : dirty ? 'Unsaved changes.' : ' '}
          </p>
          <button
            type="button"
            disabled={!dirty || isSaving}
            onClick={handleSave}
            className="action-button text-sm disabled:opacity-50"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </Card>
    </SectionWrapper>
  );
};

const SmtpTestButton: React.FC<{
  state: 'idle' | 'testing' | 'ok' | 'fail';
  detail: string;
  onTest: () => void;
  disabled?: boolean;
}> = ({ state, detail, onTest, disabled }) => (
  <div className="flex flex-col items-end gap-1 shrink-0">
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); onTest(); }}
      disabled={state === 'testing' || disabled}
      title={disabled ? 'Save your outbound choice and enter at least an SMTP host first.' : undefined}
      className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-border hover:border-foreground/40 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
    >
      {state === 'testing' && <Loader2 className="w-3 h-3 animate-spin" />}
      {state === 'ok' && <CheckCircle2 className="w-3 h-3 text-green-600" />}
      {state === 'fail' && <XCircle className="w-3 h-3 text-rose-600" />}
      {state === 'idle' && null}
      {state === 'testing' ? 'Testing…' : 'Test connection'}
    </button>
    {state === 'ok' && (
      <span className="text-xs text-green-700 dark:text-green-400">Connected.</span>
    )}
    {state === 'fail' && detail && (
      <span className="text-xs text-rose-600 max-w-[180px] text-right leading-tight">{detail}</span>
    )}
  </div>
);

const RadioOption: React.FC<{
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  label: string;
  hint: string;
  rightSlot?: React.ReactNode;
}> = ({ checked, disabled, onSelect, label, hint, rightSlot }) => (
  <label
    className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
      disabled
        ? 'opacity-60 cursor-not-allowed border-border'
        : checked
        ? 'border-primary bg-primary/5 cursor-pointer'
        : 'border-border hover:border-foreground/30 cursor-pointer'
    }`}
  >
    <input
      type="radio"
      checked={checked}
      disabled={disabled}
      onChange={() => !disabled && onSelect()}
      className="mt-1 flex-shrink-0"
    />
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <Mail className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <span className="text-sm font-medium text-foreground">{label}</span>
      </div>
      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{hint}</p>
    </div>
    {rightSlot}
  </label>
);
