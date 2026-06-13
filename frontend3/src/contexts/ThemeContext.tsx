import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  THEME_VARIANTS,
  THEME_VARIANT_ORDER,
  applyThemeVariant,
  type ThemeVariantKey,
  type ThemeMode,
} from './themeVariants';

interface ThemeContextValue {
  variantKey: ThemeVariantKey;
  variant: ReturnType<typeof currentVariant>;
  setVariant: (key: ThemeVariantKey) => void;
  variants: typeof THEME_VARIANT_ORDER;
  theme: ThemeMode;
  toggleTheme: () => void;
  setTheme: (mode: ThemeMode) => void;
  /** True once the user has explicitly picked a theme (a value is stored). */
  hasStoredChoice: boolean;
  /** Apply a team-default variant, but ONLY if the user hasn't chosen one. */
  applyDefaultVariant: (key: ThemeVariantKey) => void;
}

function currentVariant(key: ThemeVariantKey) {
  return THEME_VARIANTS[key];
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

// Distinct from frontend2's key so the two apps don't share theme state
// when both are running locally. frontend3 = v3 (no relation to frontend1's
// legacy theme storage).
const STORAGE_KEY = 'acufy-theme-variant-v3';

function getInitialVariant(): ThemeVariantKey {
  if (typeof window === 'undefined') return 'cyan-light';
  const stored = window.localStorage.getItem(STORAGE_KEY) as ThemeVariantKey | null;
  if (stored && stored in THEME_VARIANTS) return stored;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'violet-night' : 'cyan-light';
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [variantKey, setVariantKey] = useState<ThemeVariantKey>(getInitialVariant);

  useEffect(() => {
    applyThemeVariant(THEME_VARIANTS[variantKey]);
  }, [variantKey]);

  const setVariant = useCallback((key: ThemeVariantKey) => {
    window.localStorage.setItem(STORAGE_KEY, key);
    setVariantKey(key);
  }, []);

  const theme: ThemeMode = THEME_VARIANTS[variantKey].mode;
  const setTheme = useCallback(
    (mode: ThemeMode) => {
      setVariant(mode === 'dark' ? 'violet-night' : 'cyan-light');
    },
    [setVariant],
  );
  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  // Apply a tenant-default variant for a brand-new user. No-op once the user
  // has made (and stored) their own choice, so the team default only seeds the
  // first visit and never overrides a deliberate pick. Does NOT write to
  // localStorage — the default stays "soft" until the user explicitly chooses.
  const applyDefaultVariant = useCallback((key: ThemeVariantKey) => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem(STORAGE_KEY)) return; // user already chose
    if (!(key in THEME_VARIANTS)) return;
    setVariantKey(key);
  }, []);

  const hasStoredChoice =
    typeof window !== 'undefined' && Boolean(window.localStorage.getItem(STORAGE_KEY));

  return (
    <ThemeContext.Provider
      value={{
        variantKey,
        variant: THEME_VARIANTS[variantKey],
        setVariant,
        variants: THEME_VARIANT_ORDER,
        theme,
        toggleTheme,
        setTheme,
        hasStoredChoice,
        applyDefaultVariant,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeContextValue => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
};
