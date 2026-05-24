import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Eye, EyeOff, Lock, Mail } from 'lucide-react';

import { Card, CardContent } from '@/components';
import { useAuth } from '@/hooks';
import { useTheme } from '@/contexts/ThemeContext';
import { AcufyLogo } from '@/components/layout/AcufyLogo';
import { ThemePicker } from '@/components/layout/ThemePicker';

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
    <div className="min-h-screen bg-background p-0">
      {/* Theme picker - absolute top-right */}
      <div className="absolute right-6 top-6 z-10">
        <ThemePicker />
      </div>

      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[55%_45%]">
        {/* Left panel — Acufy branded */}
        <section
          className="relative hidden overflow-hidden p-14 lg:flex lg:flex-col lg:justify-between"
          style={{ background: `linear-gradient(135deg, ${themeVariant.legacy.bgApp} 0%, ${themeVariant.legacy.bgSurface} 60%, ${themeVariant.legacy.bgSurface2} 100%)` }}
        >
          {/* Animated grid bg */}
          <div
            className="absolute inset-0 opacity-40"
            style={{
              backgroundImage: 'linear-gradient(rgba(14,165,233,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(14,165,233,0.06) 1px, transparent 1px)',
              backgroundSize: '60px 60px',
              maskImage: 'radial-gradient(ellipse 70% 60% at 50% 40%, black 20%, transparent 70%)',
              WebkitMaskImage: 'radial-gradient(ellipse 70% 60% at 50% 40%, black 20%, transparent 70%)',
            }}
          />
          {/* Glow orb */}
          <div className="absolute -right-24 -top-24 h-[500px] w-[500px] animate-pulse rounded-full" style={{ background: 'radial-gradient(circle, rgba(14,165,233,0.15) 0%, transparent 60%)' }} />
          <div className="absolute -bottom-32 -left-24 h-[400px] w-[400px] animate-pulse rounded-full" style={{ background: 'radial-gradient(circle, rgba(20,184,166,0.1) 0%, transparent 60%)', animationDelay: '2s' }} />

          <div className="relative z-10">
            <img src={themeVariant.logoPath} alt="Acufy AI" style={{ height: 64, width: 'auto' }} />
          </div>
        </section>

        {/* Right panel — login form */}
        <section className="flex items-center justify-center bg-card px-6 py-10">
          <Card className="w-full max-w-[420px] border-0 shadow-none">
            <CardContent className="p-0">
              {/* Mobile logo */}
              <div className="mb-6 lg:hidden">
                <AcufyLogo />
              </div>
              <h2 className="mb-8 text-2xl font-semibold tracking-tight text-foreground">Sign in</h2>

              {flashMessage && (
                <div className="mb-5 flex items-start gap-3 rounded-lg bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <span>{flashMessage}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-5">
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
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition"
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
                  {isLoading ? 'Signing In...' : 'Sign In'}
                </button>
              </form>

              {/* Dev-only quick login — only renders if DevQuickLogin.tsx exists locally */}
              {DevQuickLogin && <DevQuickLogin isLoading={isLoading} onQuickLogin={handleQuickLogin} />}
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
};
