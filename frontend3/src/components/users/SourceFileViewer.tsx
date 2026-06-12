import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';

import { adminApi } from '@/api/client';
import { cn } from '@/lib/cn';

// Right slide-over that previews an approved-ingestion attachment's source
// file. Ported from frontend2's AdminPage source-file panel (openAttachment +
// the slide-over JSX). The render path branches on what the backend gives us:
//
//   1. HTML (spreadsheets / csv): the /full-html endpoint returns a sanitized
//      server-rendered table snippet. Injected via dangerouslySetInnerHTML —
//      safe because xlsx_render sanitizes server-side.
//   2. PDF / image: the /file endpoint streams the raw bytes. We turn the blob
//      into an object URL and render a PDF in an <iframe> or an image in an
//      <img>.
//   3. Anything else: a download CTA, so opening the panel never silently
//      triggers a browser download.
//
// The full-html call is tried first; it 400s for non-spreadsheet mimes, in
// which case we fall back to the raw-file path. Object URLs are revoked on
// close/unmount so we don't leak blobs.

export interface SourceFileViewerProps {
  open: boolean;
  attachmentId: number | null;
  filename?: string;
  onClose: () => void;
}

// Spreadsheets render as HTML; PDFs/images render inline. Everything else gets
// a download CTA. Mirrors frontend2's isSpreadsheetMime / isInlineRenderableMime.
function isSpreadsheetMime(m: string | null | undefined): boolean {
  if (!m) return false;
  const lower = m.toLowerCase();
  return (
    lower.includes('openxmlformats') ||
    lower === 'application/vnd.ms-excel' ||
    lower.includes('csv')
  );
}
function isPdfMime(m: string | null | undefined): boolean {
  return !!m && m.toLowerCase().split(';')[0].trim() === 'application/pdf';
}
function isImageMime(m: string | null | undefined): boolean {
  return !!m && m.toLowerCase().startsWith('image/');
}

function extractError(err: unknown): string {
  const e = err as { response?: { data?: { detail?: string } }; message?: string };
  const d = e?.response?.data?.detail;
  return (typeof d === 'string' ? d : undefined) ?? e?.message ?? 'Could not load attachment.';
}

export function SourceFileViewer({ open, attachmentId, filename, onClose }: SourceFileViewerProps) {
  const [displayFilename, setDisplayFilename] = useState<string>(filename ?? '');
  const [html, setHtml] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [mime, setMime] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the live object URL in a ref so cleanup (effect teardown / unmount)
  // revokes the latest one without re-running on every state change.
  const urlRef = useRef<string | null>(null);
  const revokeUrl = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  // Fetch whenever the panel opens with a new attachment id. We try the
  // HTML render first, then fall back to the raw file on failure (the
  // full-html endpoint 400s for non-spreadsheet mimes).
  useEffect(() => {
    if (!open || attachmentId == null) return;

    let cancelled = false;
    setHtml(null);
    setObjectUrl(null);
    revokeUrl();
    setMime(null);
    setError(null);
    setDisplayFilename(filename ?? '');
    setLoading(true);

    const loadRawFile = async () => {
      const res = await adminApi.approvedIngestionAttachmentFile(attachmentId);
      const blob = res.data as Blob;
      // Prefer the response Content-Type header (carries the true mime);
      // fall back to the blob's own type if the header is absent.
      const headerMime =
        (res.headers?.['content-type'] as string | undefined) ?? blob.type ?? null;
      const url = URL.createObjectURL(blob);
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }
      urlRef.current = url;
      setObjectUrl(url);
      setMime(headerMime);
    };

    (async () => {
      try {
        const res = await adminApi.approvedIngestionAttachmentHtml(attachmentId);
        if (cancelled) return;
        const data = res.data as { html: string; filename?: string; mime_type?: string };
        setHtml(data.html);
        setMime(data.mime_type ?? null);
        if (data.filename) setDisplayFilename(data.filename);
      } catch (htmlErr) {
        if (cancelled) return;
        // 400 (not a spreadsheet) or a network-style failure: fall back to
        // streaming the raw bytes.
        try {
          await loadRawFile();
        } catch (fileErr) {
          if (!cancelled) setError(extractError(fileErr) || extractError(htmlErr));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, attachmentId, filename, revokeUrl]);

  // Revoke any live object URL on unmount.
  useEffect(() => () => revokeUrl(), [revokeUrl]);

  // Close on Escape and lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const handleClose = useCallback(() => {
    revokeUrl();
    setHtml(null);
    setObjectUrl(null);
    setMime(null);
    setError(null);
    onClose();
  }, [onClose, revokeUrl]);

  if (!open || attachmentId == null) return null;

  const showImage = !html && objectUrl && isImageMime(mime);
  const showIframe =
    !html && objectUrl && (isPdfMime(mime) || isSpreadsheetMime(mime));
  const showDownload = !html && objectUrl && !showImage && !showIframe;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={handleClose} />

      {/* Panel */}
      <div className="relative z-10 flex h-full w-[640px] max-w-full flex-col border-l border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Source file
            </p>
            <p className="truncate font-semibold text-foreground">
              {displayFilename || 'Attachment'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : html ? (
            // Server-rendered, sanitized xlsx/csv HTML. Wrapped so wide
            // columns scroll instead of blowing past the panel.
            <div
              className={cn(
                'overflow-x-auto text-sm',
                '[&_table]:border-collapse',
                '[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
                '[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted/40 [&_th]:font-medium',
              )}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : showImage ? (
            <img
              src={objectUrl ?? undefined}
              alt={displayFilename || 'Attachment preview'}
              className="mx-auto max-w-full"
            />
          ) : showIframe ? (
            <iframe
              src={objectUrl ?? undefined}
              title={displayFilename || 'Attachment preview'}
              className="h-full min-h-[70vh] w-full border-0"
            />
          ) : showDownload ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">
                This file type can&apos;t be previewed in the browser.
              </p>
              <a
                href={objectUrl ?? undefined}
                download={displayFilename || undefined}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground transition hover:bg-muted/40"
              >
                <Download className="h-3.5 w-3.5" />
                Download {displayFilename || 'file'}
              </a>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {error ?? 'Failed to load file.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
