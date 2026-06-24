import { useAuth } from '@/contexts/AuthContext';
import { ClientPortalPage } from '@/pages/ClientPortalPage';
import { ClientManagerPortalPage } from '@/pages/ClientManagerPortalPage';

// Routes /portal by client role:
//   CLIENT_MANAGER -> the manager portal (team, assignments, review)
//   CLIENT / CLIENT_EMPLOYEE -> the scoped project/task view (read/update,
//     capability-gated; create/delete never offered to employees).
export function PortalRouter() {
  const { user } = useAuth();
  if (user?.role === 'CLIENT_MANAGER') return <ClientManagerPortalPage />;
  return <ClientPortalPage />;
}
