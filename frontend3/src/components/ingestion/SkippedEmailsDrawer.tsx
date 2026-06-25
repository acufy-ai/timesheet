import { ArrowUpRight, BadgeCheck, Loader2, Paperclip } from 'lucide-react';

import { Empty, Modal } from '@/components/ui';
import { useConfirmSkip, usePromoteSkipped, useSkippedEmails } from '@/hooks/useAdmin';
import { avatarTone, initials } from '@/lib/avatar';

function relTime(iso?: string | null): string {
  if (!iso) return '';
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Skipped-emails manager: emails the classifier judged not-a-timesheet. The
// reviewer can PROMOTE one (force it into the pending queue) or CONFIRM-SKIP
// (acknowledge it is correctly skipped, removing it from this actionable list).
export function SkippedEmailsDrawer({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const q = useSkippedEmails(open);
  const promote = usePromoteSkipped();
  const confirm = useConfirmSkip();
  const emails = q.data?.emails ?? [];

  async function doPromote(id: number) {
    try { await promote.mutateAsync(id); onDone('Email promoted to the review queue.'); }
    catch { onDone('Could not promote that email.'); }
  }
  async function doConfirm(id: number) {
    try { await confirm.mutateAsync(id); onDone('Marked as correctly skipped.'); }
    catch { onDone('Could not update that email.'); }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Skipped emails${q.data ? ` (${q.data.count})` : ''}`} className="max-w-3xl">
      {q.isLoading ? (
        <div className="grid place-items-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></div>
      ) : emails.length === 0 ? (
        <Empty title="No skipped emails" description="Emails the classifier set aside as not-a-timesheet appear here." className="border-0" />
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">These were classified as not timesheets. Promote any the classifier got wrong, or confirm the skip to clear them.</p>
          {emails.map((e) => (
            <div key={e.id} className="rounded-xl border border-border p-3">
              <div className="flex items-start gap-3">
                <span className={'grid h-8 w-8 shrink-0 place-items-center rounded-full text-[10px] font-semibold ' + avatarTone(e.sender_name ?? e.sender_email)}>
                  {initials(e.sender_name ?? e.sender_email)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{e.sender_name ?? e.sender_email}</p>
                  <p className="truncate text-xs text-muted-foreground">{e.subject ?? '(no subject)'}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{relTime(e.received_at)}</span>
                    {e.mailbox_label ? <span>· {e.mailbox_label}</span> : null}
                    {e.has_attachments ? <span className="inline-flex items-center gap-0.5"><Paperclip className="h-3 w-3" />{e.timesheet_attachment_count || ''}</span> : null}
                    {e.skip_reason ? <span className="rounded-full bg-muted px-1.5 py-0.5">{e.skip_reason}</span> : null}
                  </div>
                </div>
              </div>
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={() => void doConfirm(e.id)} disabled={confirm.isPending} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-foreground/5">
                  <BadgeCheck className="h-3.5 w-3.5" /> Confirm skip
                </button>
                <button type="button" onClick={() => void doPromote(e.id)} disabled={promote.isPending} className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90">
                  <ArrowUpRight className="h-3.5 w-3.5" /> Promote to review
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
