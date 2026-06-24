import { useState } from 'react';
import { ArrowLeft, Copy, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';

import { Button, Card, Input, Modal, StatusBadge, TonePill, WorkspaceHeader } from '@/components/ui';
import {
  useCreateServiceToken,
  useProvisionSystemUser,
  useRevokeServiceToken,
  useServiceTokens,
  useTenantFeatures,
  useTenantLifecycle,
  useTenants,
  useTenantStats,
  useUpdateTenant,
  useUpdateTenantFeatures,
} from '@/hooks/usePlatform';
import { cn } from '@/lib/cn';

function errText(err: unknown, fb: string): string {
  const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof d === 'string' ? d : fb;
}

type Tab = 'overview' | 'features' | 'advanced';

// Platform-admin: one tenant's detail across tabs — Overview (details +
// ingestion toggle + stats), Features (entitlement flags), Advanced (lifecycle
// + service tokens + provision system user). PA create/delete is intentionally
// out of scope (PA accounts live in the control DB, no tenant-scoped endpoint).
export function PlatformTenantDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const tenantsQ = useTenants(true);
  const update = useUpdateTenant();
  const lifecycle = useTenantLifecycle();

  const tenant = (tenantsQ.data ?? []).find((t) => t.slug === slug);
  const statsQ = useTenantStats(Boolean(tenant));
  const [tab, setTab] = useState<Tab>('overview');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const flashAndFade = (tone: 'ok' | 'err', text: string) => { setFlash({ tone, text }); window.setTimeout(() => setFlash(null), 5000); };

  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');

  // Edit-details modal state. Seeded from the tenant when opened.
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editSlug, setEditSlug] = useState('');
  const [editTz, setEditTz] = useState('');
  const [editMaxMb, setEditMaxMb] = useState('');
  const [editErr, setEditErr] = useState<string | null>(null);

  if (tenantsQ.isLoading) {
    return <div className="grid place-items-center py-20 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>;
  }
  if (!tenant) {
    return (
      <div className="space-y-4">
        <button type="button" onClick={() => navigate('/platform/tenants')} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary"><ArrowLeft className="h-4 w-4" /> Back to tenants</button>
        <Card className="px-4 py-6 text-sm text-muted-foreground">Tenant not found.</Card>
      </div>
    );
  }
  const t = tenant;
  const stats = statsQ.data?.stats?.[t.id];

  async function toggleIngestion() {
    try { await update.mutateAsync({ id: t.id, data: { ingestion_enabled: !t.ingestion_enabled } }); flashAndFade('ok', 'Updated.'); }
    catch (err) { flashAndFade('err', errText(err, 'Could not update the tenant.')); }
  }

  function openEdit() {
    setEditName(t.name);
    setEditSlug(t.slug);
    setEditTz(t.timezone ?? '');
    setEditMaxMb(t.max_mailboxes != null ? String(t.max_mailboxes) : '');
    setEditErr(null);
    setEditOpen(true);
  }
  async function saveEdit() {
    setEditErr(null);
    if (!editName.trim()) { setEditErr('Name is required.'); return; }
    const mb = editMaxMb.trim() === '' ? undefined : Number(editMaxMb);
    if (mb !== undefined && (!Number.isInteger(mb) || mb < 0)) { setEditErr('Max mailboxes must be a non-negative whole number.'); return; }
    try {
      // Slug intentionally not sent — it's load-bearing for DB routing and is
      // shown read-only.
      await update.mutateAsync({
        id: t.id,
        data: {
          name: editName.trim(),
          timezone: editTz.trim() || undefined,
          ...(mb !== undefined ? { max_mailboxes: mb } : {}),
        },
      });
      flashAndFade('ok', 'Tenant details updated.');
      setEditOpen(false);
    } catch (err) {
      setEditErr(errText(err, 'Could not update the tenant.'));
    }
  }
  async function runLifecycle() {
    if (!confirmAction) return;
    const needsToken = confirmAction !== 'resume';
    if (needsToken && confirmName !== t.name) { flashAndFade('err', 'Type the tenant name exactly to confirm.'); return; }
    try {
      await lifecycle.mutateAsync({ id: t.id, action: confirmAction, token: needsToken ? confirmName : undefined });
      setConfirmAction(null); setConfirmName('');
      flashAndFade('ok', `Tenant ${confirmAction.replace('_', ' ')} applied.`);
      if (confirmAction === 'delete') navigate('/platform/tenants');
    } catch (err) {
      flashAndFade('err', errText(err, 'Could not apply that action.'));
    }
  }

  const lifecycleActions: Array<{ action: string; label: string; danger?: boolean }> =
    t.status === 'active'
      ? [{ action: 'mark_inactive', label: 'Mark inactive' }, { action: 'suspend', label: 'Suspend', danger: true }, { action: 'delete', label: 'Delete', danger: true }]
      : [{ action: 'resume', label: 'Resume' }, { action: 'delete', label: 'Delete', danger: true }];

  const TABS: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'features', label: 'Features' },
    { key: 'advanced', label: 'Advanced' },
  ];

  return (
    <div className="space-y-5">
      <button type="button" onClick={() => navigate('/platform/tenants')} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary"><ArrowLeft className="h-4 w-4" /> Back to tenants</button>
      <WorkspaceHeader
        title={t.name}
        description={`/${t.slug}`}
        primary={t.status === 'active' ? <StatusBadge status="approved" variant="timesheet" label="Active" showIcon={false} /> : <TonePill tone={t.status === 'suspended' ? 'danger' : 'neutral'}>{t.status}</TonePill>}
      />

      {flash ? (
        <div role="alert" className={'rounded-xl border px-3 py-2 text-sm ' + (flash.tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300')}>
          {flash.text}
        </div>
      ) : null}

      {/* Tab rail */}
      <div className="flex items-center gap-1.5 border-b border-border pb-3">
        {TABS.map((x) => (
          <button key={x.key} type="button" onClick={() => setTab(x.key)} className={cn('rounded-full px-3.5 py-1.5 text-sm transition-colors', tab === x.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-primary/5')}>{x.label}</button>
        ))}
      </div>

      {tab === 'overview' ? (
        <>
          {/* Stat tiles */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatBox label="Users" value={stats?.user_count != null ? String(stats.user_count) : '—'} />
            <StatBox label="Admins" value={stats?.admin_count != null ? String(stats.admin_count) : '—'} />
            <StatBox label="Last activity" value={stats?.last_activity_at ? new Date(stats.last_activity_at).toLocaleDateString() : 'never'} />
          </div>
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-foreground">Details</p>
              <Button size="sm" variant="secondary" onClick={openEdit}>
                <Pencil className="h-3.5 w-3.5" /> Edit details
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
              <Detail label="Tenant ID" value={String(t.id)} />
              <Detail label="Slug" value={t.slug} />
              <Detail label="Status" value={t.status} />
              <Detail label="Timezone" value={t.timezone ?? 'UTC'} />
              <Detail label="Created" value={new Date(t.created_at).toLocaleDateString()} />
              <Detail label="Max mailboxes" value={t.max_mailboxes != null ? String(t.max_mailboxes) : '—'} />
            </div>
            <label className="mt-4 flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={t.ingestion_enabled} onChange={toggleIngestion} disabled={update.isPending} className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]" />
              Email ingestion enabled
            </label>
          </Card>
        </>
      ) : null}

      {tab === 'features' ? <FeaturesTab tenantId={t.id} onFlash={flashAndFade} /> : null}

      {tab === 'advanced' ? (
        <>
          <Card className="p-4">
            <p className="mb-1 text-sm font-semibold text-foreground">Lifecycle</p>
            <p className="mb-3 text-xs text-muted-foreground">Destructive actions require typing the tenant name to confirm.</p>
            <div className="flex flex-wrap gap-2">
              {lifecycleActions.map((a) => (
                <Button key={a.action} size="sm" variant={a.danger ? 'destructive' : 'secondary'} onClick={() => { setConfirmAction(a.action); setConfirmName(''); }}>{a.label}</Button>
              ))}
            </div>
          </Card>
          <ServiceTokensCard tenantId={t.id} onFlash={flashAndFade} />
          <ProvisionCard tenantId={t.id} onFlash={flashAndFade} />
        </>
      ) : null}

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title={`Edit · ${t.name}`}>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Tenant name" autoFocus />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Slug</label>
            <Input value={editSlug} disabled className="opacity-70" />
            <p className="mt-1 text-[11px] text-muted-foreground">The slug is fixed — it maps to the tenant's database (acufy_tenant_&lt;slug&gt;). Renaming it is a migration, not an edit.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Timezone</label>
              <Input value={editTz} onChange={(e) => setEditTz(e.target.value)} placeholder="UTC or America/New_York" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Max mailboxes</label>
              <Input value={editMaxMb} onChange={(e) => setEditMaxMb(e.target.value)} placeholder="e.g. 3" inputMode="numeric" />
            </div>
          </div>
          {editErr ? <p className="text-sm text-rose-600 dark:text-rose-300">{editErr}</p> : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={() => void saveEdit()} disabled={update.isPending}>
              {update.isPending ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</>) : 'Save changes'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={confirmAction != null} onClose={() => setConfirmAction(null)} title={`Confirm: ${confirmAction?.replace('_', ' ')}`}>
        <div className="space-y-3">
          {confirmAction === 'resume' ? (
            <p className="text-sm text-muted-foreground">Resume <strong className="text-foreground">{t.name}</strong>? This re-enables access.</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">This will <strong className="text-foreground">{confirmAction?.replace('_', ' ')}</strong> <strong className="text-foreground">{t.name}</strong>. Type the tenant name to confirm.</p>
              <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={t.name} autoFocus />
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmAction(null)}>Cancel</Button>
            <Button variant={confirmAction === 'resume' ? 'primary' : 'destructive'} size="sm" onClick={() => void runLifecycle()} disabled={lifecycle.isPending || (confirmAction !== 'resume' && confirmName !== t.name)}>
              {lifecycle.isPending ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Applying…</>) : 'Confirm'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function FeaturesTab({ tenantId, onFlash }: { tenantId: number; onFlash: (t: 'ok' | 'err', m: string) => void }) {
  const q = useTenantFeatures(tenantId);
  const update = useUpdateTenantFeatures();
  const f = q.data;
  function toggle(key: 'custom_outbound_email' | 'custom_email_template', value: boolean) {
    update.mutateAsync({ id: tenantId, updates: { [key]: value } })
      .then(() => onFlash('ok', 'Feature updated.'))
      .catch((e) => onFlash('err', errText(e, 'Could not update the feature.')));
  }
  if (q.isLoading) return <Card className="grid place-items-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" /></Card>;
  return (
    <Card className="divide-y divide-border">
      <FeatureRow label="Custom outbound email" desc="Tenant can configure its own SMTP / OAuth sending." checked={!!f?.custom_outbound_email} disabled={update.isPending} onChange={(v) => toggle('custom_outbound_email', v)} />
      <FeatureRow label="Custom email templates" desc="Tenant can edit invite / reset email templates." checked={!!f?.custom_email_template} disabled={update.isPending} onChange={(v) => toggle('custom_email_template', v)} />
    </Card>
  );
}

function FeatureRow({ label, desc, checked, disabled, onChange }: { label: string; desc: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
      <span>
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{desc}</span>
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 shrink-0 rounded border-border accent-[hsl(var(--primary))]" />
    </label>
  );
}

function ServiceTokensCard({ tenantId, onFlash }: { tenantId: number; onFlash: (t: 'ok' | 'err', m: string) => void }) {
  const q = useServiceTokens(tenantId);
  const create = useCreateServiceToken();
  const revoke = useRevokeServiceToken();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [issuer, setIssuer] = useState('');
  const [plaintext, setPlaintext] = useState<string | null>(null);

  async function submit() {
    if (!name.trim() || !issuer.trim()) return;
    try {
      const res = await create.mutateAsync({ id: tenantId, name: name.trim(), issuer: issuer.trim() });
      setPlaintext(res.token ?? null);
      setName(''); setIssuer(''); setAdding(false);
      onFlash('ok', 'Service token created. Copy it now — it cannot be shown again.');
    } catch (e) { onFlash('err', errText(e, 'Could not create the token.')); }
  }

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">Service tokens</p>
        <Button size="sm" variant="secondary" onClick={() => setAdding((v) => !v)}><Plus className="h-3.5 w-3.5" /> New token</Button>
      </div>

      {plaintext ? (
        <div className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
          <p className="mb-1 text-xs font-medium text-amber-700 dark:text-amber-300">Copy this token now — it will not be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-card px-2 py-1 text-xs text-foreground">{plaintext}</code>
            <button type="button" onClick={() => { navigator.clipboard?.writeText(plaintext); }} className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-foreground/10"><Copy className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      ) : null}

      {adding ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Label (e.g. Ingestion platform)" className="flex-1" />
          <Input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="Issuer" className="w-40" />
          <Button size="sm" onClick={() => void submit()} disabled={create.isPending || !name.trim() || !issuer.trim()}>{create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Create'}</Button>
        </div>
      ) : null}

      {q.isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" />
      ) : (q.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">No service tokens.</p>
      ) : (
        <div className="space-y-1.5">
          {(q.data ?? []).map((tok) => (
            <div key={tok.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate text-foreground">{tok.name} {!tok.is_active ? <span className="text-xs text-rose-500">(revoked)</span> : null}</p>
                <p className="text-xs text-muted-foreground">{tok.issuer}{tok.last_used_at ? ` · last used ${new Date(tok.last_used_at).toLocaleDateString()}` : ' · never used'}</p>
              </div>
              {tok.is_active ? (
                <button type="button" aria-label="Revoke" onClick={() => revoke.mutate({ id: tenantId, tokenId: tok.id })} className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"><Trash2 className="h-3.5 w-3.5" /></button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ProvisionCard({ tenantId, onFlash }: { tenantId: number; onFlash: (t: 'ok' | 'err', m: string) => void }) {
  const provision = useProvisionSystemUser();
  async function run() {
    try { await provision.mutateAsync(tenantId); onFlash('ok', 'System user provisioned.'); }
    catch (e) { onFlash('err', errText(e, 'Could not provision the system user.')); }
  }
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">System user</p>
          <p className="text-xs text-muted-foreground">Provision (or repair) the tenant's ingestion system user.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void run()} disabled={provision.isPending}>
          {provision.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Provision
        </Button>
      </div>
    </Card>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-border pb-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm text-foreground">{value}</p>
    </div>
  );
}
