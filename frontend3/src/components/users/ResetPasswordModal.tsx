import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button, Input, Modal } from '@/components/ui';
import { useResetUserPassword } from '@/hooks/useAdmin';
import type { ManagedUser } from '@/types/admin';

// Admin-initiated password reset. The backend requires a new password of at
// least 8 chars (AdminPasswordResetRequest). Matches frontend2's reset flow.
export function ResetPasswordModal({
  open,
  user,
  onClose,
  onDone,
}: {
  open: boolean;
  user: ManagedUser | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reset = useResetUserPassword();

  useEffect(() => {
    if (open) { setPw(''); setError(null); }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (!user) return;
    try {
      await reset.mutateAsync({ id: user.id, password: pw });
      onDone(`Password reset for ${user.full_name}.`);
      onClose();
    } catch (err) {
      const e = err as { response?: { data?: { detail?: string } } };
      setError((typeof e?.response?.data?.detail === 'string' ? e.response.data.detail : undefined) ?? 'Could not reset the password.');
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Reset password · ${user?.full_name ?? ''}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">New password</label>
          <Input
            type="text"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="At least 8 characters"
            autoFocus
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Share this with the user securely. They can change it after signing in.
          </p>
        </div>
        {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={reset.isPending}>
            {reset.isPending ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Resetting…</>) : 'Reset password'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
