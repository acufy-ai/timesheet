import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Users, X, Check } from 'lucide-react';

import type { User } from '@/types';

interface Props {
  allEmployees: User[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Compact employee multi-select. Trigger button shows:
 *   - "All employees" when nothing is selected
 *   - "<Name>" when one is selected
 *   - "<N> employees" when more than one
 * The popover lists active EMPLOYEE-role users with search + check
 * toggles. "Clear" empties the selection (reverts to all-employees).
 */
export const EmployeeMultiSelectPicker: React.FC<Props> = ({
  allEmployees,
  selectedIds,
  onChange,
  open,
  onOpenChange,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onOpenChange]);

  const sortedEmployees = useMemo(
    () => [...allEmployees].sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [allEmployees],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sortedEmployees;
    return sortedEmployees.filter((u) => u.full_name.toLowerCase().includes(q));
  }, [search, sortedEmployees]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const triggerLabel = (() => {
    if (selectedIds.length === 0) return 'All employees';
    if (selectedIds.length === 1) {
      const first = allEmployees.find((u) => u.id === selectedIds[0]);
      return first?.full_name ?? '1 employee';
    }
    return `${selectedIds.length} employees`;
  })();

  const toggle = (id: number) => {
    if (selectedSet.has(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="relative inline-flex items-center gap-2 rounded-lg border border-border bg-card pl-3 pr-9 py-2 text-sm hover:border-primary/40 transition"
      >
        <Users className="w-4 h-4 text-muted-foreground" />
        <span className={selectedIds.length === 0 ? 'text-muted-foreground' : 'text-foreground'}>
          {triggerLabel}
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground absolute right-2.5" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-border bg-card shadow-lg">
          <div className="p-2 border-b border-border">
            <input
              type="text"
              placeholder="Search employees..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="field-input w-full text-sm py-1.5"
              autoFocus
            />
          </div>
          {selectedIds.length > 0 && (
            <div className="px-3 py-1.5 text-xs flex items-center justify-between border-b border-border bg-muted/30">
              <span className="text-muted-foreground">{selectedIds.length} selected</span>
              <button
                type="button"
                onClick={() => onChange([])}
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <X className="w-3 h-3" />
                Clear
              </button>
            </div>
          )}
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-3">No matching employees.</p>
            ) : (
              filtered.map((u) => {
                const checked = selectedSet.has(u.id);
                return (
                  <button
                    type="button"
                    key={u.id}
                    onClick={() => toggle(u.id)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-muted/60 transition"
                  >
                    <span
                      className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center ${
                        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                      }`}
                    >
                      {checked && <Check className="w-3 h-3" />}
                    </span>
                    <span className="truncate">{u.full_name}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
