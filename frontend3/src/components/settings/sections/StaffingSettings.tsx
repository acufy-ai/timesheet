import React from 'react';
import { Users } from 'lucide-react';

import { SectionWrapper, IconCard, SettingsSaveBar } from '@/components/settings/SettingsPrimitives';
import { SettingField } from '@/components/TenantSettingsForm';
import { useSettingsDraft } from '@/hooks/useSettingsDraft';

// Staffing policy. Currently one toggle: cross-team staffing. When off (the
// default), project teams and task assignees are limited to the project
// manager's own direct reports. When on, the pool widens to the client's whole
// management chain + their reports. The per-manager exception list
// (cross_team_staffing_user_ids) is seeded but not surfaced here yet.
export const StaffingSettings: React.FC = () => {
  const draft = useSettingsDraft();

  const header = {
    title: 'Staffing',
    desc: 'Control who can be staffed onto projects and tasks.',
  };

  if (draft.isLoading) {
    return (
      <SectionWrapper {...header}>
        <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">Loading settings…</div>
      </SectionWrapper>
    );
  }
  if (draft.isError) {
    return (
      <SectionWrapper {...header}>
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
    <SectionWrapper {...header}>
      {draft.errors.__form && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm text-destructive">
          {draft.errors.__form}
        </div>
      )}
      <IconCard
        icon={<Users className="h-5 w-5" />}
        title="Project &amp; task staffing"
        desc="Who shows up when assigning people to projects and tasks."
      >
        {renderField('allow_cross_team_staffing')}
      </IconCard>
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
