import React from 'react';

// Switches to the new UI (frontend2). When both UIs are served under
// the same origin (frontend2 at "/", frontend at "/legacy/"),
// sessionStorage tokens are already shared, so we just do a hard nav.
// The receiving AuthContext on the other side picks up the token from
// sessionStorage and resumes the session.
//
// Override at build time with VITE_FRONTEND_OTHER_PATH if the new UI
// lives at a different path. Override with VITE_FRONTEND_OTHER_URL to
// hop across origins (dev mode, where the two run on different ports).
//
// VITE_FRONTEND_OTHER_LABEL controls the button copy.

const OTHER_URL = import.meta.env.VITE_FRONTEND_OTHER_URL || '';
const OTHER_PATH = (import.meta.env.VITE_FRONTEND_OTHER_PATH || '/').replace(/\/+$/, '/');
const OTHER_LABEL = import.meta.env.VITE_FRONTEND_OTHER_LABEL || 'New UI';

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

    // Same-origin. sessionStorage persists across the nav.
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
