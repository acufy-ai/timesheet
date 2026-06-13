import React from 'react';
import { LayoutGrid, Palette, SlidersHorizontal } from 'lucide-react';

import { SectionWrapper, IconCard, SettingsSaveBar } from '../SettingsPrimitives';
import { SettingField } from '@/components/TenantSettingsForm';
import { useSettingsDraft } from '@/hooks/useSettingsDraft';

// Team-wide UI/UX defaults and the navigation-switch policy. Mirrors the
// hand-built draft pattern used by Reminders/Notifications: each field renders
// through the shared ``SettingField`` (so the catalog widgets and validation
// stay in one place) and the whole section saves through one admin-gated
// "Save changes" bar.
export const CustomizationSettings: React.FC = () => {
  const draft = useSettingsDraft();

  if (draft.isLoading) {
    return (
      <SectionWrapper title="Customization" desc="Set the default look and navigation for everyone on the team.">
        <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          Loading settings…
        </div>
      </SectionWrapper>
    );
  }
  if (draft.isError) {
    return (
      <SectionWrapper title="Customization" desc="Set the default look and navigation for everyone on the team.">
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

  // When switching is allowed for everyone, the exception list has no effect.
  // Surface that so admins aren't confused about why their picks do nothing.
  const switchEnabled = Boolean(
    draft.draft['nav_switch_enabled'] ??
      draft.catalogByKey.get('nav_switch_enabled')?.default_value,
  );

  return (
    <SectionWrapper title="Customization" desc="Set the default look and navigation for everyone on the team. New users start from these; users who are allowed to switch can change their own.">
      {draft.errors.__form && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm text-destructive">
          {draft.errors.__form}
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <IconCard
          icon={<LayoutGrid className="h-5 w-5" />}
          title="Navigation"
          desc="The default navigation layout and who may change their own."
        >
          {renderField('default_nav_layout')}
          {renderField('nav_switch_enabled')}
          <div className={switchEnabled ? 'opacity-60' : ''}>
            {renderField('nav_switch_user_ids')}
            {switchEnabled && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                Switching is currently allowed for everyone, so these exceptions have no effect. Turn off the switch above to lock the layout, then list the users who may still change their own.
              </p>
            )}
          </div>
        </IconCard>

        <IconCard
          icon={<Palette className="h-5 w-5" />}
          title="Appearance"
          desc="The theme and color palette new users start with."
        >
          {renderField('default_theme')}
          {renderField('default_palette')}
        </IconCard>

        <IconCard
          icon={<SlidersHorizontal className="h-5 w-5" />}
          title="Workspace defaults"
          desc="Where new users land and how much they see per page."
        >
          {renderField('default_landing')}
          {renderField('default_page_size')}
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
