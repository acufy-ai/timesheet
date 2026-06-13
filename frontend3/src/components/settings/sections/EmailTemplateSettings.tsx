import React, { useEffect, useRef, useState } from 'react';
import { Eye, Lock, Mail, RefreshCcw, RefreshCw, Save } from 'lucide-react';
import axios from 'axios';

import { tenantSettingsApi } from '@/api/client';
import { useTenantFeatures, useTenantSettings, useUpdateTenantSettings } from '@/hooks/useAdmin';
import { SectionWrapper } from '@/components/settings/SettingsPrimitives';

type Purpose = 'invite' | 'reset';

const TABS: { key: Purpose; label: string }[] = [
  { key: 'invite', label: 'Invitation email' },
  { key: 'reset',  label: 'Password reset email' },
];

type TemplateDraft = {
  subject: string;
  greeting: string;
  body: string;
  button_label: string;
  signoff: string;
};

const EMPTY_DRAFT: TemplateDraft = { subject: '', greeting: '', body: '', button_label: '', signoff: '' };

const PLACEHOLDERS: Record<Purpose, TemplateDraft> = {
  invite: {
    subject:      "You're invited to Acufy Timesheet",
    greeting:     "welcome to our team!",
    body:         "Your account has been set up on Acufy Timesheet. Click the button below to set your password and get started.",
    button_label: "Set my password",
    signoff:      "Sent on behalf of Acme Corp",
  },
  reset: {
    subject:      "Reset your Acufy Timesheet password",
    greeting:     "we received a password reset request for your account.",
    body:         "Click the button below to choose a new password. If you didn't request this, you can safely ignore this email.",
    button_label: "Reset my password",
    signoff:      "Acufy AI Security",
  },
};

const FIELD_LABELS: Record<keyof TemplateDraft, string> = {
  subject:      'Subject line',
  greeting:     'Greeting (after "Hi [name],")',
  body:         'Body message',
  button_label: 'Button label',
  signoff:      'Sign-off',
};

const FIELD_HINTS: Record<Purpose, Record<keyof TemplateDraft, string>> = {
  invite: {
    subject:      'Shown in the recipient\'s inbox before they open the email.',
    greeting:     'Follows "Hi Alex," automatically. E.g. "welcome to Acme Corp!"',
    body:         'The main message below the greeting.',
    button_label: 'Text on the action button. E.g. "Set my password".',
    signoff:      'Small footer line below the button. E.g. "Sent by the Acme Corp HR team".',
  },
  reset: {
    subject:      'Shown in the recipient\'s inbox.',
    greeting:     'Follows "Hi Alex," automatically. E.g. "we received a request to reset your password."',
    body:         'The main message below the greeting.',
    button_label: 'Text on the action button. E.g. "Reset my password".',
    signoff:      'Small footer line below the button.',
  },
};

const KEY_MAP: Record<Purpose, Record<keyof TemplateDraft, string>> = {
  invite: {
    subject:      'invite_email_subject',
    greeting:     'invite_email_greeting',
    body:         'invite_email_body',
    button_label: 'invite_email_button_label',
    signoff:      'invite_email_signoff',
  },
  reset: {
    subject:      'reset_email_subject',
    greeting:     'reset_email_greeting',
    body:         'reset_email_body',
    button_label: 'reset_email_button_label',
    signoff:      'reset_email_signoff',
  },
};

const apiError = (err: unknown): string => {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail;
    if (typeof detail === 'string') return detail;
  }
  if (err instanceof Error) return err.message;
  return 'Couldn\'t save. Please try again.';
};

