import { useEffect } from 'react';

import { useTheme } from '@/contexts/ThemeContext';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import { THEME_VARIANTS, type ThemeVariantKey } from '@/contexts/themeVariants';

// Applies the tenant's customization appearance defaults (theme / palette) to
// a BRAND-NEW user once their preferences load. The backend seeds these into
// GET /me/preferences for users who haven't chosen yet; here we translate that
// into the concrete theme variant and apply it — but only when the user has no
// stored theme choice (ThemeContext.applyDefaultVariant is a no-op otherwise),
// so a deliberate pick is never overridden.
//
// Resolution order: an explicit ``palette`` (a theme variant key) wins; else
// ``theme`` maps light -> cyan-light, dark -> violet-night, system -> the
// OS preference. Renders nothing.

function resolveVariant(palette?: string, theme?: string): ThemeVariantKey | null {
  if (palette && palette in THEME_VARIANTS) return palette as ThemeVariantKey;
  if (theme === 'light') return 'cyan-light';
  if (theme === 'dark') return 'violet-night';
  if (theme === 'system') {
    const prefersDark =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'violet-night' : 'cyan-light';
  }
  return null;
}

export function PreferencesDefaultsSync({ enabled }: { enabled: boolean }) {
  const prefs = useUserPreferences(enabled);
  const { applyDefaultVariant } = useTheme();

  useEffect(() => {
    if (!prefs.data) return;
    const variant = resolveVariant(
      typeof prefs.data.palette === 'string' ? prefs.data.palette : undefined,
      typeof prefs.data.theme === 'string' ? prefs.data.theme : undefined,
    );
    if (variant) applyDefaultVariant(variant);
  }, [prefs.data, applyDefaultVariant]);

  return null;
}
