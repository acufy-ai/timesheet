import { useEffect, useState } from 'react';
import { Check, Copy, Link2, RefreshCw, Trash2 } from 'lucide-react';

import { Button, Modal, Toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  useShareDashboard, useRefreshDashboardSnapshot, useRevokeDashboardShare,
} from '@/hooks/useCustomDashboards';
import type { CustomDashboard, ShareMode } from '@/types/customDashboard';

// Smartsheet-style share dialog. Three ways to share a dashboard read-only:
//   1. Public link   — a no-login URL anyone can open. Live (re-queries each
//                      load) or Snapshot (frozen data the owner can refresh).
//   2. Email people  — opens the user's mail client with the link prefilled.
//   3. Export        — print to PDF / save (the browser's print dialog), for a
//                      static copy. No live data, no exposure.
// The link the public viewer opens is the SPA route /shared/<token>.

function publicUrl(token: string): string {
  // The public view lives at /shared/<token> within this same SPA. Use the app's
  // own origin + base path so it works in dev and under a sub-path in prod.
  const base = `${window.location.origin}${import.meta.env.BASE_URL || '/'}`.replace(/\/+$/, '');
  return `${base}/shared/${token}`;
}

export function ShareDashboardModal({ dashboard, open, onClose }: {
  dashboard: CustomDashboard | null;
  open: boolean;
  onClose: () => void;
}) {
  const share = useShareDashboard();
  const refresh = useRefreshDashboardSnapshot();
  const revoke = useRevokeDashboardShare();

  const token = dashboard?.share_token ?? null;
  const mode: ShareMode = dashboard?.share_mode ?? 'live';
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => { if (open) setCopied(false); }, [open, token]);

  if (!dashboard) return null;
  const url = token ? publicUrl(token) : '';
  const busy = share.isPending || refresh.isPending || revoke.isPending;

  const publish = (m: ShareMode) =>
    share.mutate({ id: dashboard.id, mode: m },
      { onError: () => setToast({ tone: 'err', text: 'Could not create the link.' }) });

  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { setToast({ tone: 'err', text: 'Copy failed — select and copy manually.' }); }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Share "${dashboard.name}"`} className="max-w-lg" flushBottom>
      <div className="space-y-5">
        {/* 1 — Public link */}
        <section>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Link2 className="h-4 w-4 text-primary" /> Public link
          </div>
          {!token ? (
            <div className="rounded-xl border border-border p-3">
              <p className="mb-3 text-[13px] text-muted-foreground">
                Anyone with the link can view this dashboard read-only. No sign-in needed.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" disabled={busy} onClick={() => publish('live')}>
                  Create live link
                </Button>
                <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => publish('snapshot')}>
                  Create snapshot link
                </Button>
              </div>
              <p className="mt-2 text-[12px] text-muted-foreground">
                <b>Live</b> always shows current data. <b>Snapshot</b> freezes today's numbers until you refresh.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-border p-3">
              <div className="flex items-center gap-2">
                <input
                  readOnly value={url} onFocus={(e) => e.currentTarget.select()}
                  className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-muted/40 px-2.5 text-[13px] text-foreground"
                />
                <Button type="button" size="sm" variant="secondary" onClick={copy}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>

              {/* Mode switch + snapshot refresh */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-lg border border-border p-0.5">
                  {(['live', 'snapshot'] as ShareMode[]).map((m) => (
                    <button key={m} type="button" disabled={busy} onClick={() => publish(m)}
                      className={cn('rounded-md px-2.5 py-1 text-[12px] font-medium capitalize transition-colors',
                        mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
                      {m}
                    </button>
                  ))}
                </div>
                {mode === 'snapshot' ? (
                  <Button type="button" size="sm" variant="ghost" disabled={busy}
                    onClick={() => refresh.mutate(dashboard.id, { onError: () => setToast({ tone: 'err', text: 'Refresh failed.' }) })}>
                    <RefreshCw className="h-3.5 w-3.5" /> Refresh data
                  </Button>
                ) : null}
                <Button type="button" size="sm" variant="ghost" disabled={busy}
                  className="ml-auto text-rose-600 hover:text-rose-700"
                  onClick={() => revoke.mutate(dashboard.id, { onError: () => setToast({ tone: 'err', text: 'Could not revoke.' }) })}>
                  <Trash2 className="h-3.5 w-3.5" /> Revoke
                </Button>
              </div>
              {mode === 'snapshot' && dashboard.share_snapshot_at ? (
                <p className="mt-2 text-[12px] text-muted-foreground">
                  Snapshot taken {new Date(dashboard.share_snapshot_at).toLocaleString()}.
                </p>
              ) : null}
            </div>
          )}
        </section>

        {/* Email and PDF export are disabled for now. */}

        <div className="sticky bottom-0 -mx-4 flex justify-end border-t border-border bg-card px-4 pb-4 pt-3">
          <Button type="button" size="sm" onClick={onClose}>Done</Button>
        </div>
      </div>
      {toast ? <Toast tone={toast.tone} message={toast.text} onDismiss={() => setToast(null)} /> : null}
    </Modal>
  );
}
