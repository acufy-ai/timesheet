import { useEffect, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, Loader2, XCircle } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';

import { Button, Input } from '@/components/ui';
import { authApi } from '@/api/client';
import { AuthShell } from './ForgotPasswordPage';

type Stage = 'verifying' | 'set-password' | 'success' | 'error';

// Public: confirm an email-verification token from the link in the user's
// inbox, THEN let the new user set their password (enter the temporary password
// from the email + choose a new one). Mirrors frontend2's three-stage flow.
export function VerifyAccountPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [stage, setStage] = useState<Stage>('verifying');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('This verification link is invalid or has expired.');

  // Set-password form state.
  const [tempPassword, setTempPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showTemp, setShowTemp] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) { setError('No verification token found in the link.'); setStage('error'); return; }
    authApi.verifyEmail(token)
      .then((r) => { setEmail(r.data.email ?? ''); setStage('set-password'); })
      .catch((err) => {
        const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        setError(typeof d === 'string' ? d : 'This verification link is invalid or has expired.');
        setStage('error');
      });
  }, [token]);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!tempPassword || !newPassword || !confirmPassword) { setFormError('All fields are required.'); return; }
    if (newPassword.length < 10) { setFormError('New password must be at least 10 characters.'); return; }
    if (newPassword !== confirmPassword) { setFormError('Passwords do not match.'); return; }
    if (newPassword === tempPassword.trim()) { setFormError('New password must be different from your temporary password.'); return; }
    setSubmitting(true);
    try {
      await authApi.changePasswordAfterVerification(tempPassword, newPassword, email);
      setStage('success');
    } catch (err) {
      const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setFormError(typeof d === 'string' ? d : 'Could not set your password. Check the temporary password and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell title="Verify your account">
      {stage === 'verifying' ? (
        <div className="grid place-items-center py-6 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Verifying" /></div>
      ) : stage === 'set-password' ? (
        <form onSubmit={submitPassword} className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Set your password</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {email ? <><strong className="text-foreground">{email}</strong> is verified.</> : 'Your email is verified.'} Enter the temporary password from your email and choose a new one.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Temporary password</label>
            <div className="relative">
              <Input type={showTemp ? 'text' : 'password'} value={tempPassword} onChange={(e) => setTempPassword(e.target.value)} autoComplete="current-password" placeholder="From your email" />
              <button type="button" onClick={() => setShowTemp((v) => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label={showTemp ? 'Hide' : 'Show'}>
                {showTemp ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">New password</label>
            <div className="relative">
              <Input type={showNew ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" placeholder="At least 10 characters" />
              <button type="button" onClick={() => setShowNew((v) => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label={showNew ? 'Hide' : 'Show'}>
                {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">At least 10 characters with uppercase, lowercase, number, and special character.</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Confirm new password</label>
            <Input type={showNew ? 'text' : 'password'} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" placeholder="Re-enter new password" />
          </div>
          {formError ? <p className="text-sm text-rose-600 dark:text-rose-300">{formError}</p> : null}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? <><Loader2 className="h-4 w-4 animate-spin" /> Setting password…</> : 'Set password & continue'}
          </Button>
        </form>
      ) : stage === 'success' ? (
        <div className="space-y-4 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300"><CheckCircle2 className="h-6 w-6" /></div>
          <p className="text-sm text-muted-foreground">Your password is set. You can now sign in.</p>
          <Link to="/login" className="block"><Button className="w-full">Go to sign in</Button></Link>
        </div>
      ) : (
        <div className="space-y-4 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300"><XCircle className="h-6 w-6" /></div>
          <p className="text-sm text-muted-foreground">{error}</p>
          <Link to="/login" className="text-sm font-medium text-primary hover:underline">Back to sign in</Link>
        </div>
      )}
    </AuthShell>
  );
}
