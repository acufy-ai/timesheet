import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, CheckCircle2 } from 'lucide-react';
import axios from 'axios';

import { authAPI } from '@/api/endpoints';
import { Card, CardContent } from '@/components';
import { useTheme } from '@/contexts/ThemeContext';

const getApiError = (err: unknown): string => {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail;
    if (typeof detail === 'string') return detail;
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
};

export const ForgotPasswordPage: React.FC = () => {
  const navigate = useNavigate();
  const { variant: themeVariant } = useTheme();
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      await authAPI.forgotPassword(email.trim().toLowerCase());
      // Anti-enumeration: we always show the success state regardless of
      // whether the email exists. Real users get the email; everyone else
      // sees nothing changed for them.
      setSent(true);
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="flex min-h-screen items-center justify-center px-4 py-10">
        <Card className="w-full max-w-[460px]">
          <CardContent className="p-8">
            <div className="mb-6 flex items-center gap-3">
              <img src={themeVariant.logoPath} alt="Acufy AI" style={{ height: 36, width: 'auto' }} />
              <div className="h-7 w-px bg-border" aria-hidden="true" />
              <span className="text-lg font-medium tracking-tight text-foreground">Timesheet</span>
            </div>

            {sent ? (
              <div className="py-2">
                <div className="mb-4 flex items-center gap-3 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-6 w-6 flex-shrink-0" />
                  <h2 className="text-lg font-semibold">Check your email</h2>
                </div>
                <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
                  If an account exists for <span className="font-medium text-foreground">{email}</span>, we've
                  sent a link to reset your password. The link is valid for 7 days and can only be used once.
                </p>
                <button
                  type="button"
                  onClick={() => navigate('/login')}
                  className="action-button w-full"
                >
                  Back to sign in
                </button>
              </div>
            ) : (
              <>
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">Forgot your password?</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  Enter the email you use to sign in and we'll send you a link to reset it.
                </p>

                <form onSubmit={handleSubmit} className="mt-6 space-y-5">
                  <div>
                    <label className="mb-2 block text-sm font-medium text-foreground">Email</label>
                    <div className="relative">
                      <Mail className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@company.com"
                        className="field-input pl-11"
                        autoComplete="email"
                        required
                      />
                    </div>
                  </div>

                  {error && (
                    <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {error}
                    </div>
                  )}

                  <button type="submit" disabled={isSubmitting} className="action-button w-full">
                    {isSubmitting ? 'Sending...' : 'Send reset link'}
                  </button>

                  <p className="text-center text-sm text-muted-foreground">
                    <Link to="/login" className="text-primary hover:underline">
                      Back to sign in
                    </Link>
                  </p>
                </form>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
