import { ChevronDown, ChevronUp, Eye, EyeOff, RotateCcw } from 'lucide-react';

import { Modal } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  MANAGER_TILES,
  useManagerDashboardPrefs,
  type ManagerTileDef,
} from '@/hooks/useManagerDashboardPrefs';

// Lets a manager tailor their dashboard: show/hide tiles, reorder them, and
// pick which columns appear within column-bearing tiles. All changes persist to
// the user's server-side preferences immediately (no separate Save step).
export function ManagerDashboardCustomizer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { prefs, toggleHidden, moveTile, toggleColumn, reset, isHidden, isColumnHidden, saving } =
    useManagerDashboardPrefs();

  // Render tiles in the user's current order.
  const ordered = prefs.order
    .map((k) => MANAGER_TILES.find((t) => t.key === k))
    .filter((t): t is ManagerTileDef => Boolean(t));

  return (
    <Modal open={open} onClose={onClose} title="Customize dashboard" className="max-w-lg">
      <div className="flex flex-col gap-2 pb-4">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Show or hide tiles, reorder them, and choose columns. Saved to your profile.
            {saving ? <span className="ml-1.5 text-primary">Saving…</span> : null}
          </p>
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
        </div>

        <ul className="flex flex-col gap-1.5">
          {ordered.map((tile, idx) => {
            const hidden = isHidden(tile.key);
            return (
              <li
                key={tile.key}
                className={cn(
                  'rounded-xl border border-border bg-card px-3 py-2.5 transition-opacity',
                  hidden && 'opacity-55',
                )}
              >
                <div className="flex items-center gap-2">
                  {/* reorder */}
                  <div className="flex flex-col">
                    <button
                      type="button"
                      onClick={() => moveTile(tile.key, -1)}
                      disabled={idx === 0}
                      aria-label="Move up"
                      className="grid h-4 w-5 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveTile(tile.key, 1)}
                      disabled={idx === ordered.length - 1}
                      aria-label="Move down"
                      className="grid h-4 w-5 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <span className="flex-1 text-sm font-medium text-foreground">{tile.label}</span>

                  {/* show/hide */}
                  <button
                    type="button"
                    onClick={() => toggleHidden(tile.key)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors',
                      hidden
                        ? 'border-border text-muted-foreground hover:text-foreground'
                        : 'border-primary/40 bg-primary/10 text-primary',
                    )}
                  >
                    {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    {hidden ? 'Hidden' : 'Shown'}
                  </button>
                </div>

                {/* per-tile columns */}
                {!hidden && tile.columns ? (
                  <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border/60 pt-2">
                    {tile.columns.map((col) => {
                      const colHidden = isColumnHidden(tile.key, col.key);
                      return (
                        <button
                          key={col.key}
                          type="button"
                          disabled={col.locked}
                          onClick={() => toggleColumn(tile.key, col.key)}
                          title={col.locked ? 'Always shown' : undefined}
                          className={cn(
                            'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                            col.locked
                              ? 'cursor-default border-border bg-muted/40 text-muted-foreground'
                              : colHidden
                                ? 'border-border text-muted-foreground/60 line-through hover:text-foreground'
                                : 'border-primary/40 bg-primary/10 text-primary',
                          )}
                        >
                          {col.label}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
