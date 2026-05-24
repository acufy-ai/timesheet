import React from 'react';

// Switches to the legacy UI (frontend). When both UIs are served under
// the same origin (frontend2 at "/", frontend at "/legacy/"),
// sessionStorage tokens are already shared, so we just do a hard nav.
// The receiving AuthContext on the other side picks up the token from
// sessionStorage and resumes the session.
//
// Override at build time with VITE_FRONTEND_OTHER_PATH if the legacy UI
// lives at a different path. Override with VITE_FRONTEND_OTHER_URL to
// hop across origins (dev mode, where the two run on different ports).
//
// VITE_FRONTEND_OTHER_LABEL controls the button copy ("Classic UI" by
// default for the new-UI side, "New UI" on the legacy side).

const OTHER_URL = import.meta.env.VITE_FRONTEND_OTHER_URL || '';
const OTHER_PATH = (import.meta.env.VITE_FRONTEND_OTHER_PATH || '/legacy/').replace(/\/+$/, '/');
const OTHER_LABEL = import.meta.env.VITE_FRONTEND_OTHER_LABEL || 'Classic UI';

export const FrontendSwitcher: React.FC = () => {
  const handleSwitch = () => {
    // Carry the current in-app path across so users land on the same
    // screen on the other side. Strip the current basename (Vite's
    // BASE_URL) so we don't double-prefix.
    const baseUrl = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '/');
    let suffix = window.location.pathname + window.location.search;
    if (baseUrl !== '/' && suffix.startsWith(baseUrl)) {
      suffix = suffix.slice(baseUrl.length - 1);
    }
    // suffix now starts with "/" relative to the OTHER app's basename.
    const cleanSuffix = suffix.startsWith('/') ? suffix.slice(1) : suffix;

    if (OTHER_URL) {
      // Cross-origin (dev). Use the fragment handoff to carry tokens.
      const accessToken = sessionStorage.getItem('accessToken') || '';
      const refreshToken = sessionStorage.getItem('refreshToken') || '';
      const themeVariant = localStorage.getItem('themeVariant') || '';
      const payload = { accessToken, refreshToken, themeVariant, path: suffix };
      const fragment = encodeURIComponent(btoa(JSON.stringify(payload)));
      window.location.href = `${OTHER_URL.replace(/\/$/, '')}/#handoff=${fragment}`;
      return;
    }

    // Same-origin. sessionStorage persists across the nav; no fragment
    // needed. Append the current path under the other basename so the
    // user lands on the equivalent route in the other UI.
    window.location.href = `${OTHER_PATH}${cleanSuffix}`;
  };

  return (
    <button
      type="button"
      onClick={handleSwitch}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
      title={`Switch to ${OTHER_LABEL}`}
    >
      <span aria-hidden>⇄</span>
      <span className="hidden sm:inline">{OTHER_LABEL}</span>
    </button>
  );
};
