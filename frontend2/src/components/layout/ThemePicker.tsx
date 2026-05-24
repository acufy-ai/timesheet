import React, { useEffect, useRef, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import { useTheme } from '@/contexts/ThemeContext';
import { THEME_VARIANTS, type ThemeVariantKey } from '@/contexts/themeVariants';
import { cn } from '@/lib/utils';

// Acufy v2 theme picker: palette icon trigger + dark/light grouped dropdown.
// Each row shows two overlapping color swatches (the variant's accent +
// secondary), the theme name, and a check on the active row.
export const ThemePicker: React.FC = () => {
  const { variantKey, setVariant, variants } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const darkKeys = variants.filter((k) => THEME_VARIANTS[k].mode === 'dark');
  const lightKeys = variants.filter((k) => THEME_VARIANTS[k].mode === 'light');

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground"
        aria-label="Change theme"
        title="Change theme"
      >
        <Palette className="h-4 w-4" />
      </button>

      {open && (
        <div
          className="absolute right-0 top-11 z-50 w-[260px] rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-[0_20px_60px_rgba(0,0,0,0.35),0_0_0_1px_rgba(255,255,255,0.04)]"
        >
          <ThemeGroup title="DARK" keys={darkKeys} activeKey={variantKey} onSelect={(k) => { setVariant(k); setOpen(false); }} />
          <div className="my-3 h-px bg-border" />
          <ThemeGroup title="LIGHT" keys={lightKeys} activeKey={variantKey} onSelect={(k) => { setVariant(k); setOpen(false); }} />
        </div>
      )}
    </div>
  );
};

const ThemeGroup: React.FC<{
  title: string;
  keys: ThemeVariantKey[];
  activeKey: ThemeVariantKey;
  onSelect: (k: ThemeVariantKey) => void;
}> = ({ title, keys, activeKey, onSelect }) => (
  <div>
    <span className="mb-2 block text-[9px] font-medium tracking-[0.2em] text-muted-foreground">{title}</span>
    <div className="flex flex-col gap-0.5">
      {keys.map((k) => {
        const v = THEME_VARIANTS[k];
        const active = k === activeKey;
        return (
          <button
            key={k}
            type="button"
            onClick={() => onSelect(k)}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition',
              active ? 'bg-foreground/[0.08]' : 'hover:bg-foreground/[0.04]',
            )}
            aria-pressed={active}
            title={v.label}
          >
            <span className="flex shrink-0 items-center">
              <span
                className="h-5 w-5 rounded-full border-2"
                style={{ background: v.preview[0], borderColor: 'hsl(var(--card))' }}
              />
              <span
                className="-ml-1.5 h-5 w-5 rounded-full border-2"
                style={{ background: v.preview[1], borderColor: 'hsl(var(--card))' }}
              />
            </span>
            <span
              className={cn(
                'text-[12px] tracking-wide transition-colors',
                active ? 'text-foreground font-medium' : 'text-muted-foreground',
              )}
            >
              {v.label}
            </span>
            {active && (
              <span
                className="ml-auto inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground"
                aria-hidden
              >
                <Check className="h-2.5 w-2.5" strokeWidth={3} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  </div>
);
