import React, { useState } from 'react';
import { SettingsSidebar, SettingsContent } from '@/components/settings';

export const AdminSettingsPage: React.FC = () => {
  const [activeSection, setActiveSection] = useState(() => {
    const hash = window.location.hash.replace('#', '');
    return hash || 'time-entry';
  });

  const handleChange = (key: string) => {
    setActiveSection(key);
    window.location.hash = key;
  };

  return (
    <>
      {/* ``top`` matches frontend2's TopNavBar height (96px). When the
          topbar height changes, update here too — otherwise the
          Settings sidebar's "Settings / Tenant-wide policies" heading
          slides under the nav and gets clipped. */}
      <div className="fixed inset-x-0 bottom-0 top-[96px] flex bg-background z-10 border-t border-border/50">
        <SettingsSidebar activeSection={activeSection} onChange={handleChange} />
        <SettingsContent activeSection={activeSection} />
      </div>
    </>
  );
};
