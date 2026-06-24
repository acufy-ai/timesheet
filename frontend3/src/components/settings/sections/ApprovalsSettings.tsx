import React from 'react';
import { CheckCircle2 } from 'lucide-react';

import { SectionWrapper, IconCard, SettingsSaveBar } from '@/components/settings/SettingsPrimitives';
import { SettingField } from '@/components/TenantSettingsForm';
import { useSettingsDraft } from '@/hooks/useSettingsDraft';

// Approval policy. Currently one toggle: multi-manager / per-entry routing.
// When off (default), an employee's reporting manager approves all of their
// entries as one weekly batch. When on, an employee can report to multiple
// managers and each entry is approved by the manager it was submitted to.
export const ApprovalsSettings: React.FC = () => {
  const draft = useSettingsDraft();

  const header = {
    title: 'Approvals',
    desc: 'Control how time entries are routed for approval.',
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
        icon={<CheckCircle2 className="h-5 w-5" />}
        title="Approval routing"
        desc="Who reviews an employee's time, and whether a week can be split across managers."
      >
        {renderField('approval_by_assigned_manager')}
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
