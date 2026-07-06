// frontend2 — Acufy v2 six-theme system bridged onto the existing shadcn API.
//
// The public surface (ThemeVariantKey, THEME_VARIANTS, THEME_VARIANT_ORDER,
// applyThemeVariant, ThemeVariant.{logoPath, mode, label, legacy.{bgApp,bgSurface,bgSurface2,...}, tokens})
// is preserved so every existing component using useTheme()/THEME_VARIANTS keeps working.
//
// The values are sourced from acufy_website_v2/frontend/src/index.css (the
// canonical 6-theme palette) and rewritten as HSL triplets so shadcn's
// hsl(var(--*)) classes pick them up automatically.

export type ThemeVariantKey =
  | 'violet-night'
  | 'emerald-night'
  | 'amber-night'
  | 'cyan-light'
  | 'rose-light'
  | 'sapphire-light';

export type ThemeMode = 'dark' | 'light';

export interface ThemeVariant {
  key: ThemeVariantKey;
  label: string;
  mode: ThemeMode;
  logoPath: string;
  /** Color swatches shown in the picker (primary, secondary). */
  preview: [string, string];
  /** shadcn HSL tokens (no `hsl()` wrapper — that's added at apply time). */
  tokens: {
    background: string;
    foreground: string;
    card: string;
    cardForeground: string;
    primary: string;
    primaryForeground: string;
    secondary: string;
    secondaryForeground: string;
    muted: string;
    mutedForeground: string;
    accent: string;
    accentForeground: string;
    border: string;
    input: string;
    ring: string;
    popover: string;
    popoverForeground: string;
    /** Optional per-theme danger color. Defaults to rose-600 when omitted, so
        destructive buttons stay red on every theme. */
    destructive?: string;
    destructiveForeground?: string;
  };
  /** Legacy semantic vars consumed by older components in this codebase. */
  legacy: {
    accentBlue: string;
    accentLight: string;
    accentHover: string;
    bgApp: string;
    bgSurface: string;
    bgSurface2: string;
    textPrimary: string;
    textSecondary: string;
    glassBg: string;
    glassBorder: string;
  };
  /** Acufy v2 named tokens — set on the root so utility CSS using them works. */
  acufy: {
    ink: string;
    ink2: string;
    ink3: string;
    ink4: string;
    bone: string;
    bone2: string;
    boneDim: string;
    mute: string;
    line: string;
    line2: string;
    line3: string;
    violet: string;
    violet2: string;
    violet3: string;
    violet4: string;
    magenta: string;
    plasma: string;
    accent: string;
    accentRgb: string;
    gradVio: string;
    glow: string;
    /** Logo SVG tint tokens (kept for parity with v2; harmless if unused). */
    logoCBright: string;
    logoCMid: string;
    logoCDeep: string;
  };
}

