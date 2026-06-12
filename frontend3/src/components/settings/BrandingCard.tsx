import { useEffect, useRef, useState } from 'react';
import { Loader2, Trash2, Upload } from 'lucide-react';

import { Button, Card } from '@/components/ui';
import { api, brandingApi } from '@/api/client';

const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif';

// Tenant branding: upload / preview / delete the logo used on exported reports.
// The logo bytes are fetched through the auth-attached client (never a public
// URL), so we load it into an object URL for the <img> preview.
export function BrandingCard() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [hasLogo, setHasLogo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadLogo() {
    try {
      const res = await api.get(brandingApi.logoUrl, { responseType: 'blob' });
      const blob = res.data as Blob;
      if (blob && blob.size > 0) {
        setLogoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
        setHasLogo(true);
      } else {
        setHasLogo(false);
      }
    } catch {
      // 404 = no logo yet; treat as "no logo".
      setHasLogo(false);
    }
  }

  useEffect(() => {
    loadLogo();
    return () => { setLogoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleFile(file: File) {
    setError(null);
    if (file.size > MAX_BYTES) { setError('File is too large. Maximum 2 MB.'); return; }
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) { setError('Unsupported file type. Use PNG, JPG, WEBP, or GIF.'); return; }
    setBusy(true);
    try { await brandingApi.uploadLogo(file); await loadLogo(); }
    catch (e) { setError((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Upload failed.'); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  }
  async function handleRemove() {
    setBusy(true);
    try { await brandingApi.deleteLogo(); setLogoUrl((p) => { if (p) URL.revokeObjectURL(p); return null; }); setHasLogo(false); }
    catch (e) { setError((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Could not remove logo.'); }
    finally { setBusy(false); }
  }

  return (
    <Card className="p-5">
      <p className="text-sm font-semibold text-foreground">Brand &amp; logo</p>
      <p className="mt-0.5 text-xs text-muted-foreground">PNG, JPG, WEBP, or GIF up to 2 MB. Recommended 400×120px, transparent background. Appears on exported reports.</p>
      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex h-20 w-52 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/30">
          {hasLogo && logoUrl ? (
            <img src={logoUrl} alt="Tenant logo" style={{ maxWidth: '90%', maxHeight: '90%', objectFit: 'contain' }} />
          ) : (
            <span className="text-sm font-medium text-muted-foreground">No logo</span>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {hasLogo ? 'Replace logo' : 'Upload logo'}
            </Button>
            {hasLogo ? (
              <Button variant="secondary" size="sm" onClick={handleRemove} disabled={busy} className="text-rose-600 hover:bg-rose-500/10 dark:text-rose-300">
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </Button>
            ) : null}
          </div>
          <input ref={fileRef} type="file" accept={ACCEPT} className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
          {error ? <p className="text-xs text-rose-600 dark:text-rose-300">{error}</p> : null}
          <p className="text-[11px] text-muted-foreground">Stored privately for this workspace.</p>
        </div>
      </div>
    </Card>
  );
}
