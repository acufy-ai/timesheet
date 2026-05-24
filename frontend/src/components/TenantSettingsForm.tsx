// Catalog-driven tenant-settings form. Renders setting_definitions
// from the backend and writes via PATCH /users/tenant-settings.
import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

import {
  useTenantSettings,
  useTenantSettingsCatalog,
  useUpdateTenantSettings,
  useUsers,
} from '@/hooks';
import type { SettingDefinition, SettingValue } from '@/api/endpoints';

// Categories rendered in this order; any category returned by the backend
// that isn't listed here appears at the end, unordered.
const CATEGORY_ORDER: Array<{ key: string; label: string }> = [
  { key: 'time_entry', label: 'Time entry' },
  { key: 'time_off', label: 'Time off' },
  { key: 'security', label: 'Security' },
  { key: 'reminders', label: 'Reminders' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'email', label: 'Email / SMTP' },
];

// ``smtp_password`` has its own dedicated (encrypted) entry flow elsewhere
// in the admin UI. Skip rendering it here so operators don't accidentally
// overwrite a stored secret with the catalog default (empty string) by
// clicking Save without touching the field.
const SKIP_KEYS = new Set<string>([
  'smtp_password',
  // Rendered separately in the OutboundEmailSettings section so it can
  // show as 3 radios with friendly labels (not the raw enum values)
  // and be gated by the custom_outbound_email feature flag.
  'outbound_email_source',
  // Rendered in the dedicated Email templates section (EmailTemplateSettings).
  'invite_email_subject',
  'invite_email_greeting',
  'invite_email_body',
  'invite_email_button_label',
  'invite_email_signoff',
  'reset_email_subject',
  'reset_email_greeting',
  'reset_email_body',
  'reset_email_button_label',
  'reset_email_signoff',
]);

type Errors = Record<string, string | undefined>;

// Keys that are credentials for the custom SMTP path; dimmed when custom_smtp
// is not the active outbound source so operators don't fill them in pointlessly.
const SMTP_CREDENTIAL_KEYS = new Set([
  'smtp_host', 'smtp_port', 'smtp_username', 'smtp_password',
  'smtp_from_address', 'smtp_from_name', 'smtp_use_tls',
]);

interface TenantSettingsFormProps {
  filterCategories?: string[];
  showHeader?: boolean;
  disableSmtpCredentials?: boolean;
}

