import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus, Share2 } from 'lucide-react';

import { Button, Empty, Toast } from '@/components/ui';
import {
  useCustomDashboards, useCreateCustomDashboard, useUpdateCustomDashboard, useDeleteCustomDashboard,
} from '@/hooks/useCustomDashboards';
import type { CustomDashboard, WidgetInstance } from '@/types/customDashboard';
import { DashboardGrid } from './DashboardGrid';
import { DashboardSwitcher } from './DashboardSwitcher';
import { WidgetLibrary } from './WidgetLibrary';
import { WidgetConfigModal } from './WidgetConfigModal';
import { NewDashboardModal } from './NewDashboardModal';
import { ShareDashboardModal } from './ShareDashboardModal';
import { AuthedWidgetData } from './WidgetDataContext';

// The "Dashboards" Insights tab. A dashboard the user OWNS is always directly
// editable (no edit-mode toggle): inline-rename, always-visible "Add widget",
// per-tile gear/resize/drag/remove, and a Share toggle — all autosaved. A
// non-owner sees a shared dashboard read-only. Delete lives on each list row.

export function DashboardsTab() {
  const listQ = useCustomDashboards();
  const create = useCreateCustomDashboard();
  const update = useUpdateCustomDashboard();
  const del = useDeleteCustomDashboard();

  const dashboards = listQ.data ?? [];
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [libOpen, setLibOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [configWidget, setConfigWidget] = useState<WidgetInstance | null>(null);
  const [toast, setToast] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  // Local working copy of the selected dashboard's layout (instant edits;
  // autosaved with a debounce). Name is edited inline + saved on its own.
  const [layout, setLayout] = useState<WidgetInstance[]>([]);
  const [name, setName] = useState('');

  const selected = useMemo<CustomDashboard | null>(
    () => dashboards.find((d) => d.id === selectedId) ?? null, [dashboards, selectedId]);
  const isOwner = !!selected?.is_owner;

  useEffect(() => {
    if (selectedId == null && dashboards.length) setSelectedId(dashboards[0].id);
  }, [dashboards, selectedId]);

  // Sync the working copies when the selection changes.
  const syncedFor = useRef<number | null>(null);
  useEffect(() => {
    if (selected && syncedFor.current !== selected.id) {
      setLayout(selected.layout ?? []);
      setName(selected.name);
      syncedFor.current = selected.id;
    }
  }, [selected]);

  // Persist a layout change. Discrete actions (add / configure / remove) save
  // immediately so a quick reload can't lose them; continuous gestures
  // (drag / resize) debounce to avoid a write per pixel.
  const saveTimer = useRef<number | null>(null);
  const persist = (next: WidgetInstance[]) => {
    update.mutate({ id: selected!.id, data: { layout: next } },
      { onError: () => setToast({ tone: 'err', text: 'Could not save layout.' }) });
  };
  const saveLayout = (next: WidgetInstance[], immediate = false) => {
    setLayout(next);
    if (!selected) return;
    if (saveTimer.current) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (immediate) { persist(next); return; }
    saveTimer.current = window.setTimeout(() => persist(next), 600);
  };

  // Debounced autosave of the name.
  const nameTimer = useRef<number | null>(null);
  const saveName = (next: string) => {
    setName(next);
    if (!selected) return;
    if (nameTimer.current) window.clearTimeout(nameTimer.current);
    nameTimer.current = window.setTimeout(() => {
      if (next.trim()) update.mutate({ id: selected.id, data: { name: next.trim() } });
    }, 600);
  };

  const onCreated = (created: CustomDashboard) => { setSelectedId(created.id); };

  const removeDashboard = async (d: CustomDashboard) => {
    if (!window.confirm(`Delete "${d.name}"? This can't be undone.`)) return;
    try {
      await del.mutateAsync(d.id);
      if (selectedId === d.id) setSelectedId(null);
      setToast({ tone: 'ok', text: 'Dashboard deleted.' });
    } catch { setToast({ tone: 'err', text: 'Could not delete.' }); }
  };


  if (listQ.isLoading) {
    return <div className="grid place-items-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  return (
    <div className="min-w-0">
      {/* Toolbar: the dashboard title on the left; the switcher dropdown sits
          with the Add widget / Share actions on the right. Renaming lives in the
          dropdown menu (no separate field), but the name is shown here clearly. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {selected ? (
            <h2 className="truncate text-lg font-bold text-foreground">{name || selected.name}</h2>
          ) : null}
          {selected && !isOwner ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">Shared by {selected.owner_name ?? 'someone'}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <DashboardSwitcher
            dashboards={dashboards}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
            onNew={() => setNewOpen(true)}
            onDelete={(d) => void removeDashboard(d)}
            onRename={isOwner ? (next) => saveName(next) : undefined}
          />
          {selected && isOwner ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => setLibOpen(true)}><Plus className="h-3.5 w-3.5" /> Add widget</Button>
              <Button
                size="sm"
                variant={selected.share_token ? 'primary' : 'ghost'}
                onClick={() => setShareOpen(true)}
                title={selected.share_token ? 'Shared via public link — manage sharing' : 'Share this dashboard'}
              >
                <Share2 className="h-3.5 w-3.5" /> {selected.share_token ? 'Shared' : 'Share'}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {!selected ? (
        <Empty Icon={Plus} title="No dashboard selected" description="Create a dashboard or pick one from the menu."
          action={<Button size="sm" onClick={() => setNewOpen(true)}>New dashboard</Button>} />
      ) : (
        // data-print-dashboard marks the only region kept when exporting.
        <div data-print-dashboard>
          <h2 className="mb-3 hidden text-lg font-bold text-foreground print:block">{selected.name}</h2>
          <AuthedWidgetData>
            <DashboardGrid
              layout={isOwner ? layout : (selected.layout ?? [])}
              editing={isOwner}
              onChange={saveLayout}
              onRemove={(id) => saveLayout(layout.filter((w) => w.id !== id), true)}
              onConfigure={(w) => setConfigWidget(w)}
              onAdd={() => setLibOpen(true)}
            />
          </AuthedWidgetData>
        </div>
      )}

      <NewDashboardModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreate={async (payload) => {
          try {
            const d = await create.mutateAsync(payload);
            onCreated(d);
          } catch { setToast({ tone: 'err', text: 'Could not create dashboard.' }); }
        }}
      />
      <WidgetLibrary open={libOpen} onClose={() => setLibOpen(false)} onAdd={(w) => saveLayout([...layout, w], true)} />
      <WidgetConfigModal
        widget={configWidget}
        onClose={() => setConfigWidget(null)}
        onSave={(updated) => saveLayout(layout.map((w) => (w.id === updated.id ? updated : w)), true)}
      />
      <ShareDashboardModal dashboard={selected} open={shareOpen} onClose={() => setShareOpen(false)} />
      {toast ? <Toast tone={toast.tone} message={toast.text} onDismiss={() => setToast(null)} /> : null}
    </div>
  );
}
