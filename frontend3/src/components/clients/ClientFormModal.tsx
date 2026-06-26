import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button, Input, Modal, RequiredMark, FieldError } from '@/components/ui';
import { useCreateClient, useUpdateClient } from '@/hooks/useAdmin';
import type { Client, ClientBody } from '@/types/admin';

// Create / edit a client. Fields mirror the backend ClientCreate/ClientUpdate:
// name, type (internal/external), QuickBooks customer id, and primary contact.
export function ClientFormModal({
  open,
  client,
  onClose,
  onSaved,
}: {
  open: boolean;
  client: Client | null; // null = create
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const isEdit = !!client;
  const create = useCreateClient();
  const update = useUpdateClient();

  const [name, setName] = useState('');
  const [type, setType] = useState('external');
  const [qbId, setQbId] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setName(client?.name ?? '');
    setType(client?.client_type ?? 'external');
    setQbId(client?.quickbooks_customer_id ?? '');
    setContactName(client?.contact_name ?? '');
    setContactEmail(client?.contact_email ?? '');
    setContactPhone(client?.contact_phone ?? '');
    setError(null);
    setErrors({});
  }, [open, client]);

  const saving = create.isPending || update.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'This field is required.';
    if (Object.keys(next).length) { setErrors(next); return; }
    setErrors({});
    const body: ClientBody = {
      name: name.trim(),
      client_type: type,
      quickbooks_customer_id: qbId.trim() || null,
      contact_name: contactName.trim() || null,
      contact_email: contactEmail.trim() || null,
      contact_phone: contactPhone.trim() || null,
    };
    try {
      if (isEdit && client) {
        await update.mutateAsync({ id: client.id, data: body });
        onSaved('Client updated.');
      } else {
        await create.mutateAsync(body);
        onSaved(`Client ${name.trim()} created successfully.`);
      }
      onClose();
    } catch (err) {
      const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof d === 'string' ? d : 'Could not save the client.');
    }
  }

  const labelClass = 'mb-1 block text-[13px] font-medium text-muted-foreground';

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit client · ${client?.name}` : 'New client'} className="max-w-lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={labelClass}>Name<RequiredMark /></label>
          <Input value={name} onChange={(e) => { setName(e.target.value); if (errors.name) setErrors((p) => ({ ...p, name: '' })); }} placeholder="Acme Corp" required error={!!errors.name} />
          <FieldError error={errors.name} />
        </div>
        <div>
          <span className={labelClass}>Type</span>
          <div className="grid grid-cols-2 gap-2">
            {(['internal', 'external'] as const).map((opt) => {
              const checked = type === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setType(opt)}
                  aria-pressed={checked}
                  className={
                    'rounded-xl border px-3 py-2 text-sm font-semibold capitalize transition ' +
                    (checked ? 'border-primary bg-primary/10 ring-1 ring-primary/40' : 'border-border hover:bg-muted/40')
                  }
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <label className={labelClass}>QuickBooks customer ID</label>
          <Input value={qbId} onChange={(e) => setQbId(e.target.value)} placeholder="Optional" />
        </div>
        <div className="border-t border-border pt-3">
          <p className="mb-2 text-xs font-semibold text-foreground">Primary contact</p>
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Name</label>
              <Input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Jane Doe" />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={labelClass}>Email</label>
                <Input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="jane@acme.com" />
              </div>
              <div>
                <label className={labelClass}>Phone</label>
                <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="+1 555 123 4567" />
              </div>
            </div>
          </div>
        </div>
        {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
        <div className="sticky bottom-0 -mx-4 mt-2 flex justify-end gap-2 border-t border-border bg-card px-4 pb-4 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</>) : isEdit ? 'Save changes' : 'Create client'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
