import React from 'react';
import { Download, Loader2, Mail, Trash2, UserMinus, X } from 'lucide-react';

interface BulkSelectBarProps {
  selectedCount: number;
  totalCount: number;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onDelete: () => void;
  isDeleting?: boolean;
  itemLabel?: string;

  // New bulk actions (optional so existing callers keep working unchanged).
  onSendInvite?: () => void;
  isSendingInvite?: boolean;
  // When true the Send invite button renders but is disabled. Used
  // when the selection contains only users for whom invite is
  // meaningless (e.g. all-external users have no login).
  sendInviteDisabled?: boolean;
  sendInviteDisabledTitle?: string;
  onExport?: () => void;
  isExporting?: boolean;
  onDeactivate?: () => void;
  isDeactivating?: boolean;
}

/**
 * Floating selection toolbar that sticks to the bottom of the viewport
 * while rows are selected. Bottom-fixed so the user never loses sight of
 * the action set, no matter where they scrolled to make the selection.
 *
 * Renders nothing when selectedCount === 0.
 */
export const BulkSelectBar: React.FC<BulkSelectBarProps> = ({
  selectedCount,
  totalCount,
  onSelectAll,
  onClearSelection,
  onDelete,
  isDeleting = false,
  itemLabel = 'item',
  onSendInvite,
  isSendingInvite = false,
  sendInviteDisabled = false,
  sendInviteDisabledTitle,
  onExport,
  isExporting = false,
  onDeactivate,
  isDeactivating = false,
}) => {
  if (selectedCount === 0) return null;

  const plural = selectedCount === 1 ? itemLabel : `${itemLabel}s`;
  const anyActionRunning = isDeleting || isSendingInvite || isExporting || isDeactivating;

  return (
    <div
      role="region"
      aria-label={`Bulk actions for ${selectedCount} selected ${plural}`}
      className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 transform"
    >
      <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-card/95 px-4 py-2.5 shadow-2xl backdrop-blur supports-[backdrop-filter]:bg-card/85">
        <div className="flex items-center gap-3 pr-3 border-r border-border">
          <span className="text-sm font-medium text-foreground whitespace-nowrap">
            {selectedCount} {plural} selected
          </span>
          {selectedCount < totalCount && (
            <button
              type="button"
              onClick={onSelectAll}
              disabled={anyActionRunning}
              className="text-xs font-medium text-primary hover:text-primary/80 transition disabled:opacity-50 whitespace-nowrap"
            >
              Select all {totalCount}
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {onSendInvite && (
            <button
              type="button"
              onClick={onSendInvite}
              disabled={anyActionRunning || sendInviteDisabled}
              title={sendInviteDisabled ? sendInviteDisabledTitle : undefined}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-primary/30 hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {isSendingInvite ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
              {isSendingInvite ? 'Sending...' : 'Send invite'}
            </button>
          )}
          {onExport && (
            <button
              type="button"
              onClick={onExport}
              disabled={anyActionRunning}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-primary/30 hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {isExporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {isExporting ? 'Exporting...' : 'Export'}
            </button>
          )}
          {onDeactivate && (
            <button
              type="button"
              onClick={onDeactivate}
              disabled={anyActionRunning}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 transition hover:bg-amber-500/15 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              title="Set the selected users to inactive. They won't be able to log in until you re-enable them."
            >
              {isDeactivating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserMinus className="h-3.5 w-3.5" />}
              {isDeactivating ? 'Disabling...' : 'Disable login'}
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            disabled={anyActionRunning}
            className="inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-destructive/90 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {isDeleting ? 'Deleting...' : `Delete ${selectedCount}`}
          </button>
        </div>

        <button
          type="button"
          onClick={onClearSelection}
          disabled={anyActionRunning}
          aria-label="Clear selection"
          className="ml-2 inline-flex items-center justify-center rounded-md h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted transition disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};
