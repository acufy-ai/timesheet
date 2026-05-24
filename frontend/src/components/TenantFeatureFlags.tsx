import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';

import { tenantsAPI, type TenantFeatures } from '@/api/endpoints';

interface Props {
  tenantId: number;
}

interface FlagDef {
  key: keyof Omit<TenantFeatures, 'tenant_id'>;
  label: string;
  description: string;
}

const FLAGS: FlagDef[] = [
  {
    key: 'custom_outbound_email',
    label: 'Custom Outbound Email',
    description:
      "Tenant can route invitation and reset emails through their OAuth mailbox or a custom SMTP server instead of the platform default.",
  },
  {
    key: 'custom_email_template',
    label: 'Custom Email Template',
    description:
      'Tenant can edit the invitation email body and branding from their admin settings.',
  },
];

const apiError = (err: unknown): string => {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail;
    if (typeof detail === 'string') return detail;
  }
  if (err instanceof Error) return err.message;
  return 'Failed to update feature flag.';
};

export const TenantFeatureFlags: React.FC<Props> = ({ tenantId }) => {
  const qc = useQueryClient();

  const { data: features, isLoading, isError } = useQuery({
    queryKey: ['tenant-features', tenantId],
    queryFn: () => tenantsAPI.getTenantFeatures(tenantId).then((r) => r.data),
  });

  const mutation = useMutation({
    mutationFn: ({ key, value }: { key: FlagDef['key']; value: boolean }) =>
      tenantsAPI.updateTenantFeatures(tenantId, { [key]: value }).then((r) => r.data),
    onSuccess: (data) => {
      qc.setQueryData(['tenant-features', tenantId], data);
    },
  });

  return (
    <div>
      {isLoading && (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-foreground" />
          Loading flags…
        </div>
      )}

      {isError && (
        <p className="text-sm text-destructive py-2">Failed to load feature flags.</p>
      )}

      {features && (
        <div className="space-y-2">
          {FLAGS.map((flag) => {
            const value = features[flag.key];
            const isPending = mutation.isPending && mutation.variables?.key === flag.key;
            return (
              <div
                key={flag.key}
                className="rounded-lg border border-border bg-card px-4 py-3 flex items-start justify-between gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-foreground text-sm">{flag.label}</div>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {flag.description}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={value}
                  onClick={() => mutation.mutate({ key: flag.key, value: !value })}
                  disabled={isPending}
                  title={value ? 'Click to disable' : 'Click to enable'}
                  className={`relative shrink-0 inline-flex h-[22px] w-[42px] rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    value ? 'bg-primary' : 'bg-muted-foreground/30'
                  }`}
                >
                  <span
                    className={`absolute top-[2px] left-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform ${
                      value ? 'translate-x-[20px]' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            );
          })}

          {mutation.isError && (
            <p className="text-sm text-destructive mt-2">{apiError(mutation.error)}</p>
          )}
        </div>
      )}
    </div>
  );
};
