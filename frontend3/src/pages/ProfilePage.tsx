import { useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound, Loader2, Users } from 'lucide-react';

import { Button, Card, Input, RoleBadge, WorkspaceHeader } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { useChangePassword, useMyProfile, useUpdateProfile } from '@/hooks/useAdmin';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';

const TIMEZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Europe/Paris',
  'Europe/Berlin', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
];

function errText(err: unknown, fallback: string): string {
  const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof d === 'string' ? d : fallback;
}

export function ProfilePage() {
  const { user, refreshUser } = useAuth();
  const profileQ = useMyProfile();
  const update = useUpdateProfile();
  const changePw = useChangePassword();

  // Editable profile fields.
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [title, setTitle] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const flashAndFade = (tone: 'ok' | 'err', text: string) => {
    setFlash({ tone, text });
    window.setTimeout(() => setFlash(null), 4000);
  };

  // Change-password form.
  const [pwOpen, setPwOpen] = useState(false);
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwError, setPwError] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);

  useEffect(() => {
    if (!user) return;
    setFullName(user.full_name ?? '');
    setUsername(user.username ?? '');
    setTitle(user.title ?? '');
    setTimezone(user.timezone ?? 'UTC');
  }, [user]);

  if (!user) return null;

  const dirty =
    fullName !== (user.full_name ?? '') ||
    username !== (user.username ?? '') ||
    title !== (user.title ?? '') ||
    timezone !== (user.timezone ?? 'UTC');

  async function handleSave() {
    if (!user) return;
    const data: Record<string, string> = {};
    if (fullName !== user.full_name) data.full_name = fullName.trim();
    if (username !== user.username) data.username = username.trim();
    if (title !== (user.title ?? '')) data.title = title.trim();
    if (timezone !== (user.timezone ?? 'UTC')) data.timezone = timezone;
    try {
      await update.mutateAsync(data);
      await refreshUser();
      flashAndFade('ok', 'Profile updated.');
    } catch (err) {
      flashAndFade('err', errText(err, 'Could not update profile.'));
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    if (newPw.length < 8) { setPwError('New password must be at least 8 characters.'); return; }
    if (newPw !== confirmPw) { setPwError('Passwords do not match.'); return; }
    try {
      await changePw.mutateAsync({ current: curPw, next: newPw });
      setPwOpen(false); setCurPw(''); setNewPw(''); setConfirmPw('');
      flashAndFade('ok', 'Password changed.');
    } catch (err) {
      setPwError(errText(err, 'Could not change password.'));
    }
  }

  const profile = profileQ.data;
  // All immediate managers (primary first). Falls back to the legacy single
  // manager_name when the list isn't populated.
  const managerList = profile?.managers ?? [];
  const labelClass = 'mb-1 block text-[13px] font-medium text-muted-foreground';

  return (
    <div className="space-y-5">
      <WorkspaceHeader title="Profile" description="Your account details." />

      {flash ? (
        <div role="alert" className={'rounded-xl border px-3 py-2 text-sm ' + (flash.tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300')}>
          {flash.text}
        </div>
      ) : null}

      {/* Identity + roles */}
      <Card className="p-6">
        <div className="flex items-center gap-4">
          <span className={cn('grid h-16 w-16 place-items-center rounded-full text-xl font-semibold', avatarTone(user.email))}>
            {initials(user.full_name)}
          </span>
          <div>
            <p className="text-lg font-semibold text-foreground">{user.full_name}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <RoleBadge role={user.role} />
              {(user.roles ?? []).filter((r) => r !== user.role).map((r) => <RoleBadge key={r} role={r} />)}
              {user.can_review ? (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">Reviewer</span>
              ) : null}
            </div>
          </div>
        </div>
      </Card>

      {/* Editable details */}
      <Card className="p-6">
        <p className="mb-4 text-sm font-semibold text-foreground">Account details</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Full name</label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Username</label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Email (read-only)</label>
            {/* Email is display-only on the profile (no edit wiring here). A
                platform admin changes a user's email from User management, not
                their own profile — so always render read-only to avoid a
                misleadingly-editable field and the controlled-without-onChange warning. */}
            <Input value={user.email} disabled readOnly />
          </div>
          <div>
            <label className={labelClass}>Title</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Senior Consultant" />
          </div>
          <div>
            <label className={labelClass}>Timezone</label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="h-10 w-full rounded-full border border-border bg-transparent px-4 text-[15px] text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              {TIMEZONES.includes(timezone) ? null : <option value={timezone}>{timezone}</option>}
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass}>Department</label>
            <Input value={user.department ?? '—'} disabled readOnly />
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <Button onClick={() => void handleSave()} disabled={!dirty || update.isPending}>
            {update.isPending ? (<><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>) : 'Save changes'}
          </Button>
          <Button variant="secondary" onClick={() => setPwOpen((v) => !v)}>
            <KeyRound className="h-4 w-4" /> Change password
          </Button>
        </div>

        {/* Change-password form (inline) */}
        {pwOpen ? (
          <form onSubmit={handleChangePassword} className="mt-4 space-y-3 rounded-2xl border border-border bg-muted/20 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className={labelClass}>Current password</label>
                <div className="relative">
                  <Input type={showPw ? 'text' : 'password'} value={curPw} onChange={(e) => setCurPw(e.target.value)} autoComplete="current-password" className="pr-10" />
                  <PwToggle shown={showPw} onToggle={() => setShowPw((v) => !v)} />
                </div>
              </div>
              <div>
                <label className={labelClass}>New password</label>
                <div className="relative">
                  <Input type={showPw ? 'text' : 'password'} value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" className="pr-10" />
                  <PwToggle shown={showPw} onToggle={() => setShowPw((v) => !v)} />
                </div>
              </div>
              <div>
                <label className={labelClass}>Confirm new</label>
                <div className="relative">
                  <Input type={showPw ? 'text' : 'password'} value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" className="pr-10" />
                  <PwToggle shown={showPw} onToggle={() => setShowPw((v) => !v)} />
                </div>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">At least 8 characters with uppercase, lowercase, number, and special character.</p>
            {pwError ? <p className="text-sm text-rose-600 dark:text-rose-300">{pwError}</p> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setPwOpen(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={changePw.isPending}>
                {changePw.isPending ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Changing…</>) : 'Change password'}
              </Button>
            </div>
          </form>
        ) : null}
      </Card>

      {/* Organization */}
      {profile && (managerList.length > 0 || profile.manager_name || profile.direct_reports.length > 0) ? (
        <Card className="p-6">
          <div className="mb-4 flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-semibold text-foreground">Organization</p>
          </div>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Reports to</p>
              {managerList.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">{profile.manager_name ?? '—'}</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {managerList.map((m, i) => (
                    <li key={m.id} className="flex items-center gap-1.5 text-sm text-foreground">
                      <span>{m.full_name}</span>
                      {managerList.length > 1 && i === 0 ? (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">primary</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Direct reports ({profile.direct_reports.length})
              </p>
              {profile.direct_reports.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">None</p>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {profile.direct_reports.map((p) => (
                    <li key={p.id} className="text-sm text-foreground">{p.full_name}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

// Eye toggle inside a password input. Reveals/hides the field so the user can
// check what they typed before submitting.
function PwToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={shown ? 'Hide password' : 'Show password'}
      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
    >
      {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );
}
