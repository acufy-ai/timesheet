import { useEffect, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { Button, Input } from '@/components/ui';
import { authApi } from '@/api/client';
import { AuthShell } from './ForgotPasswordPage';

type Stage = 'validating' | 'form' | 'invalid' | 'success';

// Public: set a password from an invitation or reset link. The token is in the
// URL (?token=...). We validate it on load, then accept a new password.
export function SetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [stage, setStage] = useState<Stage>('validating');
  const [email, setEmail] = useState('');
  const [purpose, setPurpose] = useState<'invite' | 'reset'>('invite');
  const [reason, setReason] = useState('This link is invalid or has expired.');

  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!token) { setReason('No token provided.'); setStage('invalid'); return; }
    authApi.verifyInvitation(token)
      .then((r) => {
        if (r.data.valid) {
          setEmail(r.data.email ?? '');
          setPurpose(r.data.purpose ?? 'invite');
          setStage('form');
        } else {
          setReason(r.data.reason ?? 'This link is invalid or has expired.');
          setStage('invalid');
        }
      })
      .catch(() => { setReason('This link is invalid or has expired.'); setStage('invalid'); });
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (pw !== confirm) { setError('Passwords do not match.'); return; }
    setPending(true);
    try {
      await authApi.setPasswordViaInvitation(token, pw);
      setStage('success');
    } catch (err) {
      const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof d === 'string' ? d : 'Could not set your password. The link may have expired.');
    } finally {
      setPending(false);
    }
  }

  const title = purpose === 'reset' ? 'Choose a new password' : 'Set up your account';

  if (stage === 'validating') {
    return <AuthShell title="Just a moment…"><div className="grid place-items-center py-6 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Validating" /></div></AuthShell>;
  }
  if (stage === 'invalid') {
    return (
      <AuthShell title="Link not valid">
        <div className="space-y-4 text-center">
          <p className="text-sm text-muted-foreground">{reason}</p>
          <Link to="/forgot-password" className="text-sm font-medium text-primary hover:underline">Request a new link</Link>
        </div>
      </AuthShell>
    );
  }
  if (stage === 'success') {
    return (
      <AuthShell title="All set">
        <div className="space-y-4 text-center">
          <p className="text-sm text-muted-foreground">Your password has been {purpose === 'reset' ? 'reset' : 'set'}. You can now sign in.</p>
          <Button className="w-full" onClick={() => navigate('/login')}>Go to sign in</Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={title}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {email ? <p className="text-sm text-muted-foreground">for <strong className="text-foreground">{email}</strong></p> : null}
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">New password</label>
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" autoFocus />
          {/* Live rule checklist (matches frontend2). */}
          <ul className="mt-2 space-y-1">
            {([
              ['At least 8 characters', pw.length >= 8],
              ['An uppercase letter', /[A-Z]/.test(pw)],
              ['A lowercase letter', /[a-z]/.test(pw)],
              ['A number', /[0-9]/.test(pw)],
              ['A special character', /[^A-Za-z0-9]/.test(pw)],
            ] as const).map(([label, ok]) => (
              <li key={label} className={'flex items-center gap-1.5 text-[11px] ' + (ok ? 'text-emerald-600 dark:text-emerald-300' : 'text-muted-foreground')}>
                {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />} {label}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Confirm password</label>
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </div>
        {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? (<><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>) : 'Set password'}
        </Button>
      </form>
    </AuthShell>
  );
}
