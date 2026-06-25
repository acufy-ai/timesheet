import { useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';

import { Button, Input } from '@/components/ui';
import {
  useAddAlias,
  useAddUserClient,
  useClients,
  useRemoveAlias,
  useRemoveUserClient,
  useUserAliases,
  useUserClients,
} from '@/hooks/useAdmin';

// Email aliases + client assignments for an existing user. These are managed
// against their own endpoints (not the user create/update payload), so they
// only appear when editing a saved user. Mirrors frontend2's alias rows +
// client-assignment panel.
export function UserExtrasPanel({ userId, hideClients = false }: { userId: number; hideClients?: boolean }) {
  const aliasesQ = useUserAliases(userId);
  const clientsQ = useUserClients(userId);
  const allClientsQ = useClients(true);
  const addAlias = useAddAlias();
  const delAlias = useRemoveAlias();
  const addClient = useAddUserClient();
  const delClient = useRemoveUserClient();

  const [aliasInput, setAliasInput] = useState('');
  const [clientToAdd, setClientToAdd] = useState<number | ''>('');
  const [err, setErr] = useState<string | null>(null);

  const errText = (e: unknown, fb: string) => {
    const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
    return typeof d === 'string' ? d : fb;
  };

  const assigned = clientsQ.data ?? [];
  const assignedIds = new Set(assigned.map((a) => a.client_id));
  const addable = (allClientsQ.data ?? []).filter((c) => !assignedIds.has(c.id));

  async function submitAlias() {
    setErr(null);
    const email = aliasInput.trim().toLowerCase();
    if (!email || !email.includes('@')) { setErr('Enter a valid email.'); return; }
    try { await addAlias.mutateAsync({ userId, email }); setAliasInput(''); }
    catch (e) { setErr(errText(e, 'Could not add the alias.')); }
  }
  async function submitClient() {
    if (clientToAdd === '') return;
    setErr(null);
    try { await addClient.mutateAsync({ userId, clientId: Number(clientToAdd) }); setClientToAdd(''); }
    catch (e) { setErr(errText(e, 'Could not assign the client.')); }
  }

  return (
    <div className="space-y-4 border-t border-border pt-4">
      {/* Email aliases */}
      <div>
        <p className="mb-1 text-xs font-semibold text-foreground">Email aliases</p>
        <p className="mb-2 text-[11px] text-muted-foreground">Extra addresses that resolve to this user (e.g. forwarded timesheet senders).</p>
        {aliasesQ.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" />
        ) : (
          <div className="space-y-1.5">
            {(aliasesQ.data ?? []).map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-lg border border-border px-2.5 py-1.5 text-sm">
                <span className="text-foreground">{a.email}</span>
                <button type="button" aria-label="Remove alias" onClick={() => delAlias.mutate({ userId, aliasId: a.id })} className="grid h-6 w-6 place-items-center rounded-full text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"><X className="h-3.5 w-3.5" /></button>
              </div>
            ))}
            <div className="flex gap-2">
              <Input value={aliasInput} onChange={(e) => setAliasInput(e.target.value)} placeholder="alias@example.com" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submitAlias(); } }} />
              <Button type="button" variant="secondary" size="sm" onClick={() => void submitAlias()} disabled={addAlias.isPending}><Plus className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        )}
      </div>

      {/* Client assignments (hidden for external users — managed in the
          external client fields above). */}
      {!hideClients ? (
      <div>
        <p className="mb-1 text-xs font-semibold text-foreground">Assigned clients</p>
        <p className="mb-2 text-[11px] text-muted-foreground">Clients this user is assigned to (separate from their default client).</p>
        {clientsQ.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" />
        ) : (
          <div className="space-y-1.5">
            {assigned.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg border border-border px-2.5 py-1.5 text-sm">
                <span className="text-foreground">{c.client_name} <span className="text-[11px] text-muted-foreground">({c.client_type})</span></span>
                <button type="button" aria-label="Remove client" onClick={() => delClient.mutate({ userId, clientId: c.client_id })} className="grid h-6 w-6 place-items-center rounded-full text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"><X className="h-3.5 w-3.5" /></button>
              </div>
            ))}
            <div className="flex gap-2">
              <select value={clientToAdd} onChange={(e) => setClientToAdd(e.target.value ? Number(e.target.value) : '')} className="h-9 flex-1 rounded-full border border-border bg-transparent px-4 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20">
                <option value="">Add a client…</option>
                {addable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <Button type="button" variant="secondary" size="sm" onClick={() => void submitClient()} disabled={addClient.isPending || clientToAdd === ''}><Plus className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        )}
      </div>

      ) : null}

      {err ? <p className="text-sm text-rose-600 dark:text-rose-300">{err}</p> : null}
    </div>
  );
}
