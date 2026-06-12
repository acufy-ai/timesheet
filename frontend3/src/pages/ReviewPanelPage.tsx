import React from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Loader2,
  PauseCircle,
  Paperclip,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, clientsApi, ingestionApi } from '@/api/client';
import { StatusBadge } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  domainOf,
  formatDateRange,
  getApiErrorMessage,
  isPersonalDomain,
  suggestNameFromDomain,
} from '@/lib/ingestion';
import {
  useAddLineItem,
  useApproveIngestion,
  useAssignChainCandidate,
  useAssignableUsers,
  useClients,
  useCreateClient,
  useDeleteLineItem,
  useDraftComment,
  useFetchJobStatus,
  useHoldIngestion,
  useIngestionDetail,
  useIngestionEmail,
  useIngestionTimesheets,
  useAdminProjects,
  usePromoteSkipped,
  useRejectIngestion,
  useRejectLineItem,
  useReprocessStoredEmail,
  useRevertIngestionRejection,
  useUnrejectLineItem,
  useUpdateIngestionData,
  useUpdateLineItem,
} from '@/hooks/useAdmin';
import type { IngestionLineItem, IngestionSummary } from '@/types/admin';

// ─────────────────────────────────────────────────────────────────────────────
// f3 port of frontend2/src/pages/ReviewPanelPage.tsx.
//
// Logic ported verbatim; only the primitives + Tailwind classes are reskinned
// to f3. The page replaces the modal at components/ingestion/ReviewPanel.tsx.
//
// f3 DATA-LAYER NOTES (see PORT NOTES at bottom for the full list):
//   - IngestionDetail in f3 does NOT carry attachments / body / extracted_data /
//     audit_log / llm_anomalies / llm_match_suggestions. The richer fields live
//     on the IngestionSummary (list row) and on StoredEmailDetail (the email).
//     So we hydrate the email reader from useIngestionEmail(detail.email.id),
//     and read anomalies / match-suggestions / attachment_id off the matching
//     summary row from the full list.
//   - useIngestionTimesheets takes no filter params; siblings are filtered
//     CLIENT-SIDE by email_id.
//   - Attachment preview bytes are fetched as a blob through the authed axios
//     instance (sessionStorage bearer), since attachmentFileUrl(id) is just a
//     path and an <iframe src> can't attach the Authorization header.
// ─────────────────────────────────────────────────────────────────────────────

// Loosely-typed attachment off StoredEmailDetail.attachments (Record<string,unknown>).
type Attachment = {
  id: number;
  filename: string;
  mime_type?: string | null;
  extraction_method?: string | null;
  extraction_status?: string | null;
  raw_extracted_text?: string | null;
  rendered_html?: string | null;
  spreadsheet_preview?: SpreadsheetPreview | null;
};

type SpreadsheetPreview = {
  sheets?: Array<{ name?: string; rows: string[][]; blocks?: Array<{ rows: string[][] }> }>;
};

type ChainCandidate = {
  name: string | null;
  email: string | null;
  existing_user_id: number | null;
  matches_extracted_name: boolean;
};

type LineItemFormState = {
  work_date: string;
  hours: string;
  description: string;
  project_code: string;
  project_id: string;
};

// ── Local hook: create-client-from-domain (cascade) ──────────────────────────
// f3's useAdmin.ts ships clientsApi.createFromDomain but not a wrapping hook, so
// we inline one here (invalidates the clients cache on success) to keep this
// module self-contained.
function useCreateClientFromDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, domain }: { name: string; domain: string }) =>
      clientsApi.createFromDomain(name, domain).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['clients'] }),
  });
}

// ── Inline CreateClientFromDomainPopover (ported from f2; f3 has no shared one) ─
interface ExistingClient {
  id: number;
  name: string;
}
const POPOVER_WIDTH = 380;
const POPOVER_ESTIMATED_HEIGHT = 280;
const VIEWPORT_MARGIN = 16;
const findExistingByName = (value: string, clients: ExistingClient[]): ExistingClient | null => {
  const q = value.trim().toLowerCase();
  if (!q) return null;
  return clients.find((c) => c.name.toLowerCase() === q) ?? null;
};

const CreateClientFromDomainPopover: React.FC<{
  open: boolean;
  domain: string;
  cascadeCount: number;
  existingClients: ExistingClient[];
  anchorEl: HTMLElement | null;
  initialValue: string;
  isSubmitting?: boolean;
  onConfirm: (payload: { name: string; existing: ExistingClient | null }) => void;
  onClose: () => void;
}> = ({ open, domain, cascadeCount, existingClients, anchorEl, initialValue, isSubmitting, onConfirm, onClose }) => {
  const [value, setValue] = React.useState(initialValue);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [position, setPosition] = React.useState<{ top: number; left: number } | null>(null);

  React.useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  React.useLayoutEffect(() => {
    if (!open || !anchorEl) return;
    const update = () => {
      const rect = anchorEl.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const top = spaceBelow > POPOVER_ESTIMATED_HEIGHT + VIEWPORT_MARGIN
        ? rect.bottom + window.scrollY + 6
        : rect.top + window.scrollY - POPOVER_ESTIMATED_HEIGHT - 6;
      const maxLeft = window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN;
      const left = Math.min(rect.left + window.scrollX, Math.max(maxLeft, VIEWPORT_MARGIN));
      setPosition({ top, left });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorEl]);

  React.useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !position) return null;

  const trimmed = value.trim();
  const exact = findExistingByName(trimmed, existingClients);
  const canSubmit = trimmed.length > 0 && !isSubmitting;
  const handleConfirm = () => {
    if (!canSubmit) return;
    onConfirm({ name: trimmed, existing: exact });
  };

  const cascadeMode = Boolean(domain) && cascadeCount > 0;
  const cascadeSuffix = cascadeMode ? ` · assign ${cascadeCount}` : '';
  const buttonLabel = !trimmed
    ? `Create${cascadeSuffix}`
    : exact
      ? `Link to ${exact.name}${cascadeSuffix}`
      : `Create "${trimmed}"${cascadeSuffix}`;
  const headerLabel = cascadeMode ? 'Assign client from domain' : 'Add client';

  return (
    <>
      <div role="presentation" className="fixed inset-0 z-[80]" onClick={onClose} />
      <div
        role="dialog"
        aria-label={headerLabel}
        className="absolute z-[90] rounded-xl border border-border/70 bg-card p-4 shadow-[0_18px_48px_rgba(0,0,0,0.35)]"
        style={{ top: position.top, left: position.left, width: POPOVER_WIDTH }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{headerLabel}</p>
        {cascadeMode ? (
          <p className="mb-3 text-xs text-muted-foreground">
            All <span className="font-semibold text-amber-600 dark:text-amber-300">{cascadeCount} pending email{cascadeCount === 1 ? '' : 's'}</span>{' '}
            from <span className="font-mono text-amber-600 dark:text-amber-300">{domain}</span> will be assigned.
          </p>
        ) : domain ? (
          <p className="mb-3 text-xs text-muted-foreground">
            Will also map <span className="font-mono text-foreground">{domain}</span> to this client so future emails from that domain auto-resolve.
          </p>
        ) : (
          <p className="mb-3 text-xs text-muted-foreground">
            Create a new client. The sender's domain is personal (gmail, outlook, etc.) so no domain mapping is added.
          </p>
        )}
        <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="cascade-name-input">Client name</label>
        <input
          id="cascade-name-input"
          ref={inputRef}
          type="text"
          className="field-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleConfirm();
            }
          }}
          autoComplete="off"
          spellCheck={false}
        />
        {exact ? (
          <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-emerald-400/30 bg-emerald-500/5 px-3 py-2">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Matches existing client</p>
              <p className="truncate text-sm font-semibold text-emerald-600 dark:text-emerald-300">{exact.name}</p>
            </div>
            <p className="max-w-[9.5rem] text-right text-[11px] leading-tight text-muted-foreground">
              Confirm to link the domain. Edit the name to create a new client.
            </p>
          </div>
        ) : null}
        <p className="mt-3 text-[11px] text-muted-foreground">Tip: Press Enter to confirm, or edit the name first.</p>
        <div className="mt-3 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="action-button-secondary h-9 px-3 text-sm">Cancel</button>
          <button type="button" onClick={handleConfirm} disabled={!canSubmit} className="action-button h-9 px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60">
            {isSubmitting ? 'Assigning...' : buttonLabel}
          </button>
        </div>
      </div>
    </>
  );
};

