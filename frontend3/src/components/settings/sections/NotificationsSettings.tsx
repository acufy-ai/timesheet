import React from 'react';
import { Bell, Clock } from 'lucide-react';

import { SectionWrapper, IconCard, SettingsSaveBar } from '@/components/settings/SettingsPrimitives';
import { SettingField } from '@/components/TenantSettingsForm';
import { useSettingsDraft } from '@/hooks/useSettingsDraft';

// Hand-built two-card layout for Notifications. Mirrors the Reminders
// section: left card holds retention/history (calmer infra-style
// preferences), right card holds alert timing (when reminders fire).
export const NotificationsSettings: React.FC = () => {
  const draft = useSettingsDraft();

  if (draft.isLoading) {
    return (
      <SectionWrapper
        title="Notifications"
        desc="Configure notification retention, approval history, and alert timing."
      >
        <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          Loading settings…
        </div>
      </SectionWrapper>
    );
  }
  if (draft.isError) {
    return (
      <SectionWrapper
        title="Notifications"
        desc="Configure notification retention, approval history, and alert timing."
      >
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
          Failed to load the settings catalog. Refresh to retry.
        </div>
      </SectionWrapper>
    );
  }

  const renderField = (key: string) => {
    const defn = draft.catalogByKey.get(key);
    if (!defn) return null;
    return (
      <SettingField
        key={defn.key}
        defn={defn}
        value={draft.draft[defn.key] ?? defn.default_value}
        onChange={(v) => draft.setValue(defn.key, v)}
        error={draft.errors[defn.key]}
      />
    );
  };

  return (
    <SectionWrapper
      title="Notifications"
      desc="Configure notification retention, approval history, and alert timing."
    >
      {draft.errors.__form && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm text-destructive">
          {draft.errors.__form}
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <IconCard
          icon={<Bell className="h-5 w-5" />}
          title="Notification settings"
          desc="How long notifications and approval history stay visible."
        >
          {renderField('notification_ttl_days')}
          {renderField('approval_history_ttl_days')}
        </IconCard>
        <IconCard
          icon={<Clock className="h-5 w-5" />}
          title="Alert timing"
          desc="When alerts and reminders are triggered."
        >
          {renderField('daily_submission_deadline_time')}
          {renderField('missing_yesterday_notify_after_hour')}
          {renderField('manager_missing_team_notify_after_hour')}
        </IconCard>
      </div>
      <SettingsSaveBar
        isDirty={draft.isDirty}
        isSaving={draft.isSaving}
        saveFlash={draft.saveFlash}
        onSave={draft.save}
        onDiscard={draft.discard}
      />
    </SectionWrapper>
  );
};
