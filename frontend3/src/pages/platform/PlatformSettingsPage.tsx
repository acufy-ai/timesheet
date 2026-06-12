import { useEffect, useState } from 'react';
import { Eye, EyeOff, Loader2, Mail } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

import { Button, Card, Empty, Input, TonePill, WorkspaceHeader } from '@/components/ui';
import { platformApi } from '@/api/client';
import { usePlatformSmtp } from '@/hooks/usePlatform';

// Platform-admin settings: the platform-default outbound SMTP config used for
// invitations / password resets when a tenant has no custom mailbox.
//
// The config has a `source` ("environment" | "database"): env vars are the
// fallback default; a saved DB config overrides them. We surface that source
// as a header badge and show a read-only status view when not editing, so an
// operator can tell at a glance which config is live without opening the form.
//
// NOTE: the Platform Admins management section (add/remove PAs) from
// frontend2 is intentionally omitted here — it needs a control-plane
// platform_admins endpoint that frontend3's API layer does not yet expose.
export function PlatformSettingsPage() {
  const qc = useQueryClient();
  const q = usePlatformSmtp();
  const config = q.data;

  const [editMode, setEditMode] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState({
    smtp_host: '',
    smtp_port: '587',
    smtp_username: '',
    smtp_password: '',
    smtp_use_tls: true,
    smtp_from_address: '',
    smtp_from_name: '',
  });
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const flashAndFade = (tone: 'ok' | 'err', text: string) => {
    setFlash({ tone, text });
    window.setTimeout(() => setFlash(null), 4000);
  };

  // Seed the form from the live config whenever it loads / changes. Password is
  // never returned, so it stays blank (blank on save = keep existing).
  useEffect(() => {
    if (!config) return;
    setForm({
      smtp_host: config.smtp_host ?? '',
      smtp_port: config.smtp_port != null ? String(config.smtp_port) : '587',
      smtp_username: config.smtp_username ?? '',
      smtp_password: '',
      smtp_use_tls: config.smtp_use_tls ?? true,
      smtp_from_address: config.smtp_from_address ?? '',
      smtp_from_name: config.smtp_from_name ?? '',
    });
  }, [config]);

  const openEdit = () => {
    setShowPassword(false);
    setEditMode(true);
  };

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await platformApi.updateSmtp({
        smtp_host: form.smtp_host.trim(),
        smtp_port: form.smtp_port ? Number(form.smtp_port) : 587,
        smtp_username: form.smtp_username.trim(),
        // null = keep existing; only send a value when the operator typed one.
        smtp_password: form.smtp_password ? form.smtp_password : null,
        smtp_use_tls: form.smtp_use_tls,
        smtp_from_address: form.smtp_from_address.trim(),
        smtp_from_name: form.smtp_from_name.trim(),
      });
      await qc.invalidateQueries({ queryKey: ['platform', 'smtp'] });
      setEditMode(false);
      flashAndFade('ok', 'SMTP settings saved.');
    } catch (err) {
      const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      flashAndFade('err', typeof d === 'string' ? d : 'Could not save SMTP settings.');
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setClearing(true);
    try {
      await platformApi.deleteSmtp();
      await qc.invalidateQueries({ queryKey: ['platform', 'smtp'] });
      setEditMode(false);
      flashAndFade('ok', 'SMTP config cleared. Environment variables are now active.');
    } catch (err) {
      const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      flashAndFade('err', typeof d === 'string' ? d : 'Could not reset SMTP settings.');
    } finally {
      setClearing(false);
    }
  }

  const labelClass = 'mb-1 block text-xs font-medium text-muted-foreground';
  const isDbSource = config?.source === 'database';

  return (
    <div className="space-y-5">
      <WorkspaceHeader title="Platform settings" description="Default outbound email for the whole fleet." />

      {flash ? (
        <div
          role="alert"
          className={
            'rounded-xl border px-3 py-2 text-sm ' +
            (flash.tone === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300')
          }
        >
          {flash.text}
        </div>
      ) : null}

      {q.isLoading ? (
        <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
        </div>
      ) : q.isError ? (
        <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">Couldn't load platform settings.</Card>
      ) : (
        <Card className="p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-2 min-w-0">
              <Mail className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-foreground">Default SMTP</p>
                  {/* Source badge: env-var fallback (amber) vs DB override (emerald). */}
                  {config?.source === 'environment' ? (
                    <TonePill tone="warning">Using env vars</TonePill>
                  ) : isDbSource ? (
                    <TonePill tone="success">DB configured</TonePill>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Used for password resets, invitations, and onboarding emails before a tenant configures
                  its own mailbox. Tenants can override this per workspace.
                </p>
              </div>
            </div>
            {!editMode ? (
              <div className="flex shrink-0 items-center gap-2">
                {isDbSource ? (
                  <Button variant="ghost" size="sm" onClick={handleReset} disabled={clearing}>
                    {clearing ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" /> Resetting…
                      </>
                    ) : (
                      'Reset to env vars'
                    )}
                  </Button>
                ) : null}
                <Button variant="secondary" size="sm" onClick={openEdit}>
                  {config?.smtp_host ? 'Edit' : 'Configure'}
                </Button>
              </div>
            ) : null}
          </div>

          {!editMode ? (
            config?.smtp_host ? (
              // Read-only 6-field status view (host+port, username, password,
              // TLS, from address, from name) of the currently-live config.
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className={labelClass}>Host</dt>
                  <dd className="font-mono text-foreground">
                    {config.smtp_host}:{config.smtp_port}
                  </dd>
                </div>
                <div>
                  <dt className={labelClass}>Username</dt>
                  <dd className="font-mono text-foreground">{config.smtp_username || '—'}</dd>
                </div>
                <div>
                  <dt className={labelClass}>Password</dt>
                  <dd className="text-foreground">{config.smtp_password_set ? '••••••••' : '—'}</dd>
                </div>
                <div>
                  <dt className={labelClass}>TLS</dt>
                  <dd className="text-foreground">{config.smtp_use_tls ? 'Enabled' : 'Disabled'}</dd>
                </div>
                <div>
                  <dt className={labelClass}>From email</dt>
                  <dd className="text-foreground">{config.smtp_from_address || '—'}</dd>
                </div>
                <div>
                  <dt className={labelClass}>From name</dt>
                  <dd className="text-foreground">{config.smtp_from_name || '—'}</dd>
                </div>
              </dl>
            ) : (
              <Empty
                Icon={Mail}
                title="No SMTP server configured"
                description="Without an SMTP host, password-reset and invitation emails are logged to the container console instead of being delivered. Configure once here and every tenant inherits this default."
                action={
                  <Button size="sm" onClick={openEdit}>
                    <Mail className="h-3.5 w-3.5" /> Configure SMTP
                  </Button>
                }
              />
            )
          ) : (
            <form onSubmit={handleSave} className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px]">
                <div>
                  <label className={labelClass}>Host</label>
                  <Input
                    value={form.smtp_host}
                    onChange={(e) => setForm({ ...form, smtp_host: e.target.value })}
                    placeholder="smtp.example.com"
                  />
                </div>
                <div>
                  <label className={labelClass}>Port</label>
                  <Input
                    type="number"
                    value={form.smtp_port}
                    onChange={(e) => setForm({ ...form, smtp_port: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Username</label>
                  <Input
                    value={form.smtp_username}
                    onChange={(e) => setForm({ ...form, smtp_username: e.target.value })}
                  />
                </div>
                <div>
                  <label className={labelClass}>
                    Password {config?.smtp_password_set ? '(set — leave blank to keep)' : ''}
                  </label>
                  <div className="relative">
                    <Input
                      type={showPassword ? 'text' : 'password'}
                      value={form.smtp_password}
                      onChange={(e) => setForm({ ...form, smtp_password: e.target.value })}
                      placeholder={config?.smtp_password_set ? '••••••••' : 'Enter password'}
                      autoComplete="off"
                      className="pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>From email</label>
                  <Input
                    type="email"
                    value={form.smtp_from_address}
                    onChange={(e) => setForm({ ...form, smtp_from_address: e.target.value })}
                    placeholder="no-reply@acufy.ai"
                  />
                </div>
                <div>
                  <label className={labelClass}>From name</label>
                  <Input
                    value={form.smtp_from_name}
                    onChange={(e) => setForm({ ...form, smtp_from_name: e.target.value })}
                    placeholder="Acufy AI"
                  />
                </div>
              </div>
              <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={form.smtp_use_tls}
                  onChange={(e) => setForm({ ...form, smtp_use_tls: e.target.checked })}
                  className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]"
                />
                Use TLS
              </label>
              <div className="flex items-center gap-2 pt-1">
                <Button type="submit" disabled={saving}>
                  {saving ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                    </>
                  ) : (
                    'Save settings'
                  )}
                </Button>
                <Button type="button" variant="secondary" onClick={() => setEditMode(false)} disabled={saving}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </Card>
      )}
    </div>
  );
}
