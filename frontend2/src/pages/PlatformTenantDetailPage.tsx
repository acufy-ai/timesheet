import React, { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Box,
  Clock,
  ChevronRight,
  CheckCircle,
  Copy,
  FileText,
  Mailbox,
  PauseCircle,
  Pencil,
  Plus,
  PowerOff,
  ShieldOff,
  Trash2,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';

import { tenantsAPI } from '@/api';
import { usePlatformTenantStats } from '@/hooks';

import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { TenantFeatureFlags } from '@/components/TenantFeatureFlags';
import {
  useCreateUser,
  useDeleteUser,
  usePlatformAudit,
  useResetUserPassword,
  useSendInvite,
  useTenantBySlug,
  useTenantLifecycle,
  useUpdateTenant,
  useUpdateUser,
  useUsers,
} from '@/hooks';
import type { PlatformAuditEventRow, Tenant, User, UserRole } from '@/types';

// ── PlatformTenantDetailPage ─────────────────────────────────────────
//
// Path-B detail route. Lives at /platform/tenants/:slug. Five tabs:
// Overview, Admins, Feature flags, Audit log, Advanced. Only Overview
// and Advanced are real this slice - the rest are stubs that reference
// the existing surfaces. Filling them in is a follow-up slice.
//
// Advanced tab is the focus: each destructive action goes through the
// shared ConfirmDialog with a typed-name gate, and the server-side
// /tenants/:id/lifecycle endpoint re-validates the token + writes a
// PlatformAuditEvent with before/after state.

type TabKey = 'overview' | 'admins' | 'features' | 'audit' | 'advanced';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'admins', label: 'Admins' },
  { key: 'features', label: 'Features' },
  { key: 'audit', label: 'Audit Log' },
  { key: 'advanced', label: 'Advanced' },
];

const TENANT_AVATAR_INITIALS = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

