// Shared draft-state for the redesigned settings cards (Reminders,
// Notifications) so each panel can render hand-built layouts while still
// flowing through the catalog hooks and save mutation that the legacy
// TenantSettingsForm uses. Returns the catalog, the working draft, a
// setter, and the dirty/save/reset machinery.
import { useEffect, useMemo, useState } from 'react';

import {
  useTenantSettings,
  useTenantSettingsCatalog,
  useUpdateTenantSettings,
} from '@/hooks/useAdmin';
import type { SettingDefinition, SettingValue } from '@/types/admin';

export type SaveFlash = 'idle' | 'saved' | 'error';

export interface UseSettingsDraftResult {
  catalog: SettingDefinition[];
  catalogByKey: Map<string, SettingDefinition>;
  draft: Record<string, SettingValue>;
  setValue: (key: string, value: SettingValue) => void;
  errors: Record<string, string | undefined>;
  isLoading: boolean;
  isError: boolean;
  isDirty: boolean;
  isSaving: boolean;
  saveFlash: SaveFlash;
  save: () => Promise<void>;
  discard: () => void;
}

export const useSettingsDraft = (): UseSettingsDraftResult => {
  const catalogQuery = useTenantSettingsCatalog();
  const valuesQuery = useTenantSettings();
  const updateMutation = useUpdateTenantSettings();

  const [draft, setDraft] = useState<Record<string, SettingValue>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [saveFlash, setSaveFlash] = useState<SaveFlash>('idle');

  useEffect(() => {
    if (valuesQuery.data) {
      setDraft((existing) => ({ ...valuesQuery.data, ...existing }));
    }
    // Only seed once per response; don't fight user edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valuesQuery.data]);

  const catalog = useMemo(() => catalogQuery.data ?? [], [catalogQuery.data]);
  const catalogByKey = useMemo(() => {
    const m = new Map<string, SettingDefinition>();
    for (const d of catalog) m.set(d.key, d);
    return m;
  }, [catalog]);

  const setValue = (key: string, value: SettingValue) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const server = valuesQuery.data ?? {};
  const isDirty = Object.entries(draft).some(
    ([k, v]) => JSON.stringify(v) !== JSON.stringify(server[k]),
  );

  const save = async () => {
    const payload: Record<string, SettingValue> = {};
    for (const [k, v] of Object.entries(draft)) {
      if (JSON.stringify(v) !== JSON.stringify(server[k])) payload[k] = v;
    }
    if (Object.keys(payload).length === 0) {
      setSaveFlash('saved');
      window.setTimeout(() => setSaveFlash('idle'), 2000);
      return;
    }
    try {
      await updateMutation.mutateAsync(payload);
      setErrors({});
      setSaveFlash('saved');
      window.setTimeout(() => setSaveFlash('idle'), 2000);
    } catch (exc: unknown) {
      const detail =
        (exc as { response?: { data?: { detail?: string } } })?.response?.data?.detail
          ?? 'Save failed.';
      setErrors({ __form: detail });
      setSaveFlash('error');
      window.setTimeout(() => setSaveFlash('idle'), 4000);
    }
  };

  const discard = () => {
    setDraft({ ...(valuesQuery.data ?? {}) });
    setErrors({});
  };

  return {
    catalog,
    catalogByKey,
    draft,
    setValue,
    errors,
    isLoading: catalogQuery.isLoading || valuesQuery.isLoading,
    isError: catalogQuery.isError,
    isDirty,
    isSaving: updateMutation.isPending,
    saveFlash,
    save,
    discard,
  };
};
