// Pure helpers for the reviewer inbox + review panel. Ported verbatim (logic)
// from frontend2/src/pages/InboxPage.tsx so behavior matches exactly. No React.

import type { SkippedEmail } from '@/types/admin';

// Rows older than this (business days, weekends excluded) get a staleness tint.
export const STALE_BUSINESS_DAYS = 5;

// Personal email providers — never auto-create a client from these domains.
// Mirror of the backend PERSONAL_EMAIL_DOMAINS set in ingestion_pipeline.py.
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com',
  'aol.com', 'live.com', 'msn.com', 'proton.me', 'protonmail.com',
]);

export const domainOf = (email: string | null | undefined): string => {
  if (!email || !email.includes('@')) return '';
  return email.split('@', 2)[1].trim().toLowerCase();
};

export const isPersonalDomain = (domain: string): boolean =>
  PERSONAL_EMAIL_DOMAINS.has(domain.trim().toLowerCase());

// Smart-guess a client name from a domain. "dxc.com" -> "DXC", "aegon.com" -> "Aegon".
export const suggestNameFromDomain = (domain: string): string => {
  const stem = (domain.split('.')[0] || domain).trim();
  if (!stem) return '';
  if (stem.length <= 4) return stem.toUpperCase();
  return stem.charAt(0).toUpperCase() + stem.slice(1).toLowerCase();
};

export const getInitials = (name: string | null | undefined, email?: string | null): string => {
  const source = (name || '').trim();
  if (source.includes(',')) {
    const [last, first] = source.split(',').map((p) => p.trim()).filter(Boolean);
    if (last && first) return (first.charAt(0) + last.charAt(0)).toUpperCase();
    if (last) return last.slice(0, 2).toUpperCase();
  }
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  const local = (email || '').split('@')[0] || '';
  if (local.length >= 2) return local.slice(0, 2).toUpperCase();
  return '?';
};

// Business days between two dates (weekends excluded, floored). Cheap 5/7 approx.
const businessDaysBetween = (later: Date, earlier: Date): number => {
  const ms = later.getTime() - earlier.getTime();
  if (ms <= 0) return 0;
  const calendarDays = Math.floor(ms / (24 * 60 * 60 * 1000));
  return Math.floor(calendarDays * (5 / 7));
};

export const formatRelativeReceived = (value: string | null | undefined): string => {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export const isStaleReceived = (value: string | null | undefined): boolean => {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return businessDaysBetween(new Date(), date) >= STALE_BUSINESS_DAYS;
};

export const formatShortDate = (value: string | null | undefined): string => {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export const formatDateRange = (start: string | null, end: string | null): string => {
  if (!start && !end) return '--';
  const startLabel = formatShortDate(start);
  const endLabel = formatShortDate(end);
  if (start && end) return `${startLabel} - ${endLabel}`;
  return startLabel !== '--' ? startLabel : endLabel;
};

export const formatHours = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined || value === '') return '--';
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return String(value);
  return numeric.toFixed(1);
};

export const prettifySkipReason = (value: string | null | undefined): string => {
  if (!value) return 'Unknown reason';
  return value
    .replace(/^not_timesheet_email:/, 'not_timesheet_email ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

const isNoiseSkipReason = (value: string | null | undefined): boolean => {
  if (!value) return false;
  return (
    value.startsWith('not_timesheet_email:') ||
    value.startsWith('low_confidence_no_attachments:') ||
    value === 'no_candidate_timesheet_attachment'
  );
};

const hasTimesheetKeywords = (value: string | null | undefined): boolean => {
  if (!value) return false;
  const text = value.toLowerCase();
  const keywords = ['timesheet', 'time sheet', 'timecard', 'time card', 'hours worked', 'weekly hours', 'work log', 'billable'];
  return keywords.some((k) => text.includes(k));
};

// Whether a skipped email is worth surfacing for the reviewer to audit.
export const isActionableSkippedEmail = (email: SkippedEmail): boolean => {
  const isClassifierSkip =
    email.skip_reason?.startsWith('not_timesheet_email:') ||
    email.skip_reason?.startsWith('low_confidence_no_attachments:');
  if (isClassifierSkip) return true;
  if (isNoiseSkipReason(email.skip_reason)) return false;
  const reproc = email.reprocessable_attachments ?? [];
  const hasContext =
    hasTimesheetKeywords(email.subject) ||
    ['new_submission', 'resubmission', 'correction', 'submission', 'timesheet_submission'].includes(email.classification_intent ?? '') ||
    reproc.some((a) => hasTimesheetKeywords((a as { filename?: string }).filename));
  if (!hasContext) return false;
  return (email.timesheet_attachment_count ?? 0) > 0 || reproc.length > 0;
};

// ── Status presentation (shared) ────────────────────────────────────
export type IngestionTone = 'success' | 'danger' | 'warning' | 'info' | 'outline';

export const getStatusTone = (status: string): IngestionTone => {
  if (status === 'approved') return 'success';
  if (status === 'rejected') return 'danger';
  if (status === 'on_hold') return 'outline';
  if (status === 'under_review') return 'info';
  if (status === 'skipped') return 'outline';
  return 'warning';
};

export const statusLabel = (status: string): string => {
  if (status === 'under_review') return 'Under Review';
  if (status === 'on_hold') return 'On Hold';
  return status.charAt(0).toUpperCase() + status.slice(1);
};

export const STATUS_OPTIONS = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'under_review', label: 'Under Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'on_hold', label: 'On Hold' },
  { key: 'skipped', label: 'Skipped' },
] as const;

export const getApiErrorMessage = (error: unknown, fallback: string): string => {
  const e = error as { response?: { data?: { detail?: unknown } }; message?: string };
  const detail = e?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (e?.message) return e.message;
  return fallback;
};
