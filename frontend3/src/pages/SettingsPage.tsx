import { useState } from 'react';

import { SettingsSidebar } from '@/components/settings/SettingsSidebar';
import { SettingsContent } from '@/components/settings/SettingsContent';

// Settings page (ported to match frontend2): a grouped left sidebar
// (Time management / Access & security / Notifications / Integrations /
// Branding) + a content pane that renders the active section component.
// Mailboxes lives under Integrations, not the top nav. The active section is
// driven by the URL hash so deep links (e.g. #mailboxes) land correctly.
export function SettingsPage() {
  const [activeSection, setActiveSection] = useState(() => {
    const hash = window.location.hash.replace('#', '');
    return hash || 'time-entry';
  });

  const handleChange = (key: string) => {
    setActiveSection(key);
    window.location.hash = key;
  };

  return (
    <div className="flex min-h-[calc(100vh-9rem)] overflow-hidden rounded-2xl border border-border bg-background">
      <SettingsSidebar activeSection={activeSection} onChange={handleChange} />
      <SettingsContent activeSection={activeSection} />
    </div>
  );
}
