import React from 'react';
import { Download, X } from 'lucide-react';

import { adminAPI } from '@/api';

type Mime = string | null;

type ViewerState = {
  id: number | null;
  filename: string;
  url: string | null;
  mime: Mime;
  html: string | null;
  loading: boolean;
  error: string | null;
};

const isSpreadsheetMime = (m: Mime): boolean => {
  if (!m) return false;
  const lower = m.toLowerCase();
  return (
    lower.includes('openxmlformats') ||
    lower === 'application/vnd.ms-excel' ||
    lower.includes('csv')
  );
};

const isInlineRenderableMime = (m: Mime): boolean => {
  if (!m) return false;
  const lower = m.toLowerCase();
  return lower.startsWith('image/') || lower === 'application/pdf';
};

const extractErrorMessage = (err: unknown): string => {
  if (err && typeof err === 'object' && 'response' in err) {
    const resp = (err as { response?: { data?: { detail?: string } } }).response;
    if (resp?.data?.detail) return resp.data.detail;
  }
  if (err instanceof Error) return err.message;
  return 'Unknown error';
};

export function useSourceAttachmentViewer() {
  const [state, setState] = React.useState<ViewerState>({
    id: null,
    filename: '',
    url: null,
    mime: null,
    html: null,
    loading: false,
    error: null,
  });

  const close = React.useCallback(() => {
    setState((prev) => {
      if (prev.url) URL.revokeObjectURL(prev.url);
      return { id: null, filename: '', url: null, mime: null, html: null, loading: false, error: null };
    });
  }, []);

  const open = React.useCallback(async (attachmentId: number, filename: string) => {
    setState({
      id: attachmentId,
      filename,
      url: null,
      mime: null,
      html: null,
      loading: true,
      error: null,
    });
    try {
      const res = await adminAPI.getApprovedIngestionAttachmentHtml(attachmentId);
      setState((prev) => ({
        ...prev,
        html: res.data.html,
        mime: res.data.mime_type,
        filename: res.data.filename ?? prev.filename,
        loading: false,
      }));
    } catch (err: unknown) {
      const httpStatus = (err as { response?: { status?: number } }).response?.status;
      if (httpStatus === 400 || httpStatus === undefined) {
        try {
          const fileRes = await adminAPI.getApprovedIngestionAttachmentFile(attachmentId);
          setState((prev) => ({
            ...prev,
            url: fileRes.url,
            mime: fileRes.mime,
            loading: false,
          }));
        } catch (fileErr) {
          setState((prev) => ({
            ...prev,
            loading: false,
            error: extractErrorMessage(fileErr) || 'Could not load attachment.',
          }));
        }
      } else {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: extractErrorMessage(err) || 'Could not load attachment.',
        }));
      }
    }
  }, []);

  return { state, open, close };
}

interface SourceAttachmentViewerProps {
  state: ViewerState;
  onClose: () => void;
}

export const SourceAttachmentViewer: React.FC<SourceAttachmentViewerProps> = ({ state, onClose }) => {
  if (state.id === null) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-card border-l border-border shadow-xl w-full max-w-3xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Source File</p>
            <p className="font-semibold text-foreground truncate max-w-md">{state.filename}</p>
          </div>
          <button
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {state.loading ? (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Loading…</div>
          ) : state.html ? (
            <div
              className="text-sm overflow-x-auto [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted/40 [&_th]:font-medium"
              dangerouslySetInnerHTML={{ __html: state.html }}
            />
          ) : state.url && (isInlineRenderableMime(state.mime) || isSpreadsheetMime(state.mime)) ? (
            <iframe src={state.url} className="h-full w-full border-0 min-h-[70vh]" title={state.filename} />
          ) : state.url ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">
                This file type can't be previewed in the browser.
              </p>
              <a
                href={state.url}
                download={state.filename || undefined}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted transition"
              >
                <Download className="h-3.5 w-3.5" />
                Download {state.filename || 'file'}
              </a>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              {state.error ?? 'Failed to load file.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
