import React from 'react';
import { TenantSettingsForm } from '@/components/TenantSettingsForm';
import { SectionWrapper } from '@/components/settings/SettingsPrimitives';

export const SecuritySettings: React.FC = () => (
  <SectionWrapper title="Security" desc="Sign-in session length and account lockout after repeated failed attempts.">
    <TenantSettingsForm filterCategories={['security']} showHeader={false} />
  </SectionWrapper>
);