const STATUS_PILL: Record<Tenant['status'], { label: string; className: string }> = {
  active: {
    label: 'Active',
    className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
  inactive: {
    label: 'Inactive',
    className: 'bg-muted text-muted-foreground',
  },
  suspended: {
    label: 'Suspended',
    className: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  },
};

export const PlatformTenantDetailPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const { data: tenant, isLoading, error } = useTenantBySlug(slug);

  // "Edit identity" modal state. Lives on the detail page header now
  // (the legacy list-page Edit affordance was retired in B.2).
  const [showEdit, setShowEdit] = useState(false);

  // Tab is part of the URL query so audit-log entries can deep-link
  // straight to a particular section.
  const tabFromUrl = (searchParams.get('tab') as TabKey | null) ?? 'overview';
  const activeTab: TabKey = TABS.some((t) => t.key === tabFromUrl) ? tabFromUrl : 'overview';
  const setTab = (next: TabKey) => {
    const newParams = new URLSearchParams(searchParams);
    if (next === 'overview') {
      newParams.delete('tab');
    } else {
      newParams.set('tab', next);
    }
    setSearchParams(newParams, { replace: true });
  };

  if (!slug) {
    return <Navigate to="/platform/tenants" replace />;
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-6 w-64 animate-pulse rounded bg-muted" />
        <div className="h-32 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  if (error || !tenant) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-sm font-medium text-foreground">Tenant not found</p>
        <p className="mt-1 text-xs text-muted-foreground">
          No tenant matches slug <code className="font-mono">{slug}</code>. It may have been deleted or archived.
        </p>
        <button
          type="button"
          onClick={() => navigate('/platform/tenants')}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to tenants
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1 text-xs text-muted-foreground">
        <Link to="/platform/tenants" className="hover:text-foreground">
          Platform
        </Link>
        <ChevronRight className="h-3 w-3" />
        <Link to="/platform/tenants" className="hover:text-foreground">
          Tenants
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">{tenant.name}</span>
      </nav>

      {/* Header */}
      <div className="flex items-start gap-4 border-b border-border pb-5">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl text-lg font-bold text-white"
          style={{ background: 'linear-gradient(135deg, #6d28d9, #4c1d95)' }}
          aria-hidden="true"
        >
          {TENANT_AVATAR_INITIALS(tenant.name)}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold text-foreground">
            <span>{tenant.name}</span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_PILL[tenant.status].className}`}
            >
              {STATUS_PILL[tenant.status].label}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                tenant.ingestion_enabled
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              Processing: {tenant.ingestion_enabled ? 'On' : 'Off'}
            </span>
          </h1>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              Slug: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{tenant.slug}</code>
            </span>
            <span>
              Tenant ID: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{tenant.id}</code>
            </span>
            <span>
              Created: {new Date(tenant.created_at).toLocaleString(undefined, {
                month: 'short', day: 'numeric', year: 'numeric',
                hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
              })}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowEdit(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
        >
          <Pencil className="h-3.5 w-3.5" />
          Edit tenant
        </button>
      </div>

      {showEdit && (
        <EditIdentityModal tenant={tenant} onClose={() => setShowEdit(false)} />
      )}

      {/* Tabs */}
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          const isAdvanced = tab.key === 'advanced';
          return (
            <button
              key={tab.key}
              role="tab"
              aria-selected={isActive}
              type="button"
              onClick={() => setTab(tab.key)}
              className={[
                'border-b-2 px-4 py-2.5 text-sm font-medium transition',
                isActive
                  ? isAdvanced
                    ? 'border-rose-500 text-rose-600 dark:text-rose-400'
                    : 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab panels + side rail. The rail is overview-only (matches
          the mockup) — other tabs already have their own dense
          layouts that don't need a second column. */}
      {activeTab === 'overview' ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <OverviewTab tenant={tenant} onEdit={() => setShowEdit(true)} onChangeTab={setTab} />
          <OverviewSideRail tenant={tenant} onChangeTab={setTab} />
        </div>
      ) : activeTab === 'admins' ? (
        <AdminsTab tenant={tenant} />
      ) : activeTab === 'features' ? (
        <FeaturesTab tenant={tenant} />
      ) : activeTab === 'audit' ? (
        <AuditTab tenant={tenant} />
      ) : (
        <AdvancedTab tenant={tenant} />
      )}
    </div>
  );
};

// ── Overview tab ─────────────────────────────────────────────────────

const OverviewTab: React.FC<{
  tenant: Tenant;
  onEdit: () => void;
  onChangeTab: (next: TabKey) => void;
}> = ({ tenant, onEdit, onChangeTab }) => {
  const [isEditOpen, setIsEditOpen] = useState(false);
  const { data: statsResp } = usePlatformTenantStats();
  const stats = statsResp?.stats?.[String(tenant.id)];

  const { data: featuresData } = useQuery({
    queryKey: ['tenant-features', tenant.id],
    queryFn: () => tenantsAPI.getTenantFeatures(tenant.id).then((r) => r.data),
    staleTime: 60_000,
  });

  // Stats endpoint doesn't surface mailbox_count yet; show the cap
  // alone when we have one. Used count falls back to 'N/A'.
  const mailboxesUsed: number | null = null;
  const mailboxLimit = tenant.max_mailboxes ?? null;
  const lastActivityRel = stats?.last_activity_at
    ? new Date(stats.last_activity_at).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : null;

  // The two flags currently surfaced by TenantFeatureFlags. We don't
  // need them by name here — just an enabled-count for the summary.
  const enabledFeatures = featuresData
    ? Number(featuresData.custom_outbound_email) + Number(featuresData.custom_email_template)
    : null;

  return (
    <section className="grid gap-4 md:grid-cols-2">
      {/* ── Top-left: Tenant status & lifecycle ──────────────────── */}
      <Card
        title="Tenant status & lifecycle"
        subtitle="Current status and lifecycle settings for this tenant."
        icon={<Zap className="h-4 w-4 text-rose-500" />}
        action={
          <button
            type="button"
            onClick={() => setIsEditOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium transition hover:bg-muted/60"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
        }
      >
        <dl className="divide-y divide-border">
          <Row label="Status">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_PILL[tenant.status].className}`}
            >
              {STATUS_PILL[tenant.status].label}
            </span>
          </Row>
          <Row label="Processing">
            <span className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  tenant.ingestion_enabled
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {tenant.ingestion_enabled ? 'On' : 'Off'}
              </span>
              <span className="text-xs text-muted-foreground">
                {tenant.ingestion_enabled ? 'Live email processing is enabled' : 'Email processing is paused'}
              </span>
            </span>
          </Row>
          <Row label="Timezone">{tenant.timezone || 'UTC (default)'}</Row>
          {tenant.max_mailboxes != null && (
            <Row label="Max mailboxes">{tenant.max_mailboxes}</Row>
          )}
          <Row label="Created">
            {new Date(tenant.created_at).toLocaleString()}
          </Row>
        </dl>
      </Card>

      {/* ── Top-right: Usage summary ─────────────────────────────── */}
      <Card
        title="Usage summary"
        subtitle="Current usage and allocation overview."
        icon={<Box className="h-4 w-4 text-primary" />}
        footer={
          <button
            type="button"
            onClick={() => onChangeTab('audit')}
            className="flex w-full items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2 text-xs font-medium text-foreground transition hover:bg-muted/60"
          >
            View detailed usage
            <ChevronRight className="h-3 w-3" />
          </button>
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <UsageTile
            label="Mailboxes"
            value={mailboxesUsed ?? 'N/A'}
            sublabel={mailboxLimit != null ? `of ${mailboxLimit}` : 'No limit'}
            showBar={mailboxLimit != null && mailboxLimit > 0 && mailboxesUsed != null}
            barPercent={
              mailboxLimit != null && mailboxLimit > 0 && mailboxesUsed != null
                ? Math.min(100, Math.round((mailboxesUsed / mailboxLimit) * 100))
                : 0
            }
            barLabel={
              mailboxLimit != null && mailboxLimit > 0 && mailboxesUsed != null
                ? `${Math.round((mailboxesUsed / mailboxLimit) * 100)}% used`
                : ''
            }
          />
          <UsageTile
            label="Admins"
            value={stats?.admin_count ?? 'N/A'}
            sublabel="No limit"
          />
          <UsageTile
            label="Users"
            value={stats?.user_count ?? 'N/A'}
            sublabel="No limit"
          />
          <UsageTile
            label="Features"
            value={enabledFeatures ?? 'N/A'}
            sublabel="enabled"
          />
        </div>
      </Card>

      {/* ── Bottom-left: Email processing settings ───────────────── */}
      <Card
        title="Email processing settings"
        subtitle="Configure how email is processed for this tenant."
        icon={<Mailbox className="h-4 w-4 text-violet-500" />}
        action={
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium transition hover:bg-muted/60"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
        }
      >
        <dl className="divide-y divide-border">
          <Row label="Status">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                tenant.ingestion_enabled
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {tenant.ingestion_enabled ? 'On' : 'Off'}
            </span>
          </Row>
          <Row label="Connector">
            <span className="flex flex-col gap-1">
              <span className="inline-flex w-fit items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                Email
              </span>
              <span className="text-xs text-muted-foreground">
                {tenant.ingestion_enabled
                  ? 'Active email-processing pipeline'
                  : 'No active connector'}
              </span>
            </span>
          </Row>
          <Row label="Last processed">
            <span className="text-foreground">{lastActivityRel ?? 'N/A'}</span>
          </Row>
          <Row label="Errors (24h)">
            <span className="text-foreground tabular-nums">0</span>
          </Row>
        </dl>
      </Card>

      {/* ── Bottom-right: Feature overview ───────────────────────── */}
      <Card
        title="Feature overview"
        subtitle="Features enabled for this tenant."
        icon={<Box className="h-4 w-4 text-primary" />}
        footer={
          <button
            type="button"
            onClick={() => onChangeTab('features')}
            className="flex w-full items-center justify-center rounded-md border border-border bg-muted/30 px-3 py-2 text-xs font-medium text-foreground transition hover:bg-muted/60"
          >
            Manage features
            <ChevronRight className="ml-1 h-3 w-3" />
          </button>
        }
      >
        <div className="space-y-2">
          <FeatureLine
            label="Email processing"
            description="Email processing pipeline"
            enabled={tenant.ingestion_enabled}
          />
          {featuresData && (
            <>
              <FeatureLine
                label="Custom outbound email"
                description="Send notifications from your own domain"
                enabled={featuresData.custom_outbound_email}
              />
              <FeatureLine
                label="Custom email template"
                description="Override the default templates"
                enabled={featuresData.custom_email_template}
              />
            </>
          )}
        </div>
      </Card>

      {isEditOpen && (
        <EditTenantModal tenant={tenant} onClose={() => setIsEditOpen(false)} />
      )}
    </section>
  );
};

