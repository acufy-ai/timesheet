import React from 'react';
import { Users, Briefcase, Clock } from 'lucide-react';

import { SectionWrapper, IconCard, SettingsSaveBar } from '../SettingsPrimitives';
import { SettingField } from '@/components/TenantSettingsForm';
import { useSettingsDraft } from '@/hooks';
import type { SettingDefinition } from '@/api/endpoints';

// Hand-built two-card layout for Reminders. Each field renders through
// the shared ``SettingField`` so validation / widget machinery stays in
// one place; only the visual shell here is bespoke.
export const RemindersSettings: React.FC = () => {
  const draft = useSettingsDraft();

  if (draft.isLoading) {
    return (
      <SectionWrapper title="Reminders" desc="Automated deadline reminders for employees and contractors.">
        <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          Loading settings…
        </div>
      </SectionWrapper>
    );
  }
  if (draft.isError) {
    return (
      <SectionWrapper title="Reminders" desc="Automated deadline reminders for employees and contractors.">
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
    <SectionWrapper title="Reminders" desc="Automated deadline reminders for employees and contractors.">
      {draft.errors.__form && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm text-destructive">
          {draft.errors.__form}
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <IconCard
          icon={<Users className="h-5 w-5" />}
          title="Employee reminders"
          desc="Submission cadence drives both reminders and the manager dashboard's late signal."
        >
          {renderField('submission_cadence_internal')}
          {renderField('reminder_internal_enabled')}
          {renderField('reminder_internal_deadline_day')}
          {renderField('reminder_internal_deadline_time')}
          {renderField('reminder_internal_recipients')}
          {renderField('reminder_internal_lock_enabled')}
        </IconCard>
        <IconCard
          icon={<Briefcase className="h-5 w-5" />}
          title="Contractor reminders"
          desc="Send monthly reminders to external contractors."
        >
          {renderField('submission_cadence_external')}
          {renderField('reminder_external_enabled')}
          {renderField('reminder_external_deadline_day_of_month')}
          {renderField('reminder_external_deadline_time')}
        </IconCard>
        <IconCard
          icon={<Clock className="h-5 w-5" />}
          title="Late signal"
          desc="How many business days after the deadline before a user is flagged late on the manager dashboard."
        >
          {renderField('late_grace_business_days')}
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

// Type guard placeholder so the file stays self-contained if the catalog
// ever returns an unexpected shape.
export type _RemindersDefinition = SettingDefinition;
