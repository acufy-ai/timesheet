import type { ReactNode } from 'react';

import { Modal } from '@/components/ui';

// Thin wrapper that hosts a tile's full report inside a wide modal. The report
// BODY (e.g. ProjectMatrixReport) is a standalone component that knows nothing
// about the modal — so the same body can later be mounted at a dedicated route
// (/dashboard/reports/:tile) or a shareable custom-dashboard shell without
// change. This shell only supplies the overlay + sizing.
export function ReportModal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} className="max-w-5xl">
      {children}
    </Modal>
  );
}
