import React from 'react';
import { TenantSettingsForm } from '@/components/TenantSettingsForm';
import { SectionWrapper } from '@/components/settings/SettingsPrimitives';

// Tenant-admin kill switch for the Client Portal. When off, no client account
// can sign in and no grant is active, regardless of per-project toggles.
export const ClientPortalSettings: React.FC = () => (
  <SectionWrapper
    title="Client portal"
    desc="Let external client users sign in and see projects/tasks shared with them. Managers grant access per project on the Clients page; this is the workspace-wide master switch."
  >
    <TenantSettingsForm filterCategories={['client_portal']} showHeader={false} />
  </SectionWrapper>
);
