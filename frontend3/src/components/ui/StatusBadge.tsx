import {
  CheckCircle2,
  Circle,
  Clock,
  EyeOff,
  PauseCircle,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';

// One central place for every status pill in the app. Tones are FIXED (not
// theme-bound) because semantic meaning beats brand coherence: "approved"
// should always read green regardless of whether you're on Cyan Mist or
// Violet Night. Each status has a label, a tinted background, an icon, and
// an optional `dot` shorthand.

export type Tone = 'success' | 'warning' | 'info' | 'danger' | 'neutral' | 'brand';

const TONE_CLASS: Record<Tone, string> = {
  success: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  warning: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  info: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  danger: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  neutral: 'bg-slate-200 text-slate-700 dark:bg-slate-700/40 dark:text-slate-300',
  brand: 'bg-primary/15 text-primary',
};

interface Meta {
  label: string;
  tone: Tone;
  Icon: LucideIcon;
}

// The two status families we render across the app.
export const TIMESHEET_STATUS_META: Record<string, Meta> = {
  draft: { label: 'Draft', tone: 'neutral', Icon: Circle },
  submitted: { label: 'Submitted', tone: 'brand', Icon: Clock },
  approved: { label: 'Approved', tone: 'success', Icon: CheckCircle2 },
  rejected: { label: 'Rejected', tone: 'danger', Icon: XCircle },
};

export const INGESTION_STATUS_META: Record<string, Meta> = {
  pending: { label: 'Pending', tone: 'warning', Icon: Clock },
  under_review: { label: 'Under review', tone: 'info', Icon: EyeOff },
  approved: { label: 'Approved', tone: 'success', Icon: CheckCircle2 },
  rejected: { label: 'Rejected', tone: 'danger', Icon: XCircle },
  on_hold: { label: 'On hold', tone: 'neutral', Icon: PauseCircle },
  skipped: { label: 'Skipped', tone: 'neutral', Icon: Circle },
};

interface StatusBadgeProps {
  status: string;
  // Choose which meta table to look the status up in.
  variant?: 'timesheet' | 'ingestion';
  // Override the label without touching the meta tables.
  label?: string;
  className?: string;
  showIcon?: boolean;
  size?: 'sm' | 'md';
}

export function StatusBadge({
  status,
  variant = 'timesheet',
  label,
  className,
  showIcon = true,
  size = 'sm',
}: StatusBadgeProps) {
  const table = variant === 'ingestion' ? INGESTION_STATUS_META : TIMESHEET_STATUS_META;
  const meta = table[status];
  if (!meta) {
    // Unknown status — render an inert neutral pill rather than crash.
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
          TONE_CLASS.neutral,
          className,
        )}
      >
        {label ?? status}
      </span>
    );
  }
  const sizeClass =
    size === 'md' ? 'px-2.5 py-1 text-[11px]' : 'px-2 py-0.5 text-[10px]';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-semibold uppercase tracking-wider',
        sizeClass,
        TONE_CLASS[meta.tone],
        className,
      )}
    >
      {showIcon ? <meta.Icon className="h-3 w-3" /> : null}
      {label ?? meta.label}
    </span>
  );
}

// Role → tone mapping, fixed per the deck status section. Admin=danger,
// Manager=violet(brand-ish), Employee=brand, Viewer=neutral, Platform=ink.
const ROLE_TONE: Record<string, Tone> = {
  ADMIN: 'danger',
  MANAGER: 'info',
  EMPLOYEE: 'brand',
  VIEWER: 'neutral',
  PLATFORM_ADMIN: 'neutral',
};

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  EMPLOYEE: 'Employee',
  VIEWER: 'Viewer',
  PLATFORM_ADMIN: 'Platform admin',
};

export function RoleBadge({ role, className }: { role: string; className?: string }) {
  const tone = ROLE_TONE[role] ?? 'neutral';
  const label = ROLE_LABEL[role] ?? role;
  return (
    <TonePill tone={tone} className={className}>
      {label}
    </TonePill>
  );
}

// Standalone tone pill (no status table) for ad-hoc cases (e.g. role tags).
export function TonePill({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
