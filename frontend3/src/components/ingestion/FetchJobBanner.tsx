import { Loader2, X } from 'lucide-react';

import { Button } from '@/components/ui';
import { useCancelFetchJob, useFetchJobStatus } from '@/hooks/useAdmin';

const TERMINAL = ['completed', 'failed', 'cancelled', 'error'];

// Live progress for an in-flight mailbox fetch job. Polls status (2.5s) until a
// terminal state, shows honest counters when present, and a cancel button while
// running. Renders nothing once the job ends (the parent clears the job id).
export function FetchJobBanner({ jobId, onDone }: { jobId: string; onDone: (msg: string) => void }) {
  const statusQ = useFetchJobStatus(jobId);
  const cancel = useCancelFetchJob();
  const s = statusQ.data;

  if (!s) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span className="text-muted-foreground">Starting fetch…</span>
      </div>
    );
  }

  const running = !TERMINAL.includes(s.status);
  const c = s.counters ?? {};
  const msgProcessed = c.messages_processed;
  const msgTotal = c.messages_total;
  const pct = typeof s.progress === 'number' ? s.progress : msgTotal ? Math.round(((msgProcessed ?? 0) / msgTotal) * 100) : null;

  // Surface the terminal outcome once, then the parent will clear us.
  if (!running) {
    const ok = s.status === 'completed';
    const created = (s.result && (s.result.created ?? s.result.timesheets_created)) as number | undefined;
    const summary = ok
      ? `Fetch complete${typeof created === 'number' ? ` · ${created} new timesheet${created === 1 ? '' : 's'}` : ''}.`
      : `Fetch ${s.status}${s.error ? `: ${s.error}` : ''}.`;
    onDone(summary);
    return null;
  }

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{s.message ?? 'Fetching emails…'}</p>
            {msgTotal != null ? (
              <p className="text-xs text-muted-foreground">{msgProcessed ?? 0} of {msgTotal} emails{c.mailboxes_total != null ? ` · ${c.mailboxes_processed ?? 0}/${c.mailboxes_total} mailboxes` : ''}</p>
            ) : null}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => cancel.mutate(jobId)} disabled={cancel.isPending}>
          <X className="h-3.5 w-3.5" /> Cancel
        </Button>
      </div>
      {pct != null ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
        </div>
      ) : null}
    </div>
  );
}
