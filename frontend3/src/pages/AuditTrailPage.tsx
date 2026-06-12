import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, Empty, Input, TonePill, WorkspaceHeader } from '@/components/ui';
import { useAuditTrail } from '@/hooks/useAdmin';
import { avatarTone, initials } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import type { Tone } from '@/components/ui';

const SEVERITY_TONE: Record<string, Tone> = { error: 'danger', warning: 'warning', success: 'success', info: 'info' };
const SEVERITY_LABEL: Record<string, string> = { error: 'Alert', warning: 'Notice', success: 'Done', info: 'Info' };

function relativeTime(iso: string, now: Date): string {
  const diff = Math.max(0, now.getTime() - new Date(iso).getTime());
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function AuditTrailPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [limit, setLimit] = useState(50);
  const [typeFilter, setTypeFilter] = useState<string>('all');

  // Cheap debounce so each keystroke doesn't refetch.
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const audit = useAuditTrail({
    limit,
    search: debounced.trim() || undefined,
    activity_type: typeFilter === 'all' ? undefined : typeFilter,
  });
  const now = new Date();
  const events = audit.data ?? [];

  // Activity-type filter options derived from what's loaded (plus "all").
  const types = useMemo(() => {
    const set = new Set<string>();
    events.forEach((e) => set.add(e.activity_type));
    return ['all', ...Array.from(set).sort()];
  }, [events]);

  const typeLabel = (t: string) => t.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

  return (
    <div className="space-y-5">
      <WorkspaceHeader title="Audit Trail" description="Recent activity across your workspace." />

      {/* Filters */}
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search activity..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="h-9 rounded-full border border-border bg-transparent px-4 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          {types.map((t) => <option key={t} value={t}>{t === 'all' ? 'All activity' : typeLabel(t)}</option>)}
        </select>
      </Card>

      {audit.isLoading ? (
        <div className="grid place-items-center rounded-2xl border border-border bg-card py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
        </div>
      ) : audit.isError ? (
        <Card className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">
          Couldn't load the audit trail. You may not have admin access.
        </Card>
      ) : events.length === 0 ? (
        <Empty Icon={Search} title="No activity matches" description={debounced || typeFilter !== 'all' ? 'Try a different search or filter.' : 'Workspace events will appear here.'} />
      ) : (
        <>
          <Card className="divide-y divide-border">
            {events.map((e) => {
              const tone = SEVERITY_TONE[e.severity] ?? 'info';
              const label = SEVERITY_LABEL[e.severity] ?? 'Info';
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => e.route && navigate(e.route)}
                  disabled={!e.route}
                  className={cn('flex w-full items-start gap-3 px-4 py-3 text-left', e.route ? 'hover:bg-primary/5' : 'cursor-default')}
                >
                  <span className={cn('mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full text-[10px] font-semibold', avatarTone(e.actor_name ?? 'system'))}>
                    {initials(e.actor_name ?? 'SY')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm text-foreground">{e.summary}</p>
                      <TonePill tone={tone}>{label}</TonePill>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {typeLabel(e.activity_type)}{e.route ? ` · ${e.route}` : ''}
                    </p>
                  </div>
                  <p className="shrink-0 text-xs text-muted-foreground">{relativeTime(e.created_at, now)}</p>
                </button>
              );
            })}
          </Card>
          {/* Load more — if we got a full page there may be more. */}
          {events.length >= limit ? (
            <div className="flex justify-center">
              <Button variant="secondary" size="sm" onClick={() => setLimit((l) => Math.min(l + 50, 200))}>
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