// ─── Overview sub-components ─────────────────────────────────────────

const Card: React.FC<{
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, subtitle, icon, action, footer, children }) => (
  <div className="flex flex-col rounded-xl border border-border bg-card p-5">
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-2.5">
        {icon}
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {subtitle && (
            <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
      </div>
      {action}
    </div>
    <div className="mt-4 flex-1">{children}</div>
    {footer && <div className="mt-4">{footer}</div>}
  </div>
);

const UsageTile: React.FC<{
  label: string;
  value: number | string;
  sublabel: string;
  showBar?: boolean;
  barPercent?: number;
  barLabel?: string;
}> = ({ label, value, sublabel, showBar, barPercent = 0, barLabel = '' }) => (
  <div className="rounded-lg border border-border bg-background/60 p-3">
    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
    <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">{value}</div>
    <div className="text-[11px] text-muted-foreground">{sublabel}</div>
    {showBar ? (
      <div className="mt-2">
        <div className="h-1 w-full rounded-full bg-muted">
          <div
            className={`h-1 rounded-full ${barPercent >= 90 ? 'bg-rose-500' : barPercent >= 70 ? 'bg-amber-500' : 'bg-primary'}`}
            style={{ width: `${barPercent}%` }}
          />
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">{barLabel}</div>
      </div>
    ) : (
      <div className="mt-2 h-1 w-full rounded-full bg-muted/40">
        <div className="h-1 rounded-full bg-muted/40" />
      </div>
    )}
  </div>
);

const FeatureLine: React.FC<{
  label: string;
  description: string;
  enabled: boolean;
}> = ({ label, description, enabled }) => (
  <div className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3 py-2.5">
    <div className="flex items-center gap-2.5">
      <span
        className={`inline-flex h-2 w-2 rounded-full ${
          enabled ? 'bg-emerald-500' : 'bg-muted-foreground/50'
        }`}
        aria-hidden="true"
      />
      <div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-[11px] text-muted-foreground">{description}</div>
      </div>
    </div>
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
        enabled
          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
          : 'bg-muted text-muted-foreground'
      }`}
    >
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  </div>
);

// ─── Overview side rail (Tenant summary + Quick actions) ──────────

const OverviewSideRail: React.FC<{
  tenant: Tenant;
  onChangeTab: (next: TabKey) => void;
}> = ({ tenant, onChangeTab }) => {
  const { data: statsResp } = usePlatformTenantStats();
  const stats = statsResp?.stats?.[String(tenant.id)];
  const [copied, setCopied] = useState<'slug' | 'id' | null>(null);

  const copy = async (value: string, which: 'slug' | 'id') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable; silently ignore */
    }
  };

  const lastActivityRel = stats?.last_activity_at
    ? relativeShort(stats.last_activity_at)
    : 'N/A';

  return (
    <aside className="space-y-4">
      {/* Tenant summary */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground">Tenant summary</h3>
        <dl className="mt-3 space-y-2.5">
          <SummaryRow icon={<Users className="h-3.5 w-3.5" />} label="Admins" value={stats?.admin_count ?? 'N/A'} />
          <SummaryRow icon={<Users className="h-3.5 w-3.5" />} label="Users" value={stats?.user_count ?? 'N/A'} />
          <SummaryRow
            icon={<Mailbox className="h-3.5 w-3.5" />}
            label="Mailboxes"
            value={tenant.max_mailboxes != null ? `${tenant.max_mailboxes} max` : 'N/A'}
          />
          <SummaryRow icon={<Clock className="h-3.5 w-3.5" />} label="Last activity" value={lastActivityRel} />
        </dl>
        <hr className="my-3 border-border" />
        <div className="space-y-1.5">
          <SummaryCopyRow
            label="Tenant ID"
            value={String(tenant.id)}
            mono
            copied={copied === 'id'}
            onCopy={() => copy(String(tenant.id), 'id')}
          />
          <SummaryCopyRow
            label="Slug"
            value={tenant.slug}
            mono
            copied={copied === 'slug'}
            onCopy={() => copy(tenant.slug, 'slug')}
          />
        </div>
      </div>

      {/* Quick actions */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-amber-500" />
          <h3 className="text-sm font-semibold text-foreground">Quick actions</h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Common actions for this tenant.</p>
        <div className="mt-3 space-y-1">
          <QuickAction
            icon={<Users className="h-4 w-4" />}
            label="Manage admins"
            sublabel="Add, remove, or update admins"
            onClick={() => onChangeTab('admins')}
          />
          <QuickAction
            icon={<Box className="h-4 w-4" />}
            label="Manage features"
            sublabel="Enable or disable features"
            onClick={() => onChangeTab('features')}
          />
          <QuickAction
            icon={<FileText className="h-4 w-4" />}
            label="View audit log"
            sublabel="See recent activity and changes"
            onClick={() => onChangeTab('audit')}
          />
          {tenant.status === 'active' ? (
            <QuickAction
              icon={<PauseCircle className="h-4 w-4 text-rose-500" />}
              label="Suspend tenant"
              sublabel="Temporarily suspend this tenant"
              destructive
              onClick={() => onChangeTab('advanced')}
            />
          ) : tenant.status === 'suspended' ? (
            <QuickAction
              icon={<CheckCircle className="h-4 w-4 text-emerald-500" />}
              label="Resume tenant"
              sublabel="Restore sign-ins and processing"
              onClick={() => onChangeTab('advanced')}
            />
          ) : (
            <QuickAction
              icon={<ShieldOff className="h-4 w-4 text-amber-500" />}
              label="Mark inactive"
              sublabel="Hide from non-platform surfaces"
              onClick={() => onChangeTab('advanced')}
            />
          )}
          <QuickAction
            icon={<Trash2 className="h-4 w-4 text-rose-500" />}
            label="Delete tenant"
            sublabel="Permanently delete this tenant"
            destructive
            onClick={() => onChangeTab('advanced')}
          />
        </div>
      </div>
    </aside>
  );
};

const SummaryRow: React.FC<{ icon: React.ReactNode; label: string; value: React.ReactNode }> = ({ icon, label, value }) => (
  <div className="flex items-center justify-between text-sm">
    <span className="flex items-center gap-2 text-muted-foreground">
      <span className="text-muted-foreground/80">{icon}</span>
      {label}
    </span>
    <span className="font-semibold tabular-nums text-foreground">{value}</span>
  </div>
);

const SummaryCopyRow: React.FC<{
  label: string;
  value: string;
  mono?: boolean;
  copied: boolean;
  onCopy: () => void;
}> = ({ label, value, mono, copied, onCopy }) => (
  <div className="flex items-center justify-between text-xs">
    <span className="text-muted-foreground">{label}</span>
    <div className="flex items-center gap-1.5">
      <span className={`text-foreground ${mono ? 'font-mono' : ''}`}>{value}</span>
      <button
        type="button"
        onClick={onCopy}
        title={copied ? 'Copied' : 'Copy'}
        className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground"
        aria-label={`Copy ${label}`}
      >
        {copied ? <CheckCircle className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  </div>
);

const QuickAction: React.FC<{
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  destructive?: boolean;
  onClick: () => void;
}> = ({ icon, label, sublabel, destructive, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm transition hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-primary/30 ${
      destructive ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'
    }`}
  >
    <span className={destructive ? 'text-rose-500' : 'text-muted-foreground'}>{icon}</span>
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium">{label}</div>
      <div className="text-[11px] text-muted-foreground">{sublabel}</div>
    </div>
    <ChevronRight className={`h-4 w-4 ${destructive ? 'text-rose-500/70' : 'text-muted-foreground'}`} />
  </button>
);

