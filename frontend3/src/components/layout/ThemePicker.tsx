import { useEffect, useRef, useState } from 'react';
import { Check, Palette } from 'lucide-react';

import { useTheme } from '@/contexts/ThemeContext';
import { THEME_VARIANTS, type ThemeVariantKey } from '@/contexts/themeVariants';
import { cn } from '@/lib/cn';

// Theme picker for the frontend3 shell. Palette icon button → dropdown with
// the six themes split by mode (DARK / LIGHT). Each row shows two overlapping
// preview swatches, the theme name, and a check on the active row.
export function ThemePicker() {
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
        aria-label="Change theme"
        title="Change theme"
        className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
      >
        <Palette className="h-4 w-4" />
      </button>

      {open ? (
        <div className="absolute right-0 top-11 z-50 w-[268px] rounded-2xl border border-border bg-popover p-3 text-popover-foreground shadow-xl">
          <ThemeGroup
            title="Dark"
            keys={darkKeys}
            activeKey={variantKey}
            onSelect={(k) => {
              setVariant(k);
              setOpen(false);
            }}
          />
          <div className="my-2 h-px bg-border" />
          <ThemeGroup
            title="Light"
            keys={lightKeys}
            activeKey={variantKey}
            onSelect={(k) => {
              setVariant(k);
              setOpen(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function ThemeGroup({
  title,
  keys,
  activeKey,
  onSelect,
}: {
  title: string;
  keys: ThemeVariantKey[];
  activeKey: ThemeVariantKey;
  onSelect: (k: ThemeVariantKey) => void;
}) {
  return (
    <div>
      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {title}
      </p>
      <div className="space-y-0.5">
        {keys.map((k) => {
          const v = THEME_VARIANTS[k];
          const active = k === activeKey;
          return (
            <button
              key={k}
              type="button"
              onClick={() => onSelect(k)}
              aria-pressed={active}
              title={v.label}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
                active ? 'bg-foreground/[0.08]' : 'hover:bg-foreground/[0.04]',
              )}
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
                  'text-[13px] tracking-wide transition-colors',
                  active ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                {v.label}
              </span>
              {active ? (
                <span
                  className="ml-auto inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground"
                  aria-hidden
                >
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