export const TenantSettingsForm: React.FC<TenantSettingsFormProps> = ({
  filterCategories,
  showHeader = true,
  disableSmtpCredentials = false,
}) => {
  const catalogQuery = useTenantSettingsCatalog();
  const valuesQuery = useTenantSettings();
  const updateMutation = useUpdateTenantSettings();

  // Local working copy of the form values. Keyed by setting key.
  const [draft, setDraft] = useState<Record<string, SettingValue>>({});
  const [errors, setErrors] = useState<Errors>({});
  const [saveFlash, setSaveFlash] = useState<'idle' | 'saved' | 'error'>('idle');

  // Seed the draft from the server values whenever they change.
  useEffect(() => {
    if (valuesQuery.data) {
      setDraft((existing) => ({ ...valuesQuery.data, ...existing }));
    }
    // Only seed once per response; don't fight user edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valuesQuery.data]);

  const grouped = useMemo(() => {
    const catalog = catalogQuery.data ?? [];
    const byCategory = new Map<string, SettingDefinition[]>();
    for (const defn of catalog) {
      if (SKIP_KEYS.has(defn.key)) continue;
      if (filterCategories && !filterCategories.includes(defn.category)) continue;
      const list = byCategory.get(defn.category) ?? [];
      list.push(defn);
      byCategory.set(defn.category, list);
    }
    for (const list of byCategory.values()) {
      list.sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key));
    }
    const ordered = CATEGORY_ORDER
      .filter((c) => byCategory.has(c.key))
      .map((c) => ({ label: c.label, defs: byCategory.get(c.key)! }));
    // Trailing "unknown" categories -- shouldn't happen in practice but keep
    // the UI graceful if a new category is added server-side before the
    // frontend is updated.
    const knownKeys = new Set(CATEGORY_ORDER.map((c) => c.key));
    for (const [key, defs] of byCategory.entries()) {
      if (!knownKeys.has(key)) ordered.push({ label: key, defs });
    }
    return ordered;
  }, [catalogQuery.data, filterCategories]);

  if (catalogQuery.isLoading || valuesQuery.isLoading) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        Loading settings catalog…
      </div>
    );
  }

  if (catalogQuery.isError) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
        Failed to load the settings catalog. Refresh to retry.
      </div>
    );
  }

  const setValue = (key: string, value: SettingValue) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const handleSave = async () => {
    // Only send keys whose value differs from the server snapshot.
    const server = valuesQuery.data ?? {};
    const payload: Record<string, SettingValue> = {};
    for (const [k, v] of Object.entries(draft)) {
      if (SKIP_KEYS.has(k)) continue;
      if (JSON.stringify(v) !== JSON.stringify(server[k])) {
        payload[k] = v;
      }
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
      // Server returns 422 with a per-key-or-general detail string.
      const detail =
        (exc as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Save failed.';
      // We don't know which key failed from the detail alone — surface a
      // form-level error.
      setErrors({ __form: detail });
      setSaveFlash('error');
      window.setTimeout(() => setSaveFlash('idle'), 4000);
    }
  };

  // The "dirty" flag drives the sticky save bar visibility. It compares each
  // draft value to the server snapshot using JSON equality (cheap, covers
  // arrays/objects that may appear in catalog-driven settings).
  const server = valuesQuery.data ?? {};
  const isDirty = Object.entries(draft).some(([k, v]) => {
    if (SKIP_KEYS.has(k)) return false;
    return JSON.stringify(v) !== JSON.stringify(server[k]);
  });
  const handleReset = () => {
    setDraft({ ...(valuesQuery.data ?? {}) });
    setErrors({});
  };

  return (
    <div className="rounded-lg border border-border bg-card">
      {showHeader && (
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">
            All settings (catalog-driven)
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Every tenant setting, rendered from the server catalog. Fields are validated server-side when you save.
          </p>
        </div>
      )}

      {errors.__form && (
        <div className="border-b border-destructive/40 bg-destructive/5 px-4 py-2 text-sm text-destructive">
          {errors.__form}
        </div>
      )}

      <div className="divide-y divide-border">
        {grouped.map((group) => (
          <section key={group.label} className="px-4 py-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              {group.label}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
              {group.defs.map((defn) => (
                <SettingField
                  key={defn.key}
                  defn={defn}
                  value={draft[defn.key] ?? defn.default_value}
                  onChange={(v) => setValue(defn.key, v)}
                  error={errors[defn.key]}
                  disabled={disableSmtpCredentials && SMTP_CREDENTIAL_KEYS.has(defn.key)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* Sticky save bar. Appears only when the form is dirty, never when
          there's nothing to save. Replaces the always-rendered empty header
          card that wasted ~70px on every settings sub-page. */}
      {(isDirty || saveFlash !== 'idle') && (
        <div className="sticky bottom-0 z-10 flex items-center justify-end gap-2 border-t border-border bg-card/95 backdrop-blur px-4 py-3">
          <span className="mr-auto text-xs text-muted-foreground">
            {saveFlash === 'saved'
              ? 'Saved.'
              : saveFlash === 'error'
              ? 'Save failed.'
              : updateMutation.isPending
              ? 'Saving…'
              : 'Unsaved changes.'}
          </span>
          <button
            type="button"
            className="action-button-secondary text-sm"
            onClick={handleReset}
            disabled={updateMutation.isPending}
          >
            Discard
          </button>
          <button
            type="button"
            className="action-button text-sm"
            onClick={handleSave}
            disabled={updateMutation.isPending || !isDirty}
          >
            {updateMutation.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-field widget
// ─────────────────────────────────────────────────────────────────────────────

interface SettingFieldProps {
  defn: SettingDefinition;
  value: SettingValue;
  onChange: (v: SettingValue) => void;
  error?: string;
  disabled?: boolean;
}

export const SettingField: React.FC<SettingFieldProps> = ({ defn, value, onChange, error, disabled }) => {
  const labelId = `setting-${defn.key}`;
  const helpId = `setting-${defn.key}-help`;

  return (
    <div className={`flex flex-col gap-1 ${disabled ? 'opacity-40 pointer-events-none select-none' : ''}`}>
      <label htmlFor={labelId} className="text-sm font-medium">
        {defn.label}
      </label>
      <Widget defn={defn} value={value} onChange={onChange} labelId={labelId} />
      {defn.description && (
        <p id={helpId} className="text-xs text-muted-foreground">
          {defn.description}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
};

interface WidgetProps {
  defn: SettingDefinition;
  value: SettingValue;
  onChange: (v: SettingValue) => void;
  labelId: string;
}

const Widget: React.FC<WidgetProps> = ({ defn, value, onChange, labelId }) => {
  const { data_type, validation } = defn;

  // Specialized widgets by key. These take precedence over data_type so the
  // raw integer/string values stored on the server get a user-friendly editor.
  if (defn.key === 'tenant_default_timezone') {
    return <TimezoneWidget value={String(value ?? '')} onChange={onChange} labelId={labelId} />;
  }
  if (defn.key === 'week_start_day') {
    return <WeekStartWidget value={Number(value ?? 0)} onChange={onChange} />;
  }
  if (defn.key === 'reminder_internal_recipients') {
    return <RecipientsWidget value={String(value ?? '')} onChange={onChange} />;
  }
  if (defn.key === 'missing_yesterday_notify_after_hour' || defn.key === 'manager_missing_team_notify_after_hour') {
    return <HourOfDayWidget value={Number(value ?? 0)} onChange={onChange} />;
  }

  if (data_type === 'bool') {
    const checked = Boolean(value);
    return (
      <button
        id={labelId}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex w-[34px] h-[18px] rounded-full transition-colors duration-200 ${
          checked ? 'bg-primary' : 'bg-muted-foreground/30'
        }`}
      >
        <span
          className={`absolute top-[2px] left-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
            checked ? 'translate-x-[16px]' : 'translate-x-0'
          }`}
        />
      </button>
    );
  }

  if (data_type === 'string' && validation.enum) {
    return (
      <select
        id={labelId}
        className="field-input"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      >
        {validation.enum.map((opt) => (
          <option key={String(opt)} value={String(opt)}>
            {String(opt)}
          </option>
        ))}
      </select>
    );
  }

  if (data_type === 'string') {
    return (
      <input
        id={labelId}
        type="text"
        className="field-input"
        value={String(value ?? '')}
        minLength={validation.min_length}
        maxLength={validation.max_length}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  if (data_type === 'time') {
    return (
      <div className="flex items-center gap-2">
        <input
          id={labelId}
          type="time"
          className="field-input flex-1"
          value={typeof value === 'string' ? value : '00:00'}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="text-xs text-muted-foreground">tenant time</span>
      </div>
    );
  }

  if (data_type === 'int' && validation.enum) {
    // Small enum-of-ints renders as a select for clearer affordance.
    return (
      <select
        id={labelId}
        className="field-input"
        value={String(value ?? 0)}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {validation.enum.map((opt) => (
          <option key={String(opt)} value={String(opt)}>
            {String(opt)}
          </option>
        ))}
      </select>
    );
  }

  if (data_type === 'int' || data_type === 'float') {
    const numeric = typeof value === 'number' ? value : Number(value) || 0;
    return (
      <input
        id={labelId}
        type="number"
        className="field-input"
        value={numeric}
        step={data_type === 'int' ? 1 : 0.1}
        min={validation.min}
        max={validation.max}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') {
            onChange(0);
            return;
          }
          onChange(data_type === 'int' ? Math.trunc(Number(raw)) : Number(raw));
        }}
      />
    );
  }

  // json or unknown — fall back to a textarea that preserves the raw JSON.
  return (
    <textarea
      id={labelId}
      className="field-textarea"
      rows={3}
      value={value == null ? '' : JSON.stringify(value)}
      onChange={(e) => {
        try {
          onChange(JSON.parse(e.target.value));
        } catch {
          /* leave unchanged until it parses */
        }
      }}
    />
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Specialized widgets (D-28). Each maps a raw stored value to a friendly editor
// while keeping the server contract unchanged.
// ─────────────────────────────────────────────────────────────────────────────

// IANA timezone typeahead. Uses the browser's runtime list so we don't ship a
// 600+ entry table. Falls back to an Intl-supported subset on older browsers.
// Display swaps "_" for " " for readability (the stored value stays the
// underscored IANA id). Entries are bucketed by region (Africa / America /
// Asia / etc.) so scrolling through the full list isn't a wall of names.
const formatZoneLabel = (tz: string): string => tz.replace(/_/g, ' ');

const zoneRegion = (tz: string): string => {
  const slash = tz.indexOf('/');
  return slash === -1 ? 'Other' : tz.slice(0, slash);
};

const TimezoneWidget: React.FC<{ value: string; onChange: (v: string) => void; labelId: string }> = ({
  value,
  onChange,
  labelId,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const allZones = useMemo<string[]>(() => {
    type IntlWithZones = typeof Intl & { supportedValuesOf?: (k: string) => string[] };
    const intl = Intl as IntlWithZones;
    const fn = intl.supportedValuesOf;
    const zones =
      typeof fn === 'function'
        ? fn('timeZone')
        : ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Tokyo'];
    return [...zones].sort((a, b) => {
      // Group by region first, then alphabetical inside the region.
      const ra = zoneRegion(a);
      const rb = zoneRegion(b);
      if (ra !== rb) return ra.localeCompare(rb);
      return a.localeCompare(b);
    });
  }, []);

  // Filter: match against both the IANA id (with underscores) and the
  // human form (with spaces). Typing "New York" finds "America/New_York".
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allZones;
    return allZones.filter((z) => {
      const id = z.toLowerCase();
      const friendly = formatZoneLabel(z).toLowerCase();
      return id.includes(q) || friendly.includes(q);
    });
  }, [allZones, query]);

  // Build region-bucketed render groups so the list shows section headers
  // and a divider between regions. Order follows the sorted ``filtered``
  // array (region-then-city).
  const groups = useMemo(() => {
    const out: { region: string; zones: string[] }[] = [];
    let current: { region: string; zones: string[] } | null = null;
    for (const tz of filtered) {
      const region = zoneRegion(tz);
      if (!current || current.region !== region) {
        current = { region, zones: [] };
        out.push(current);
      }
      current.zones.push(tz);
    }
    return out;
  }, [filtered]);

  return (
    <div className="relative">
      <button
        id={labelId}
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="field-input flex items-center justify-between text-left"
      >
        <span className="truncate">{value ? formatZoneLabel(value) : 'Select timezone…'}</span>
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 w-full max-h-72 overflow-hidden rounded-md border border-border bg-card shadow-lg flex flex-col">
            <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
              <Search className="w-3.5 h-3.5 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search (e.g. New York, Tokyo)"
                className="flex-1 bg-transparent text-sm focus:outline-none"
              />
            </div>
            <div className="overflow-y-auto">
              {groups.length === 0 && (
                <p className="px-3 py-2 text-xs text-muted-foreground">No match.</p>
              )}
              {groups.map((group, gIdx) => (
                <div key={group.region} className={gIdx > 0 ? 'border-t border-border' : ''}>
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {group.region}
                  </div>
                  {group.zones.map((tz) => (
                    <button
                      key={tz}
                      type="button"
                      onClick={() => { onChange(tz); setOpen(false); setQuery(''); }}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-muted ${tz === value ? 'text-primary' : 'text-foreground'}`}
                    >
                      {formatZoneLabel(tz)}
                      {tz === value && <Check className="w-3.5 h-3.5" />}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

// Week-start segmented buttons. Stored value stays 0 or 1.
const WeekStartWidget: React.FC<{ value: number; onChange: (v: number) => void }> = ({ value, onChange }) => (
  <div className="inline-flex rounded-md border border-border bg-background p-0.5">
    {[
      { v: 0, label: 'Sunday' },
      { v: 1, label: 'Monday' },
    ].map((opt) => (
      <button
        key={opt.v}
        type="button"
        onClick={() => onChange(opt.v)}
        className={`px-3 py-1 text-xs font-medium rounded transition ${
          value === opt.v
            ? 'bg-primary text-primary-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        {opt.label}
      </button>
    ))}
  </div>
);

// Reminder recipients. Stored value is either the literal string "all" or a
// comma-separated list of user IDs. UI flips between an "All eligible" toggle
// and a multi-select.
const RecipientsWidget: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  const usersQuery = useUsers();
  const allMode = value.trim().toLowerCase() === 'all';
  const selectedIds = useMemo(() => {
    if (allMode) return new Set<number>();
    return new Set(
      value
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    );
  }, [value, allMode]);

  const eligible = (usersQuery.data ?? [])
    .filter((u) => u.is_active)
    .sort((a, b) => a.full_name.localeCompare(b.full_name));

  const toggleUser = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange(Array.from(next).join(','));
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => onChange(allMode ? '' : 'all')}
        className="inline-flex items-center gap-2 text-xs"
      >
        <span
          className={`relative inline-flex w-[34px] h-[18px] rounded-full transition-colors duration-200 ${
            allMode ? 'bg-primary' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`absolute top-[2px] left-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
              allMode ? 'translate-x-[16px]' : 'translate-x-0'
            }`}
          />
        </span>
        <span className="text-foreground">All eligible employees</span>
      </button>

      {!allMode && (
        <div className="rounded-md border border-border bg-background max-h-44 overflow-y-auto divide-y divide-border">
          {usersQuery.isLoading && <p className="px-3 py-2 text-xs text-muted-foreground">Loading users…</p>}
          {!usersQuery.isLoading && eligible.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No eligible users.</p>
          )}
          {eligible.map((u) => {
            const checked = selectedIds.has(u.id);
            return (
              <label
                key={u.id}
                className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleUser(u.id)}
                  className="accent-primary"
                />
                <span className="text-foreground">{u.full_name}</span>
                <span className="text-muted-foreground ml-auto">{u.email}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
};

// Hour-of-day picker (0-23). Maps to a HH:00 time string for the picker UI
// then writes back the integer hour to keep the catalog's int contract.
const HourOfDayWidget: React.FC<{ value: number; onChange: (v: number) => void }> = ({ value, onChange }) => {
  const hh = Math.max(0, Math.min(23, Number.isFinite(value) ? value : 0));
  const timeStr = `${String(hh).padStart(2, '0')}:00`;
  return (
    <div className="flex items-center gap-2">
      <input
        type="time"
        step={3600}
        value={timeStr}
        onChange={(e) => {
          const parsed = Number((e.target.value || '00:00').split(':')[0]);
          if (Number.isFinite(parsed)) onChange(Math.max(0, Math.min(23, parsed)));
        }}
        className="field-input w-32"
      />
      <span className="text-xs text-muted-foreground">tenant time</span>
    </div>
  );
};
