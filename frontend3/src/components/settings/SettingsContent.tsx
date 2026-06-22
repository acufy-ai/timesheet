import React from 'react';
import { TimeEntrySettings } from './sections/TimeEntrySettings';
import { TimeOffPolicySettings } from './sections/TimeOffPolicySettings';
import { SecuritySettings } from './sections/SecuritySettings';
import { RemindersSettings } from './sections/RemindersSettings';
import { NotificationsSettings } from './sections/NotificationsSettings';
import { OutboundEmailSettings } from './sections/OutboundEmailSettings';
import { MailboxesSettings } from './sections/MailboxesSettings';
import { EmailTemplateSettings } from './sections/EmailTemplateSettings';
import { BrandingSettings } from './sections/BrandingSettings';
import { CustomizationSettings } from './sections/CustomizationSettings';
import { ClientPortalSettings } from './sections/ClientPortalSettings';

// Legacy ``email-smtp`` aliases ``outbound-email``: the standalone
// Email / SMTP page used to show the same SMTP credentials that Outbound
// Email now manages inline. Keeping the alias so old bookmarks land in
// the right place instead of falling back to Time entry.
const sectionMap: Record<string, React.FC> = {
  'time-entry':      TimeEntrySettings,
  'timeoff-policy':  TimeOffPolicySettings,
  'security':        SecuritySettings,
  'reminders':       RemindersSettings,
  'notifications':   NotificationsSettings,
  'outbound-email':  OutboundEmailSettings,
  'email-smtp':      OutboundEmailSettings,
  'mailboxes':       MailboxesSettings,
  'email-templates': EmailTemplateSettings,
  'branding':        BrandingSettings,
  'customization':   CustomizationSettings,
  'client-portal':   ClientPortalSettings,
};

interface Props {
  activeSection: string;
}

export const SettingsContent: React.FC<Props> = ({ activeSection }) => {
  const ActiveComponent = sectionMap[activeSection] ?? TimeEntrySettings;
  return (
    <div className="flex-1 overflow-y-auto p-6 lg:p-7">
      <ActiveComponent />
    </div>
  );
};