const LOGO_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/logos`;

const violetNight: ThemeVariant = {
  key: 'violet-night',
  label: 'Violet Night',
  mode: 'dark',
  logoPath: `${LOGO_BASE}/logo-violet-night.png`,
  preview: ['#a855f7', '#d946ef'],
  tokens: {
    background: '252 67% 6%',         // ~#07041a (Acufy --ink)
    foreground: '255 36% 95%',        // ~#f1eef9 (Acufy --bone)
    card: '253 53% 10%',              // ~#0e0826 (Acufy --ink-2)
    cardForeground: '255 36% 95%',
    primary: '271 91% 65%',           // #a855f7 (Acufy --violet-2 / --accent)
    primaryForeground: '0 0% 100%',
    secondary: '254 53% 14%',         // ~#160e34 (Acufy --ink-3)
    secondaryForeground: '255 36% 95%',
    muted: '254 53% 14%',
    mutedForeground: '253 11% 60%',   // ~#9089ab (Acufy --bone-dim)
    accent: '271 91% 65%',
    accentForeground: '0 0% 100%',
    border: '253 16% 22%',            // tuned line-2 substitute
    input: '253 16% 22%',
    ring: '271 91% 65%',
    popover: '253 53% 10%',
    popoverForeground: '255 36% 95%',
  },
  legacy: {
    accentBlue: '#a855f7',
    accentLight: 'rgba(168, 85, 247, 0.12)',
    accentHover: '#c084fc',
    bgApp: '#07041a',
    bgSurface: '#0e0826',
    bgSurface2: '#160e34',
    textPrimary: '#f1eef9',
    textSecondary: '#9089ab',
    glassBg: 'rgba(14, 8, 38, 0.85)',
    glassBorder: 'rgba(168, 85, 247, 0.14)',
  },
  acufy: {
    ink: '#07041a', ink2: '#0e0826', ink3: '#160e34', ink4: '#1f1545',
    bone: '#f1eef9', bone2: '#d0cbe5', boneDim: '#9089ab', mute: '#564f72',
    line: 'rgba(241, 238, 249, 0.07)', line2: 'rgba(241, 238, 249, 0.14)', line3: 'rgba(241, 238, 249, 0.24)',
    violet: '#9333ea', violet2: '#a855f7', violet3: '#c084fc', violet4: '#d8b4fe',
    magenta: '#d946ef', plasma: '#f472b6',
    accent: '#a855f7', accentRgb: '168, 85, 247',
    gradVio: 'linear-gradient(135deg, #9333ea 0%, #a855f7 60%, #d946ef 100%)',
    glow: '0 0 40px rgba(168, 85, 247, 0.55)',
    // Monochromatic sphere: bright is a lighter shade of the violet mid,
    // not a contrasting cyan. Keeps the logo on-brand per theme.
    logoCBright: '#d8b4fe', logoCMid: '#a855f7', logoCDeep: '#9333ea',
  },
};

const emeraldNight: ThemeVariant = {
  key: 'emerald-night',
  label: 'Emerald Night',
  mode: 'dark',
  logoPath: `${LOGO_BASE}/logo-emerald-night.png`,
  preview: ['#34d399', '#14b8a6'],
  tokens: {
    background: '146 67% 6%',         // ~#041a0e
    foreground: '140 36% 95%',        // ~#eef9f2
    card: '149 53% 10%',              // ~#082618
    cardForeground: '140 36% 95%',
    primary: '160 84% 39%',           // #10b981
    primaryForeground: '0 0% 100%',
    secondary: '152 58% 13%',         // ~#0e3424
    secondaryForeground: '140 36% 95%',
    muted: '152 58% 13%',
    mutedForeground: '140 11% 60%',
    accent: '160 84% 39%',
    accentForeground: '0 0% 100%',
    border: '152 14% 22%',
    input: '152 14% 22%',
    ring: '160 84% 39%',
    popover: '149 53% 10%',
    popoverForeground: '140 36% 95%',
  },
  legacy: {
    accentBlue: '#10b981',
    accentLight: 'rgba(16, 185, 129, 0.12)',
    accentHover: '#34d399',
    bgApp: '#041a0e',
    bgSurface: '#082618',
    bgSurface2: '#0e3424',
    textPrimary: '#eef9f2',
    textSecondary: '#89ab94',
    glassBg: 'rgba(8, 38, 24, 0.85)',
    glassBorder: 'rgba(16, 185, 129, 0.14)',
  },
  acufy: {
    ink: '#041a0e', ink2: '#082618', ink3: '#0e3424', ink4: '#154530',
    bone: '#eef9f2', bone2: '#cbe5d3', boneDim: '#89ab94', mute: '#4f7260',
    line: 'rgba(238, 249, 242, 0.07)', line2: 'rgba(238, 249, 242, 0.14)', line3: 'rgba(238, 249, 242, 0.24)',
    violet: '#059669', violet2: '#10b981', violet3: '#34d399', violet4: '#6ee7b7',
    magenta: '#14b8a6', plasma: '#2dd4bf',
    accent: '#10b981', accentRgb: '16, 185, 129',
    gradVio: 'linear-gradient(135deg, #059669 0%, #10b981 60%, #14b8a6 100%)',
    glow: '0 0 40px rgba(16, 185, 129, 0.55)',
    logoCBright: '#6ee7b7', logoCMid: '#10b981', logoCDeep: '#059669',
  },
};

const amberNight: ThemeVariant = {
  key: 'amber-night',
  label: 'Amber Night',
  mode: 'dark',
  logoPath: `${LOGO_BASE}/logo-amber-night.png`,
  preview: ['#fbbf24', '#f97316'],
  tokens: {
    background: '33 67% 6%',          // ~#1a1004
    foreground: '33 79% 96%',         // ~#fdf6ee
    card: '32 53% 10%',               // ~#261a08
    cardForeground: '33 79% 96%',
    primary: '38 92% 50%',            // #f59e0b
    primaryForeground: '0 0% 100%',
    secondary: '31 58% 13%',          // ~#34240e
    secondaryForeground: '33 79% 96%',
    muted: '31 58% 13%',
    mutedForeground: '33 22% 58%',
    accent: '38 92% 50%',
    accentForeground: '0 0% 100%',
    border: '31 24% 22%',
    input: '31 24% 22%',
    ring: '38 92% 50%',
    popover: '32 53% 10%',
    popoverForeground: '33 79% 96%',
  },
  legacy: {
    accentBlue: '#f59e0b',
    accentLight: 'rgba(245, 158, 11, 0.12)',
    accentHover: '#fbbf24',
    bgApp: '#1a1004',
    bgSurface: '#261a08',
    bgSurface2: '#34240e',
    textPrimary: '#fdf6ee',
    textSecondary: '#b09878',
    glassBg: 'rgba(38, 26, 8, 0.85)',
    glassBorder: 'rgba(245, 158, 11, 0.14)',
  },
  acufy: {
    ink: '#1a1004', ink2: '#261a08', ink3: '#34240e', ink4: '#453115',
    bone: '#fdf6ee', bone2: '#e8d8c4', boneDim: '#b09878', mute: '#7a6548',
    line: 'rgba(253, 246, 238, 0.07)', line2: 'rgba(253, 246, 238, 0.14)', line3: 'rgba(253, 246, 238, 0.24)',
    violet: '#d97706', violet2: '#f59e0b', violet3: '#fbbf24', violet4: '#fcd34d',
    magenta: '#f97316', plasma: '#fb923c',
    accent: '#f59e0b', accentRgb: '245, 158, 11',
    gradVio: 'linear-gradient(135deg, #d97706 0%, #f59e0b 60%, #f97316 100%)',
    glow: '0 0 40px rgba(245, 158, 11, 0.55)',
    logoCBright: '#fcd34d', logoCMid: '#f59e0b', logoCDeep: '#d97706',
  },
};

const cyanLight: ThemeVariant = {
  key: 'cyan-light',
  label: 'Cyan Mist',
  mode: 'light',
  logoPath: `${LOGO_BASE}/logo-cyan-light.png`,
  preview: ['#06b6d4', '#0891b2'],
  tokens: {
    background: '165 76% 97%',        // ~#f0fdfa
    foreground: '174 70% 13%',        // ~#0a3a36
    card: '0 0% 100%',
    cardForeground: '174 70% 13%',
    primary: '192 91% 37%',           // #0891b2
    primaryForeground: '0 0% 100%',
    secondary: '167 85% 89%',         // ~#ccfbf1
    secondaryForeground: '174 70% 13%',
    muted: '166 76% 94%',
    mutedForeground: '174 33% 35%',
    accent: '192 91% 37%',
    accentForeground: '0 0% 100%',
    border: '170 40% 80%',
    input: '170 40% 80%',
    ring: '192 91% 37%',
    popover: '0 0% 100%',
    popoverForeground: '174 70% 13%',
  },
  legacy: {
    accentBlue: '#0891b2',
    accentLight: 'rgba(8, 145, 178, 0.10)',
    accentHover: '#0e7490',
    bgApp: '#f0fdfa',
    bgSurface: '#ffffff',
    bgSurface2: '#ccfbf1',
    textPrimary: '#0a3a36',
    textSecondary: '#2d6b65',
    glassBg: 'rgba(255, 255, 255, 0.85)',
    glassBorder: 'rgba(8, 145, 178, 0.16)',
  },
  acufy: {
    ink: '#f0fdfa', ink2: '#ccfbf1', ink3: '#99f6e4', ink4: '#5eead4',
    bone: '#0a3a36', bone2: '#134e4a', boneDim: '#2d6b65', mute: '#4f857f',
    line: 'rgba(13, 60, 56, 0.16)', line2: 'rgba(13, 60, 56, 0.28)', line3: 'rgba(13, 60, 56, 0.42)',
    violet: '#0891b2', violet2: '#06b6d4', violet3: '#0e7490', violet4: '#0c5d72',
    magenta: '#0d9488', plasma: '#14b8a6',
    accent: '#0891b2', accentRgb: '8, 145, 178',
    gradVio: 'linear-gradient(135deg, #0e7490 0%, #0891b2 60%, #0d9488 100%)',
    glow: '0 0 40px rgba(8, 145, 178, 0.45)',
    logoCBright: '#67e8f9', logoCMid: '#06b6d4', logoCDeep: '#0e7490',
  },
};

const roseLight: ThemeVariant = {
  key: 'rose-light',
  label: 'Rose Dawn',
  mode: 'light',
  logoPath: `${LOGO_BASE}/logo-rose-light.png`,
  preview: ['#fb7185', '#e11d48'],
  tokens: {
    background: '354 100% 97%',       // ~#fff1f2
    foreground: '348 51% 16%',        // ~#3d141c
    card: '0 0% 100%',
    cardForeground: '348 51% 16%',
    primary: '348 83% 47%',           // #e11d48
    primaryForeground: '0 0% 100%',
    secondary: '352 96% 90%',         // ~#fecdd3
    secondaryForeground: '348 51% 16%',
    muted: '354 100% 95%',
    mutedForeground: '348 30% 38%',
    accent: '348 83% 47%',
    accentForeground: '0 0% 100%',
    border: '352 50% 82%',
    input: '352 50% 82%',
    ring: '348 83% 47%',
    popover: '0 0% 100%',
    popoverForeground: '348 51% 16%',
  },
  legacy: {
    accentBlue: '#e11d48',
    accentLight: 'rgba(225, 29, 72, 0.10)',
    accentHover: '#be123c',
    bgApp: '#fff1f2',
    bgSurface: '#ffffff',
    bgSurface2: '#fecdd3',
    textPrimary: '#3d141c',
    textSecondary: '#7a3a4c',
    glassBg: 'rgba(255, 255, 255, 0.85)',
    glassBorder: 'rgba(225, 29, 72, 0.16)',
  },
  acufy: {
    ink: '#fff1f2', ink2: '#fecdd3', ink3: '#fda4af', ink4: '#fb7185',
    bone: '#3d141c', bone2: '#4c1d27', boneDim: '#7a3a4c', mute: '#a35a73',
    line: 'rgba(76, 29, 39, 0.16)', line2: 'rgba(76, 29, 39, 0.28)', line3: 'rgba(76, 29, 39, 0.42)',
    violet: '#be123c', violet2: '#e11d48', violet3: '#9f1239', violet4: '#881337',
    magenta: '#f43f5e', plasma: '#fb7185',
    accent: '#e11d48', accentRgb: '225, 29, 72',
    gradVio: 'linear-gradient(135deg, #9f1239 0%, #e11d48 60%, #f43f5e 100%)',
    glow: '0 0 40px rgba(225, 29, 72, 0.45)',
    logoCBright: '#fda4af', logoCMid: '#f43f5e', logoCDeep: '#881337',
  },
};

const sapphireLight: ThemeVariant = {
  key: 'sapphire-light',
  label: 'Sapphire Cloud',
  mode: 'light',
  logoPath: `${LOGO_BASE}/logo-sapphire-light.png`,
  preview: ['#3b82f6', '#6366f1'],
  tokens: {
    background: '214 100% 97%',       // ~#eff6ff
    foreground: '220 49% 16%',        // ~#15213d
    card: '0 0% 100%',
    cardForeground: '220 49% 16%',
    primary: '243 75% 59%',           // #4f46e5
    primaryForeground: '0 0% 100%',
    secondary: '214 95% 87%',         // ~#bfdbfe
    secondaryForeground: '220 49% 16%',
    muted: '214 100% 95%',
    mutedForeground: '220 27% 40%',
    accent: '243 75% 59%',
    accentForeground: '0 0% 100%',
    border: '214 40% 80%',
    input: '214 40% 80%',
    ring: '243 75% 59%',
    popover: '0 0% 100%',
    popoverForeground: '220 49% 16%',
  },
  legacy: {
    accentBlue: '#4f46e5',
    accentLight: 'rgba(79, 70, 229, 0.10)',
    accentHover: '#4338ca',
    bgApp: '#eff6ff',
    bgSurface: '#ffffff',
    bgSurface2: '#bfdbfe',
    textPrimary: '#15213d',
    textSecondary: '#475573',
    glassBg: 'rgba(255, 255, 255, 0.85)',
    glassBorder: 'rgba(79, 70, 229, 0.16)',
  },
  acufy: {
    ink: '#eff6ff', ink2: '#bfdbfe', ink3: '#93c5fd', ink4: '#60a5fa',
    bone: '#15213d', bone2: '#1e2a4a', boneDim: '#475573', mute: '#6b7d9a',
    line: 'rgba(30, 42, 74, 0.16)', line2: 'rgba(30, 42, 74, 0.28)', line3: 'rgba(30, 42, 74, 0.42)',
    violet: '#4338ca', violet2: '#4f46e5', violet3: '#3730a3', violet4: '#312e81',
    magenta: '#2563eb', plasma: '#3b82f6',
    accent: '#4f46e5', accentRgb: '79, 70, 229',
    gradVio: 'linear-gradient(135deg, #3730a3 0%, #4f46e5 60%, #2563eb 100%)',
    glow: '0 0 40px rgba(79, 70, 229, 0.45)',
    logoCBright: '#a5b4fc', logoCMid: '#4f46e5', logoCDeep: '#312e81',
  },
};

export const THEME_VARIANTS: Record<ThemeVariantKey, ThemeVariant> = {
  'violet-night': violetNight,
  'emerald-night': emeraldNight,
  'amber-night': amberNight,
  'cyan-light': cyanLight,
  'rose-light': roseLight,
  'sapphire-light': sapphireLight,
};

export const THEME_VARIANT_ORDER: ThemeVariantKey[] = [
  'violet-night',
  'emerald-night',
  'amber-night',
  'cyan-light',
  'rose-light',
  'sapphire-light',
];

export function applyThemeVariant(variant: ThemeVariant) {
  const root = document.documentElement;

  // dark/light class (backwards compat for shadcn dark-mode utilities)
  root.classList.remove('light', 'dark');
  root.classList.add(variant.mode);
  // data-theme attribute (so any `[data-theme="..."]` selectors fire too)
  root.setAttribute('data-theme', variant.key);
  // color-scheme so the browser paints NATIVE controls (select dropdown panels,
  // scrollbars, date pickers) to match the theme. Without this, dark themes get
  // a white native <select> dropdown with near-invisible white option text.
  root.style.colorScheme = variant.mode;

  const t = variant.tokens;
  root.style.setProperty('--background', t.background);
  root.style.setProperty('--foreground', t.foreground);
  root.style.setProperty('--card', t.card);
  root.style.setProperty('--card-foreground', t.cardForeground);
  root.style.setProperty('--primary', t.primary);
  root.style.setProperty('--primary-foreground', t.primaryForeground);
  root.style.setProperty('--secondary', t.secondary);
  root.style.setProperty('--secondary-foreground', t.secondaryForeground);
  root.style.setProperty('--muted', t.muted);
  root.style.setProperty('--muted-foreground', t.mutedForeground);
  root.style.setProperty('--accent', t.accent);
  root.style.setProperty('--accent-foreground', t.accentForeground);
  root.style.setProperty('--border', t.border);
  root.style.setProperty('--input', t.input);
  root.style.setProperty('--ring', t.ring);
  root.style.setProperty('--popover', t.popover);
  root.style.setProperty('--popover-foreground', t.popoverForeground);
  // Destructive is a semantic danger color, kept consistent (rose-600) across
  // every theme. The variants don't define it, so set it explicitly here —
  // otherwise a themed view can leave --destructive unset/stale and destructive
  // buttons (Suspend / Archive / delete confirms) render pale instead of red.
  root.style.setProperty('--destructive', t.destructive ?? '347 77% 50%');
  root.style.setProperty('--destructive-foreground', t.destructiveForeground ?? '0 0% 100%');

  const l = variant.legacy;
  root.style.setProperty('--accent-blue', l.accentBlue);
  root.style.setProperty('--accent-light', l.accentLight);
  root.style.setProperty('--accent-hover', l.accentHover);
  root.style.setProperty('--bg-app', l.bgApp);
  root.style.setProperty('--bg-surface', l.bgSurface);
  root.style.setProperty('--bg-surface-2', l.bgSurface2);
  root.style.setProperty('--text-primary', l.textPrimary);
  root.style.setProperty('--text-secondary', l.textSecondary);
  root.style.setProperty('--glass-bg', l.glassBg);
  root.style.setProperty('--glass-border', l.glassBorder);

  const a = variant.acufy;
  root.style.setProperty('--ink', a.ink);
  root.style.setProperty('--ink-2', a.ink2);
  root.style.setProperty('--ink-3', a.ink3);
  root.style.setProperty('--ink-4', a.ink4);
  root.style.setProperty('--bone', a.bone);
  root.style.setProperty('--bone-2', a.bone2);
  root.style.setProperty('--bone-dim', a.boneDim);
  root.style.setProperty('--mute', a.mute);
  root.style.setProperty('--line', a.line);
  root.style.setProperty('--line-2', a.line2);
  root.style.setProperty('--line-3', a.line3);
  root.style.setProperty('--violet', a.violet);
  root.style.setProperty('--violet-2', a.violet2);
  root.style.setProperty('--violet-3', a.violet3);
  root.style.setProperty('--violet-4', a.violet4);
  root.style.setProperty('--magenta', a.magenta);
  root.style.setProperty('--plasma', a.plasma);
  root.style.setProperty('--accent-named', a.accent);
  root.style.setProperty('--accent-rgb', a.accentRgb);
  root.style.setProperty('--grad-vio', a.gradVio);
  root.style.setProperty('--glow', a.glow);
  root.style.setProperty('--logo-c-bright', a.logoCBright);
  root.style.setProperty('--logo-c-mid', a.logoCMid);
  root.style.setProperty('--logo-c-deep', a.logoCDeep);

  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) metaThemeColor.setAttribute('content', l.bgApp);
}