const relativeShort = (iso: string): string => {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'N/A';
  const diffMs = Date.now() - then.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// ── EditTenantModal ──────────────────────────────────────────────────

interface EditTenantModalProps {
  tenant: Tenant;
  onClose: () => void;
}

const EditTenantModal: React.FC<EditTenantModalProps> = ({ tenant, onClose }) => {
  const [name, setName] = useState(tenant.name);
  const [status, setStatus] = useState<Tenant['status']>(tenant.status);
  const [ingestionEnabled, setIngestionEnabled] = useState(tenant.ingestion_enabled);
  const [error, setError] = useState<string | null>(null);

  const updateTenant = useUpdateTenant();

  const dirty =
    name.trim() !== tenant.name
    || status !== tenant.status
    || ingestionEnabled !== tenant.ingestion_enabled;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    const payload: Parameters<typeof updateTenant.mutate>[0]['data'] = {};
    if (name.trim() !== tenant.name) payload.name = name.trim();
    if (status !== tenant.status) payload.status = status;
    if (ingestionEnabled !== tenant.ingestion_enabled) payload.ingestion_enabled = ingestionEnabled;
    updateTenant.mutate(
      { tenantId: tenant.id, data: payload },
      {
        onSuccess: () => onClose(),
        onError: (err: unknown) => {
          if (axios.isAxiosError(err)) {
            const detail = err.response?.data?.detail;
            setError(typeof detail === 'string' ? detail : 'Failed to update tenant.');
          } else if (err instanceof Error) {
            setError(err.message);
          } else {
            setError('Failed to update tenant.');
          }
        },
      },
    );
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-[rgba(0,0,0,0.45)] px-4 py-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-card shadow-[0_4px_24px_rgba(0,0,0,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Edit tenant</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Routine changes only. Suspending or deleting goes through the Advanced tab.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
            <input
              type="text"
              className="field-input w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Status</label>
            <select
              className="field-input w-full"
              value={status}
              onChange={(e) => setStatus(e.target.value as Tenant['status'])}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="suspended">Suspended</option>
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Inactive blocks tenant logins. Suspended freezes the tenant and routes them to a holding page.
            </p>
          </div>
          <div>
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={ingestionEnabled}
                onChange={(e) => setIngestionEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
              />
              <div>
                <p className="text-sm font-medium text-foreground leading-tight">Email processing enabled</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Turns the Mailboxes settings page on for this tenant and lets the worker fetch their inbound timesheet emails.
                </p>
              </div>
            </label>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="action-button-secondary text-sm"
              disabled={updateTenant.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="action-button text-sm"
              disabled={updateTenant.isPending || !dirty}
            >
              {updateTenant.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center gap-4 py-2.5">
    <dt className="w-40 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
    <dd className="flex-1 text-sm text-foreground">{children}</dd>
  </div>
);

// ── Admins tab ───────────────────────────────────────────────────────

const AdminsTab: React.FC<{ tenant: Tenant }> = ({ tenant }) => {
  // Pass the slug so the backend routes /users to the correct
  // tenant DB and applies the tenant_id filter. Without it the
  // request 400s for platform-admin callers (no X-Tenant-Slug).
  const { data: allUsers = [] } = useUsers(true, tenant.slug);
  const admins = useMemo(
    () => allUsers.filter((u) => u.role === 'ADMIN'),
    [allUsers],
  );
  // Slide-over state: which admin is being managed. null = closed.
  const [activeAdmin, setActiveAdmin] = useState<User | null>(null);
  const [isAddOpen, setIsAddOpen] = useState(false);
  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Admin contacts ({admins.length})</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Click an admin to manage them in a side panel.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setIsAddOpen(true)}
            className="action-button text-sm"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            Add admin
          </button>
        </div>
        {admins.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No admin contacts yet.</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {admins.map((admin) => (
              <li key={admin.id}>
                <button
                  type="button"
                  onClick={() => setActiveAdmin(admin)}
                  className="flex w-full items-center gap-3 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm transition hover:border-primary/30 hover:bg-muted"
                >
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-foreground">{admin.full_name}</p>
                    <p className="font-mono text-xs text-muted-foreground">{admin.email}</p>
                  </div>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${admin.is_active ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}
                  >
                    {admin.is_active ? 'Active' : 'Inactive'}
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {activeAdmin && (
        <AdminSlideOver
          admin={activeAdmin}
          tenantSlug={tenant.slug}
          onClose={() => setActiveAdmin(null)}
        />
      )}
      {isAddOpen && (
        <AddAdminModal
          tenant={tenant}
          onClose={() => setIsAddOpen(false)}
        />
      )}
    </section>
  );
};

// ── AddAdminModal ────────────────────────────────────────────────────

interface AddAdminModalProps {
  tenant: Tenant;
  onClose: () => void;
}

const AddAdminModal: React.FC<AddAdminModalProps> = ({ tenant, onClose }) => {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const createUser = useCreateUser();

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!fullName.trim() || !email.trim() || !username.trim()) {
      setError('All fields are required.');
      return;
    }
    // The backend always auto-generates an initial password and sends
    // a setup-your-password email — we never pass a user-typed value.
    createUser.mutate(
      {
        data: {
          full_name: fullName.trim(),
          email: email.trim(),
          username: username.trim().toLowerCase(),
          role: 'ADMIN' as UserRole,
          tenant_id: tenant.id,
          // Admin contacts are internal users, not external contractors.
          is_external: false,
        },
        tenantSlug: tenant.slug,
      },
      {
        onSuccess: () => onClose(),
        onError: (err: unknown) => {
          if (axios.isAxiosError(err)) {
            const detail = err.response?.data?.detail;
            setError(typeof detail === 'string' ? detail : 'Failed to add admin.');
          } else if (err instanceof Error) {
            setError(err.message);
          } else {
            setError('Failed to add admin.');
          }
        },
      },
    );
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-[rgba(0,0,0,0.45)] px-4 py-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-card shadow-[0_4px_24px_rgba(0,0,0,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Add admin to {tenant.name}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Creates an ADMIN-role user inside this tenant. They'll get an email to set their password.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Full name</label>
            <input
              type="text"
              className="field-input w-full"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Jane Smith"
              required
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Email</label>
            <input
              type="email"
              className="field-input w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@example.com"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Username</label>
            <input
              type="text"
              className="field-input w-full font-mono"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              placeholder="jane.smith"
              minLength={3}
              required
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="action-button-secondary text-sm"
              disabled={createUser.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="action-button text-sm"
              disabled={createUser.isPending}
            >
              {createUser.isPending ? 'Adding…' : 'Add admin'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ── AdminSlideOver ───────────────────────────────────────────────────
//
// Single panel that replaces the legacy four-modal stack
// (Edit / Resend verification / Reset password / Delete admin). The
// destructive actions are kept visually separated and gated by the
// shared ConfirmDialog with typed-confirmation - same pattern as
// the tenant Advanced tab.

interface AdminSlideOverProps {
  admin: User;
  // Platform-admin callers must include the tenant slug so DELETE /users/:id
  // carries an X-Tenant-Slug header. Without it, the backend's tenant-db
  // dep rejects PA requests because PA tokens have no tenant claim.
  tenantSlug: string;
  onClose: () => void;
}

const AdminSlideOver: React.FC<AdminSlideOverProps> = ({
  admin,
  tenantSlug,
  onClose,
}) => {
  const [fullName, setFullName] = useState(admin.full_name);
  const [email, setEmail] = useState(admin.email);
  const [username, setUsername] = useState(admin.username);
  const [isActive, setIsActive] = useState(admin.is_active);
  const [resetPw, setResetPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);

  // Re-sync local form state when the slide-over is reopened with a
  // different admin (parent passes a new admin prop).
  React.useEffect(() => {
    setFullName(admin.full_name);
    setEmail(admin.email);
    setUsername(admin.username);
    setIsActive(admin.is_active);
    setResetPw('');
    setError(null);
    setToast(null);
  }, [admin.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateUser = useUpdateUser();
  const resetPassword = useResetUserPassword();
  const sendInvite = useSendInvite();
  const deleteUser = useDeleteUser();

  const dirty =
    fullName !== admin.full_name ||
    email !== admin.email ||
    username !== admin.username ||
    isActive !== admin.is_active;

  const flashToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  const apiError = (err: unknown): string =>
    (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
    ?? 'Something went wrong';

  const handleSave = async () => {
    setError(null);
    if (!fullName.trim() || !email.trim() || !username.trim()) {
      setError('Name, email, and username are required.');
      return;
    }
    try {
      await updateUser.mutateAsync({
        id: admin.id,
        data: {
          full_name: fullName.trim(),
          email: email.trim().toLowerCase(),
          username: username.trim().toLowerCase(),
          is_active: isActive,
        },
        tenantSlug,
      });
      flashToast('Saved');
    } catch (err) {
      setError(apiError(err));
    }
  };

  const handleResetPassword = async () => {
    setError(null);
    if (resetPw.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    try {
      await resetPassword.mutateAsync({ id: admin.id, newPassword: resetPw, tenantSlug });
      setResetPw('');
      flashToast('Password reset');
    } catch (err) {
      setError(apiError(err));
    }
  };

  const handleResendInvite = async () => {
    setError(null);
    try {
      await sendInvite.mutateAsync({ id: admin.id, tenantSlug });
      flashToast('Invite sent');
    } catch (err) {
      setError(apiError(err));
    }
  };

  const handleDelete = async (typedValue: string | null) => {
    if (typedValue !== admin.email) {
      setError('Typed value does not match the admin email.');
      return;
    }
    setError(null);
    try {
      await deleteUser.mutateAsync({ id: admin.id, tenantSlug });
      setPendingDelete(false);
      onClose();
    } catch (err) {
      setError(apiError(err));
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex justify-end bg-black/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Manage admin ${admin.full_name}`}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-md flex-col overflow-y-auto bg-card shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">{admin.full_name}</h2>
            <p className="font-mono text-xs text-muted-foreground">{admin.email}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground transition hover:text-foreground"
            aria-label="Close"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        </div>

        {toast && (
          <div className="mx-5 mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
            {toast}
          </div>
        )}
        {error && (
          <div className="mx-5 mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}

        {/* Identity */}
        <section className="space-y-3 px-5 py-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Identity</h3>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Full name</label>
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm text-foreground"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm text-foreground"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            Active (can sign in)
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || updateUser.isPending}
              className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
            >
              {updateUser.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </section>

        {/* Credentials */}
        <section className="space-y-3 border-t border-border px-5 py-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Credentials</h3>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Reset password</label>
            <p className="mt-1 text-[11px] text-muted-foreground">
              The admin will be logged out everywhere and must use the new password on next sign-in. Minimum 8 characters.
            </p>
            <div className="mt-2 flex items-stretch gap-2">
              <input
                type="text"
                value={resetPw}
                onChange={(e) => setResetPw(e.target.value)}
                placeholder="New password"
                className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm text-foreground"
              />
              <button
                type="button"
                onClick={handleResetPassword}
                disabled={resetPw.length < 8 || resetPassword.isPending}
                className="inline-flex items-center rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
              >
                {resetPassword.isPending ? 'Resetting…' : 'Reset'}
              </button>
            </div>
          </div>
          <div className="pt-2">
            <label className="text-xs font-medium text-muted-foreground">Send invite</label>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Email the admin a sign-in link. Useful when the previous invite expired or the email was misdirected.
            </p>
            <button
              type="button"
              onClick={handleResendInvite}
              disabled={sendInvite.isPending}
              className="mt-2 inline-flex items-center rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
            >
              {sendInvite.isPending ? 'Sending…' : 'Send invite email'}
            </button>
          </div>
        </section>

        {/* Advanced */}
        <section className="space-y-3 border-t border-rose-500/20 bg-rose-500/[0.03] px-5 py-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-rose-600 dark:text-rose-400">
            Advanced
          </h3>
          <div className="flex items-center gap-3 rounded-md border border-rose-500/20 bg-rose-500/[0.04] px-3 py-2">
            <Trash2 className="h-4 w-4 text-rose-500" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-rose-600 dark:text-rose-400">Delete admin</p>
              <p className="text-[11px] text-rose-700/80 dark:text-rose-300/70">
                Removes this admin. Cannot be undone. Audit log entries survive.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPendingDelete(true)}
              className="inline-flex items-center rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-700"
            >
              Delete…
            </button>
          </div>
        </section>
      </aside>

      <ConfirmDialog
        open={pendingDelete}
        title={`Delete ${admin.full_name}?`}
        description={
          <p>
            This admin will be removed and can no longer sign in. The action is logged in the platform audit log.
          </p>
        }
        tone="destructive"
        confirmLabel="Delete admin"
        expectedTypedValue={admin.email}
        typeFieldLabel="Type the admin email to confirm"
        typeFieldPlaceholder={admin.email}
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(false)}
        isPending={deleteUser.isPending}
        errorMessage={error}
      />
    </div>
  );
};

// ── Feature flags tab ────────────────────────────────────────────────

const FeaturesTab: React.FC<{ tenant: Tenant }> = ({ tenant }) => (
  <section className="space-y-4">
    <div className="rounded-xl border border-border bg-card p-5">
      <h2 className="text-sm font-semibold text-foreground">Feature flags</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Each toggle persists immediately. Changes are recorded in the platform audit log.
      </p>
      <div className="mt-3">
        <TenantFeatureFlags tenantId={tenant.id} />
      </div>
    </div>
  </section>
);

// ── Audit log tab ────────────────────────────────────────────────────
//
// Tenant-scoped slice of /platform/audit. We reuse the existing
// usePlatformAudit hook with a tenant_id filter so we don't duplicate
// the audit list endpoint. Clicking a row navigates to the full Audit
// page with the same filter applied + the event ID auto-opened in the
// drawer (B.7 deep link).

const AUDIT_CATEGORY_PILLS: Record<
  PlatformAuditEventRow['category'],
  { label: string; classes: string }
> = {
  tenant: { label: 'Tenant', classes: 'bg-rose-500/15 text-rose-600 dark:text-rose-400' },
  feature: { label: 'Feature', classes: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
  admin: { label: 'Admin', classes: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  credentials: { label: 'Credentials', classes: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  migration: { label: 'Migration', classes: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300' },
  system: { label: 'System', classes: 'bg-muted text-muted-foreground' },
};

const AUDIT_PAGE_SIZE = 25;

const AuditTab: React.FC<{ tenant: Tenant }> = ({ tenant }) => {
  const navigate = useNavigate();
  const { data, isLoading, error } = usePlatformAudit({
    tenant_id: tenant.id,
    limit: AUDIT_PAGE_SIZE,
  });
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Audit log</h2>
            <p className="text-xs text-muted-foreground">
              {total === 0
                ? 'No platform audit events for this tenant yet.'
                : `${items.length} of ${total} events`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/platform/settings?tab=logs&tenant_id=${tenant.id}`)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted"
          >
            Open full audit
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>

        {isLoading ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : error ? (
          <div className="px-5 py-8 text-center text-sm text-rose-500">Failed to load audit log.</div>
        ) : items.length === 0 ? (
          <div className="px-5 py-10 text-center text-xs text-muted-foreground">
            No events yet. Tenant lifecycle actions, feature toggles, and credential rotations land here.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted/30">
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-2 font-semibold">When</th>
                <th className="px-5 py-2 font-semibold">Actor</th>
                <th className="px-5 py-2 font-semibold">Event</th>
                <th className="px-5 py-2 font-semibold">Summary</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => {
                const pill = AUDIT_CATEGORY_PILLS[row.category];
                return (
                  <tr
                    key={row.id}
                    onClick={() =>
                      // B.7 deep link. The Logs sub-tab inside Settings
                      // is the canonical Platform audit surface now.
                      // event_id is reserved for the drawer-auto-open
                      // wire (queued in the audit page itself).
                      navigate(`/platform/settings?tab=logs&tenant_id=${tenant.id}&event_id=${row.id}`)
                    }
                    className="cursor-pointer border-t border-border hover:bg-muted/40"
                  >
                    <td className="whitespace-nowrap px-5 py-2.5 text-foreground">
                      {new Date(row.created_at).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="whitespace-nowrap px-5 py-2.5 text-foreground">
                      {row.actor_email ?? row.actor_label ?? 'System'}
                    </td>
                    <td className="whitespace-nowrap px-5 py-2.5">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${pill.classes}`}
                      >
                        {pill.label}
                      </span>
                      <code className="ml-2 font-mono text-[10px] text-muted-foreground">{row.event}</code>
                    </td>
                    <td className="px-5 py-2.5 text-foreground">{row.summary}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
};

// ── Advanced tab ─────────────────────────────────────────────────────

const AdvancedTab: React.FC<{ tenant: Tenant }> = ({ tenant }) => {
  type Pending = null | {
    action: 'mark_inactive' | 'suspend' | 'resume' | 'delete';
    title: string;
    description: React.ReactNode;
    confirmLabel: string;
    tone: 'destructive' | 'warning';
    requiresTyping: boolean;
  };

  const [pending, setPending] = useState<Pending>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const lifecycle = useTenantLifecycle();
  const navigate = useNavigate();

  const openConfirm = (preset: NonNullable<Pending>) => {
    setErrorMessage(null);
    setPending(preset);
  };

  const onConfirm = async (typedValue: string | null) => {
    if (!pending) return;
    setErrorMessage(null);
    try {
      await lifecycle.mutateAsync({
        tenantId: tenant.id,
        action: pending.action,
        confirmationToken: typedValue ?? undefined,
      });
      // Delete archives the tenant - the list query will drop it, so
      // bounce back to the tenants index. Other actions stay on-page.
      if (pending.action === 'delete') {
        setPending(null);
        navigate('/platform/tenants', { replace: true });
        return;
      }
      setPending(null);
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? 'The action failed. Try again or check the platform audit log.';
      setErrorMessage(detail);
    }
  };

  // Available actions vary by current status: a suspended tenant gets
  // Resume; an active tenant gets the destructive trio.
  const isActive = tenant.status === 'active';
  const isInactive = tenant.status === 'inactive';
  const isSuspended = tenant.status === 'suspended';

  return (
    <section className="space-y-3">
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.04] p-5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-rose-400" />
          <div>
            <h2 className="text-sm font-semibold text-rose-600 dark:text-rose-400">
              Advanced
            </h2>
            <p className="mt-1 text-xs text-rose-700/80 dark:text-rose-300/70">
              Destructive lifecycle actions. Each requires typing the tenant name to confirm and is recorded in the platform audit log with the typed token in the payload.
            </p>
          </div>
        </div>
      </div>

      {/* Mark inactive */}
      <ActionCard
        icon={<PowerOff className="h-4 w-4 text-amber-500" />}
        title="Mark inactive"
        description="Hides the tenant from non-platform surfaces. Users can still sign in. Reversible by editing the tenant or re-enabling here."
        button={isInactive ? null : (
          <button
            type="button"
            onClick={() =>
              openConfirm({
                action: 'mark_inactive',
                title: `Mark ${tenant.name} as inactive?`,
                description: (
                  <span>
                    The tenant will be hidden from non-platform surfaces (dashboards, reports). Users continue to sign in normally. This is reversible.
                  </span>
                ),
                confirmLabel: 'Mark inactive',
                tone: 'warning',
                requiresTyping: true,
              })
            }
            className="inline-flex items-center rounded-md border border-amber-500/40 bg-transparent px-3 py-1.5 text-xs font-semibold text-amber-600 transition hover:bg-amber-500/10 dark:text-amber-400"
          >
            Mark inactive
          </button>
        )}
      />

      {/* Suspend / Resume */}
      {isSuspended ? (
        <ActionCard
          icon={<CheckCircle className="h-4 w-4 text-emerald-500" />}
          title="Resume tenant"
          description="Restore sign-ins and resume email processing. Reverses the previous suspension."
          button={
            <button
              type="button"
              onClick={() =>
                openConfirm({
                  action: 'resume',
                  title: `Resume ${tenant.name}?`,
                  description: (
                    <span>
                      Users will be able to sign in again and any paused
                      email processing will resume on its next scheduled run.
                    </span>
                  ),
                  confirmLabel: 'Resume tenant',
                  tone: 'warning',
                  requiresTyping: false,
                })
              }
              className="inline-flex items-center rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700"
            >
              Resume tenant
            </button>
          }
        />
      ) : (
        <ActionCard
          icon={<PauseCircle className="h-4 w-4 text-rose-500" />}
          title="Suspend tenant"
          description="Blocks all user sign-ins, pauses email processing, halts scheduled jobs. Reversible from this same panel."
          button={isActive || isInactive ? (
            <button
              type="button"
              onClick={() =>
                openConfirm({
                  action: 'suspend',
                  title: `Suspend ${tenant.name}?`,
                  description: (
                    <span>
                      All users will be blocked from signing in. Email processing stops, scheduled jobs halt. No data is deleted - reversible from the Advanced tab. This action is recorded in the platform audit log.
                    </span>
                  ),
                  confirmLabel: 'Suspend tenant',
                  tone: 'destructive',
                  requiresTyping: true,
                })
              }
              className="inline-flex items-center rounded-md border border-rose-500/40 bg-transparent px-3 py-1.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-500/10 dark:text-rose-400"
            >
              Suspend tenant
            </button>
          ) : null}
        />
      )}

      {/* Delete */}
      <ActionCard
        icon={<Trash2 className="h-4 w-4 text-rose-500" />}
        title="Delete tenant (permanent)"
        description="Archives the tenant and removes it from every operational view. Audit log entries survive. This action cannot be undone from the UI."
        button={
          <button
            type="button"
            onClick={() =>
              openConfirm({
                action: 'delete',
                title: `Delete ${tenant.name}?`,
                description: (
                  <>
                    <p>
                      The tenant will be archived and removed from every operational view immediately. Users cannot sign in.
                    </p>
                    <p className="mt-2">
                      <strong>This cannot be undone from the UI.</strong> Audit log entries for the tenant remain readable so you can trace the deletion.
                    </p>
                  </>
                ),
                confirmLabel: 'Delete tenant',
                tone: 'destructive',
                requiresTyping: true,
              })
            }
            className="inline-flex items-center rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-700"
          >
            Delete tenant…
          </button>
        }
      />

      <ConfirmDialog
        open={pending !== null}
        title={pending?.title ?? ''}
        description={pending?.description}
        tone={pending?.tone}
        confirmLabel={pending?.confirmLabel ?? 'Confirm'}
        expectedTypedValue={
          pending?.requiresTyping ? tenant.name : undefined
        }
        typeFieldLabel="Type the tenant name to confirm"
        typeFieldPlaceholder={tenant.name}
        onConfirm={onConfirm}
        onCancel={() => {
          if (lifecycle.isPending) return;
          setPending(null);
          setErrorMessage(null);
        }}
        isPending={lifecycle.isPending}
        errorMessage={errorMessage}
      />
    </section>
  );
};

const ActionCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  button: React.ReactNode | null;
}> = ({ icon, title, description, button }) => {
  if (!button) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-rose-500/20 bg-rose-500/[0.02] px-4 py-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-rose-500/10">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-rose-600 dark:text-rose-400">{title}</h3>
        <p className="mt-0.5 text-xs text-rose-700/80 dark:text-rose-300/70">{description}</p>
      </div>
      <div className="shrink-0">{button}</div>
    </div>
  );
};

// ── EditIdentityModal ────────────────────────────────────────────────
//
// Tenant identity edits live here. Status is intentionally NOT in this
// form anymore - lifecycle changes route through the Advanced tab so
// the typed-name gate isn't bypassed. Ingestion was also moved out
// (see Feature flags tab) so toggles don't fight each other across
// two surfaces.

interface EditIdentityModalProps {
  tenant: Tenant;
  onClose: () => void;
}

const EditIdentityModal: React.FC<EditIdentityModalProps> = ({ tenant, onClose }) => {
  const qc = useQueryClient();
  const [name, setName] = useState(tenant.name);
  const [slug, setSlug] = useState(tenant.slug);
  const [maxMailboxes, setMaxMailboxes] = useState(
    tenant.max_mailboxes == null ? '' : String(tenant.max_mailboxes),
  );
  const [timezone, setTimezone] = useState(tenant.timezone ?? '');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (data: {
      name?: string;
      slug?: string;
      max_mailboxes?: number | null;
      timezone?: string | null;
    }) => tenantsAPI.update(tenant.id, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants'] });
      qc.invalidateQueries({ queryKey: ['platform', 'audit'] });
      onClose();
    },
    onError: (e: unknown) => {
      const detail =
        (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? 'Save failed.';
      setError(detail);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();
    if (!trimmedName || !trimmedSlug) {
      setError('Name and slug are required.');
      return;
    }
    if (!/^[a-z0-9-]+$/.test(trimmedSlug)) {
      setError('Slug must be lowercase letters, numbers, hyphens only.');
      return;
    }
    const mb = maxMailboxes.trim();
    const mbValue = mb === '' ? null : Math.max(0, parseInt(mb, 10) || 0);
    const tz = timezone.trim();
    mutation.mutate({
      name: trimmedName,
      slug: trimmedSlug,
      max_mailboxes: mbValue,
      timezone: tz === '' ? null : tz,
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit tenant identity"
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/40 px-4"
      onClick={() => { if (!mutation.isPending) onClose(); }}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={submit} className="p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Edit identity</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Name, slug, timezone, mailbox cap. Status changes are in the Advanced tab; feature toggles are in Feature flags.
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Slug</label>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
              pattern="^[a-z0-9-]+$"
              required
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Changing the slug also changes the URL for this tenant. Existing links break.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Max mailboxes</label>
              <input
                type="number"
                min={0}
                value={maxMailboxes}
                onChange={(e) => setMaxMailboxes(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                placeholder="no limit"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Timezone</label>
              <input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
                placeholder="UTC"
              />
            </div>
          </div>
          {error && <p className="text-xs text-rose-500">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={mutation.isPending}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {mutation.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
