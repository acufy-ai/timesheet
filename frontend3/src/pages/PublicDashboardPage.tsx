import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

import { publicDashboardApi } from '@/api/client';
import { DashboardGrid } from '@/components/insights/DashboardGrid';
import { StaticWidgetData } from '@/components/insights/WidgetDataContext';

// Public, no-login view of a shared dashboard. Reached at /shared/<token>. The
// public endpoint returns the layout + the metric bundles (already computed as
// the owner); StaticWidgetData feeds those to the same widget components, so the
// viewer sees exactly what the owner sees — read-only, no edit handles.

export function PublicDashboardPage() {
  const { token = '' } = useParams();
  const q = useQuery({
    queryKey: ['public-dashboard', token],
    queryFn: () => publicDashboardApi.get(token).then((r) => r.data),
    enabled: !!token,
    retry: false,
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold">{q.data?.name ?? 'Shared dashboard'}</h1>
            {q.data?.owner_name ? (
              <p className="text-[13px] text-muted-foreground">Shared by {q.data.owner_name}</p>
            ) : null}
          </div>
          <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            Read-only{q.data?.mode === 'snapshot' ? ' · snapshot' : ' · live'}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {q.isLoading ? (
          <div className="grid place-items-center py-24 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : q.isError || !q.data ? (
          <div className="grid place-items-center gap-2 rounded-2xl border border-dashed border-border py-24 text-center">
            <p className="text-sm font-medium text-foreground">This dashboard link isn't available.</p>
            <p className="text-[13px] text-muted-foreground">It may have been revoked or the link is incorrect.</p>
          </div>
        ) : q.data.layout.length === 0 ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border py-24 text-center text-sm text-muted-foreground">
            This dashboard has no widgets.
          </div>
        ) : (
          <StaticWidgetData bundle={q.data.data}>
            <DashboardGrid
              layout={q.data.layout}
              editing={false}
              onChange={() => {}}
              onRemove={() => {}}
              onConfigure={() => {}}
            />
          </StaticWidgetData>
        )}

        {q.data?.mode === 'snapshot' && q.data.captured_at ? (
          <p className="mt-6 text-center text-[12px] text-muted-foreground">
            Snapshot from {new Date(q.data.captured_at).toLocaleString()}.
          </p>
        ) : null}
      </main>
    </div>
  );
}
