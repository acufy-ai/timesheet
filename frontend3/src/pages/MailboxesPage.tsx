import { useState } from 'react';
import { Loader2, Mail, Plus, RotateCcw, Trash2, Zap } from 'lucide-react';

import { Button, Card, Empty, Input, Modal, StatusBadge, TonePill, WorkspaceHeader } from '@/components/ui';
import {
  useCreateMailbox,
  useDeleteMailbox,
  useMailboxes,
  useResetMailboxCursor,
  useTestMailbox,
} from '@/hooks/useAdmin';
import { mailboxesApi } from '@/api/client';
import type { Mailbox, MailboxCreateBody } from '@/types/admin';

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
  const q = useMailboxes();
  const create = useCreateMailbox();
  const del = useDeleteMailbox();
  const test = useTestMailbox();
  const resetCursor = useResetMailboxCursor();

  const [addOpen, setAddOpen] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [testResult, setTestResult] = useState<Record<number, string>>({});
  const flashAndFade = (tone: 'ok' | 'err', text: string) => { setFlash({ tone, text }); window.setTimeout(() => setFlash(null), 5000); };

  // IMAP add form.
  const [form, setForm] = useState({ label: '', host: '', port: '993', username: '', password: '', use_ssl: true });

  const mailboxes = q.data ?? [];

  async function connectOAuth(provider: 'google' | 'microsoft') {
    try {
      const res = await mailboxesApi.oauthConnect(provider);
      window.location.href = res.data.auth_url;
    } catch (err) {
      flashAndFade('err', errText(err, `Could not start ${provider} connection.`));
    }
  }
  async function addImap(e: React.FormEvent) {
    e.preventDefault();
    if (!form.label.trim() || !form.host.trim()) { flashAndFade('err', 'Label and host are required.'); return; }
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
            <Button variant="secondary" onClick={() => connectOAuth('google')}>Connect Gmail</Button>
            <Button variant="secondary" onClick={() => connectOAuth('microsoft')}>Connect Outlook</Button>
            <Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add IMAP</Button>
          </div>
        }
      />

      {flash ? (
        <div role="alert" className={'rounded-xl border px-3 py-2 text-sm ' + (flash.tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300')}>
          {flash.text}
        </div>
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
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Label *</label>
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Timesheets inbox" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_100px]">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Host *</label>
              <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="imap.example.com" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Port</label>
              <Input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Username</label>
              <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="user@example.com" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Password</label>
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
