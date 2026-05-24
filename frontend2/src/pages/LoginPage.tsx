import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Eye, EyeOff, Lock, Mail } from 'lucide-react';

import { useAuth } from '@/hooks';
import { useTheme } from '@/contexts/ThemeContext';
import { AcufyLogo } from '@/components/layout/AcufyLogo';

// Dev-only quick login — file is gitignored and only exists locally.
// Uses Vite's glob import so the build succeeds even when the file is absent.
const devModules = import.meta.glob('./DevQuickLogin.tsx');
const hasDevLogin = Object.keys(devModules).length > 0;

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Login failed';
};

const EMAIL_NOT_VERIFIED_MSG =
  'Your account has not been verified yet. Please check your email for the verification link.';

// Same landing for everyone after login. The /dashboard route's
// switcher renders PlatformDashboardPage for PA, DashboardPage for
// everyone else. Kept as a function so re-introducing role-based
// landings later is a single-line change.
const getPostLoginRoute = (_role?: string) => '/dashboard';

export const LoginPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [DevQuickLogin, setDevQuickLogin] = useState<React.FC<{ isLoading: boolean; onQuickLogin: (email: string, password: string) => void }> | null>(null);
  const { login, loginWithRoleHandoff } = useAuth();
  const { variant: themeVariant } = useTheme();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const roleHandoffAttemptedRef = useRef(false);

  // Flash banner after a successful /set-password redirect.
  const passwordSetFlash = useMemo(() => searchParams.get('password_set'), [searchParams]);
  const flashMessage =
    passwordSetFlash === 'invite'
      ? 'Password set. Sign in with your new password.'
      : passwordSetFlash === 'reset'
      ? 'Password reset. Sign in with your new password.'
      : null;

  useEffect(() => {
    if (hasDevLogin) {
      const loader = Object.values(devModules)[0];
      loader().then((mod) => {
        const m = mod as { default: typeof DevQuickLogin };
        setDevQuickLogin(() => m.default);
      }).catch(() => {});
    }
  }, []);

  // ?role-handoff=<token>: exchange for an independent session, then strip the param.
  // ?next=<path>: optional in-app destination after the exchange. We
  // validate that it's a same-origin relative path so a hostile inbound
  // link can't redirect a freshly handed-off session to an external URL.
  useEffect(() => {
    const roleHandoffToken = searchParams.get('role-handoff');
    if (!roleHandoffToken || roleHandoffAttemptedRef.current) return;
    roleHandoffAttemptedRef.current = true;
    const rawNext = searchParams.get('next');
    const isSafeRelative = (p: string | null): p is string =>
      Boolean(p) && p!.startsWith('/') && !p!.startsWith('//');
    const nextPath = isSafeRelative(rawNext) ? rawNext : null;
    setIsLoading(true);
    loginWithRoleHandoff(roleHandoffToken)
      .then((nextUser) => {
        setSearchParams({}, { replace: true });
        navigate(nextPath ?? getPostLoginRoute(nextUser.role), { replace: true });
      })
      .catch((err: unknown) => {
        setError(getErrorMessage(err) || 'Could not open the requested portal.');
        setSearchParams({}, { replace: true });
      })
      .finally(() => setIsLoading(false));
  }, [loginWithRoleHandoff, navigate, searchParams, setSearchParams]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const user = await login(email, password);
      // The portal-picker modal lives in AppLayout (it has to outlive
      // the LoginPage redirect that happens immediately after login).
      // We always navigate to the dashboard; the modal handles the
      // multi-role case there.
      navigate(getPostLoginRoute(user.role));
    } catch (err) {
      const msg = getErrorMessage(err);
      setError(msg === 'EMAIL_NOT_VERIFIED' ? EMAIL_NOT_VERIFIED_MSG : msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleQuickLogin = async (quickEmail: string, quickPassword: string) => {
    setError('');
    setIsLoading(true);
    setEmail(quickEmail);
    setPassword(quickPassword);

    try {
      const user = await login(quickEmail, quickPassword);
      navigate(getPostLoginRoute(user.role));
    } catch (err) {
      const msg = getErrorMessage(err);
      setError(msg === 'EMAIL_NOT_VERIFIED' ? EMAIL_NOT_VERIFIED_MSG : msg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      {/* Aurora backdrop (mirrors acufy_website_v2 LoginGate). Three soft
          blurred orbs in theme colors + a center vignette + a faint
          violet grid. All pointer-events:none so the form stays clickable. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className="absolute -left-[15%] -top-[10%] h-[50vmax] w-[50vmax] animate-pulse rounded-full opacity-[0.55] blur-[70px]"
          style={{ background: 'radial-gradient(circle, hsl(var(--primary)) 0%, transparent 60%)' }}
        />
        <div
          className="absolute -right-[18%] top-[8%] h-[55vmax] w-[55vmax] animate-pulse rounded-full opacity-[0.40] blur-[70px]"
          style={{ background: `radial-gradient(circle, ${themeVariant.acufy.magenta} 0%, transparent 60%)`, animationDelay: '2s' }}
        />
        <div
          className="absolute -bottom-[20%] left-[10%] h-[45vmax] w-[45vmax] animate-pulse rounded-full opacity-[0.32] blur-[70px]"
          style={{ background: `radial-gradient(circle, ${themeVariant.acufy.violet3} 0%, transparent 60%)`, animationDelay: '4s' }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse at center, transparent 0%, color-mix(in srgb, hsl(var(--background)) 55%, transparent) 60%, color-mix(in srgb, hsl(var(--background)) 92%, transparent) 100%)',
          }}
        />
      </div>

      {/* Centered content column */}
      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4 py-10 md:px-6">
        <div className="flex w-full max-w-[540px] flex-col items-center">
          {/* Logo — same themable SVG used everywhere else in the app, at
              the v2 login size (168px). This was the source of the "looks
              different on login vs. inside the app" drift: the old login
              used the per-theme PNG, every other surface uses AcufyLogo. */}
          <div className="login-logo mb-4 shrink-0 md:mb-6">
            <AcufyLogo height={168} />
          </div>

          {/* Glass card */}
          <div
            className="relative w-full overflow-hidden rounded-3xl border bg-card/55 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.5)] backdrop-blur-2xl md:p-7"
            style={{ borderColor: 'var(--glass-border)' }}
          >
            {/* Subtle diagonal sheen across the card. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-3xl opacity-60"
              style={{
                background: 'linear-gradient(120deg, transparent 40%, rgba(var(--accent-rgb),0.18) 50%, transparent 60%)',
                mixBlendMode: 'screen',
              }}
            />

            <div className="relative">
              <h1 className="text-balance text-[clamp(22px,3.4vw,34px)] font-bold leading-[1.1] -tracking-[0.025em] text-foreground">
                Welcome to <span className="em-serif">Acufy AI</span>
              </h1>

              {flashMessage && (
                <div className="mt-4 flex items-start gap-3 rounded-lg bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <span>{flashMessage}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="mt-5 space-y-4">
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">Email</label>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@company.com"
                      className="field-input pl-11"
                      required
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">Password</label>
                  <div className="relative">
                    <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="********"
                      className="field-input pl-11 pr-11"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      title={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <div className="mt-2 flex justify-end">
                    <Link
                      to="/forgot-password"
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      Forgot password?
                    </Link>
                  </div>
                </div>

                {error && (
                  <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                  </div>
                )}

                <button type="submit" disabled={isLoading} className="action-button w-full">
                  {isLoading ? 'Signing in…' : 'Sign in'}
                </button>
              </form>

              {/* Dev-only quick login — only renders if DevQuickLogin.tsx exists locally */}
              {DevQuickLogin && (
                <div className="mt-6">
                  <DevQuickLogin isLoading={isLoading} onQuickLogin={handleQuickLogin} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
