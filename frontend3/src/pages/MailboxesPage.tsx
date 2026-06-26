import { useEffect, useRef, useState } from 'react';
import { Loader2, Mail, Plus, RotateCcw, Trash2, Zap } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

import { Button, Card, Empty, FieldError, Input, Modal, RequiredMark, StatusBadge, Toast, TonePill, WorkspaceHeader } from '@/components/ui';
import {
  useCreateMailbox,
  useDeleteMailbox,
  useMailboxes,
  useResetMailboxCursor,
  useTestMailbox,
} from '@/hooks/useAdmin';
import { API_BASE, mailboxesApi } from '@/api/client';
import type { Mailbox, MailboxCreateBody } from '@/types/admin';

// Origin the OAuth callback popup posts back from (the API origin). Used to
// validate the postMessage. API_BASE may be a relative '/api' (same origin) or
// an absolute URL; resolve it against the current location either way.
const API_ORIGIN = (() => {
  try { return new URL(API_BASE, window.location.origin).origin; }
  catch { return window.location.origin; }
})();

function errText(err: unknown, fb: string): string {
  const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof d === 'string' ? d : fb;
}
function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Mailbox configuration for email ingestion: connect Gmail/Outlook via OAuth,
// or add an IMAP mailbox with credentials. Per-row test / reset-cursor / delete.
export function MailboxesPage() {
  const qc = useQueryClient();
  const q = useMailboxes();
  const create = useCreateMailbox();
  const del = useDeleteMailbox();
  const test = useTestMailbox();
  const resetCursor = useResetMailboxCursor();

  const [addOpen, setAddOpen] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [testResult, setTestResult] = useState<Record<number, string>>({});
  const [connecting, setConnecting] = useState<null | 'google' | 'microsoft'>(null);
  const flashAndFade = (tone: 'ok' | 'err', text: string) => { setFlash({ tone, text }); window.setTimeout(() => setFlash(null), 5000); };

  // Handle to the OAuth popup so we can poll for the user closing it manually.
  const popupRef = useRef<Window | null>(null);

  // IMAP add form.
  const [form, setForm] = useState({ label: '', host: '', port: '993', username: '', password: '', use_ssl: true });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const mailboxes = q.data ?? [];

  // Listen for the OAuth callback popup's postMessage (the backend posts
  // { type: 'mailbox-oauth', status, message } then auto-closes). On success we
  // refetch the mailbox list so the new mailbox shows without a manual reload.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== API_ORIGIN) return;
      const data = e.data as { type?: string; status?: string; message?: string } | null;
      if (!data || data.type !== 'mailbox-oauth') return;
      setConnecting(null);
      if (data.status === 'success') {
        qc.invalidateQueries({ queryKey: ['mailboxes'] });
        flashAndFade('ok', data.message || 'Mailbox connected.');
      } else {
        flashAndFade('err', data.message || 'Could not connect the mailbox.');
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connectOAuth(provider: 'google' | 'microsoft') {
    try {
      // Open the popup synchronously (inside the click) so the browser doesn't
      // block it, then point it at the auth URL once we have it.
      const popup = window.open('about:blank', 'mailbox-oauth', 'width=520,height=680');
      const res = await mailboxesApi.oauthConnect(provider);
      if (popup && !popup.closed) {
        popup.location.href = res.data.auth_url;
        popupRef.current = popup;
        setConnecting(provider);
        // If the user closes the popup without finishing, clear the busy state.
        const timer = window.setInterval(() => {
          if (!popupRef.current || popupRef.current.closed) {
            window.clearInterval(timer);
            setConnecting((c) => (c === provider ? null : c));
            // Refetch in case the connection succeeded right before close.
            qc.invalidateQueries({ queryKey: ['mailboxes'] });
          }
        }, 800);
      } else {
        // Popup blocked — fall back to same-tab navigation (old behavior).
        window.location.href = res.data.auth_url;
      }
    } catch (err) {
      popupRef.current?.close();
      setConnecting(null);
      flashAndFade('err', errText(err, `Could not start ${provider} connection.`));
    }
  }
  async function addImap(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.label.trim()) errs.label = 'This field is required.';
    if (!form.host.trim()) errs.host = 'This field is required.';
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setErrors({});
    const body: MailboxCreateBody = {
      label: form.label.trim(),
      protocol: 'imap',
      auth_type: 'basic',
      host: form.host.trim(),
      port: form.port ? Number(form.port) : 993,
      use_ssl: form.use_ssl,
      username: form.username.trim() || null,
      password: form.password || null,
    };
    try {
      await create.mutateAsync(body);
      setAddOpen(false);
      setForm({ label: '', host: '', port: '993', username: '', password: '', use_ssl: true });
      setErrors({});
      flashAndFade('ok', 'Mailbox added.');
    } catch (err) {
      flashAndFade('err', errText(err, 'Could not add the mailbox.'));
    }
  }
  async function runTest(m: Mailbox) {
    setTestResult((s) => ({ ...s, [m.id]: 'testing' }));
    try {
      const r = await test.mutateAsync(m.id);
      setTestResult((s) => ({ ...s, [m.id]: r.success ? `OK · ${r.message_count} msgs · ${r.latency_ms}ms` : (r.error ?? 'Failed') }));
    } catch (err) {
      setTestResult((s) => ({ ...s, [m.id]: errText(err, 'Connection test failed. Check the host and credentials.') }));
    }
  }
  async function removeMailbox(m: Mailbox) {
    if (!window.confirm(`Remove mailbox "${m.label}"?`)) return;
    try { await del.mutateAsync(m.id); flashAndFade('ok', 'Mailbox removed.'); }
    catch (err) { flashAndFade('err', errText(err, 'Could not remove the mailbox.')); }
  }
  async function reset(m: Mailbox) {
    if (!window.confirm(`Reset the fetch cursor for "${m.label}"? The next fetch will re-scan from the start.`)) return;
    try { await resetCursor.mutateAsync(m.id); flashAndFade('ok', 'Fetch cursor reset.'); }
    catch (err) { flashAndFade('err', errText(err, 'Could not reset the cursor.')); }
  }

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        title="Mailboxes"
        description="Connect inboxes so timesheet emails are processed automatically."
        primary={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => connectOAuth('google')} disabled={connecting !== null}>
              {connecting === 'google' ? <><Loader2 className="h-4 w-4 animate-spin" /> Connecting…</> : 'Connect Gmail'}
            </Button>
            <Button variant="secondary" onClick={() => connectOAuth('microsoft')} disabled={connecting !== null}>
              {connecting === 'microsoft' ? <><Loader2 className="h-4 w-4 animate-spin" /> Connecting…</> : 'Connect Outlook'}
            </Button>
            <Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add IMAP</Button>
          </div>
        }
      />

      {flash ? (
        <Toast tone={flash.tone} message={flash.text} onDismiss={() => setFlash(null)} />
      ) : null}

      {q.isLoading ? (
        <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>
      ) : q.isError ? (
        <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">Couldn't load mailboxes. You may not have access.</Card>
      ) : mailboxes.length === 0 ? (
        <Empty Icon={Mail} title="No mailboxes connected" description="Connect a Gmail/Outlook account or add an IMAP mailbox to start processing timesheet emails." />
      ) : (
        <div className="space-y-3">
          {mailboxes.map((m) => (
            <Card key={m.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary"><Mail className="h-5 w-5" /></span>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-foreground">{m.label}</p>
                      {m.is_active ? <StatusBadge status="approved" variant="timesheet" label="Active" showIcon={false} /> : <TonePill tone="neutral">Inactive</TonePill>}
                      {m.oauth_provider ? <TonePill tone="info">{m.oauth_provider}</TonePill> : <TonePill tone="neutral">IMAP</TonePill>}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {m.oauth_email ?? m.username ?? m.host ?? '—'} · last fetched {relTime(m.last_fetched_at)}
                    </p>
                    {m.last_fetch_error ? <p className="mt-0.5 text-xs text-rose-600 dark:text-rose-300">{m.last_fetch_error}</p> : null}
                    {m.auto_disabled_reason ? <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-300">Auto-disabled: {m.auto_disabled_reason}</p> : null}
                    {testResult[m.id] ? <p className="mt-1 text-xs text-muted-foreground">Test: {testResult[m.id]}</p> : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => runTest(m)} disabled={testResult[m.id] === 'testing'}>
                    {testResult[m.id] === 'testing' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />} Test
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => reset(m)} title="Reset fetch cursor"><RotateCcw className="h-3.5 w-3.5" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => removeMailbox(m)} title="Remove" className="text-rose-600 hover:bg-rose-500/10 dark:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Add IMAP modal */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add IMAP mailbox">
        <form onSubmit={addImap} className="space-y-3">
          <div>
            <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Label<RequiredMark /></label>
            <Input error={!!errors.label} value={form.label} onChange={(e) => { setForm({ ...form, label: e.target.value }); if (errors.label) setErrors((s) => ({ ...s, label: '' })); }} placeholder="Timesheets inbox" />
            <FieldError error={errors.label} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_100px]">
            <div>
              <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Host<RequiredMark /></label>
              <Input error={!!errors.host} value={form.host} onChange={(e) => { setForm({ ...form, host: e.target.value }); if (errors.host) setErrors((s) => ({ ...s, host: '' })); }} placeholder="imap.example.com" />
              <FieldError error={errors.host} />
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Port</label>
              <Input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Username</label>
              <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="user@example.com" />
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Password</label>
              <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="off" />
            </div>
          </div>
          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={form.use_ssl} onChange={(e) => setForm({ ...form, use_ssl: e.target.checked })} className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]" />
            Use SSL/TLS
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={create.isPending}>
              {create.isPending ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding…</>) : 'Add mailbox'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
