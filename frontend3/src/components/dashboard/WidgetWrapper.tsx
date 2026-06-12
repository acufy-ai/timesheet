import type { ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Minus, Plus } from 'lucide-react';

import { cn } from '@/lib/cn';
import { ALLOWED_SIZES, type WidgetKey } from '@/hooks/useDashboardPrefs';

interface WidgetWrapperProps {
  id: WidgetKey;
  span: number; // current column span (out of 12)
  title?: string;
  canGrow: boolean;
  canShrink: boolean;
  onGrow: () => void;
  onShrink: () => void;
  children: ReactNode;
}

// Wraps a dashboard widget with the two layout affordances frontend2 has:
//   • a DRAG grip (top-left, hover-revealed) — reorder via @dnd-kit
//   • RESIZE controls (bottom-right, hover-revealed) — a "−" and a "+" that
//     step the widget through its allowed column spans. Unlike f2's single
//     wrap-around button, these let you grow AND shrink directly; each is
//     disabled at the corresponding limit.
export function WidgetWrapper({ id, span, title, canGrow, canShrink, onGrow, onShrink, children }: WidgetWrapperProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const resizable = (ALLOWED_SIZES[id]?.length ?? 0) > 1;

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // 12-col grid; widgets go full width on small screens (see grid wrapper).
    gridColumn: `span ${span}`,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('group/slot relative col-span-12', isDragging && 'z-50 scale-[1.01] opacity-50')}
    >
      {/* Drag grip */}
      <button
        type="button"
        className="absolute left-3 top-3 z-20 grid h-6 w-6 cursor-grab place-items-center rounded-full bg-muted/80 text-muted-foreground opacity-0 transition-all hover:bg-primary/20 hover:text-primary active:cursor-grabbing group-hover/slot:opacity-100"
        aria-label={`Drag ${title ?? 'widget'}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>

      {/* Resize: shrink / grow */}
      {resizable ? (
        <div className="absolute bottom-3 right-3 z-20 flex items-center gap-1 opacity-0 transition-all group-hover/slot:opacity-100">
          <button
            type="button"
            onClick={onShrink}
            disabled={!canShrink}
            className="grid h-[18px] w-[18px] place-items-center rounded bg-muted/80 text-muted-foreground transition-all hover:bg-primary/20 hover:text-primary disabled:cursor-not-allowed disabled:opacity-30"
            aria-label={`Shrink ${title ?? 'widget'}`}
            title="Make smaller"
          >
            <Minus className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onGrow}
            disabled={!canGrow}
            className="grid h-[18px] w-[18px] place-items-center rounded bg-muted/80 text-muted-foreground transition-all hover:bg-primary/20 hover:text-primary disabled:cursor-not-allowed disabled:opacity-30"
            aria-label={`Enlarge ${title ?? 'widget'}`}
            title="Make larger"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      ) : null}

      {isDragging ? <div className="pointer-events-none absolute inset-0 z-10 rounded-2xl border-2 border-primary" /> : null}

      {children}
    </div>
  );
}
