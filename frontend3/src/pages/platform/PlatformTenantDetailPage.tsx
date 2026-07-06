import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Pencil, Plus, ShieldMinus, X } from 'lucide-react';

import { Button, Card, FieldError, Input, Modal, RequiredMark, StatusBadge, Toast, TonePill } from '@/components/ui';
import type { Tenant } from '@/types/platform';
import {
  useAddTenantAdmin,
  useRemoveTenantAdmin,
  useTenantAdmins,
  useTenantFeatures,
  useTenantLifecycle,
  useTenantStats,
  useUpdateTenant,
  useUpdateTenantAdmin,
  useUpdateTenantFeatures,
} from '@/hooks/usePlatform';

function errText(err: unknown, fb: string): string {
  const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof d === 'string' ? d : fb;
}

// Platform-admin: the detail PANEL for one selected tenant — details + ingestion
// toggle, admins (list + add/edit/remove), entitlement features, lifecycle, and
// at-a-glance stats. Rendered inside the master-detail Tenants page (right side).
// Takes the tenant as a prop; the parent owns list/selection/URL. ``onArchived``
// lets the parent clear the selection after an archive.
export function TenantDetailPanel({ tenant: t, onArchived }: { tenant: Tenant; onArchived?: () => void }) {
  const update = useUpdateTenant();
  const lifecycle = useTenantLifecycle();

  const statsQ = useTenantStats(true);
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
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});

  const stats = statsQ.data?.stats?.[t.id];

  async function toggleIngestion() {
    try { await update.mutateAsync({ id: t.id, data: { ingestion_enabled: !t.ingestion_enabled } }); flashAndFade('ok', 'Updated.'); }
    catch (err) { flashAndFade('err', errText(err, 'Could not update the tenant.')); }
  }
  async function toggleProjectManagement() {
    try { await update.mutateAsync({ id: t.id, data: { project_management_enabled: !(t.project_management_enabled ?? true) } }); flashAndFade('ok', 'Updated.'); }
    catch (err) { flashAndFade('err', errText(err, 'Could not update the tenant.')); }
  }

  function openEdit() {
    setEditName(t.name);
    setEditSlug(t.slug);
    setEditTz(t.timezone ?? '');
    setEditMaxMb(t.max_mailboxes != null ? String(t.max_mailboxes) : '');
    setEditErr(null);
    setEditErrors({});
    setEditOpen(true);
  }
  async function saveEdit() {
    setEditErr(null);
    const next: Record<string, string> = {};
    if (!editName.trim()) next.name = 'This field is required.';
    const mb = editMaxMb.trim() === '' ? undefined : Number(editMaxMb);
    if (mb !== undefined && (!Number.isInteger(mb) || mb < 0)) next.maxMb = 'Enter a non-negative whole number.';
    if (Object.keys(next).length > 0) { setEditErrors(next); return; }
    setEditErrors({});
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
    // Non-destructive actions (resume, unarchive) skip the type-to-confirm gate.
    const needsToken = !['resume', 'unarchive'].includes(confirmAction);
    if (needsToken && confirmName !== t.name) { flashAndFade('err', 'Type the tenant name exactly to confirm.'); return; }
    try {
      await lifecycle.mutateAsync({ id: t.id, action: confirmAction, token: needsToken ? confirmName : undefined });
      const done: Record<string, string> = {
        mark_inactive: 'marked inactive', suspend: 'suspended', archive: 'archived', unarchive: 'unarchived', resume: 'resumed',
      };
      setConfirmAction(null); setConfirmName('');
      flashAndFade('ok', `${t.name} ${done[confirmAction] ?? 'updated'}.`);
      if (confirmAction === 'archive') onArchived?.();
    } catch (err) {
      flashAndFade('err', errText(err, 'Could not apply that action.'));
    }
  }

  // Archived tenants only get "Unarchive" (a real, working restore). Active
  // tenants can be marked inactive, suspended, or archived. A merely
  // inactive/suspended (not archived) tenant can be resumed or archived.
  const lifecycleActions: Array<{ action: string; label: string; danger?: boolean }> =
    t.is_archived
      ? [{ action: 'unarchive', label: 'Unarchive' }]
      : t.status === 'active'
        ? [{ action: 'mark_inactive', label: 'Mark Inactive' }, { action: 'suspend', label: 'Suspend', danger: true }, { action: 'archive', label: 'Archive', danger: true }]
        : [{ action: 'resume', label: 'Resume' }, { action: 'archive', label: 'Archive', danger: true }];

  // "resume" and "unarchive" are non-destructive — no type-to-confirm needed.
  const nonDestructiveActions = new Set(['resume', 'unarchive']);

  // Short title-case label for the confirm dialog heading.
  const actionTitle: Record<string, string> = {
    mark_inactive: 'Mark Inactive', suspend: 'Suspend', archive: 'Archive', unarchive: 'Unarchive', resume: 'Resume',
  };
  // Grammatical confirm sentence: verb + the tenant name (object) so it never
  // reads "mark inactive Infosys". Returns JSX with the name emphasized.
  const confirmSentence = (action: string) => {
    const name = <strong className="text-foreground">{t.name}</strong>;
    switch (action) {
      case 'mark_inactive':
        return <>This will mark {name} as inactive. Type the tenant name to confirm.</>;
      case 'suspend':
        return <>This will suspend {name}. Type the tenant name to confirm.</>;
      case 'archive':
        return <>This will archive {name} (a reversible soft-delete). Type the tenant name to confirm.</>;
      default:
        return <>This will update {name}. Type the tenant name to confirm.</>;
    }
  };

  return (
    <div className="space-y-3">
      {/* Panel header: selected tenant name + status. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h2 className="truncate text-xl font-bold text-foreground">{t.name}</h2>
            {t.is_archived
              ? <TonePill tone="neutral">Archived</TonePill>
              : t.status === 'active'
                ? <StatusBadge status="approved" variant="timesheet" label="Active" showIcon={false} />
                : <TonePill tone={t.status === 'suspended' ? 'danger' : 'neutral'}>{t.status}</TonePill>}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">/{t.slug}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={openEdit}>
          <Pencil className="h-3.5 w-3.5" /> Edit details
        </Button>
      </div>

      {flash ? (
        <Toast tone={flash.tone} message={flash.text} onDismiss={() => setFlash(null)} />
      ) : null}

      {/* At-a-glance stats. */}
      <div className="grid grid-cols-3 gap-3">
        <StatBox label="Users" value={stats?.user_count != null ? String(stats.user_count) : '—'} />
        <StatBox label="Admins" value={stats?.admin_count != null ? String(stats.admin_count) : '—'} />
        <StatBox label="Last activity" value={stats?.last_activity_at ? new Date(stats.last_activity_at).toLocaleDateString() : 'never'} />
      </div>

      {/* Two-column so the panel is short: Details/Features/Lifecycle stack on the
          left, Admins (the tall one) on the right. Both columns top-align. */}
      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
        <div className="space-y-3">
          <Card className="p-3">
            <p className="mb-2 text-sm font-semibold text-foreground">Details</p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              <Detail label="Tenant ID" value={String(t.id)} />
              <Detail label="Slug" value={t.slug} />
              <Detail label="Status" value={t.is_archived ? 'archived' : t.status} />
              <Detail label="Timezone" value={t.timezone ?? 'UTC'} />
              <Detail label="Created" value={new Date(t.created_at).toLocaleDateString()} />
              <Detail label="Max mailboxes" value={t.max_mailboxes != null ? String(t.max_mailboxes) : '—'} />
            </div>
          </Card>

          <Card className="p-3">
            <p className="mb-2 text-sm font-semibold text-foreground">Features</p>
            <FeaturesTab tenantId={t.id} onFlash={flashAndFade} />
          </Card>
        </div>

        <div className="space-y-3">
          <Card className="p-3">
            <p className="mb-1 text-sm font-semibold text-foreground">Access</p>
            <p className="mb-1.5 text-xs text-muted-foreground">Which modules this workspace can use.</p>
            <div className="divide-y divide-border">
              <FeatureRow
                label="Email Processing"
                desc="Ingest timesheets from email (mailboxes, LLM extraction, review queue)."
                checked={t.ingestion_enabled}
                disabled={update.isPending}
                onChange={() => void toggleIngestion()}
              />
              <FeatureRow
                label="Project Management"
                desc="Clients, projects, tasks, and the Insights dashboards."
                checked={t.project_management_enabled ?? true}
                disabled={update.isPending}
                onChange={() => void toggleProjectManagement()}
              />
            </div>
          </Card>

          <AdminsCard tenantId={t.id} onFlash={flashAndFade} />

          <Card className="border-amber-500/50 p-3">
            <p className="mb-2 text-sm font-semibold text-foreground">Advanced</p>
            <div className="flex flex-wrap gap-2">
              {lifecycleActions.map((a) => (
                <Button key={a.action} size="sm" variant={a.danger ? 'destructive' : 'secondary'} onClick={() => { setConfirmAction(a.action); setConfirmName(''); }}>{a.label}</Button>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title={`Edit · ${t.name}`}>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Name<RequiredMark /></label>
            <Input error={!!editErrors.name} value={editName} onChange={(e) => { setEditName(e.target.value); if (editErrors.name) setEditErrors((p) => ({ ...p, name: '' })); }} placeholder="Tenant name" autoFocus />
            <FieldError error={editErrors.name} />
          </div>
          <div>
            <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Slug</label>
            <Input value={editSlug} disabled className="opacity-70" />
            <p className="mt-1 text-[11px] text-muted-foreground">The slug is fixed — it maps to the tenant's database (acufy_tenant_&lt;slug&gt;). Renaming it is a migration, not an edit.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Timezone</label>
              <Input value={editTz} onChange={(e) => setEditTz(e.target.value)} placeholder="UTC or America/New_York" />
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Max mailboxes</label>
              <Input error={!!editErrors.maxMb} value={editMaxMb} onChange={(e) => { setEditMaxMb(e.target.value); if (editErrors.maxMb) setEditErrors((p) => ({ ...p, maxMb: '' })); }} placeholder="e.g. 3" inputMode="numeric" />
              <FieldError error={editErrors.maxMb} />
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

      <Modal open={confirmAction != null} onClose={() => setConfirmAction(null)} title={confirmAction ? `Confirm: ${actionTitle[confirmAction] ?? confirmAction}` : 'Confirm'}>
        <div className="space-y-3">
          {confirmAction && nonDestructiveActions.has(confirmAction) ? (
            <p className="text-sm text-muted-foreground">
              {confirmAction === 'unarchive' ? 'Unarchive' : 'Resume'} <strong className="text-foreground">{t.name}</strong>? This restores access.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{confirmAction ? confirmSentence(confirmAction) : null}</p>
              <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={t.name} autoFocus />
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmAction(null)}>Cancel</Button>
            <Button
              variant={confirmAction && nonDestructiveActions.has(confirmAction) ? 'primary' : 'destructive'}
              size="sm"
              onClick={() => void runLifecycle()}
              disabled={lifecycle.isPending || (confirmAction != null && !nonDestructiveActions.has(confirmAction) && confirmName !== t.name)}
            >
              {lifecycle.isPending ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Applying…</>) : 'Confirm'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// Admins of this tenant: the LIST (by multi-role membership) + an inline form to
// add another (created in the tenant DB + emailed a set-password invite). The
// list is why "2 admins" now shows both — including a tenant-self-added admin
// whose active role isn't ADMIN.
function AdminsCard({ tenantId, onFlash }: { tenantId: number; onFlash: (t: 'ok' | 'err', m: string) => void }) {
  const qc = useQueryClient();
  const adminsQ = useTenantAdmins(tenantId);
  const addAdmin = useAddTenantAdmin();
  const updateAdmin = useUpdateTenantAdmin();
  const removeAdmin = useRemoveTenantAdmin();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Inline edit state (one row at a time).
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  // Confirm removing admin rights.
  const [removeTarget, setRemoveTarget] = useState<{ id: number; name: string } | null>(null);
  const admins = adminsQ.data?.admins ?? [];

  const errMsg = (err: unknown, fb: string) => {
    const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
    return typeof d === 'string' ? d : fb;
  };

  async function submit() {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'This field is required.';
    if (!email.trim()) next.email = 'This field is required.';
    else if (!email.includes('@')) next.email = 'Enter a valid email address.';
    if (Object.keys(next).length > 0) { setErrors(next); return; }
    setErrors({});
    try {
      const r = await addAdmin.mutateAsync({ id: tenantId, full_name: name.trim(), email: email.trim() });
      setName(''); setEmail(''); setErrors({});
      qc.invalidateQueries({ queryKey: ['platform', 'tenant-admins', tenantId] });
      qc.invalidateQueries({ queryKey: ['platform', 'tenant-stats'] });
      onFlash('ok', r.invited ? `Admin added — invite emailed to ${r.email}.` : `Admin added (${r.email}). Invite email could not be sent; resend from their account.`);
    } catch (err) {
      onFlash('err', errMsg(err, 'Could not add the admin.'));
    }
  }

  function startEdit(a: { id: number; full_name: string; email: string }) {
    setEditId(a.id); setEditName(a.full_name); setEditEmail(a.email);
  }
  async function saveEdit(id: number) {
    if (!editName.trim() || !editEmail.trim() || !editEmail.includes('@')) {
      onFlash('err', 'Enter a valid name and email.'); return;
    }
    try {
      await updateAdmin.mutateAsync({ id: tenantId, userId: id, full_name: editName.trim(), email: editEmail.trim() });
      setEditId(null);
      onFlash('ok', 'Admin updated.');
    } catch (err) {
      onFlash('err', errMsg(err, 'Could not update the admin.'));
    }
  }
  async function confirmRemove() {
    if (!removeTarget) return;
    try {
      await removeAdmin.mutateAsync({ id: tenantId, userId: removeTarget.id });
      setRemoveTarget(null);
      onFlash('ok', 'Admin rights removed.');
    } catch (err) {
      onFlash('err', errMsg(err, 'Could not remove admin rights.'));
    }
  }

  return (
    <Card className="p-3">
      <p className="mb-1 text-sm font-semibold text-foreground">Admins</p>
      <p className="mb-2 text-xs text-muted-foreground">Everyone with the ADMIN role in this workspace (including a role they can switch into).</p>

      {adminsQ.isLoading ? (
        <div className="py-4 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-label="Loading" /></div>
      ) : admins.length === 0 ? (
        <p className="mb-3 text-sm text-muted-foreground">No admins yet.</p>
      ) : (
        <ul className="mb-3 divide-y divide-border rounded-lg border border-border">
          {admins.map((a) => (
            <li key={a.id} className="px-3 py-2">
              {editId === a.id ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Full name" className="flex-1" />
                  <Input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} placeholder="Email" className="flex-1" />
                  <div className="flex shrink-0 gap-1">
                    <button type="button" aria-label="Save" disabled={updateAdmin.isPending} onClick={() => void saveEdit(a.id)} className="grid h-7 w-7 place-items-center rounded text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-50">
                      {updateAdmin.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-4 w-4" />}
                    </button>
                    <button type="button" aria-label="Cancel" onClick={() => setEditId(null)} className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-foreground/10"><X className="h-4 w-4" /></button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{a.full_name}</p>
                    <p className="truncate text-xs text-muted-foreground">{a.email}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="hidden text-[11px] text-muted-foreground sm:inline">
                      {a.last_login_at ? `last login ${new Date(a.last_login_at).toLocaleDateString()}` : 'never logged in'}
                    </span>
                    <button type="button" aria-label="Edit admin" onClick={() => startEdit(a)} className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"><Pencil className="h-3.5 w-3.5" /></button>
                    <button type="button" aria-label="Remove admin rights" onClick={() => setRemoveTarget({ id: a.id, name: a.full_name })} className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"><ShieldMinus className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Modal open={removeTarget != null} onClose={() => setRemoveTarget(null)} title="Remove admin rights">
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Remove admin rights from <strong className="text-foreground">{removeTarget?.name}</strong>? Their account stays, but they'll no longer be an admin of this workspace.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRemoveTarget(null)}>Cancel</Button>
            <Button variant="destructive" size="sm" onClick={() => void confirmRemove()} disabled={removeAdmin.isPending}>
              {removeAdmin.isPending ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Removing…</>) : 'Remove admin'}
            </Button>
          </div>
        </div>
      </Modal>

      <p className="mb-2 text-[13px] font-medium text-foreground">Add admin</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Name<RequiredMark /></label>
          <Input error={!!errors.name} value={name} onChange={(e) => { setName(e.target.value); if (errors.name) setErrors((p) => ({ ...p, name: '' })); }} placeholder="Jane Doe" />
          <FieldError error={errors.name} />
        </div>
        <div className="flex-1">
          <label className="mb-1 block text-[13px] font-medium text-muted-foreground">Email<RequiredMark /></label>
          <Input error={!!errors.email} type="email" value={email} onChange={(e) => { setEmail(e.target.value); if (errors.email) setErrors((p) => ({ ...p, email: '' })); }} placeholder="jane@acme.com" />
          <FieldError error={errors.email} />
        </div>
        <Button size="sm" onClick={() => void submit()} disabled={addAdmin.isPending}>
          {addAdmin.isPending ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding…</>) : (<><Plus className="h-3.5 w-3.5" /> Add admin</>)}
        </Button>
      </div>
    </Card>
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
  if (q.isLoading) return <div className="grid place-items-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" /></div>;
  return (
    <div className="divide-y divide-border">
      <FeatureRow label="Custom outbound email" desc="Tenant can configure its own SMTP / OAuth sending." checked={!!f?.custom_outbound_email} disabled={update.isPending} onChange={(v) => toggle('custom_outbound_email', v)} />
      <FeatureRow label="Custom email templates" desc="Tenant can edit invite / reset email templates." checked={!!f?.custom_email_template} disabled={update.isPending} onChange={(v) => toggle('custom_email_template', v)} />
    </div>
  );
}

function FeatureRow({ label, desc, checked, disabled, onChange }: { label: string; desc: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 py-2.5">
      <span>
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{desc}</span>
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 shrink-0 rounded border-border accent-[hsl(var(--primary))]" />
    </label>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums text-foreground">{value}</p>
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
