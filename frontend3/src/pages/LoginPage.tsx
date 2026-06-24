import { useState } from 'react';
import { Eye, EyeOff, Loader2, Lock, Mail } from 'lucide-react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import { AcufyLogo } from '@/components/layout/AcufyLogo';
import { ThemePicker } from '@/components/layout/ThemePicker';
import { Button } from '@/components/ui';
import { authApi } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';

// Centered glass-card login over an aurora backdrop (mirrors frontend2's
// LoginPage): three soft blurred orbs in the active theme's colors, a center
// vignette, and a single frosted card holding the logo + sign-in form.
// Where a freshly-authenticated user lands when they didn't deep-link to a
// specific protected page. Platform admins have no tenant, so the team
// dashboard is meaningless (and 400s) for them — send them to the platform
// console instead. Tenant users go to the index ("/"), which LandingRedirect
// resolves to their preferred landing page (the tenant's default_landing
// setting, overridable per-user), falling back to the dashboard.
const defaultDestForRole = (role: string | undefined): string =>
  role === 'PLATFORM_ADMIN' ? '/platform' : '/';

export function LoginPage() {
  const { isAuthenticated, isInitializing, login, user } = useAuth();
  const { variant } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True when the last login failed because the account isn't verified — we
  // then offer a "resend verification" action.
  const [needsVerify, setNeedsVerify] = useState(false);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');

  // Honor an explicit deep-link target (the page they were bounced from);
  // otherwise default by role. Prefer the ?from= query param (survives a hard
  // refresh) and fall back to router state for in-app navigations.
  const fromQuery = new URLSearchParams(location.search).get('from');
  const explicitFrom = fromQuery || (location.state as { from?: string } | null)?.from || undefined;
  if (!isInitializing && isAuthenticated) {
    return <Navigate to={explicitFrom ?? defaultDestForRole(user?.role)} replace />;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setNeedsVerify(false);
    try {
      const loggedIn = await login(email, password);
      // A fresh credential login goes to the user's landing page (resolved by
      // role + their landing preference via the index route), NOT a stale
      // ?from= target. The ?from= deep-link return is only honored for the
      // already-authenticated auto-redirect above (a token that expired
      // mid-session) — not when someone deliberately types their credentials.
      // Otherwise an employee bounced off /my-work would log back into /my-work
      // instead of their dashboard landing.
      navigate(defaultDestForRole(loggedIn?.role), { replace: true });
    } catch (err) {
      const raw = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      const msg = typeof raw === 'string' ? raw : err instanceof Error ? err.message : 'Login failed';
      if (msg === 'EMAIL_NOT_VERIFIED') {
        setNeedsVerify(true);
        setError('Your account has not been verified yet. Check your email for the verification link.');
      } else {
        setError(msg);
      }
    } finally {
      setPending(false);
    }
  }

  async function resendVerification() {
    if (!email) return;
    setResendState('sending');
    try { await authApi.resendVerification(email); setResendState('sent'); }
    catch { setResendState('idle'); }
  }

  const field =
    'h-11 w-full rounded-xl border border-border bg-background/60 pl-11 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25';

  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      {/* Aurora backdrop — soft blurred orbs in the active theme colors. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className="absolute -left-[15%] -top-[10%] h-[50vmax] w-[50vmax] animate-pulse rounded-full opacity-[0.5] blur-[70px]"
          style={{ background: 'radial-gradient(circle, hsl(var(--primary)) 0%, transparent 60%)' }}
        />
        <div
          className="absolute -right-[18%] top-[8%] h-[55vmax] w-[55vmax] animate-pulse rounded-full opacity-[0.38] blur-[70px]"
          style={{ background: `radial-gradient(circle, ${variant.acufy.magenta} 0%, transparent 60%)`, animationDelay: '2s' }}
        />
        <div
          className="absolute -bottom-[20%] left-[10%] h-[45vmax] w-[45vmax] animate-pulse rounded-full opacity-[0.3] blur-[70px]"
          style={{ background: `radial-gradient(circle, ${variant.acufy.violet3} 0%, transparent 60%)`, animationDelay: '4s' }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse at center, transparent 0%, color-mix(in srgb, hsl(var(--background)) 55%, transparent) 60%, color-mix(in srgb, hsl(var(--background)) 92%, transparent) 100%)',
          }}
        />
      </div>

      <div className="absolute right-4 top-4 z-20">
        <ThemePicker />
      </div>

      {/* Centered content column */}
      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4 py-10">
        <div className="flex w-full max-w-[500px] flex-col items-center">
          <div className="mb-5 shrink-0">
            <AcufyLogo height={168} />
          </div>

          {/* Glass card */}
          <div className="relative w-full overflow-hidden rounded-3xl border border-border bg-card/55 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur-2xl md:p-8">
            <h1 className="text-2xl font-bold italic text-foreground">Sign In</h1>

            <form onSubmit={handleSubmit} className="mt-5 space-y-4">
              <div>
                <label htmlFor="email" className="mb-2 block text-sm font-medium text-foreground">Email</label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className={field}
                    required
                    autoFocus
                    autoComplete="email"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="password" className="mb-2 block text-sm font-medium text-foreground">Password</label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className={`${field} pr-11`}
                    required
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <div className="mt-2 flex justify-end">
                  <Link to="/forgot-password" className="text-xs font-medium text-primary hover:underline">
                    Forgot password?
                  </Link>
                </div>
              </div>

              {error ? (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
                  {error}
                  {needsVerify ? (
                    resendState === 'sent' ? (
                      <p className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-300">Verification email sent. Check your inbox.</p>
                    ) : (
                      <button type="button" onClick={() => void resendVerification()} disabled={resendState === 'sending'} className="mt-1.5 block text-xs font-medium text-primary hover:underline disabled:opacity-60">
                        {resendState === 'sending' ? 'Sending…' : 'Resend verification email'}
                      </button>
                    )
                  ) : null}
                </div>
              ) : null}

              <Button type="submit" className="w-full" size="lg" disabled={pending}>
                {pending ? (<><Loader2 className="h-4 w-4 animate-spin" /> Signing in…</>) : 'Sign in'}
              </Button>
            </form>
          </div>

          <p className="mt-6 text-xs text-muted-foreground">© 2026 Acufy AI. All rights reserved.</p>
        </div>
      </div>
    </div>
  );
}