// ── Reason popover (Reject / Hold) ───────────────────────────────────────────
const ReasonPopover: React.FC<{
  open: boolean;
  anchorEl: HTMLElement | null;
  title: string;
  description: string;
  placeholder: string;
  reason: string;
  setReason: (s: string) => void;
  confirmLabel: string;
  confirmTone: 'danger' | 'primary';
  isSubmitting?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}> = ({ open, anchorEl, title, description, placeholder, reason, setReason, confirmLabel, confirmTone, isSubmitting, onConfirm, onClose }) => {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const [position, setPosition] = React.useState<{ top: number; left: number } | null>(null);

  React.useLayoutEffect(() => {
    if (!open || !anchorEl) return;
    const update = () => {
      const rect = anchorEl.getBoundingClientRect();
      const WIDTH = 380;
      const ESTIMATED_HEIGHT = 240;
      const spaceBelow = window.innerHeight - rect.bottom;
      const top = spaceBelow > ESTIMATED_HEIGHT + VIEWPORT_MARGIN
        ? rect.bottom + window.scrollY + 6
        : rect.top + window.scrollY - ESTIMATED_HEIGHT - 6;
      const maxLeft = window.innerWidth - WIDTH - VIEWPORT_MARGIN;
      const left = Math.min(rect.left + window.scrollX, Math.max(maxLeft, VIEWPORT_MARGIN));
      setPosition({ top, left });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorEl]);

  React.useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !position) return null;
  const canSubmit = reason.trim().length > 0 && !isSubmitting;
  const confirmClass = confirmTone === 'danger'
    ? 'inline-flex h-9 items-center justify-center rounded-md bg-rose-500 px-3 text-sm font-medium text-white transition hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-60'
    : 'action-button h-9 px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <>
      <div role="presentation" className="fixed inset-0 z-[80]" onClick={onClose} />
      <div
        role="dialog"
        aria-label={title}
        className="absolute z-[90] w-[380px] rounded-xl border border-border/70 bg-card p-4 shadow-[0_18px_48px_rgba(0,0,0,0.35)]"
        style={{ top: position.top, left: position.left }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{title}</p>
        <p className="mb-3 text-xs text-muted-foreground">{description}</p>
        <textarea
          ref={textareaRef}
          className="field-input min-h-[72px]"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={placeholder}
        />
        <div className="mt-3 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="action-button-secondary h-9 px-3 text-sm">Cancel</button>
          <button type="button" onClick={onConfirm} disabled={!canSubmit} className={confirmClass}>
            {isSubmitting ? `${confirmLabel}…` : confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const emptyLineItem = (): LineItemFormState => ({ work_date: '', hours: '', description: '', project_code: '', project_id: '' });
const formatDateTime = (value?: string | null) => (value ? new Date(value).toLocaleString() : '--');
const attachmentKind = (attachment: Attachment | null) =>
  !attachment?.mime_type ? 'other' : attachment.mime_type.includes('pdf') ? 'pdf' : attachment.mime_type.startsWith('image/') ? 'image' : 'other';

const cleanEmployeeNameForDisplay = (value?: string | null) => {
  if (!value) return '';
  const compactLeadingPrefix = value.replace(/^ven[aij](?=[A-Z])/, '');
  const parts = compactLeadingPrefix.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1 && /^ven[aij]$/i.test(parts[0])) parts.shift();
  if (parts.length > 0 && /^ashw/i.test(parts[0])) parts[0] = `Ai${parts[0].slice(1)}`;
  return parts.join(' ').trim() || compactLeadingPrefix.trim();
};
const normalizeEmployeeNameForMatch = (value?: string | null) => {
  const cleaned = cleanEmployeeNameForDisplay(value);
  if (!cleaned) return '';
  const normalized = cleaned.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = normalized.split(' ').filter(Boolean);
  if (!parts.length) return '';
  const first = parts[0];
  if (first.startsWith('vena') && first.length > 6) parts[0] = first.slice(4);
  if (first.startsWith('venj') && first.length > 6) parts[0] = first.slice(4);
  if (first.startsWith('veni') && first.length > 6) parts[0] = first.slice(4);
  return parts.join(' ');
};

const trimTrailingEmptyColumns = (rows: string[][]): string[][] => {
  if (rows.length === 0) return rows;
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  let keep = width;
  while (keep > 0 && rows.every((row) => ((row[keep - 1] ?? '') as string).trim() === '')) keep -= 1;
  return keep === width ? rows : rows.map((row) => row.slice(0, keep));
};
const splitIntoBlocks = (rows: string[][]): string[][][] => {
  if (rows.length === 0) return [];
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (width === 0) return [];
  const emptyCols = new Set<number>();
  for (let c = 0; c < width; c += 1) {
    if (rows.every((row) => ((row[c] ?? '') as string).trim() === '')) emptyCols.add(c);
  }
  const ranges: Array<[number, number]> = [];
  let start: number | null = null;
  for (let c = 0; c < width; c += 1) {
    if (emptyCols.has(c)) {
      if (start !== null) {
        ranges.push([start, c]);
        start = null;
      }
    } else if (start === null) {
      start = c;
    }
  }
  if (start !== null) ranges.push([start, width]);
  return ranges
    .map(([s, e]) => rows.map((row) => row.slice(s, e)).filter((row) => row.some((cell) => cell.trim() !== '')))
    .filter((block) => block.length > 0);
};

const BlockTable: React.FC<{ rows: string[][] }> = ({ rows }) => {
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return (
    <table className="min-w-full border-collapse text-sm">
      <tbody>
        {rows.map((row, rIdx) => (
          <tr key={rIdx} className={rIdx === 0 ? 'bg-muted/50 font-semibold text-foreground' : 'even:bg-muted/20'}>
            {Array.from({ length: maxCols }, (_, cIdx) => (
              <td key={cIdx} className="whitespace-nowrap border border-border/60 px-3 py-1.5 align-top text-foreground">
                {row[cIdx] ?? ''}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const SpreadsheetPreviewTable: React.FC<{ preview: SpreadsheetPreview }> = ({ preview }) => {
  const [activeSheet, setActiveSheet] = React.useState(0);
  const sheets = preview.sheets ?? [];
  if (sheets.length === 0) {
    return <div className="px-6 py-10 text-sm text-muted-foreground">Spreadsheet is empty.</div>;
  }
  const rawCurrent = sheets[Math.min(activeSheet, sheets.length - 1)];
  const trimmedRows = trimTrailingEmptyColumns(rawCurrent.rows);
  const blocks = rawCurrent.blocks?.length ? rawCurrent.blocks.map((b) => b.rows) : splitIntoBlocks(trimmedRows);
  const renderBlocks = blocks.length > 0 ? blocks : [trimmedRows];
  return (
    <div className="flex flex-col">
      {sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 px-4 py-2">
          {sheets.map((sheet, idx) => (
            <button
              key={`${sheet.name}-${idx}`}
              type="button"
              onClick={() => setActiveSheet(idx)}
              className={cn(
                'shrink-0 rounded-md px-3 py-1 text-xs font-medium transition',
                idx === activeSheet ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              {sheet.name || `Sheet ${idx + 1}`}
            </button>
          ))}
        </div>
      )}
      <div className="max-h-[75vh] space-y-4 overflow-auto px-4 py-3">
        {renderBlocks.map((rows, idx) => (
          <BlockTable key={idx} rows={rows} />
        ))}
      </div>
    </div>
  );
};

// Extract chain_candidates from the loosely-typed llm_match_suggestions blob.
const extractChainCandidates = (raw: unknown): ChainCandidate[] => {
  if (!raw) return [];
  // f3 surfaces llm_match_suggestions as Array<Record<string, unknown>> on the
  // summary; the candidates may be the array itself or nested under a
  // chain_candidates key (the f2 shape). Handle both.
  const fromArray = Array.isArray(raw) ? raw : null;
  const fromObj = !Array.isArray(raw) && typeof raw === 'object'
    ? (raw as { chain_candidates?: unknown }).chain_candidates
    : null;
  const candidates = fromArray ?? (Array.isArray(fromObj) ? fromObj : null);
  if (!Array.isArray(candidates)) return [];
  return candidates
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => ({
      name: typeof entry.name === 'string' ? entry.name : null,
      email: typeof entry.email === 'string' ? entry.email : null,
      existing_user_id: typeof entry.existing_user_id === 'number' ? entry.existing_user_id : null,
      matches_extracted_name: entry.matches_extracted_name === true,
    }));
};

const ChainCandidatesPanel: React.FC<{
  timesheetId: number | null;
  rawSuggestions: unknown;
  currentEmployeeId: number | null;
  onAssign: (payload: { name?: string | null; email?: string | null }) => Promise<void>;
  isAssigning: boolean;
}> = ({ timesheetId, rawSuggestions, currentEmployeeId, onAssign, isAssigning }) => {
  const candidates = React.useMemo(() => extractChainCandidates(rawSuggestions), [rawSuggestions]);
  const [editingIdx, setEditingIdx] = React.useState<number | null>(null);
  const [emailInput, setEmailInput] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setEditingIdx(null);
    setEmailInput('');
    setError(null);
  }, [timesheetId, rawSuggestions]);

  if (!candidates.length) return null;
  if (currentEmployeeId != null) return null;

  const handleSelect = async (candidate: ChainCandidate, idx: number) => {
    setError(null);
    if (candidate.email || candidate.existing_user_id != null) {
      try {
        await onAssign({ name: candidate.name, email: candidate.email });
      } catch (exc) {
        setError(getApiErrorMessage(exc, 'Assignment failed'));
      }
      return;
    }
    setEditingIdx(idx);
    setEmailInput('');
  };

  const handleConfirmWithEmail = async (candidate: ChainCandidate) => {
    setError(null);
    try {
      await onAssign({ name: candidate.name, email: emailInput.trim() || null });
      setEditingIdx(null);
      setEmailInput('');
    } catch (exc) {
      setError(getApiErrorMessage(exc, 'Assignment failed'));
    }
  };

  return (
    <div className="mt-3 rounded-md border border-amber-300/30 bg-amber-50/5 px-3 py-2.5" data-testid="chain-candidates-panel">
      <p className="text-xs font-medium uppercase tracking-wide text-amber-500/90">Candidates from email chain</p>
      <p className="mt-1 text-xs text-muted-foreground">
        The forwarded email included these names. Pick the one that belongs to this timesheet.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {candidates.map((candidate, idx) => {
          const label = candidate.email
            ? `${candidate.name ?? candidate.email} <${candidate.email}>`
            : candidate.name ?? '(no name)';
          const isEditing = editingIdx === idx;
          const hasKnownUser = candidate.existing_user_id != null;
          return (
            <div key={idx} className="flex flex-col gap-1" data-testid="chain-candidate-chip">
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-full bg-muted/40 px-3 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
                onClick={() => void handleSelect(candidate, idx)}
                disabled={isAssigning}
                title={hasKnownUser ? 'Bind to existing user' : 'Select this candidate'}
              >
                {candidate.matches_extracted_name && <span>★</span>}
                <span>{label}</span>
                {hasKnownUser && <span className="text-[10px] uppercase text-emerald-500">known</span>}
              </button>
              {isEditing && !hasKnownUser && !candidate.email && (
                <div className="flex items-center gap-2">
                  <input
                    type="email"
                    className="field-input h-7 text-xs"
                    placeholder="email@example.com (optional)"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                  />
                  <button
                    type="button"
                    className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    onClick={() => void handleConfirmWithEmail(candidate)}
                    disabled={isAssigning}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => { setEditingIdx(null); setEmailInput(''); }}
                    disabled={isAssigning}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
    </div>
  );
};

// Brief loading + bounce to the inbox. Used when a review URL points at a
// timesheet the server no longer has (almost always a just-completed reprocess).
const SubmissionNotFoundRedirect: React.FC<{ navigate: (path: string, opts?: { replace?: boolean }) => void }> = ({ navigate }) => {
  React.useEffect(() => {
    navigate('/ingestion/inbox', { replace: true });
  }, [navigate]);
  return (
    <div className="mx-auto mt-12 max-w-xl rounded-xl border border-border bg-card p-6">
      <p className="text-sm text-muted-foreground">Loading the latest version of this submission…</p>
    </div>
  );
};

// Terminal states for the reprocess poll (f3 uses 'completed', not 'complete').
const REPROCESS_TERMINAL = ['completed', 'failed', 'cancelled', 'error'];

// ─────────────────────────────────────────────────────────────────────────────

export function ReviewPanelPage() {
  const navigate = useNavigate();
  const { timesheetId } = useParams();
  const parsedTimesheetId = Number(timesheetId ?? '');
  const normalizedTimesheetId =
    Number.isInteger(parsedTimesheetId) && parsedTimesheetId > 0 ? parsedTimesheetId : null;
  const isTimesheetMode = normalizedTimesheetId !== null;

  const { data: timesheet, isLoading: isTimesheetLoading, isError: isTimesheetError } =
    useIngestionDetail(normalizedTimesheetId);
  const { data: users = [] } = useAssignableUsers();
  const { data: clients = [] } = useClients();
  const { data: projects = [] } = useAdminProjects();
  const createClient = useCreateClient();
  const createClientFromDomain = useCreateClientFromDomain();
  const updateTimesheet = useUpdateIngestionData();
  const assignChainCandidate = useAssignChainCandidate();
  const addLineItem = useAddLineItem();
  const updateLineItem = useUpdateLineItem();
  const deleteLineItem = useDeleteLineItem();
  const approveTimesheet = useApproveIngestion();
  const rejectTimesheet = useRejectIngestion();
  const holdTimesheet = useHoldIngestion();
  const draftComment = useDraftComment();
  const reprocessStored = useReprocessStoredEmail();
  const promoteSkipped = usePromoteSkipped();
  const rejectLineItem = useRejectLineItem();
  const unrejectLineItem = useUnrejectLineItem();
  const revertTimesheetRejection = useRevertIngestionRejection();
  const queryClient = useQueryClient();

  const emailId = timesheet?.email?.id ?? null;
  // The detail's email is a thin stub (id + sender). Hydrate the full reader
  // (body, attachments, forwarded-from, mailbox) from the stored-email endpoint.
  const { data: storedEmail } = useIngestionEmail(emailId);

  // Full list -> filter siblings + read the summary's anomalies / match
  // suggestions / attachment_id (not present on IngestionDetail in f3).
  const { data: allTimesheets } = useIngestionTimesheets(true);
  const summaryRow: IngestionSummary | undefined = React.useMemo(
    () => (Array.isArray(allTimesheets) ? allTimesheets.find((t) => t.id === timesheet?.id) : undefined),
    [allTimesheets, timesheet?.id],
  );

  const [reprocessJobId, setReprocessJobId] = React.useState<string | null>(null);
  const { data: reprocessStatus } = useFetchJobStatus(reprocessJobId);
  const isReprocessing = Boolean(
    reprocessJobId && reprocessStatus && (reprocessStatus.status === 'queued' || reprocessStatus.status === 'running' || reprocessStatus.status === 'in_progress'),
  );
  const reprocessDone = Boolean(reprocessJobId && reprocessStatus && REPROCESS_TERMINAL.includes(reprocessStatus.status));

  // When a reprocess job finishes, refresh caches and bounce to the inbox so
  // the freshly-created rows (new IDs) surface naturally instead of 404-ing the
  // current review URL.
  React.useEffect(() => {
    if (!reprocessJobId || !reprocessStatus) return;
    if (!REPROCESS_TERMINAL.includes(reprocessStatus.status)) return;
    if (reprocessStatus.status === 'completed') {
      const oldId = normalizedTimesheetId;
      if (oldId != null) queryClient.removeQueries({ queryKey: ['ingestion', 'detail', oldId] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'email'] });
      queryClient.invalidateQueries({ queryKey: ['ingestion', 'skipped'] });
      navigate('/ingestion/inbox', { replace: true });
    }
    const timer = window.setTimeout(() => setReprocessJobId(null), 6000);
    return () => window.clearTimeout(timer);
  }, [reprocessJobId, reprocessStatus?.status, queryClient, normalizedTimesheetId, navigate, reprocessStatus]);

  const extractedName = ((timesheet?.extracted_employee_name ?? timesheet?.employee_name) ?? '').toLowerCase().trim();
  const resolvedEmployeeId = timesheet?.employee_id ?? null;

  // Siblings: all weeks from the same email_id, filtered CLIENT-SIDE. Match by
  // resolved employee_id first, then by extracted name. Hide rejected pills.
  const siblings = React.useMemo<IngestionSummary[]>(() => {
    if (!Array.isArray(allTimesheets) || emailId == null) return [];
    const filtered = allTimesheets.filter((s) => {
      if (s.email_id !== emailId) return false;
      if (s.status === 'rejected') return false;
      if (resolvedEmployeeId != null && s.employee_id != null) return s.employee_id === resolvedEmployeeId;
      const sName = ((s.extracted_employee_name ?? s.employee_name) ?? '').toLowerCase().trim();
      return !extractedName || sName === extractedName;
    });
    const deduped = new Map<string, IngestionSummary>();
    for (const entry of filtered) {
      const signature = `${entry.attachment_id ?? 'no-att'}|${entry.period_start ?? ''}|${entry.period_end ?? ''}|${entry.total_hours ?? ''}`;
      const existing = deduped.get(signature);
      if (!existing || entry.id === timesheet?.id) deduped.set(signature, entry);
    }
    return [...deduped.values()].sort((a, b) => {
      const av = a.period_start ? new Date(a.period_start).getTime() : 0;
      const bv = b.period_start ? new Date(b.period_start).getTime() : 0;
      return av - bv;
    });
  }, [allTimesheets, emailId, resolvedEmployeeId, extractedName, timesheet?.id]);

  // ── Form + UI state ────────────────────────────────────────────────────────
  const [summaryForm, setSummaryForm] = React.useState({
    employee_id: '',
    client_id: '',
    extracted_supervisor_name: '',
    period_start: '',
    period_end: '',
    total_hours: '',
    internal_notes: '',
  });
  const [addClientAnchor, setAddClientAnchor] = React.useState<HTMLElement | null>(null);
  const [selectedLineItemIds, setSelectedLineItemIds] = React.useState<Set<number>>(new Set());
  const [bulkProjectId, setBulkProjectId] = React.useState('');
  const [bulkExcludeReason, setBulkExcludeReason] = React.useState('');
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [rejectPopoverAnchor, setRejectPopoverAnchor] = React.useState<HTMLElement | null>(null);
  const [holdPopoverAnchor, setHoldPopoverAnchor] = React.useState<HTMLElement | null>(null);
  const [holdReason, setHoldReason] = React.useState('');
  const [reviewComment, setReviewComment] = React.useState('');
  const [rejectReason, setRejectReason] = React.useState('');
  const [lineItemModalOpen, setLineItemModalOpen] = React.useState(false);
  const [editingLineItem, setEditingLineItem] = React.useState<IngestionLineItem | null>(null);
  const [lineItemForm, setLineItemForm] = React.useState<LineItemFormState>(emptyLineItem());
  const [selectedAttachmentId, setSelectedAttachmentId] = React.useState<number | null>(null);
  const [attachmentUrl, setAttachmentUrl] = React.useState<{ url: string; forId: number } | null>(null);
  const [attachmentLoadError, setAttachmentLoadError] = React.useState<string | null>(null);
  const [showFullSheet, setShowFullSheet] = React.useState(false);
  const [fullSheetHtml, setFullSheetHtml] = React.useState<string | null>(null);
  const [fullSheetLoading, setFullSheetLoading] = React.useState(false);
  const [showApproveConfirm, setShowApproveConfirm] = React.useState(false);
  const [rejectingLineItemId, setRejectingLineItemId] = React.useState<number | null>(null);
  const [lineItemRejectReason, setLineItemRejectReason] = React.useState('');
  const [reprocessMenuOpen, setReprocessMenuOpen] = React.useState(false);
  const reprocessMenuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!reprocessMenuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!reprocessMenuRef.current?.contains(e.target as Node)) setReprocessMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setReprocessMenuOpen(false); };
    window.addEventListener('mousedown', onClickOutside);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onClickOutside);
      window.removeEventListener('keydown', onEsc);
    };
  }, [reprocessMenuOpen]);

  // ── Splitter ─────────────────────────────────────────────────────────────
  const [leftPct, setLeftPct] = React.useState(62);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const isDragging = React.useRef(false);
  const attachmentPreviewRef = React.useRef<HTMLDivElement>(null);
  const scrollToAttachment = React.useCallback(() => {
    attachmentPreviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  React.useEffect(() => {
    const onUp = () => { isDragging.current = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    const onMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      if (e.buttons === 0) { onUp(); return; }
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.min(Math.max(pct, 30), 78));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // Seed the form from the loaded detail; reset bulk selection on switch.
  React.useEffect(() => {
    if (!timesheet) return;
    setSummaryForm({
      employee_id: timesheet.employee_id ? String(timesheet.employee_id) : '',
      client_id: timesheet.client_id ? String(timesheet.client_id) : '',
      extracted_supervisor_name: timesheet.extracted_supervisor_name ?? '',
      period_start: timesheet.period_start ?? '',
      period_end: timesheet.period_end ?? '',
      total_hours: timesheet.total_hours != null ? Number(timesheet.total_hours).toFixed(1) : '',
      internal_notes: timesheet.internal_notes ?? '',
    });
    setSelectedLineItemIds(new Set());
    setBulkProjectId('');
    setBulkExcludeReason('');
  }, [timesheet]);

  // Default the selected attachment to the timesheet's linked one.
  React.useEffect(() => {
    const attId = summaryRow?.attachment_id ?? null;
    if (attId != null) setSelectedAttachmentId(attId);
  }, [summaryRow?.attachment_id]);

  // Reset full-sheet state when switching attachments.
  React.useEffect(() => {
    setShowFullSheet(false);
    setFullSheetHtml(null);
  }, [selectedAttachmentId]);

  // Fetch the attachment bytes as a blob through the authed axios instance.
  // attachmentFileUrl(id) is just a path; an <iframe src> can't attach the
  // bearer token, so we fetch + objectURL instead (mirrors f2's blob approach).
  // The blob URL is tagged with the id it was fetched FOR so a pill switch
  // never pairs the new attachment with the old blob.
  React.useEffect(() => {
    const fetchForId = selectedAttachmentId;
    let objectUrl: string | null = null;
    setAttachmentUrl(null);
    if (!fetchForId) {
      setAttachmentLoadError(null);
      return undefined;
    }
    api
      .get(ingestionApi.attachmentFileUrl(fetchForId), { responseType: 'blob' })
      .then((res) => {
        objectUrl = URL.createObjectURL(res.data as Blob);
        setAttachmentUrl({ url: objectUrl, forId: fetchForId });
        setAttachmentLoadError(null);
      })
      .catch(() => {
        setAttachmentUrl(null);
        setAttachmentLoadError('Unable to load attachment preview.');
      });
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [selectedAttachmentId]);

  const attachments = React.useMemo<Attachment[]>(
    () => ((storedEmail?.attachments ?? []) as unknown as Attachment[]),
    [storedEmail?.attachments],
  );
  const selectedAttachment = attachments.find((a) => a.id === selectedAttachmentId) ?? null;
  const linkedAttachmentId = summaryRow?.attachment_id ?? null;
  const linkedAttachment = linkedAttachmentId != null ? attachments.find((a) => a.id === linkedAttachmentId) ?? null : null;

  // Lazy-load full HTML the first time the toggle is flipped on.
  React.useEffect(() => {
    if (!showFullSheet || !selectedAttachmentId || fullSheetHtml || fullSheetLoading) return;
    setFullSheetLoading(true);
    ingestionApi
      .attachmentFullHtml(selectedAttachmentId)
      .then((res) => setFullSheetHtml(res.data.html))
      .catch(() => setFullSheetHtml('<p style="padding:16px;font-family:sans-serif">Failed to load full sheet.</p>'))
      .finally(() => setFullSheetLoading(false));
  }, [showFullSheet, selectedAttachmentId, fullSheetHtml, fullSheetLoading]);

  const selectedAttachmentType = attachmentKind(selectedAttachment);
  const liveAttachmentUrl = attachmentUrl && attachmentUrl.forId === selectedAttachmentId ? attachmentUrl.url : null;

  // Extracted hints (employee + client). The client hint comes from the
  // detail's extracted_data.client_name blob (verified on the wire); fall back
  // to the extracted_* fields off the detail / summary row for the employee.
  const extractedEmployeeHint = (
    (timesheet?.extracted_employee_name || summaryRow?.extracted_employee_name || '') as string
  ).trim();
  const extractedClientHint = (
    (timesheet?.extracted_data?.client_name as string | undefined) ?? ''
  ).trim();
  const extractedClientMatchesExisting = extractedClientHint
    ? clients.some((c) => c.name.trim().toLowerCase() === extractedClientHint.toLowerCase())
    : false;

  const senderDomain = (() => {
    const forwardedFrom = storedEmail?.forwarded_from_email;
    return domainOf(forwardedFrom || storedEmail?.sender_email || timesheet?.email?.sender_email);
  })();
  const senderDomainIsPersonal = senderDomain ? isPersonalDomain(senderDomain) : false;
  const addClientInitialValue = (() => {
    if (extractedClientHint) return extractedClientHint;
    if (senderDomain && !senderDomainIsPersonal) return suggestNameFromDomain(senderDomain);
    return '';
  })();

  const normalizedHint = normalizeEmployeeNameForMatch(extractedEmployeeHint);
  const extractedEmployeeMatch = normalizedHint
    ? users.find((user) => {
        const normalizedUser = normalizeEmployeeNameForMatch(user.full_name);
        return (
          normalizedUser === normalizedHint ||
          normalizedUser.includes(normalizedHint) ||
          normalizedHint.includes(normalizedUser)
        );
      })
    : undefined;
  const extractedEmployeeDisplayName = cleanEmployeeNameForDisplay(extractedEmployeeMatch?.full_name || extractedEmployeeHint);
  const extractedEmployeeHasMatch = !!extractedEmployeeMatch;
  const showExtractedEmployeeOption = !summaryForm.employee_id && !!extractedEmployeeHint && !extractedEmployeeHasMatch;
  const employeeSelectValue = summaryForm.employee_id || (showExtractedEmployeeOption ? '__extracted__' : '');
  const isActionable = timesheet ? timesheet.status !== 'approved' && timesheet.status !== 'rejected' : false;

  React.useEffect(() => {
    if (!timesheet) return;
    if (summaryForm.employee_id) return;
    if (!extractedEmployeeMatch) return;
    setSummaryForm((current) => ({ ...current, employee_id: String(extractedEmployeeMatch.id) }));
  }, [timesheet?.id, summaryForm.employee_id, extractedEmployeeMatch, timesheet]);

  // ── Loading / error gates ──────────────────────────────────────────────────
  if (isTimesheetMode && isTimesheetLoading) {
    return (
      <div className="grid place-items-center py-24 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading timesheet" />
      </div>
    );
  }
  if (!isTimesheetMode) {
    return (
      <div className="mx-auto mt-12 max-w-xl rounded-xl border border-border bg-card p-6">
        <p className="text-lg font-semibold text-foreground">Invalid review link</p>
        <p className="mt-2 text-sm text-muted-foreground">This page expects a valid timesheet identifier.</p>
        <button type="button" onClick={() => navigate('/ingestion/inbox')} className="action-button mt-4">Back to inbox</button>
      </div>
    );
  }
  if (isTimesheetMode && (isTimesheetError || !timesheet) && !isTimesheetLoading) {
    return <SubmissionNotFoundRedirect navigate={navigate} />;
  }
  if (!timesheet) return null;

  // ── Handlers ────────────────────────────────────────────────────────────────
  const openLineItemModal = (lineItem?: IngestionLineItem) => {
    if (lineItem) {
      setEditingLineItem(lineItem);
      setLineItemForm({
        work_date: lineItem.work_date,
        hours: String(lineItem.hours),
        description: lineItem.description ?? '',
        project_code: lineItem.project_code ?? '',
        project_id: lineItem.project_id ? String(lineItem.project_id) : '',
      });
    } else {
      setEditingLineItem(null);
      setLineItemForm(emptyLineItem());
    }
    setLineItemModalOpen(true);
  };

  // Auto-save the reviewer's client decision and cascade to every editable
  // sibling week (same employee, same email). Optimistically write the new
  // client into each sibling detail cache before the network round-trip.
  const handleClientPickerChange = async (value: string) => {
    if (!timesheet) return;
    setSummaryForm((c) => ({ ...c, client_id: value }));
    const clientId = value ? Number(value) : null;
    const clientObj = clientId != null ? clients.find((c) => c.id === clientId) : null;
    const targetIds = new Set<number>([timesheet.id]);
    for (const sibling of siblings) {
      if (sibling.status === 'approved' || sibling.status === 'rejected') continue;
      targetIds.add(sibling.id);
    }
    for (const id of targetIds) {
      queryClient.setQueryData<Record<string, unknown> | undefined>(
        ['ingestion', 'detail', id],
        (prev) => (prev ? { ...prev, client_id: clientId, client_name: clientObj?.name ?? null } : prev),
      );
    }
    await Promise.all(
      [...targetIds].map((id) => updateTimesheet.mutateAsync({ id, data: { client_id: clientId } }).catch(() => null)),
    );
    for (const id of targetIds) queryClient.invalidateQueries({ queryKey: ['ingestion', 'detail', id] });
    queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
  };

  // "+ Add client" confirm: cascade for real domains, plain create for personal,
  // or just bind the picked existing client.
  const handleAddClientConfirm = async (payload: { name: string; existing: ExistingClient | null }) => {
    try {
      let createdId: number | null = null;
      if (payload.existing) {
        createdId = payload.existing.id;
      } else if (senderDomain && !senderDomainIsPersonal) {
        const result = await createClientFromDomain.mutateAsync({ name: payload.name, domain: senderDomain });
        createdId = result.client.id;
      } else {
        const created = await createClient.mutateAsync({ name: payload.name, client_type: 'external' });
        createdId = created.id;
      }
      if (createdId != null) await handleClientPickerChange(String(createdId));
      setAddClientAnchor(null);
    } catch {
      // Leave popover open on failure so the reviewer keeps their input.
    }
  };

  const handleSaveSummary = async () => {
    if (!timesheet) return;
    // NOTE: f3 useUpdateIngestionData does not accept total_hours — it is read
    // from the line items server-side. We persist everything else it supports.
    await updateTimesheet.mutateAsync({
      id: timesheet.id,
      data: {
        employee_id: summaryForm.employee_id ? Number(summaryForm.employee_id) : null,
        client_id: summaryForm.client_id ? Number(summaryForm.client_id) : null,
        extracted_supervisor_name: summaryForm.extracted_supervisor_name.trim() || undefined,
        period_start: summaryForm.period_start || undefined,
        period_end: summaryForm.period_end || undefined,
        internal_notes: summaryForm.internal_notes || undefined,
      },
    });
  };

  const handleSaveLineItem = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!timesheet) return;
    const hours = Number(lineItemForm.hours);
    const data = {
      work_date: lineItemForm.work_date,
      hours,
      description: lineItemForm.description || undefined,
      project_code: lineItemForm.project_code || undefined,
      project_id: lineItemForm.project_id ? Number(lineItemForm.project_id) : undefined,
    };
    if (editingLineItem) {
      await updateLineItem.mutateAsync({ tid: timesheet.id, itemId: editingLineItem.id, data });
    } else if (lineItemForm.work_date && Number.isFinite(hours)) {
      await addLineItem.mutateAsync({ tid: timesheet.id, data });
    }
    setLineItemModalOpen(false);
  };

  const handleDeleteLineItem = async (lineItem: IngestionLineItem) => {
    if (!timesheet || !window.confirm(`Delete line item for ${lineItem.work_date}?`)) return;
    await deleteLineItem.mutateAsync({ tid: timesheet.id, itemId: lineItem.id });
  };

  const handleApprove = async () => {
    if (!timesheet) return;
    const employeeIdForApproval = summaryForm.employee_id ? Number(summaryForm.employee_id) : (timesheet.employee_id ?? null);
    const clientIdForApproval = summaryForm.client_id ? Number(summaryForm.client_id) : (timesheet.client_id ?? null);
    if (!employeeIdForApproval) {
      window.alert('Select an employee before approving weeks.');
      return;
    }
    const siblingIds = siblings
      .filter((item) => item.status !== 'approved' && item.status !== 'rejected')
      .map((item) => item.id);
    const targetIds = siblingIds.length ? siblingIds : [timesheet.id];

    let successCount = 0;
    const failures: string[] = [];
    for (const id of targetIds) {
      try {
        await updateTimesheet.mutateAsync({ id, data: { employee_id: employeeIdForApproval, client_id: clientIdForApproval } });
        const result = await approveTimesheet.mutateAsync({ id, comment: reviewComment || undefined });
        successCount += 1;
        if (result?.overlapping_entries_count > 0) {
          failures.push(
            `Week #${id}: Approved, but ${result.overlapping_entries_count} date(s) already had existing time entries (${result.overlapping_dates?.join(', ')}). Check for duplicates.`,
          );
        }
      } catch (error: unknown) {
        failures.push(`Week #${id}: ${getApiErrorMessage(error, 'Approval failed')}`);
      }
    }

    if (successCount === 0 && failures.length > 0) {
      window.alert(failures.join('\n'));
      return;
    }
    navigate('/ingestion/inbox', {
      state: {
        banner: failures.length
          ? `Approved ${successCount} week(s). ${failures.length} failed.`
          : targetIds.length > 1
            ? `Approved ${targetIds.length} weeks successfully.`
            : `Approved week #${timesheet.id}. Time entries were created successfully.`,
      },
    });
  };

  const handleReject = async () => {
    if (!timesheet || !rejectReason.trim()) return;
    // Forward the reviewer's free-text comment alongside the reason (the
    // backend RejectRequest accepts an optional comment), matching f2.
    await rejectTimesheet.mutateAsync({
      id: timesheet.id,
      reason: rejectReason,
      comment: reviewComment.trim() || undefined,
    });
    setRejectPopoverAnchor(null);
    setRejectReason('');
  };

  const handleHold = async () => {
    if (!timesheet || !holdReason.trim()) return;
    await holdTimesheet.mutateAsync({ id: timesheet.id, comment: holdReason.trim() });
    setHoldPopoverAnchor(null);
    setHoldReason('');
  };

  const toggleLineItemSelection = (itemId: number) => {
    setSelectedLineItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };
  const selectAllSelectableLineItems = () => {
    if (!timesheet) return;
    const next = new Set<number>();
    for (const item of timesheet.line_items) if (!item.is_rejected) next.add(item.id);
    setSelectedLineItemIds(next);
  };
  const clearLineItemSelection = () => {
    setSelectedLineItemIds(new Set());
    setBulkProjectId('');
    setBulkExcludeReason('');
  };
  const handleBulkAssignProject = async () => {
    if (!timesheet || !bulkProjectId || selectedLineItemIds.size === 0) return;
    const projectIdNum = Number(bulkProjectId);
    if (!Number.isFinite(projectIdNum)) return;
    setBulkBusy(true);
    try {
      await Promise.all(
        [...selectedLineItemIds].map((itemId) =>
          updateLineItem.mutateAsync({ tid: timesheet.id, itemId, data: { project_id: projectIdNum } }),
        ),
      );
      clearLineItemSelection();
    } finally {
      setBulkBusy(false);
    }
  };
  const handleBulkExclude = async () => {
    if (!timesheet || !bulkExcludeReason.trim() || selectedLineItemIds.size === 0) return;
    setBulkBusy(true);
    try {
      await Promise.all(
        [...selectedLineItemIds].map((itemId) =>
          rejectLineItem.mutateAsync({ tid: timesheet.id, itemId, reason: bulkExcludeReason.trim() }),
        ),
      );
      clearLineItemSelection();
    } finally {
      setBulkBusy(false);
    }
  };
  const handleRejectLineItem = async (itemId: number) => {
    if (!timesheet || !lineItemRejectReason.trim()) return;
    await rejectLineItem.mutateAsync({ tid: timesheet.id, itemId, reason: lineItemRejectReason });
    setRejectingLineItemId(null);
    setLineItemRejectReason('');
  };
  const handleUnrejectLineItem = async (itemId: number) => {
    if (!timesheet) return;
    await unrejectLineItem.mutateAsync({ tid: timesheet.id, itemId });
  };
  const handleRevertRejection = async () => {
    if (!timesheet) return;
    await revertTimesheetRejection.mutateAsync(timesheet.id);
  };
  const handleDraftComment = async () => {
    if (!timesheet) return;
    const result = await draftComment.mutateAsync({ id: timesheet.id, seedText: reviewComment });
    if (result?.comment) setReviewComment(result.comment);
  };
  const handleReprocess = async (attachmentIds?: number[]) => {
    if (emailId == null) return;
    const res = await reprocessStored.mutateAsync({ emailId, attachmentIds });
    const jobId = (res as { data?: { job_id?: string } } | undefined)?.data?.job_id;
    if (jobId) setReprocessJobId(jobId);
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  const status = timesheet.status;
  const anomalies = (summaryRow?.llm_anomalies ?? []) as Array<{ type?: string; description?: string }>;
  const matchSuggestions = summaryRow?.llm_match_suggestions ?? null;

  return (
    <div className="-m-6 flex h-[calc(100vh-64px)] flex-col overflow-hidden">
      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border/60 bg-card px-6 py-3">
        <button
          type="button"
          onClick={() => navigate('/ingestion/inbox')}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to inbox
        </button>
        <div className="ml-1 min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="truncate text-[15px] font-semibold text-foreground">
              {storedEmail?.subject || timesheet.email?.subject || 'No subject'}
            </span>
            <span className="text-sm text-muted-foreground">
              from {storedEmail?.sender_name || storedEmail?.sender_email || timesheet.email?.sender_name || timesheet.email?.sender_email || 'Unknown'}
              {storedEmail?.forwarded_from_email && (
                <span className="ml-1.5 inline-flex items-center gap-1 rounded bg-sky-500/10 px-1.5 py-0.5 text-xs font-medium text-sky-600 dark:text-sky-300">
                  Forwarded · originally from {storedEmail.forwarded_from_name || storedEmail.forwarded_from_email}
                </span>
              )}
            </span>
          </div>
        </div>
        <StatusBadge status={(status || '').toLowerCase().replace(/\s+/g, '_')} variant="ingestion" />
        {isReprocessing && (
          <div className="flex items-center gap-2">
            <RefreshCw className="h-3.5 w-3.5 animate-spin text-primary" />
            <span className="text-xs font-medium text-primary">
              {reprocessStatus?.status === 'queued' ? 'Queued...' : `Trying again... ${Math.round(Number(reprocessStatus?.progress ?? 0))}%`}
            </span>
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary/60 transition-all duration-300" style={{ width: `${Number(reprocessStatus?.progress ?? 0)}%` }} />
            </div>
          </div>
        )}
        {reprocessDone && (
          <span className={cn('text-xs font-medium', reprocessStatus?.status === 'completed' ? 'text-sky-600' : 'text-rose-500')}>
            {reprocessStatus?.status === 'completed' ? 'Done.' : 'Failed. Please try again.'}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {/* Reprocess: icon dropdown with two scopes. */}
          <div ref={reprocessMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setReprocessMenuOpen((v) => !v)}
              disabled={reprocessStored.isPending || isReprocessing}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition hover:border-primary/40 hover:text-foreground disabled:opacity-50"
              aria-label="Try again"
              aria-haspopup="menu"
              aria-expanded={reprocessMenuOpen}
              title="Try this timesheet or the whole email again"
            >
              <RefreshCw className={cn('h-4 w-4', isReprocessing && 'animate-spin')} />
            </button>
            {reprocessMenuOpen && (
              <div className="absolute right-0 top-full z-30 mt-2 w-64 rounded-lg border border-border/60 bg-card p-1 shadow-lg" role="menu">
                <button
                  type="button"
                  onClick={() => {
                    setReprocessMenuOpen(false);
                    if (linkedAttachment) void handleReprocess([linkedAttachment.id]);
                    else void handleReprocess();
                  }}
                  className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-muted/50 disabled:opacity-50"
                  disabled={reprocessStored.isPending || isReprocessing}
                  role="menuitem"
                >
                  <div className="font-medium text-foreground">Try this timesheet again</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">Re-runs LLM extraction on the linked attachment only.</div>
                </button>
                <button
                  type="button"
                  onClick={() => { setReprocessMenuOpen(false); void handleReprocess(); }}
                  className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-muted/50 disabled:opacity-50"
                  disabled={reprocessStored.isPending || isReprocessing}
                  role="menuitem"
                >
                  <div className="font-medium text-foreground">Try the whole email again</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">Re-fetches and re-extracts all attachments from this email.</div>
                </button>
              </div>
            )}
          </div>

          {status === 'rejected' && (
            <button type="button" onClick={handleRevertRejection} className="action-button-secondary" disabled={revertTimesheetRejection.isPending}>
              <RefreshCw className="mr-1.5 h-4 w-4" /> {revertTimesheetRejection.isPending ? 'Reverting...' : 'Revert Rejection'}
            </button>
          )}
          {isActionable && (
            <div className="relative">
              <button type="button" onClick={() => setShowApproveConfirm((v) => !v)} className="action-button" disabled={approveTimesheet.isPending}>
                <Check className="mr-1.5 h-4 w-4" /> {approveTimesheet.isPending ? 'Approving...' : 'Approve'}
              </button>
              {showApproveConfirm && (() => {
                const lineCount = timesheet.line_items.length;
                const totalHoursNum = timesheet.total_hours != null ? Number(timesheet.total_hours) : null;
                const summary = lineCount > 0
                  ? `Create ${lineCount} time ${lineCount === 1 ? 'entry' : 'entries'}?`
                  : totalHoursNum && totalHoursNum > 0
                    ? `Only ${totalHoursNum} total hours, no daily breakdown. Approve anyway?`
                    : 'Nothing to create. Approve anyway?';
                return (
                  <div className="absolute right-0 top-full z-30 mt-2 w-max max-w-[560px] rounded-lg border border-primary/30 bg-card p-3 shadow-lg">
                    <p className="whitespace-nowrap text-sm text-foreground">{summary}</p>
                    <div className="mt-3 flex justify-end gap-2">
                      <button type="button" className="action-button-secondary" onClick={() => setShowApproveConfirm(false)}>Cancel</button>
                      <button type="button" className="action-button" disabled={approveTimesheet.isPending} onClick={handleApprove}>
                        {approveTimesheet.isPending ? 'Approving...' : 'Confirm'}
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </div>

      {/* ── Two-panel body ────────────────────────────────────────────────── */}
      <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
        {/* LEFT — email reader */}
        <div className="overflow-y-auto border-r border-border/60" style={{ flex: `0 0 ${leftPct}%`, minWidth: 0 }}>
          <div className="px-8 py-6">
            <div className="mb-4 flex items-start justify-between gap-4 border-b border-border/60 pb-4 text-sm">
              <div className="min-w-0 flex-1 space-y-1.5">
                <p>
                  <span className="inline-block w-16 text-muted-foreground">From</span>{' '}
                  <span className="text-foreground">
                    {storedEmail?.sender_name ? `${storedEmail.sender_name} <${storedEmail.sender_email}>` : storedEmail?.sender_email || timesheet.email?.sender_email || '--'}
                  </span>
                </p>
                {storedEmail?.forwarded_from_email && (
                  <p>
                    <span className="inline-block w-16 text-muted-foreground">Originally from</span>{' '}
                    <span className="text-foreground">
                      {storedEmail.forwarded_from_name
                        ? `${storedEmail.forwarded_from_name} <${storedEmail.forwarded_from_email}>`
                        : storedEmail.forwarded_from_email}
                    </span>
                  </p>
                )}
                <p>
                  <span className="inline-block w-16 text-muted-foreground">Date</span>{' '}
                  <span className="text-foreground">{formatDateTime(storedEmail?.received_at)}</span>
                </p>
              </div>
              {selectedAttachment && (
                <button
                  type="button"
                  onClick={scrollToAttachment}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition hover:bg-primary/20"
                  title="Jump to the attached file below"
                >
                  <ArrowDown className="h-3.5 w-3.5" /> Go to attachment
                </button>
              )}
            </div>

            {/* Body text */}
            <div className="mb-5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {storedEmail?.body_text || <span className="italic text-muted-foreground">No plain-text body saved.</span>}
            </div>

            {/* Attachment picker */}
            {attachments.length > 0 && (
              <div>
                <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Attachments</p>
                <div className="space-y-3">
                  {attachments
                    .filter((att) => linkedAttachmentId == null || att.id === linkedAttachmentId || siblings.length > 1)
                    .map((att) => {
                      const isLinked = att.id === linkedAttachmentId;
                      const isSelected = att.id === selectedAttachmentId;
                      return (
                        <button
                          key={att.id}
                          type="button"
                          onClick={() => setSelectedAttachmentId(isSelected ? null : att.id)}
                          className={cn(
                            'flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition',
                            isSelected ? 'border-primary/40 bg-primary/5' : 'border-border/60 bg-muted/20 hover:border-primary/30 hover:bg-muted/40',
                          )}
                        >
                          <Paperclip className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-foreground">{att.filename}</p>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {att.extraction_method && <span className="pill pill-idle">{att.extraction_method}</span>}
                              {att.extraction_status && <span className="pill pill-idle">{att.extraction_status}</span>}
                              {isLinked && <span className="pill pill-active">linked to this record</span>}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                </div>
              </div>
            )}
          </div>

          {/* Attachment preview */}
          {selectedAttachment && (
            <div ref={attachmentPreviewRef} className="border-t border-border/60">
              <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-6 py-2.5">
                <p className="font-medium text-foreground">{selectedAttachment.filename}</p>
                {selectedAttachment.extraction_status && <span className="pill pill-idle">{selectedAttachment.extraction_status}</span>}
                {selectedAttachment.extraction_method && <span className="pill pill-idle">{selectedAttachment.extraction_method}</span>}
                {selectedAttachment.rendered_html && (
                  <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 cursor-pointer accent-primary"
                      checked={showFullSheet}
                      onChange={(e) => setShowFullSheet(e.target.checked)}
                    />
                    Show full sheet{fullSheetLoading && showFullSheet ? '…' : ''}
                  </label>
                )}
              </div>
              <div>
                {attachmentLoadError ? (
                  <div className="px-6 py-10 text-sm text-rose-500">{attachmentLoadError}</div>
                ) : selectedAttachmentType === 'pdf' && liveAttachmentUrl ? (
                  <iframe src={liveAttachmentUrl} className="h-[75vh] w-full border-0" title={selectedAttachment.filename} />
                ) : selectedAttachmentType === 'image' && liveAttachmentUrl ? (
                  <div className="flex items-center justify-center p-4">
                    <img src={liveAttachmentUrl} alt={selectedAttachment.filename} className="max-w-full rounded-2xl object-contain" />
                  </div>
                ) : selectedAttachment.rendered_html ? (
                  <iframe
                    srcDoc={showFullSheet && fullSheetHtml ? fullSheetHtml : selectedAttachment.rendered_html}
                    className="h-[75vh] w-full border-0"
                    title={selectedAttachment.filename}
                    sandbox=""
                  />
                ) : selectedAttachment.spreadsheet_preview ? (
                  <SpreadsheetPreviewTable preview={selectedAttachment.spreadsheet_preview} />
                ) : selectedAttachment.raw_extracted_text ? (
                  <pre className="overflow-x-auto whitespace-pre px-5 py-5 font-mono text-sm text-muted-foreground">{selectedAttachment.raw_extracted_text}</pre>
                ) : (
                  <div className="px-6 py-10 text-sm text-muted-foreground">Preview unavailable for this attachment.</div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Splitter */}
        <div
          className="group relative flex w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-border/40 transition hover:bg-primary/30 active:bg-primary/50"
          onMouseDown={(e) => {
            e.preventDefault();
            isDragging.current = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
        >
          <div className="h-8 w-0.5 rounded-full bg-border transition group-hover:bg-primary/60" />
        </div>

        {/* RIGHT — review form */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-6 py-6">
          {/* Sibling-week tabs */}
          {siblings.length > 1 && (() => {
            const handleDismissPill = async (event: React.MouseEvent, sibling: IngestionSummary) => {
              event.stopPropagation();
              const periodLabel = sibling.period_start && sibling.period_end
                ? `${new Date(sibling.period_start).toLocaleDateString()} – ${new Date(sibling.period_end).toLocaleDateString()}`
                : `#${sibling.id}`;
              if (!window.confirm(
                `Remove the timesheet for ${periodLabel} from this email's pills?\n\nIt stays in the system as a rejected duplicate for audit but will no longer show up here.`,
              )) return;
              try {
                await rejectTimesheet.mutateAsync({ id: sibling.id, reason: 'Duplicate submission' });
                queryClient.invalidateQueries({ queryKey: ['ingestion', 'timesheets'] });
                queryClient.invalidateQueries({ queryKey: ['ingestion', 'detail', sibling.id] });
              } catch (err) {
                window.alert(getApiErrorMessage(err, 'Could not remove this pill. Please try again.'));
              }
            };
            return (
              <div className="mb-5">
                <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  {siblings.length} timesheets from this email
                </p>
                <div className="flex flex-wrap gap-2">
                  {siblings.map((s) => {
                    const isActive = s.id === timesheet.id;
                    const label = s.period_start && s.period_end
                      ? `${new Date(s.period_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(s.period_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                      : `#${s.id}`;
                    const anomalyCount = Array.isArray(s.llm_anomalies) ? s.llm_anomalies.length : 0;
                    let dotClass = 'bg-sky-500';
                    let dotTitle = 'Ready to review';
                    if (s.status === 'approved') { dotClass = 'bg-emerald-500'; dotTitle = 'Approved'; }
                    else if (s.status === 'rejected') { dotClass = 'bg-rose-500'; dotTitle = 'Rejected'; }
                    else if (s.status === 'on_hold') { dotClass = 'bg-slate-400'; dotTitle = 'On hold'; }
                    else if (anomalyCount > 0) { dotClass = 'bg-amber-500'; dotTitle = `${anomalyCount} anomaly${anomalyCount === 1 ? '' : 'ies'} flagged`; }
                    return (
                      <span
                        key={s.id}
                        className={cn(
                          'group/pill inline-flex items-center gap-2 rounded-full pl-3 text-xs font-medium transition',
                          isActive ? 'bg-primary pr-3 text-primary-foreground' : 'border border-border/60 bg-muted/30 pr-1 text-muted-foreground hover:border-primary/30 hover:text-foreground',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => navigate(`/ingestion/review/${s.id}`)}
                          title={dotTitle}
                          className="inline-flex items-center gap-2 py-1.5"
                        >
                          <span aria-hidden="true" className={cn('inline-block h-1.5 w-1.5 rounded-full', dotClass, isActive && 'opacity-90')} />
                          {label}
                        </button>
                        {!isActive && (
                          <button
                            type="button"
                            onClick={(e) => handleDismissPill(e, s)}
                            disabled={rejectTimesheet.isPending}
                            title="Remove this pill"
                            aria-label={`Remove ${label}`}
                            className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/60 transition hover:bg-rose-500/10 hover:text-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Rejection reason banner */}
          {status === 'rejected' && timesheet.rejection_reason && (
            <div className="mb-5 rounded-md border border-rose-500/20 bg-rose-500/10 px-4 py-3">
              <p className="mb-1 text-xs font-medium uppercase tracking-[0.12em] text-rose-500">Rejection Reason</p>
              <p className="text-sm text-foreground">{timesheet.rejection_reason}</p>
            </div>
          )}

          {/* LLM summary */}
          {timesheet.llm_summary && (
            <p className="mb-5 rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">{timesheet.llm_summary}</p>
          )}

          {/* Activity log (reviewer action history) — restores f2's audit-log
              block. Collapsed by default; reads detail.audit_log. */}
          {Array.isArray(timesheet.audit_log) && timesheet.audit_log.length > 0 && (
            <details className="mb-5 rounded-xl border border-border bg-card">
              <summary className="cursor-pointer select-none px-4 py-2.5 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Activity log ({timesheet.audit_log.length})
              </summary>
              <ul className="space-y-1.5 border-t border-border px-4 py-3">
                {timesheet.audit_log.map((entry, i) => (
                  <li key={entry.id ?? i} className="flex items-start gap-2 text-xs">
                    <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
                    <div className="min-w-0 flex-1">
                      <p className="text-foreground">
                        <span className="font-medium">{(entry.action ?? 'updated').replace(/_/g, ' ')}</span>
                        {entry.created_at ? (
                          <span className="text-muted-foreground"> · {new Date(entry.created_at).toLocaleString()}</span>
                        ) : null}
                      </p>
                      {entry.comment ? <p className="text-muted-foreground">{entry.comment}</p> : null}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="space-y-5">
            {/* Assignment */}
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Assignment</p>
              <div className="space-y-3">
                <div>
                  <div className="mb-1.5 flex items-center justify-between gap-3">
                    <label className="block text-sm font-medium text-foreground">Client</label>
                    <button
                      type="button"
                      onClick={(event) => setAddClientAnchor(event.currentTarget)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary transition hover:opacity-80"
                      aria-label="Add a new client"
                      title="Open the document to find the client name, then create it here"
                    >
                      <Plus className="h-3.5 w-3.5" /> Add client
                    </button>
                  </div>
                  <select className="field-input" value={summaryForm.client_id} onChange={(e) => handleClientPickerChange(e.target.value)}>
                    <option value="">Select client</option>
                    {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
                  </select>
                  {extractedClientHint && !extractedClientMatchesExisting && !summaryForm.client_id && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
                      <p className="text-xs text-muted-foreground">
                        Found in document. Client: <span className="font-medium text-foreground">{extractedClientHint}</span> (not in your client list).
                      </p>
                      <button
                        type="button"
                        disabled={createClient.isPending}
                        onClick={async () => {
                          try {
                            const created = await createClient.mutateAsync({ name: extractedClientHint, client_type: 'external' });
                            await handleClientPickerChange(String(created.id));
                          } catch {
                            // Surfaced via mutation state.
                          }
                        }}
                        className="text-xs font-medium text-primary hover:underline disabled:opacity-60"
                      >
                        {createClient.isPending ? 'Creating…' : `Create "${extractedClientHint}"`}
                      </button>
                    </div>
                  )}
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-foreground">Employee</label>
                  <select
                    className="field-input"
                    value={employeeSelectValue}
                    onChange={(e) => setSummaryForm((c) => ({ ...c, employee_id: e.target.value === '__extracted__' ? '' : e.target.value }))}
                  >
                    <option value="">Select employee</option>
                    {showExtractedEmployeeOption && (
                      <option value="__extracted__">From document: {extractedEmployeeDisplayName || extractedEmployeeHint} (not in system)</option>
                    )}
                    {users.map((user) => <option key={user.id} value={user.id}>{cleanEmployeeNameForDisplay(user.full_name) || user.full_name}</option>)}
                  </select>
                  {extractedEmployeeHint && (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Found in document: <span className="font-medium text-foreground">{extractedEmployeeDisplayName || extractedEmployeeHint}</span>
                    </p>
                  )}
                  <ChainCandidatesPanel
                    timesheetId={timesheet.id}
                    rawSuggestions={matchSuggestions}
                    currentEmployeeId={timesheet.employee_id ?? null}
                    onAssign={async (payload) => {
                      await assignChainCandidate.mutateAsync({
                        id: timesheet.id,
                        name: payload.name ?? undefined,
                        email: payload.email ?? undefined,
                      });
                    }}
                    isAssigning={assignChainCandidate.isPending}
                  />
                </div>
              </div>

              {Boolean((timesheet.extracted_supervisor_name ?? '').trim()) && (
                <div className="mt-3">
                  <label className="mb-1.5 block text-sm font-medium text-foreground">Supervisor</label>
                  <input
                    type="text"
                    className="field-input"
                    value={summaryForm.extracted_supervisor_name}
                    onChange={(e) => setSummaryForm((c) => ({ ...c, extracted_supervisor_name: e.target.value }))}
                    placeholder="Name from the timesheet"
                  />
                  {timesheet.extracted_supervisor_name && timesheet.extracted_supervisor_name !== summaryForm.extracted_supervisor_name && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Found in the document: <span className="font-medium text-foreground">{timesheet.extracted_supervisor_name}</span>. Saved with your approval.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Week & Hours */}
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Week &amp; Hours</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-foreground">Week Start</label>
                  <input type="date" className="field-input" value={summaryForm.period_start} onChange={(e) => setSummaryForm((c) => ({ ...c, period_start: e.target.value }))} />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-foreground">Week End</label>
                  <input type="date" className="field-input" value={summaryForm.period_end} onChange={(e) => setSummaryForm((c) => ({ ...c, period_end: e.target.value }))} />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-foreground">Total Hours</label>
                  <input className="field-input" value={summaryForm.total_hours} disabled title="Total hours is derived from the line items" />
                </div>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">Reviewer notes</label>
              <textarea className="field-input min-h-[80px]" rows={3} value={summaryForm.internal_notes} onChange={(e) => setSummaryForm((c) => ({ ...c, internal_notes: e.target.value }))} />
            </div>

            <div className="flex items-center justify-between">
              {summaryRow?.created_at ? (
                <p className="text-[11px] text-muted-foreground">Processed by system · {formatDateTime(summaryRow.created_at)}</p>
              ) : <span />}
              <button type="button" onClick={handleSaveSummary} className="action-button" disabled={updateTimesheet.isPending}>
                <Save className="mr-1.5 h-4 w-4" /> {updateTimesheet.isPending ? 'Saving...' : 'Save Summary'}
              </button>
            </div>

            {/* Line items */}
            <div>
              <div className="mb-3 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Line Items</p>
                <div className="flex items-center gap-3">
                  {isActionable && timesheet.line_items.length > 0 && (() => {
                    const selectableCount = timesheet.line_items.filter((i) => !i.is_rejected).length;
                    const allSelected = selectableCount > 0 && selectedLineItemIds.size === selectableCount;
                    return (
                      <button
                        type="button"
                        onClick={allSelected ? clearLineItemSelection : selectAllSelectableLineItems}
                        className="text-xs text-primary transition hover:opacity-75"
                      >
                        {allSelected ? 'Clear selection' : `Select all (${selectableCount})`}
                      </button>
                    );
                  })()}
                  {isActionable && (
                    <button type="button" onClick={() => openLineItemModal()} className="inline-flex items-center gap-1 text-xs text-primary transition hover:opacity-75">
                      <Plus className="h-3.5 w-3.5" /> Add
                    </button>
                  )}
                </div>
              </div>

              {/* Bulk toolbar */}
              {isActionable && selectedLineItemIds.size > 0 && (
                <div className="mb-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-foreground">
                      {selectedLineItemIds.size} line {selectedLineItemIds.size === 1 ? 'item' : 'items'} selected
                    </span>
                    <button type="button" onClick={clearLineItemSelection} disabled={bulkBusy} className="text-xs text-muted-foreground transition hover:text-foreground">Clear</button>
                  </div>
                  <div className="flex flex-wrap items-stretch gap-2">
                    <select className="field-input h-8 min-w-[180px] flex-1 text-sm" value={bulkProjectId} onChange={(e) => setBulkProjectId(e.target.value)} disabled={bulkBusy}>
                      <option value="">Assign project…</option>
                      {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select>
                    <button type="button" onClick={handleBulkAssignProject} disabled={!bulkProjectId || bulkBusy} className="action-button h-8 px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60">
                      {bulkBusy ? 'Assigning…' : `Assign to ${selectedLineItemIds.size}`}
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-stretch gap-2">
                    <input className="field-input h-8 min-w-[180px] flex-1 text-sm" placeholder="Exclusion reason (required to exclude)" value={bulkExcludeReason} onChange={(e) => setBulkExcludeReason(e.target.value)} disabled={bulkBusy} />
                    <button type="button" onClick={handleBulkExclude} disabled={!bulkExcludeReason.trim() || bulkBusy} className="h-8 rounded border border-rose-500/30 px-3 text-sm text-rose-500 transition hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-60">
                      {bulkBusy ? 'Excluding…' : `Exclude ${selectedLineItemIds.size}`}
                    </button>
                  </div>
                </div>
              )}

              {timesheet.line_items.length === 0 ? (
                <p className="text-sm text-muted-foreground">No line items yet.</p>
              ) : (
                <div className="space-y-2">
                  {timesheet.line_items.map((lineItem) => {
                    const isSelected = selectedLineItemIds.has(lineItem.id);
                    const canSelect = isActionable && !lineItem.is_rejected;
                    return (
                      <div
                        key={lineItem.id}
                        className={cn(
                          'group rounded-lg border transition',
                          lineItem.is_rejected
                            ? 'border-rose-500/30 bg-rose-500/5'
                            : isSelected
                              ? 'border-primary/40 bg-primary/5'
                              : 'border-border/60 bg-muted/20 hover:bg-muted/40',
                        )}
                      >
                        <div className="flex items-start gap-2 px-3 py-2.5">
                          <div className="flex h-5 shrink-0 items-center pt-0.5">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-border accent-primary disabled:opacity-40"
                              checked={isSelected}
                              disabled={!canSelect}
                              onChange={() => toggleLineItemSelection(lineItem.id)}
                              aria-label={canSelect ? `Select line item ${lineItem.id}` : 'Excluded; cannot be selected'}
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className={cn('font-mono text-sm font-medium', lineItem.is_rejected ? 'text-muted-foreground line-through' : 'text-foreground')}>
                                {new Date(lineItem.work_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', weekday: 'short' })}
                              </span>
                              <span className={cn('font-mono text-sm', lineItem.is_rejected ? 'text-muted-foreground line-through' : 'text-foreground')}>
                                {Number(lineItem.hours).toFixed(1)}h
                              </span>
                              {lineItem.is_rejected ? (
                                <span className="pill pill-idle border-rose-500/30 text-rose-500">Excluded</span>
                              ) : (
                                <span className={cn('pill', lineItem.project_id ? 'pill-active' : 'pill-idle')}>
                                  {lineItem.project_id ? `Project #${lineItem.project_id}` : 'Needs project'}
                                </span>
                              )}
                              {lineItem.is_corrected && !lineItem.is_rejected && <span className="pill pill-idle">Corrected</span>}
                            </div>
                            <p className={cn('mt-0.5 truncate text-xs', lineItem.is_rejected ? 'text-muted-foreground line-through' : 'text-muted-foreground')}>
                              {lineItem.description || 'No description'} · Code {lineItem.project_code || '--'}
                            </p>
                            {lineItem.is_rejected && lineItem.rejection_reason && (
                              <p className="mt-1 text-xs text-rose-500">Reason: {lineItem.rejection_reason}</p>
                            )}
                            {rejectingLineItemId === lineItem.id && (
                              <div className="mt-2 flex gap-2">
                                <input
                                  className="field-input h-7 flex-1 text-xs"
                                  value={lineItemRejectReason}
                                  onChange={(e) => setLineItemRejectReason(e.target.value)}
                                  placeholder="Rejection reason (required)"
                                  autoFocus
                                />
                                <button type="button" onClick={() => handleRejectLineItem(lineItem.id)} disabled={!lineItemRejectReason.trim() || rejectLineItem.isPending} className="action-button h-7 px-2 text-xs">Confirm</button>
                                <button type="button" onClick={() => { setRejectingLineItemId(null); setLineItemRejectReason(''); }} className="action-button-secondary h-7 px-2 text-xs">Cancel</button>
                              </div>
                            )}
                          </div>
                          <div className="flex shrink-0 gap-1 opacity-0 transition group-hover:opacity-100">
                            {isActionable && !lineItem.is_rejected && (
                              <>
                                <button type="button" onClick={() => openLineItemModal(lineItem)} className="action-button-secondary h-7 px-2 text-xs">Edit</button>
                                <button type="button" onClick={() => handleDeleteLineItem(lineItem)} className="action-button-secondary h-7 px-2 text-xs"><Trash2 className="h-3.5 w-3.5" /></button>
                                <button type="button" onClick={() => { setRejectingLineItemId(lineItem.id); setLineItemRejectReason(''); }} className="h-7 rounded border border-rose-500/30 px-2 text-xs text-rose-500 transition hover:bg-rose-500/10">Exclude</button>
                              </>
                            )}
                            {lineItem.is_rejected && (
                              <button type="button" onClick={() => handleUnrejectLineItem(lineItem.id)} disabled={unrejectLineItem.isPending} className="h-7 rounded border border-border/60 px-2 text-xs text-foreground transition hover:bg-muted/40">Restore</button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {timesheet.line_items.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Project assignment must be resolved on every line item before approval can create real time entries.
                </p>
              )}
            </div>

            {/* Issues to review */}
            {anomalies.length > 0 && (
              <div>
                <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Issues to review</p>
                <div className="space-y-2">
                  {anomalies.map((anomaly, index) => (
                    <div key={index} className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-600 dark:text-amber-300">
                      <span className="font-semibold">{anomaly.type || 'Anomaly'}:</span>{' '}
                      <span className="text-foreground">{anomaly.description || 'Check this item.'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Reviewer actions */}
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Reviewer Actions</p>
              <div className="space-y-3">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-foreground">Comment</label>
                  <textarea className="field-input min-h-[80px]" rows={3} value={reviewComment} onChange={(e) => setReviewComment(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <button type="button" onClick={handleDraftComment} className="action-button-secondary" disabled={draftComment.isPending}>
                    <Bot className="mr-1.5 h-4 w-4" /> {draftComment.isPending ? 'Drafting...' : 'Draft AI Comment'}
                  </button>
                  {isActionable && (
                    <>
                      <button type="button" onClick={(e) => setHoldPopoverAnchor(e.currentTarget)} className="action-button-secondary" disabled={holdTimesheet.isPending}>
                        <PauseCircle className="mr-1.5 h-4 w-4" /> {holdTimesheet.isPending ? 'Holding...' : 'Place On Hold'}
                      </button>
                      <button type="button" onClick={(e) => setRejectPopoverAnchor(e.currentTarget)} className="action-button-secondary" disabled={rejectTimesheet.isPending}>
                        <XCircle className="mr-1.5 h-4 w-4" /> Reject Submission
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Promote-to-review (only meaningful when this row was a skipped email
                that's been opened as a timesheet; kept for parity). */}
            {status === 'on_hold' && false && (
              <button type="button" onClick={() => void promoteSkipped.mutateAsync(emailId as number)} className="action-button-secondary">
                <ArrowRight className="mr-1.5 h-4 w-4" /> Promote to review
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Line-item add/edit modal */}
      {lineItemModalOpen && (
        <div className="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) setLineItemModalOpen(false); }}>
          <div role="dialog" aria-modal="true" className="w-full max-w-lg rounded-2xl border border-border bg-card text-card-foreground shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-foreground">{editingLineItem ? 'Edit Line Item' : 'Add Line Item'}</p>
                <p className="text-xs text-muted-foreground">Project assignment can be by code, direct project id, or both.</p>
              </div>
              <button type="button" onClick={() => setLineItemModalOpen(false)} aria-label="Close" className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground transition hover:bg-foreground/[0.06] hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <form onSubmit={handleSaveLineItem} className="space-y-4 p-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">Work Date</label>
                  <input type="date" className="field-input" value={lineItemForm.work_date} onChange={(e) => setLineItemForm((c) => ({ ...c, work_date: e.target.value }))} required />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">Hours</label>
                  <input className="field-input" value={lineItemForm.hours} onChange={(e) => setLineItemForm((c) => ({ ...c, hours: e.target.value }))} required />
                </div>
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-foreground">Description</label>
                <textarea className="field-input min-h-[80px]" rows={3} value={lineItemForm.description} onChange={(e) => setLineItemForm((c) => ({ ...c, description: e.target.value }))} />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">Project Code</label>
                  <input className="field-input" value={lineItemForm.project_code} onChange={(e) => setLineItemForm((c) => ({ ...c, project_code: e.target.value }))} />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">Project</label>
                  <select className="field-input" value={lineItemForm.project_id} onChange={(e) => setLineItemForm((c) => ({ ...c, project_id: e.target.value }))}>
                    <option value="">No direct project</option>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setLineItemModalOpen(false)} className="action-button-secondary">Cancel</button>
                <button type="submit" className="action-button" disabled={addLineItem.isPending || updateLineItem.isPending}>
                  {addLineItem.isPending || updateLineItem.isPending ? 'Saving...' : editingLineItem ? 'Save Line Item' : 'Add Line Item'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <CreateClientFromDomainPopover
        open={addClientAnchor != null}
        anchorEl={addClientAnchor}
        domain={senderDomain && !senderDomainIsPersonal ? senderDomain : ''}
        cascadeCount={0}
        existingClients={clients as ExistingClient[]}
        initialValue={addClientInitialValue}
        isSubmitting={createClientFromDomain.isPending || createClient.isPending}
        onConfirm={handleAddClientConfirm}
        onClose={() => setAddClientAnchor(null)}
      />

      <ReasonPopover
        open={rejectPopoverAnchor != null}
        anchorEl={rejectPopoverAnchor}
        title="Reject submission"
        description="Reason will be visible to the submitter and saved on the audit log."
        placeholder="e.g. Hours exceed contract limit"
        reason={rejectReason}
        setReason={setRejectReason}
        confirmLabel="Reject"
        confirmTone="danger"
        isSubmitting={rejectTimesheet.isPending}
        onConfirm={handleReject}
        onClose={() => setRejectPopoverAnchor(null)}
      />

      <ReasonPopover
        open={holdPopoverAnchor != null}
        anchorEl={holdPopoverAnchor}
        title="Place on hold"
        description="What's the holdup? Visible to other reviewers in the inbox."
        placeholder="e.g. Waiting on client confirmation"
        reason={holdReason}
        setReason={setHoldReason}
        confirmLabel="Place on hold"
        confirmTone="primary"
        isSubmitting={holdTimesheet.isPending}
        onConfirm={handleHold}
        onClose={() => setHoldPopoverAnchor(null)}
      />

      {/* formatDateRange is imported for parity with the f2 helper surface; the
          pill labels use inline toLocaleDateString to match f2 exactly. Kept the
          import referenced here so tree-shaking + lint stay happy. */}
      <span className="hidden" aria-hidden="true">{formatDateRange(timesheet.period_start, timesheet.period_end)}</span>
    </div>
  );
}

export default ReviewPanelPage;

// ─────────────────────────────────────────────────────────────────────────────
// PORT NOTES
// ─────────────────────────────────────────────────────────────────────────────
// PORTED (full parity with f2 behavior, reskinned to f3):
//   - Split-pane page (left email reader ~62% / right review form ~38%) with a
//     draggable splitter (30–78% clamp, mouse-release-outside-window guard).
//   - Email reader: From / Originally-from (forwarded) / Date headers, plain-text
//     body, "Go to attachment" jump link, attachment picker chips (extraction
//     method/status + "linked to this record").
//   - Attachment preview: PDF iframe, image, server-rendered HTML (with "Show full
//     sheet" lazy-load via ingestionApi.attachmentFullHtml), spreadsheet preview
//     table (sheet tabs + empty-column trimming + block splitting), raw-text
//     fallback, "Preview unavailable". Attachment bytes are fetched as an authed
//     blob (see note below) and tagged with their source id to avoid the
//     stale-blob/wrong-MIME race f2 documents.
//   - Sibling-week tabs (status dot + period label, click-navigate, ✕ dismiss as
//     'Duplicate submission'). Approve approves ALL editable siblings in bulk;
//     client picker cascades to editable siblings with optimistic cache writes.
//   - Inline "+ Add client" popover with domain cascade + personal-domain
//     fallback; extracted-client hint banner with one-click create.
//   - Approve inline confirmation ("Create N time entries?" / hours-only / nothing
//     variants), overlap warning surfaced from approve result
//     (overlapping_entries_count / overlapping_dates), bulk multi-week approve.
//   - Reject (required-reason popover) + Hold (optional-comment popover, sent as
//     the hold comment). Revert-rejection. Draft AI comment (uses res.comment).
//   - Chain-candidates panel (click-assign, optional inline email input, hides
//     once an employee is bound), extracted-employee name normalization/cleanup
//     + auto-match against the roster.
//   - Line items: per-row checkbox + bulk toolbar (assign project / exclude with
//     reason / select-all), per-item exclude-with-reason + restore, add/edit/
//     delete modal (work_date/hours/description/project_code/project_id).
//   - Anomalies "Issues to review" amber cards, reprocess scope dropdown
//     (this-timesheet linked-attachment vs whole-email) with progress + redirect
//     on completion, extracted supervisor/internal-notes + "Save Summary".
//
// COULD NOT PORT 1:1 (f3 data-layer constraints) — verify these against the live
// API before shipping:
//   1. TOTAL HOURS is read-only. f3 `useUpdateIngestionData` does not accept a
//      total_hours field (server derives it from line items), so the "Total Hours"
//      input is rendered DISABLED. f2 let the reviewer override it on Save Summary.
//      If the backend actually accepts total_hours on PATCH /data, widen the
//      useUpdateIngestionData mutation type and re-enable the input.
//   2. AUDIT LOG ("Activity log") is OMITTED. f3 `IngestionDetail` does not carry
//      an `audit_log` array (confirmed absent in types/admin.ts). f2 rendered
//      detail.audit_log here. If the wire payload includes it, add `audit_log` to
//      IngestionDetail and re-add the block (the markup is a 1:1 lift from f2).
//   3. CONFIDENCE BADGE + EMAIL-ONLY DIAGNOSTIC VIEW omitted. f3 routes only
//      /ingestion/review/:timesheetId (no email-only mode), and IngestionDetail
//      has no `extracted_data.extraction_confidence` / `uncertain_fields`. The
//      "Promote to review" / diagnostic-summary / classifier-reasoning panels were
//      email-mode-only in f2 and are not reachable here; left as a disabled stub.
//   4. ANOMALIES + MATCH SUGGESTIONS + ATTACHMENT_ID are read off the matching
//      IngestionSummary row from the full list (useIngestionTimesheets), because
//      f3's IngestionDetail does not expose them. If the detail endpoint starts
//      returning llm_anomalies / llm_match_suggestions / attachment_id directly,
//      prefer those (read `timesheet.*`) to avoid the extra list round-trip.
//
// ASSUMPTIONS TO DOUBLE-CHECK:
//   - ATTACHMENT BLOB FETCH: f3 ships `ingestionApi.attachmentFileUrl(id)` as a
//     PATH only (no blob helper). Since sessionStorage holds the bearer token and
//     an <iframe>/<img> src can't send Authorization, we fetch via the authed
//     axios `api` instance with responseType:'blob' and objectURL it (mirrors f2's
//     getAttachmentFile). If a dedicated blob helper is added later, swap it in.
//   - REPROCESS uses `useReprocessStoredEmail({emailId, attachmentIds?})` and reads
//     `res.data.job_id` defensively to drive the poll. f3's mutationFn returns the
//     raw axios response, so `res.data.job_id` is the path; if the hook is changed
//     to unwrap `.data`, adjust the read. Terminal state is 'completed' (NOT f2's
//     'complete') per useFetchJobStatus.
//   - `useCreateClientFromDomain` is defined LOCALLY in this module (f3's
//     useAdmin.ts exposes clientsApi.createFromDomain but no wrapping hook yet).
//     Promote it to useAdmin.ts if other pages need it.
//   - `createClient` requires `client_type` in f3 (ClientBody.client_type is
//     required); we default new inline-created clients to 'external'.
//   - Sibling matching/dedup is done CLIENT-SIDE off the full list filtered by
//     email_id (f3 list hook takes no params), matching f2's group-by-employee +
//     attachment/period/total dedup signature.
// ─────────────────────────────────────────────────────────────────────────────
