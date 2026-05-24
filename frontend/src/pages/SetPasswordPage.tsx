import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, XCircle, Lock, Eye, EyeOff, AlertCircle } from 'lucide-react';
import axios from 'axios';

import { authAPI } from '@/api/endpoints';
import { Card, CardContent } from '@/components';
import { useTheme } from '@/contexts/ThemeContext';

type Stage = 'loading' | 'ready' | 'submitting' | 'invalid';

const REASON_MESSAGES: Record<string, string> = {
  malformed: 'This link is invalid or has expired.',
  unknown: 'This link is no longer valid.',
  consumed: 'This link has already been used. Request a new one if you need to reset your password.',
  expired: 'This link has expired. Request a new one to continue.',
  user_gone: "This account doesn't exist anymore. Contact your admin if this is unexpected.",
};

const getApiError = (err: unknown): string => {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail;
    if (typeof detail === 'string') return detail;
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
};

interface PasswordRule {
  label: string;
  test: (s: string) => boolean;
}

// Policy mirrors what we ask Auth0 to enforce — Auth0 is still the
// authoritative check, but matching client-side stops obvious rejects
// before round-tripping.
const RULES: PasswordRule[] = [
  { label: 'At least 8 characters', test: (s) => s.length >= 8 },
  { label: 'One uppercase letter', test: (s) => /[A-Z]/.test(s) },
  { label: 'One lowercase letter', test: (s) => /[a-z]/.test(s) },
  { label: 'One special character', test: (s) => /[^A-Za-z0-9]/.test(s) },
];

export const SetPasswordPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { variant: themeVariant } = useTheme();

  const token = searchParams.get('token') ?? '';
  const urlPurpose = (searchParams.get('purpose') as 'invite' | 'reset' | null) ?? 'invite';

  const [stage, setStage] = useState<Stage>('loading');
  const [email, setEmail] = useState('');
  const [purpose, setPurpose] = useState<'invite' | 'reset'>(urlPurpose);
  const [invalidReason, setInvalidReason] = useState('');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Validate the token on page load so we can show specific errors
  // (expired/consumed) instead of letting the user fill the form first.
  useEffect(() => {
    if (!token) {
      setInvalidReason('No token provided.');
      setStage('invalid');
      return;
    }
    let cancelled = false;
    authAPI
      .verifyInvitation(token)
      .then((res) => {
        if (cancelled) return;
        if (res.data.valid) {
          setEmail(res.data.email ?? '');
          setPurpose(res.data.purpose ?? 'invite');
          setStage('ready');
        } else {
          setInvalidReason(REASON_MESSAGES[res.data.reason ?? ''] ?? REASON_MESSAGES.unknown);
          setEmail(res.data.email ?? '');
          setStage('invalid');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setInvalidReason(getApiError(err) || REASON_MESSAGES.unknown);
        setStage('invalid');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Trim whitespace from both ends so a stray space pasted from an email
  // client (or zero-width chars from a copied-from-PDF temp password)
  // doesn't break the match-check. The trimmed value is also what we send
  // to the backend, so what the user submits equals what they see.
  const trimmedPassword = password.trim();
  const trimmedConfirm = confirm.trim();
  const ruleStates = useMemo(() => RULES.map((r) => ({ rule: r, passes: r.test(trimmedPassword) })), [trimmedPassword]);
  const allRulesPass = ruleStates.every((r) => r.passes);
  const passwordsMatch = trimmedPassword.length > 0 && trimmedPassword === trimmedConfirm;
  const isSubmitting = stage === 'submitting';
  const canSubmit = allRulesPass && passwordsMatch && stage === 'ready';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitError('');
    setStage('submitting');
    try {
      await authAPI.setPasswordViaInvitation(token, trimmedPassword);
      // Bounce to login with a banner. The login page reads the
      // ?reset=success query param and shows a green success message.
      const flash = purpose === 'reset' ? 'reset' : 'invite';
      navigate(`/login?password_set=${flash}`, { replace: true });
    } catch (err) {
      setSubmitError(getApiError(err));
      setStage('ready');
    }
  };

  const heading =
    purpose === 'reset' ? 'Reset your password' : 'Welcome to Acufy Timesheet';
  const subheading =
    purpose === 'reset'
      ? 'Choose a new password for your account'
      : 'Set a password to activate your account';

  return (
    <div className="min-h-screen bg-background">
      <div className="absolute right-6 top-6 z-10" />
      <div className="flex min-h-screen items-center justify-center px-4 py-10">
        <Card className="w-full max-w-[460px]">
          <CardContent className="p-8">
            <div className="mb-6 flex items-center gap-3">
              <img src={themeVariant.logoPath} alt="Acufy AI" style={{ height: 36, width: 'auto' }} />
              <div className="h-7 w-px bg-border" aria-hidden="true" />
              <span className="text-lg font-medium tracking-tight text-foreground">Timesheet</span>
            </div>

            {stage === 'loading' && (
              <div className="py-12 text-center">
                <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                <p className="mt-4 text-sm text-muted-foreground">Checking your link...</p>
              </div>
            )}

            {stage === 'invalid' && (
              <div className="py-6">
                <div className="mb-4 flex items-center gap-3 text-destructive">
                  <AlertCircle className="h-6 w-6 flex-shrink-0" />
                  <h2 className="text-lg font-semibold">Link no longer valid</h2>
                </div>
                <p className="mb-6 text-sm leading-relaxed text-muted-foreground">{invalidReason}</p>
                <button
                  type="button"
                  onClick={() => navigate('/forgot-password')}
                  className="action-button w-full"
                >
                  Request a new link
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/login')}
                  className="mt-3 w-full rounded-md border border-border bg-transparent px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/50"
                >
                  Back to sign in
                </button>
              </div>
            )}

            {(stage === 'ready' || stage === 'submitting') && (
              <>
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">{heading}</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  {subheading}
                  {email ? (
                    <>
                      {' '}for <span className="font-medium text-foreground">{email}</span>
                    </>
                  ) : null}
                </p>

                <form onSubmit={handleSubmit} className="mt-6 space-y-5">
                  <div>
                    <label className="mb-2 block text-sm font-medium text-foreground">New password</label>
                    <div className="relative">
                      <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Choose a strong password"
                        className="field-input pl-11 pr-11"
                        autoComplete="new-password"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        tabIndex={-1}
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  {/* Live-updating rule list — rule turns green the moment
                      it passes. Quiet animation: just color + check icon. */}
                  <ul className="space-y-1.5 text-sm">
                    {ruleStates.map(({ rule, passes }) => (
                      <li
                        key={rule.label}
                        className={`flex items-center gap-2 transition-colors ${
                          passes ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {passes ? (
                          <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                        ) : (
                          <XCircle className="h-4 w-4 flex-shrink-0" />
                        )}
                        <span>{rule.label}</span>
                      </li>
                    ))}
                  </ul>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-foreground">Confirm password</label>
                    <div className="relative">
                      <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        placeholder="Type it again"
                        className="field-input pl-11"
                        autoComplete="new-password"
                        required
                      />
                    </div>
                    {confirm.length > 0 && !passwordsMatch && (
                      <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">Passwords don't match.</p>
                    )}
                  </div>

                  {submitError && (
                    <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {submitError}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={!canSubmit || isSubmitting}
                    className="action-button w-full disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isSubmitting
                      ? 'Setting password...'
                      : purpose === 'reset'
                      ? 'Reset password'
                      : 'Set password'}
                  </button>
                </form>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
