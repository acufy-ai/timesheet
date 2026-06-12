import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Clock, PencilLine, Wrench } from 'lucide-react';

import { WorkspaceHeader } from '@/components/ui';
import { cn } from '@/lib/cn';
import { WeekEditorTab } from '@/components/my-time/WeekEditorTab';
import { NaturalLanguageEntry } from '@/components/my-time/NaturalLanguageEntry';
import { HistoryTab } from '@/components/my-time/HistoryTab';
import { ReworkTab } from '@/components/my-time/ReworkTab';
import { useMyEntriesFiltered } from '@/hooks/useTime';

type Tab = 'enter' | 'history' | 'rework';

// My Time shell: tab switcher (Enter / History / Rework) over the three
// surfaces. Enter = natural-language quick entry + the weekly editor; History
// = filterable list of all entries; Rework = rejected entries grouped by week
// with the manager's notes. Mirrors frontend2's three-tab structure.
export function MyTimePage() {
  // Tab state is driven by the URL (?tab=history|rework) so it's deep-linkable
  // and survives reload (mirrors frontend2).
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get('tab');
  const tab: Tab = urlTab === 'history' || urlTab === 'rework' ? urlTab : 'enter';
  const setTab = (t: Tab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (t === 'enter') next.delete('tab'); else next.set('tab', t);
      return next;
    }, { replace: true });
  };
  // When the editor is re-anchored from Rework ("Fix in editor"), bump this key
  // so WeekEditorTab remounts on the chosen week AND opens the rejected day.
  const [editorWeek, setEditorWeek] = useState<string | undefined>(undefined);
  const [editorDay, setEditorDay] = useState<string | undefined>(undefined);
  const [flash, setFlash] = useState<string | null>(null);
  const flashAndFade = (msg: string) => { setFlash(msg); window.setTimeout(() => setFlash(null), 4000); };

  // Rejected-count badge for the Rework tab + the promotion banner.
  const rejected = useMyEntriesFiltered({ status: 'REJECTED', limit: 200 });
  const reworkCount = rejected.data?.length ?? 0;

  const tabs = useMemo(
    () => [
      { key: 'enter' as const, label: 'Enter time', Icon: PencilLine },
      { key: 'history' as const, label: 'History', Icon: Clock },
      { key: 'rework' as const, label: 'Rework', Icon: Wrench, badge: reworkCount },
    ],
    [reworkCount],
  );

  function fixInEditor(weekStartIso: string, dayIso: string) {
    setEditorWeek(weekStartIso);
    setEditorDay(dayIso);
    setTab('enter');
  }

  return (
    <div className="space-y-4">
      <WorkspaceHeader title="My Time" description="Track your hours, review history, and fix anything sent back." />

      {/* Tabs */}
      <div className="flex items-center gap-1.5 border-b border-border pb-3">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn('pill inline-flex items-center gap-1.5 text-sm', tab === t.key ? 'pill-active' : 'pill-idle')}
          >
            <t.Icon className="h-3.5 w-3.5" />
            {t.label}
            {t.badge ? (
              <span className={cn('ml-1 rounded-full px-1.5 text-[10px]', tab === t.key ? 'bg-white/20' : 'bg-rose-500/15 text-rose-600 dark:text-rose-300')}>{t.badge}</span>
            ) : null}
          </button>
        ))}
      </div>

      {flash ? (
        <div role="alert" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{flash}</div>
      ) : null}

      {/* Rework promotion banner (Enter tab only, when there are rejections) */}
      {tab === 'enter' && reworkCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3">
          <p className="text-sm text-rose-700 dark:text-rose-300">
            <strong>{reworkCount}</strong> {reworkCount === 1 ? 'entry was' : 'entries were'} sent back for changes.
          </p>
          <button type="button" onClick={() => setTab('rework')} className="text-sm font-medium text-rose-700 underline dark:text-rose-300">
            Review rework
          </button>
        </div>
      ) : null}

      {tab === 'enter' ? (
        <div className="space-y-4">
          <NaturalLanguageEntry onSaved={flashAndFade} />
          <WeekEditorTab key={`${editorWeek ?? 'current'}|${editorDay ?? ''}`} initialWeek={editorWeek} initialDay={editorDay} />
        </div>
      ) : tab === 'history' ? (
        <HistoryTab />
      ) : (
        <ReworkTab onFix={fixInEditor} />
      )}
    </div>
  );
}