export const EmailTemplateSettings: React.FC = () => {
  const featuresQuery = useTenantFeatures();
  const settingsQuery = useTenantSettings();
  const updateSettings = useUpdateTenantSettings();

  const featureEnabled = featuresQuery.data?.custom_email_template ?? false;
  const isLoading = featuresQuery.isLoading || settingsQuery.isLoading;

  const [tab, setTab] = useState<Purpose>('invite');
  const [drafts, setDrafts] = useState<Record<Purpose, TemplateDraft>>({
    invite: { ...EMPTY_DRAFT },
    reset:  { ...EMPTY_DRAFT },
  });
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (!settingsQuery.data || seeded) return;
    const read = (p: Purpose): TemplateDraft => ({
      subject:      (settingsQuery.data[KEY_MAP[p].subject]      as string) ?? '',
      greeting:     (settingsQuery.data[KEY_MAP[p].greeting]     as string) ?? '',
      body:         (settingsQuery.data[KEY_MAP[p].body]         as string) ?? '',
      button_label: (settingsQuery.data[KEY_MAP[p].button_label] as string) ?? '',
      signoff:      (settingsQuery.data[KEY_MAP[p].signoff]      as string) ?? '',
    });
    setDrafts({ invite: read('invite'), reset: read('reset') });
    setSeeded(true);
  }, [settingsQuery.data, seeded]);

  const serverDraft = (p: Purpose): TemplateDraft => ({
    subject:      (settingsQuery.data?.[KEY_MAP[p].subject]      as string) ?? '',
    greeting:     (settingsQuery.data?.[KEY_MAP[p].greeting]     as string) ?? '',
    body:         (settingsQuery.data?.[KEY_MAP[p].body]         as string) ?? '',
    button_label: (settingsQuery.data?.[KEY_MAP[p].button_label] as string) ?? '',
    signoff:      (settingsQuery.data?.[KEY_MAP[p].signoff]      as string) ?? '',
  });

  const dirty = (p: Purpose) => {
    const s = serverDraft(p);
    const d = drafts[p];
    return (Object.keys(EMPTY_DRAFT) as Array<keyof TemplateDraft>).some((k) => d[k] !== s[k]);
  };

  const [saveFlash, setSaveFlash] = useState<Record<Purpose, 'idle' | 'saved' | 'error'>>({ invite: 'idle', reset: 'idle' });
  const [saveError, setSaveError] = useState<Record<Purpose, string>>({ invite: '', reset: '' });

  const handleSave = async (p: Purpose) => {
    setSaveError((e) => ({ ...e, [p]: '' }));
    const payload: Record<string, string> = {};
    (Object.keys(KEY_MAP[p]) as Array<keyof TemplateDraft>).forEach((field) => {
      payload[KEY_MAP[p][field]] = drafts[p][field];
    });
    try {
      await updateSettings.mutateAsync(payload);
      setSaveFlash((f) => ({ ...f, [p]: 'saved' }));
      setTimeout(() => setSaveFlash((f) => ({ ...f, [p]: 'idle' })), 2000);
    } catch (err) {
      setSaveError((e) => ({ ...e, [p]: apiError(err) }));
      setSaveFlash((f) => ({ ...f, [p]: 'error' }));
      setTimeout(() => setSaveFlash((f) => ({ ...f, [p]: 'idle' })), 4000);
    }
  };

  const setField = (p: Purpose, field: keyof TemplateDraft, value: string) =>
    setDrafts((d) => ({ ...d, [p]: { ...d[p], [field]: value } }));

  // Reset to default: clear every field for this tab and persist
  // empty strings so the platform defaults take effect immediately.
  const handleResetToDefault = async (p: Purpose) => {
    if (!window.confirm(`Reset the ${p === 'invite' ? 'invitation' : 'password reset'} email to platform defaults? Your customizations will be cleared.`)) {
      return;
    }
    setSaveError((e) => ({ ...e, [p]: '' }));
    const payload: Record<string, string> = {};
    (Object.keys(KEY_MAP[p]) as Array<keyof TemplateDraft>).forEach((field) => {
      payload[KEY_MAP[p][field]] = '';
    });
    try {
      await updateSettings.mutateAsync(payload);
      setDrafts((d) => ({ ...d, [p]: { ...EMPTY_DRAFT } }));
      setSaveFlash((f) => ({ ...f, [p]: 'saved' }));
      setTimeout(() => setSaveFlash((f) => ({ ...f, [p]: 'idle' })), 2000);
    } catch (err) {
      setSaveError((e) => ({ ...e, [p]: apiError(err) }));
      setSaveFlash((f) => ({ ...f, [p]: 'error' }));
      setTimeout(() => setSaveFlash((f) => ({ ...f, [p]: 'idle' })), 4000);
    }
  };

  if (isLoading) {
    return (
      <SectionWrapper title="Email templates" desc="Customise the emails sent to your users.">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </SectionWrapper>
    );
  }

  return (
    <SectionWrapper
      title="Email templates"
      desc="Customize invitation and password-reset emails sent to users. Leave any field blank to use the platform default."
    >
      {!featureEnabled && (
        <div className="rounded-xl border border-amber-300/40 bg-amber-50 dark:bg-amber-950/20 p-4 flex items-start gap-3">
          <Lock className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-900 dark:text-amber-100">Custom Email Templates is a paid feature</p>
            <p className="text-xs text-amber-800/80 dark:text-amber-200/80 mt-1 leading-relaxed">
              Your users receive the Acufy platform default emails. Contact your account manager to enable custom templates.
            </p>
          </div>
        </div>
      )}

      {/* Tab bar — underline style. Active tab gets a primary underline
          and pink icon; inactive tabs are muted. Dirty-dot stays so
          editors can see which tab has unsaved changes. */}
      <div className="flex items-center gap-6 border-b border-border">
        {TABS.map((t) => {
          const Icon = t.key === 'invite' ? Mail : Lock;
          const isActive = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`relative inline-flex items-center gap-2 px-1 py-3 text-sm font-medium transition-colors ${
                isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className={`h-4 w-4 ${isActive ? 'text-primary' : 'text-muted-foreground'}`} />
              {t.label}
              {dirty(t.key) && <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-amber-500 align-middle" />}
              {isActive && <span className="absolute -bottom-px left-0 right-0 h-[2px] bg-primary rounded-t" />}
            </button>
          );
        })}
      </div>

      {TABS.map((t) => tab === t.key && (
        <TabPanel
          key={t.key}
          purpose={t.key}
          draft={drafts[t.key]}
          featureEnabled={featureEnabled}
          isSaving={updateSettings.isPending}
          dirty={dirty(t.key)}
          saveFlash={saveFlash[t.key]}
          saveError={saveError[t.key]}
          onChange={setField}
          onSave={() => handleSave(t.key)}
          onResetToDefault={() => handleResetToDefault(t.key)}
          settingsReady={seeded}
        />
      ))}
    </SectionWrapper>
  );
};

// ─────────────────────────────────────────────────────────────────────────────

interface TabPanelProps {
  purpose: Purpose;
  draft: TemplateDraft;
  featureEnabled: boolean;
  isSaving: boolean;
  dirty: boolean;
  saveFlash: 'idle' | 'saved' | 'error';
  saveError: string;
  onChange: (p: Purpose, field: keyof TemplateDraft, value: string) => void;
  onSave: () => void;
  onResetToDefault: () => void;
  settingsReady: boolean;
}

const TabPanel: React.FC<TabPanelProps> = ({
  purpose, draft, featureEnabled, isSaving, dirty,
  saveFlash, saveError, onChange, onSave, onResetToDefault, settingsReady,
}) => {
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewSubject, setPreviewSubject] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const fetchPreview = async (d: TemplateDraft) => {
    setPreviewing(true);
    try {
      const res = await tenantSettingsApi.emailTemplatePreview({ purpose, ...d });
      setPreviewHtml(res.data.html ?? '');
      setPreviewSubject(res.data.subject ?? '');
    } catch {
      // keep last preview
    } finally {
      setPreviewing(false);
    }
  };

  useEffect(() => {
    if (!settingsReady) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchPreview(draft), 600);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.subject, draft.greeting, draft.body, draft.button_label, draft.signoff, purpose, settingsReady]);

  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(previewHtml || '<html><body style="margin:0;background:#f1f5f9;"></body></html>');
    doc.close();
  }, [previewHtml]);

  const disabled = !featureEnabled;
  const fields = Object.keys(EMPTY_DRAFT) as Array<keyof TemplateDraft>;
  const saveLabel =
    saveFlash === 'saved' ? 'Saved!' :
    saveFlash === 'error' ? 'Error' :
    isSaving ? 'Saving…' : 'Save changes';

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">

      {/* Editor column */}
      <div className="rounded-xl border border-border bg-card overflow-hidden flex flex-col">
        <div className="flex items-start gap-3 p-5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Mail className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground leading-tight">Template fields</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Leaving a field blank uses the platform default.
            </p>
          </div>
        </div>
        <div className={`px-5 pb-5 space-y-4 ${disabled ? 'opacity-50 pointer-events-none select-none' : ''}`}>
          {fields.map((field) => (
            <div key={field}>
              <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                {FIELD_LABELS[field]}
              </label>
              {field === 'body' ? (
                <textarea
                  className="field-input w-full text-sm"
                  rows={3}
                  placeholder={PLACEHOLDERS[purpose][field]}
                  value={draft[field]}
                  maxLength={500}
                  onChange={(e) => onChange(purpose, field, e.target.value)}
                />
              ) : (
                <input
                  type="text"
                  className="field-input w-full text-sm"
                  placeholder={PLACEHOLDERS[purpose][field]}
                  value={draft[field]}
                  maxLength={field === 'subject' || field === 'greeting' || field === 'signoff' ? 200 : 60}
                  onChange={(e) => onChange(purpose, field, e.target.value)}
                />
              )}
              <p className="text-[10.5px] text-muted-foreground/60 mt-0.5">
                {FIELD_HINTS[purpose][field]}
              </p>
            </div>
          ))}
        </div>
        {saveError && <p className="text-xs text-rose-600 px-5 pb-2">{saveError}</p>}
        <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/20 px-5 py-4">
          <button
            type="button"
            onClick={onResetToDefault}
            disabled={disabled || isSaving}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted/60 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Clear all customizations and use the platform default for every field."
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            Reset to default
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={disabled || isSaving || !dirty}
            className="action-button disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save className="mr-2 h-3.5 w-3.5" />
            {saveLabel}
          </button>
        </div>
      </div>

      {/* Preview column */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-start gap-3 p-5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Eye className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground leading-tight">Live preview</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {previewSubject ? <>Subject: <span className="font-medium text-foreground">"{previewSubject}"</span></> : 'Showing platform default.'}
            </p>
          </div>
        </div>
        <div className="px-5 pb-5">
          <div className="relative rounded-lg border border-border overflow-hidden bg-[#f1f5f9]" style={{ height: 500 }}>
            {previewing && (
              <div className="absolute inset-0 flex items-center justify-center bg-card/60 z-10">
                <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
            )}
            <iframe
              ref={iframeRef}
              title="Email preview"
              className="w-full h-full border-0"
              sandbox="allow-same-origin"
            />
          </div>
          <p className="text-[10.5px] text-muted-foreground/60 mt-2 flex items-center gap-1">
            <span className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-muted text-muted-foreground text-[8px] font-semibold">i</span>
            Preview uses sample data: name = Alex, org = Acme Corp.
          </p>
        </div>
      </div>

    </div>
  );
};
