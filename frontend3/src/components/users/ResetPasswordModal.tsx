import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button, FieldError, Input, Modal, RequiredMark } from '@/components/ui';
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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const reset = useResetUserPassword();

  useEffect(() => {
    if (open) { setPw(''); setError(null); setErrors({}); }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!pw) { setErrors({ pw: 'This field is required.' }); return; }
    if (pw.length < 8) { setErrors({ pw: 'Password must be at least 8 characters.' }); return; }
    setErrors({});
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
          <label className="mb-1 block text-[13px] font-medium text-muted-foreground">New password<RequiredMark /></label>
          <Input
            type="text"
            error={!!errors.pw}
            value={pw}
            onChange={(e) => { setPw(e.target.value); if (errors.pw) setErrors((p) => ({ ...p, pw: '' })); }}
            placeholder="At least 8 characters"
            autoFocus
          />
          <FieldError error={errors.pw} />
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
