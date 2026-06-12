import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';

import { AcufyLogo } from '@/components/layout/AcufyLogo';
import { Button, Card, CardBody, Input } from '@/components/ui';
import { authApi } from '@/api/client';

// Public: request a password-reset link. Anti-enumeration — the backend always
// returns success, so we always show the "check your email" state.
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setPending(true);
    try {
      await authApi.forgotPassword(email.trim().toLowerCase());
    } catch {
      // Anti-enumeration: never reveal failures; always show the sent state.
    } finally {
      setPending(false);
      setSent(true);
    }
  }

  return (
    <AuthShell title="Reset your password">
      {sent ? (
        <div className="space-y-4 text-center">
          <p className="text-sm text-muted-foreground">
            If an account exists for <strong className="text-foreground">{email}</strong>, a reset link is on its way. Check your inbox.
          </p>
          <Link to="/login" className="text-sm font-medium text-primary hover:underline">Back to sign in</Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <p className="text-sm text-muted-foreground">Enter your email and we'll send you a link to reset your password.</p>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Email</label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoFocus required />
          </div>
          <Button type="submit" className="w-full" disabled={pending || !email.trim()}>
            {pending ? (<><Loader2 className="h-4 w-4 animate-spin" /> Sending…</>) : 'Send reset link'}
          </Button>
          <div className="text-center">
            <Link to="/login" className="text-sm text-muted-foreground hover:text-primary">Back to sign in</Link>
          </div>
        </form>
      )}
    </AuthShell>
  );
}

// Shared centered shell for the public auth pages.
export function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-background p-4 text-foreground">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center"><AcufyLogo height={44} /></div>
        <Card>
          <CardBody className="p-6">
            <h1 className="mb-4 text-center text-xl font-semibold text-foreground">{title}</h1>
            {children}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
