import React from 'react';
import { Navigate } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { useIngestionEnabled } from '@/hooks/useIngestionEnabled';
import { MailboxesPage } from '@/pages/MailboxesPage';

// Mailboxes is gated by the per-tenant ``ingestion_enabled`` flag and is
// admin-only. Render-time guard mirrors the backend's
// ``require_ingestion_enabled`` + ``require_role("ADMIN")`` so a user
// who clicks the sidebar entry on a tenant where it shouldn't appear
// (theoretically impossible, since the sidebar hides it, but defense in
// depth) lands on the dashboard instead of an empty/error state.
export const MailboxesSettings: React.FC = () => {
  const { user } = useAuth();
  const ingestionEnabled = useIngestionEnabled();
  if (!ingestionEnabled || user?.role !== 'ADMIN') {
    return <Navigate to="/dashboard" replace />;
  }
  return <MailboxesPage />;
};
