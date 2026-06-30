import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useRef, useState } from 'react';
import { GripVertical, Info, Plus, Settings, X } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Tooltip } from '@/components/ui';
import type { WidgetInstance } from '@/types/customDashboard';
import { WIDGET_REGISTRY, widgetHeaderInfo } from './widgets';

// Strip a trailing chart-type parenthetical from a saved title (older widgets
// stored e.g. "Revenue by project (bars)"); the chart type is a setting, not
// part of the name.
const cleanTitle = (t?: string): string | undefined =>
  t?.replace(/\s*\((bars?|donut|line|pie|chart)\)\s*$/i, '').trim() || t;

// Renders a dashboard's widgets on a 12-column grid. View mode = static. Edit
// mode (owner) = dnd-kit reorder + resize (w/h steppers) + remove. The parent
// owns the layout array + persistence; this calls back on changes.

const COLS = 12;
const ROW_PX = 64;   // gridAutoRows height
const GAP_PX = 12;   // gap-3

export function DashboardGrid({
  layout, editing, onChange, onRemove, onConfigure, onAdd,
}: {
  layout: WidgetInstance[];
  editing: boolean;
  onChange: (next: WidgetInstance[]) => void;
  onRemove: (id: string) => void;
  onConfigure: (w: WidgetInstance) => void;
  onAdd?: () => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const gridRef = useRef<HTMLDivElement>(null);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = layout.findIndex((w) => w.id === active.id);
    const to = layout.findIndex((w) => w.id === over.id);
    if (from < 0 || to < 0) return;
    const next = [...layout];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  // Set absolute w/h (used by the corner drag handle), clamped to sane bounds.
  const resizeTo = (id: string, w: number, h: number) => {
    onChange(layout.map((it) => it.id === id
      ? { ...it, w: Math.min(COLS, Math.max(2, w)), h: Math.max(2, h) }
      : it));
  };

  if (layout.length === 0) {
    return (
      <div className="grid place-items-center gap-3 rounded-2xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
        <span>This dashboard has no widgets yet.</span>
        {editing && onAdd ? (
          <button type="button" onClick={onAdd} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
            <Plus className="h-3.5 w-3.5" /> Add your first widget
          </button>
        ) : null}
      </div>
    );
  }

  const grid = (
    // `grid-auto-flow: dense` backfills holes a tall widget would otherwise
    // leave, so the board packs tightly instead of leaving large vertical gaps.
    <div ref={gridRef} className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`, gridAutoRows: `${ROW_PX}px`, gridAutoFlow: 'row dense' }}>
      {layout.map((w) => (
        <WidgetCell key={w.id} widget={w} editing={editing} gridRef={gridRef}
          onResizeTo={resizeTo} onRemove={onRemove} onConfigure={onConfigure} />
      ))}
    </div>
  );

  if (!editing) return grid;
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={layout.map((w) => w.id)} strategy={rectSortingStrategy}>
        {grid}
      </SortableContext>
    </DndContext>
  );
}

function WidgetCell({
  widget, editing, gridRef, onResizeTo, onRemove, onConfigure,
}: {
  widget: WidgetInstance;
  editing: boolean;
  gridRef: React.RefObject<HTMLDivElement>;
  onResizeTo: (id: string, w: number, h: number) => void;
  onRemove: (id: string) => void;
  onConfigure: (w: WidgetInstance) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: widget.id, disabled: !editing });
  const meta = WIDGET_REGISTRY[widget.type];
  const [resizing, setResizing] = useState(false);
  const style: React.CSSProperties = {
    gridColumn: `span ${Math.min(COLS, widget.w)}`,
    gridRow: `span ${widget.h}`,
    transform: CSS.Transform.toString(transform),
    transition: resizing ? 'none' : transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Corner drag-resize: map pointer movement to grid cells. One column unit =
  // (grid width − gaps) / 12; one row unit = ROW_PX + gap. Live-updates w/h as
  // the user drags, so it feels direct.
  const onHandleDown = (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const gridEl = gridRef.current;
    if (!gridEl) return;
    const colUnit = (gridEl.clientWidth - GAP_PX * (COLS - 1)) / COLS + GAP_PX;
    const rowUnit = ROW_PX + GAP_PX;
    const startX = e.clientX, startY = e.clientY;
    const startW = widget.w, startH = widget.h;
    setResizing(true);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dw = Math.round((ev.clientX - startX) / colUnit);
      const dh = Math.round((ev.clientY - startY) / rowUnit);
      onResizeTo(widget.id, startW + dw, startH + dh);
    };
    const up = () => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div ref={setNodeRef} style={style} className={cn('group/widget relative flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card', (isDragging || resizing) && 'ring-2 ring-primary')}>
      <div className="flex items-center gap-1 border-b border-border px-2.5 py-1.5">
        {editing ? (
          <button type="button" {...attributes} {...listeners} data-print-hide className="shrink-0 cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing print:hidden" aria-label="Drag to reorder">
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span className="truncate">{cleanTitle(widget.title) ?? meta?.label}</span>
          <Tooltip label={widgetHeaderInfo(widget.type, widget.config)} side="top" maxWidth={240}>
            <Info data-print-hide className="h-3 w-3 shrink-0 cursor-help opacity-50 print:hidden" aria-hidden="true" />
          </Tooltip>
        </span>
        {editing ? (
          <span data-print-hide className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/widget:opacity-100 print:hidden">
            <IconBtn label="Configure widget" onClick={() => onConfigure(widget)}><Settings className="h-3.5 w-3.5" /></IconBtn>
            <IconBtn label="Remove widget" danger onClick={() => onRemove(widget.id)}><X className="h-3.5 w-3.5" /></IconBtn>
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {meta ? <meta.Component config={widget.config} widgetId={widget.id} /> : <p className="text-xs text-muted-foreground">Unknown widget</p>}
      </div>
      {/* Drag-to-resize handle: bottom-right corner. Reveals on hover. */}
      {editing ? (
        <div data-print-hide onPointerDown={onHandleDown} title="Drag to resize"
          className="absolute bottom-0 right-0 z-10 flex h-5 w-5 cursor-nwse-resize items-end justify-end p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/widget:opacity-100 print:hidden">
          <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 fill-current">
            <path d="M9 1v8H1z" opacity="0.5" />
          </svg>
        </div>
      ) : null}
    </div>
  );
}

function IconBtn({ children, onClick, label, danger }: { children: React.ReactNode; onClick: () => void; label: string; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className={cn('grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06]', danger ? 'hover:text-rose-600' : 'hover:text-foreground')}>
      {children}
    </button>
  );
}

