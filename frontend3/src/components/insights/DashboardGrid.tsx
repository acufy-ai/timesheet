import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Minus, Plus, Settings, X } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { WidgetInstance } from '@/types/customDashboard';
import { WIDGET_REGISTRY } from './widgets';

// Renders a dashboard's widgets on a 12-column grid. View mode = static. Edit
// mode (owner) = dnd-kit reorder + resize (w/h steppers) + remove. The parent
// owns the layout array + persistence; this calls back on changes.

const COLS = 12;

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

  const resize = (id: string, dw: number, dh: number) => {
    onChange(layout.map((w) => w.id === id
      ? { ...w, w: Math.min(COLS, Math.max(2, w.w + dw)), h: Math.max(2, w.h + dh) }
      : w));
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
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`, gridAutoRows: '64px' }}>
      {layout.map((w) => (
        <WidgetCell key={w.id} widget={w} editing={editing} onResize={resize} onRemove={onRemove} onConfigure={onConfigure} />
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
  widget, editing, onResize, onRemove, onConfigure,
}: {
  widget: WidgetInstance;
  editing: boolean;
  onResize: (id: string, dw: number, dh: number) => void;
  onRemove: (id: string) => void;
  onConfigure: (w: WidgetInstance) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: widget.id, disabled: !editing });
  const meta = WIDGET_REGISTRY[widget.type];
  const style: React.CSSProperties = {
    gridColumn: `span ${Math.min(COLS, widget.w)}`,
    gridRow: `span ${widget.h}`,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className={cn('flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card', isDragging && 'ring-2 ring-primary')}>
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5">
        {editing ? (
          <button type="button" {...attributes} {...listeners} data-print-hide className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing print:hidden" aria-label="Drag widget">
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{widget.title ?? meta?.label}</span>
        {editing ? (
          <span data-print-hide className="flex shrink-0 items-center gap-0.5 print:hidden">
            <IconBtn label="Configure widget" onClick={() => onConfigure(widget)}><Settings className="h-3 w-3" /></IconBtn>
            <IconBtn label="Narrower" onClick={() => onResize(widget.id, -1, 0)}><Minus className="h-3 w-3" /></IconBtn>
            <span className="text-[9px] text-muted-foreground">W</span>
            <IconBtn label="Wider" onClick={() => onResize(widget.id, 1, 0)}><Plus className="h-3 w-3" /></IconBtn>
            <IconBtn label="Shorter" onClick={() => onResize(widget.id, 0, -1)}><Minus className="h-3 w-3" /></IconBtn>
            <span className="text-[9px] text-muted-foreground">H</span>
            <IconBtn label="Taller" onClick={() => onResize(widget.id, 0, 1)}><Plus className="h-3 w-3" /></IconBtn>
            <IconBtn label="Remove widget" danger onClick={() => onRemove(widget.id)}><X className="h-3 w-3" /></IconBtn>
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {meta ? <meta.Component config={widget.config} /> : <p className="text-xs text-muted-foreground">Unknown widget</p>}
      </div>
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
