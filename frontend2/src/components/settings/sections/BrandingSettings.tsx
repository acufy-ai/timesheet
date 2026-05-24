import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload, Trash2 } from 'lucide-react';

import { SectionWrapper, Card } from '../SettingsPrimitives';
import { adminAPI } from '@/api/endpoints';
import { useAuth } from '@/hooks';
import { useTenantLogo } from '@/hooks/useTenantLogo';

const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif';

export const BrandingSettings: React.FC = () => {
  const { tenant, refreshTenant } = useAuth();
  const { dataUrl: logoDataUrl, refresh: refreshLogo } = useTenantLogo();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(null);
  }, [tenant?.has_logo]);

  const upload = useMutation({
    mutationFn: (file: File) => adminAPI.uploadTenantLogo(file).then((r) => r.data),
    onSuccess: async () => {
      await refreshTenant();
      await refreshLogo();
      queryClient.invalidateQueries({ queryKey: ['tenant-logo'] });
    },
  });

  const remove = useMutation({
    mutationFn: () => adminAPI.deleteTenantLogo().then((r) => r.data),
    onSuccess: async () => {
      await refreshTenant();
      await refreshLogo();
      queryClient.invalidateQueries({ queryKey: ['tenant-logo'] });
    },
  });

  const handleFile = async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) {
      setError(`File is too large. Maximum 2 MB.`);
      return;
    }
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
      setError('Unsupported file type. Use PNG, JPG, WEBP, or GIF.');
      return;
    }
    setBusy(true);
    try {
      await upload.mutateAsync(file);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Upload failed.';
      setError(msg);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    try {
      await remove.mutateAsync();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not remove logo.';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const hasLogo = Boolean(tenant?.has_logo);

  return (
    <SectionWrapper
      title="Brand & logo"
      desc="The logo appears on exported reports (Approved Timesheets PDF) and on internal documents. When no logo is uploaded the tenant name is used instead."
    >
      <Card
        title="Tenant logo"
        desc="PNG, JPG, WEBP, or GIF up to 2 MB. Recommended: 400×120 px, transparent background. Keep it horizontal. Square logos work but look cramped in report headers."
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div
            className="shrink-0 flex items-center justify-center rounded-lg border border-border bg-muted/30"
            style={{ width: 200, height: 80 }}
          >
            {hasLogo && logoDataUrl ? (
              // eslint-disable-next-line jsx-a11y/img-redundant-alt
              <img
                src={logoDataUrl}
                alt={`${tenant?.name ?? 'Tenant'} logo`}
                style={{ maxWidth: '90%', maxHeight: '90%', objectFit: 'contain' }}
              />
            ) : (
              <span className="text-sm font-medium text-muted-foreground">
                {tenant?.name ?? 'No logo'}
              </span>
            )}
          </div>

          <div className="flex flex-1 flex-col gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Upload className="w-3.5 h-3.5" />
                {hasLogo ? 'Replace logo' : 'Upload logo'}
              </button>
              {hasLogo && (
                <button
                  type="button"
                  onClick={handleRemove}
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Remove
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
            <p className="text-[11px] text-muted-foreground">
              Logo is stored privately for this tenant. Only members of {tenant?.name ?? 'your tenant'} can see it.
            </p>
          </div>
        </div>
      </Card>
    </SectionWrapper>
  );
};
