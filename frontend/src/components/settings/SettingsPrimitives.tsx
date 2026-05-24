import React from 'react';

export const SectionWrapper: React.FC<{
  title: string;
  desc: string;
  children: React.ReactNode;
}> = ({ title, desc, children }) => (
  <div className="w-full max-w-[1400px] animate-in fade-in slide-in-from-bottom-2 duration-300">
    <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
    <p className="text-[12.5px] text-muted-foreground mt-1 mb-5 leading-relaxed">{desc}</p>
    <div className="space-y-4">{children}</div>
  </div>
);

export const Card: React.FC<{
  title: string;
  desc?: string;
  children: React.ReactNode;
}> = ({ title, desc, children }) => (
  <div className="rounded-xl border border-border bg-card p-[18px]">
    <h2 className="text-[13px] font-medium text-foreground">{title}</h2>
    {desc && <p className="text-[11.5px] text-muted-foreground leading-[1.45] mt-0.5 mb-3">{desc}</p>}
    {!desc && <div className="mb-3" />}
    {children}
  </div>
);

export const SaveRow: React.FC<{
  onSave: () => void;
  disabled?: boolean;
  label?: string;
}> = ({ onSave, disabled, label = 'Save' }) => (
  <div className="flex justify-end mt-[14px]">
    <button
      type="button"
      className="action-button text-sm disabled:opacity-50"
      disabled={disabled}
      onClick={onSave}
    >
      {label}
    </button>
  </div>
);

export const FormGrid: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>
);

export const Field: React.FC<{
  label: string;
  hint?: string;
  children: React.ReactNode;
}> = ({ label, hint, children }) => (
  <div>
    <label className="block text-[11px] font-medium text-muted-foreground mb-1">{label}</label>
    {children}
    {hint && <p className="text-[10.5px] text-muted-foreground/60 mt-0.5">{hint}</p>}
  </div>
);

export const ToggleRow: React.FC<{
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ label, desc, checked, onChange }) => (
  <div className="flex items-center justify-between py-[9px] border-b border-border/40 last:border-0">
    <div className="pr-4">
      <p className="text-[12.5px] font-medium text-foreground">{label}</p>
      {desc && <p className="text-[11px] text-muted-foreground mt-0.5">{desc}</p>}
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`
        relative shrink-0 w-[34px] h-[18px] rounded-full transition-colors duration-200
        ${checked ? 'bg-primary' : 'bg-muted-foreground/30'}
      `}
    >
      <span
        className={`
          absolute top-[2px] left-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm
          transition-transform duration-200 ${checked ? 'translate-x-[16px]' : 'translate-x-0'}
        `}
      />
    </button>
  </div>
);

export const InfoBanner: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-xl border border-primary/20 bg-primary/[0.04] px-4 py-3 text-[12px] text-muted-foreground leading-relaxed">
    {children}
  </div>
);

// Card with a tinted icon tile in the top-left and a horizontal rule under
// the title. Used by the two-card layouts on Reminders and Notifications.
// Pass an icon element (e.g. <Users className="..." />) sized to fit the
// 18-pixel-square tile.
export const IconCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  desc?: string;
  children: React.ReactNode;
}> = ({ icon, title, desc, children }) => (
  <div className="rounded-xl border border-border bg-card p-5">
    <div className="flex items-start gap-3 pb-4 border-b border-border/60">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <h2 className="text-[15px] font-semibold text-foreground leading-tight">{title}</h2>
        {desc && (
          <p className="text-[12px] text-muted-foreground leading-snug mt-0.5">{desc}</p>
        )}
      </div>
    </div>
    <div className="pt-4 space-y-4">{children}</div>
  </div>
);

// Sticky save row used by the redesigned settings panels. Shows when
// dirty, summarizes save state, exposes Discard + Save buttons. Mirrors
// the bar inside TenantSettingsForm so the two layouts behave identically.
export const SettingsSaveBar: React.FC<{
  isDirty: boolean;
  isSaving: boolean;
  saveFlash: 'idle' | 'saved' | 'error';
  onSave: () => void;
  onDiscard: () => void;
}> = ({ isDirty, isSaving, saveFlash, onSave, onDiscard }) => {
  if (!isDirty && saveFlash === 'idle') return null;
  return (
    <div className="sticky bottom-0 z-10 flex items-center justify-end gap-2 border-t border-border bg-card/95 backdrop-blur px-4 py-3 rounded-b-xl">
      <span className="mr-auto text-xs text-muted-foreground">
        {saveFlash === 'saved'
          ? 'Saved.'
          : saveFlash === 'error'
          ? 'Save failed.'
          : isSaving
          ? 'Saving…'
          : 'Unsaved changes.'}
      </span>
      <button
        type="button"
        className="action-button-secondary text-sm"
        onClick={onDiscard}
        disabled={isSaving}
      >
        Discard
      </button>
      <button
        type="button"
        className="action-button text-sm"
        onClick={onSave}
        disabled={isSaving || !isDirty}
      >
        {isSaving ? 'Saving…' : 'Save changes'}
      </button>
    </div>
  );
};
