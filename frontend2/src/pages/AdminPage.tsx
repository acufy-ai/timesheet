import React, { useState } from 'react';
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, differenceInCalendarDays, parseISO } from 'date-fns';
import { PlusCircle, Pencil, Trash2, ShieldCheck, UserCircle, X, Clock, Paperclip, Building2, MoreVertical, MailCheck, Upload, Download, CheckCircle2, Check, ChevronDown, ChevronLeft, ChevronRight, ListFilter, Users, MessageSquare, UserCheck, AlertCircle } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { Loading, Error, OrganizationalChart, SearchInput, ImportUsersModal, ExportModal, DateRangePickerCalendar, ExpandableDescription } from '@/components';
import { formatTimeBlock } from '@/utils/timeFormat';
import { BulkSelectBar } from '@/components/ui/BulkSelectBar';
import { EmployeeMultiSelectPicker } from '@/components/EmployeeMultiSelectPicker';
import { cn } from '@/lib/utils';
import { useUsers, useCreateUser, useUpdateUser, useDeleteUser, useResetUserPassword, useSendInvite, useBulkDeleteUsers, useAuth, useIsPlatformAdmin, useProjects, useNotifications, useUnlockUserTimesheet, useDepartments, useCreateDepartment, useDeleteDepartment, useLeaveTypes, useCreateLeaveType, useUpdateLeaveType, useDeleteLeaveType, useClients, useCreateClient, useUserEmailAliases, useAddUserEmailAlias, useDeleteUserEmailAlias, useUserClientAssignments, useAddUserClientAssignment, useRemoveUserClientAssignment, useWeekStartsOn } from '@/hooks';
import { KeyRound, Mail, UserMinus } from 'lucide-react';
import { timeentriesAPI, ingestionAPI, adminAPI } from '@/api';
import { Client, Department, IngestionTimesheetSummary, LeaveType, Project, TimeEntry, User, UserRole } from '@/types';
import { useTenantLogo } from '@/hooks/useTenantLogo';
import {
  buildEmployeeTimesheetPdf,
  employeePdfFilename,
  type PdfReportFilters,
  type PdfTenantBranding,
} from '@/utils/teamTimesheetPdf';
import { isPendingInvite } from '@/utils/userFilters';


const extractErrorMessage = (err: unknown): string => {
  if (typeof err !== 'object' || err === null || !('response' in err)) return 'An error occurred';
  const detail = (err as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0] as { msg?: string };
    return first.msg ?? 'Validation error';
  }
  return 'An error occurred';
};

// Format hours as a fixed-precision string. Summing fractional hours
// in JavaScript yields floating-point garbage (e.g. 152.0 turning into
// 151.99999999999994); rounding at display time stops that bleeding
// into the UI. Two decimals matches the tenant-side time-entry shape.
const fmtHrs = (n: number | string): string => {
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (!Number.isFinite(num)) return '0.00';
  return num.toFixed(2);
};


type UserMutationPayload = {
  full_name: string;
  // Email is optional in the patch — omit the key entirely to leave
  // the existing value untouched. We never send null because the
  // server-side User shape doesn't model it.
  email?: string;
  title?: string | null;
  department?: string | null;
  role: UserRole;
  // Multi-role: full set of allowed roles. The active role lives in
  // `role`; this is the menu the user can flip between via the
  // post-login portal picker and topbar Switch chip.
  roles?: UserRole[];
  is_active: boolean;
  can_review: boolean;
  is_external: boolean;
  manager_id?: number | null;
  project_ids?: number[];
  default_client_id?: number | null;
  phones?: string[];
};

const TENANT_ROLES: UserRole[] = ['EMPLOYEE', 'MANAGER', 'VIEWER', 'ADMIN'];
const ALL_ROLES: UserRole[] = [...TENANT_ROLES, 'PLATFORM_ADMIN'];

type UserActionMenuProps = {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  canManage: boolean;
  canManageAuth: boolean;
  // True when the row represents the currently logged-in user. The
  // menu then shows a single "Manage your account →" link instead of
  // the management actions (which the backend rejects for self anyway:
  // delete locks you out, reset-password is blocked, etc.).
  isSelf: boolean;
  isSendInviteDisabled: boolean;
  isActive: boolean;
  onSendInvite: () => void;
  onResetPassword: () => void;
  onDisableLogin: () => void;
  onDelete: () => void;
  onManageOwnAccount: () => void;
  onViewTimesheets: () => void;
};

// Row-level actions dropdown. Flips upward when opening near the viewport
// bottom so the menu never gets clipped by the table's overflow-hidden wrapper.
const UserActionMenu: React.FC<UserActionMenuProps> = ({
  isOpen, onToggle, onClose, canManage, canManageAuth, isSelf,
  isSendInviteDisabled,
  isActive,
  onSendInvite, onResetPassword, onDisableLogin, onDelete, onManageOwnAccount, onViewTimesheets,
}) => {
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  // The dropdown renders with ``position: fixed`` (using viewport coords
  // computed from the kebab button's rect) so ``overflow-hidden`` on
  // ancestors — including the user list card — can't clip it. Previously
  // the menu was ``position: absolute`` inside an overflow-hidden card,
  // and rows near the top of the table had their menus visibly clipped.
  const [coords, setCoords] = React.useState<{ top: number; right: number; openUp: boolean } | null>(null);

  React.useEffect(() => {
    if (!isOpen || !buttonRef.current) {
      setCoords(null);
      return;
    }
    const measure = () => {
      const btnRect = buttonRef.current?.getBoundingClientRect();
      if (!btnRect) return;
      const menuHeight = 200; // approx for up to 4 items + padding
      const spaceBelow = window.innerHeight - btnRect.bottom;
      const openUp = spaceBelow < menuHeight && btnRect.top > menuHeight;
      // ``right`` measured from the viewport's right edge so the menu
      // is right-aligned to the kebab button — matches the previous
      // ``right-0`` behavior.
      const right = Math.max(8, window.innerWidth - btnRect.right);
      const top = openUp ? btnRect.top - 4 : btnRect.bottom + 4;
      setCoords({ top, right, openUp });
    };
    measure();
    // Re-measure on scroll/resize while open so the menu stays anchored
    // to the kebab if the user scrolls without closing it.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [isOpen]);

  const item = (onClick: () => void, icon: React.ReactNode, label: string, extra?: { danger?: boolean; disabled?: boolean; title?: string }) => (
    <button
      onClick={() => { onClose(); onClick(); }}
      disabled={extra?.disabled}
      title={extra?.title}
      className={`flex w-full items-center gap-2 px-3 py-2 text-sm text-left hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed ${extra?.danger ? 'text-destructive hover:bg-destructive/10' : 'text-foreground'}`}
    >
      {icon} {label}
    </button>
  );

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={onToggle}
        className="p-1.5 rounded hover:bg-muted"
        title="Actions"
        aria-label="User actions"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {isOpen && coords && (
        <div
          style={{
            position: 'fixed',
            top: coords.openUp ? undefined : coords.top,
            bottom: coords.openUp ? window.innerHeight - coords.top : undefined,
            right: coords.right,
            zIndex: 50,
          }}
          className="min-w-[180px] rounded-lg border border-border bg-card shadow-lg py-1"
        >
          {/* Edit is intentionally NOT in the kebab. It lives as the inline
              Edit pencil on the row so the most-frequent action gets one
              click. The kebab is for the less-frequent operations. */}
          {/* "Send invite" is the unified entry point. The backend picks
              the Auth0 path or the legacy verification path per user, so
              operators no longer have to know which seam of the Auth0
              rollout a given user is on. */}
          {/* View timesheets is available on every row including self —
              admins can audit anyone's logged time, and on self-row this
              is faster than navigating through My Time. */}
          {item(onViewTimesheets, <Clock className="w-3.5 h-3.5" />, 'View all timesheets')}
          {isSelf ? (
            // Self-row: the management actions don't apply (Delete /
            // Disable login lock you out, Reset password is blocked
            // backend-side by design). Surface a single shortcut to
            // the Profile page so the kebab isn't an empty menu.
            item(onManageOwnAccount, <UserCircle className="w-3.5 h-3.5" />, 'Manage your account')
          ) : (
            <>
              {canManageAuth && item(onSendInvite, <Mail className="w-3.5 h-3.5" />, 'Send invite', { disabled: isSendInviteDisabled })}
              {canManageAuth && item(onResetPassword, <KeyRound className="w-3.5 h-3.5" />, 'Reset password')}
              {/* Disable login = set is_active=false. Mirror of the floating
                  bar's bulk action so the same vocabulary works for 1 or many. */}
              {canManage && isActive && item(onDisableLogin, <UserMinus className="w-3.5 h-3.5" />, 'Disable login')}
              {canManage && item(onDelete, <Trash2 className="w-3.5 h-3.5" />, 'Delete', { danger: true })}
            </>
          )}
        </div>
      )}
    </div>
  );
};

const getAllowedSupervisorRoles = (_role: UserRole): UserRole[] => {
  return ['MANAGER', 'ADMIN', 'VIEWER'];
};

const normalizeDepartment = (value?: string | null): string => (value ?? '').trim().toLowerCase();

const isSupervisorCompatibleForRoleAndDepartment = (
  userRole: UserRole,
  _userDepartment: string,
  supervisor: User,
): boolean => {
  const allowedSupervisorRoles = getAllowedSupervisorRoles(userRole);
  return allowedSupervisorRoles.includes(supervisor.role);
};

const roleBadge = (role: UserRole, allRoles?: UserRole[] | null, isExternal?: boolean) => {
  const styles: Record<UserRole, string> = {
    EMPLOYEE: 'bg-[var(--bg-surface-3)] text-[var(--text-secondary)]',
    MANAGER: 'bg-[var(--info-light)] text-[var(--info)]',
    VIEWER: 'bg-[var(--danger-light)] text-[var(--danger)]',
    ADMIN: 'bg-[var(--accent-light)] text-[var(--accent-blue)]',
    PLATFORM_ADMIN: 'bg-[var(--accent-light)] text-[var(--accent-blue)]',
  };
  // External-audience users get an amber/outline variant of the role
  // pill so they're visually distinct even when "All employees" is
  // selected. Internal users keep the existing color palette.
  const externalRoleStyle =
    'border border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  const pillClassName = isExternal
    ? `inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${externalRoleStyle}`
    : `inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${styles[role]}`;
  // The user may carry additional roles on top of the active one
  // (multi-role accounts). When present, render a small "+N more"
  // chip listing the others as a tooltip.
  const extras = (allRoles ?? []).filter((r) => r !== role);
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <span className={pillClassName} title={isExternal ? 'External user (no login)' : undefined}>
        {(role === 'ADMIN' || role === 'PLATFORM_ADMIN') && <ShieldCheck className="w-3 h-3" />}
        {role === 'MANAGER' && <UserCircle className="w-3 h-3" />}
        {role}
      </span>
      {isExternal && (
        <span
          className="inline-flex items-center rounded-full border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300"
          title="External (contractor / vendor, no app login)"
        >
          External
        </span>
      )}
      {extras.length > 0 && (
        <span
          className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
          title={`Also: ${extras.join(', ')}`}
        >
          +{extras.length}
        </span>
      )}
    </span>
  );
};

type Audience = 'internal' | 'external' | null;

const MAX_PHONES = 3;

type FormState = {
  full_name: string;
  email: string;
  // Additional email addresses (up to MAX_EMAIL_ALIASES). The first
  // entry in this list is always the primary/login email (form.email).
  // extraEmails holds the non-primary addresses shown as extra rows.
  extraEmails: string[];
  // Phone numbers: index 0 is primary, remaining are extras (max MAX_PHONES total).
  phones: string[];
  username: string;
  title: string;
  department: string;
  role: UserRole;
  // Additional roles this user can act as on top of the primary `role`.
  // The portal picker shows up at login when the combined set has more
  // than one entry. Single-role users keep this empty.
  additional_roles: UserRole[];
  is_active: boolean;
  can_review: boolean;
  // Internal vs External selection. Null forces the admin to pick;
  // the rest of the form is disabled until they do. Persisted as
  // is_external on submit (internal -> false, external -> true).
  audience: Audience;
  manager_id: number | null;
  project_ids: number[];
  default_client_id: number | null;
};

// Roles that can be added on top of the primary role. EMPLOYEE and
// PLATFORM_ADMIN are intentionally excluded: nobody asks for an
// "employee" portal on top of a manager account, and platform-admin
// is its own identity (no tenant_id).
const ADDITIONAL_ROLE_OPTIONS: UserRole[] = ['MANAGER', 'VIEWER', 'ADMIN'];

const emptyForm = (): FormState => ({
  full_name: '',
  email: '',
  extraEmails: [],
  phones: [],
  username: '',
  title: '',
  department: '',
  role: 'EMPLOYEE',
  additional_roles: [],
  is_active: true,
  can_review: false,
  // Forces the admin to pick Internal or External before the rest of
  // the form is meaningful. Saved as is_external on submit.
  audience: null,
  manager_id: null,
  project_ids: [],
  default_client_id: null,
});

const MAX_EMAIL_ALIASES = 2;

// ──────────────────────────────────────────────────────────────────────
// Workforce Setup panel
// ──────────────────────────────────────────────────────────────────────
//
// Two side-by-side cards on the Workforce Setup tab: Departments and
// Leave Types. Replaces the previous two separate tabs so the
// org-config surface (rarely-used admin stuff) lives in one place
// instead of cluttering the top-level tab bar.

// Curated palette for the leave-type color picker. These are the
// Tailwind 500-level swatches that read well on both light and dark
// backgrounds. We constrain to a fixed list (mockup spec) instead of a
// free-form color input — easier to pick, and the dot in the row
// stays visually balanced.
const LEAVE_TYPE_COLORS: { value: string; label: string }[] = [
  { value: '#6b7280', label: 'Slate' },
  { value: '#f59e0b', label: 'Amber' },
  { value: '#6366f1', label: 'Indigo' },
  { value: '#10b981', label: 'Emerald' },
  { value: '#ef4444', label: 'Rose' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#a855f7', label: 'Purple' },
];

interface WorkforceSetupPanelProps {
  departments: Department[];
  leaveTypes: LeaveType[];
  newDepartmentName: string;
  setNewDepartmentName: (v: string) => void;
  createDepartmentPending: boolean;
  deleteDepartmentPending: boolean;
  onCreateDepartment: (name: string) => void;
  onDeleteDepartment: (id: number, name: string) => void;
  newLeaveTypeLabel: string;
  setNewLeaveTypeLabel: (v: string) => void;
  newLeaveTypeColor: string;
  setNewLeaveTypeColor: (v: string) => void;
  createLeaveTypePending: boolean;
  deleteLeaveTypePending: boolean;
  onCreateLeaveType: () => void;
  onToggleLeaveTypeActive: (lt: LeaveType) => void;
  onRenameLeaveType: (lt: LeaveType, label: string) => void;
  onDeleteLeaveType: (lt: LeaveType) => void;
}

const WorkforceSetupPanel: React.FC<WorkforceSetupPanelProps> = ({
  departments, leaveTypes,
  newDepartmentName, setNewDepartmentName,
  createDepartmentPending, deleteDepartmentPending,
  onCreateDepartment, onDeleteDepartment,
  newLeaveTypeLabel, setNewLeaveTypeLabel,
  newLeaveTypeColor, setNewLeaveTypeColor,
  createLeaveTypePending, deleteLeaveTypePending,
  onCreateLeaveType, onToggleLeaveTypeActive, onRenameLeaveType, onDeleteLeaveType,
}) => {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* ── Departments card ─────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Building2 className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold text-foreground leading-tight">Departments</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Manage departments in your organization.</p>
              <span className="mt-2 inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {departments.length} {departments.length === 1 ? 'department' : 'departments'}
              </span>
            </div>
          </div>
          <form
            className="mt-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newDepartmentName.trim();
              if (!name) return;
              onCreateDepartment(name);
            }}
          >
            <input
              value={newDepartmentName}
              onChange={(e) => setNewDepartmentName(e.target.value)}
              placeholder="New department name"
              className="field-input flex-1"
            />
            <button
              type="submit"
              className="action-button text-sm"
              disabled={createDepartmentPending || !newDepartmentName.trim()}
            >
              Add
            </button>
          </form>
        </div>
        <div className="border-t border-border">
          {departments.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground text-center">No departments yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {departments.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm hover:bg-muted/20">
                  <span className="font-medium text-foreground truncate">{d.name}</span>
                  <button
                    type="button"
                    onClick={() => onDeleteDepartment(d.id, d.name)}
                    disabled={deleteDepartmentPending}
                    className="inline-flex items-center gap-1.5 text-xs text-destructive hover:underline disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ── Leave Types card ─────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Paperclip className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold text-foreground leading-tight">Leave Types</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Manage types of time off employees can request.</p>
              <span className="mt-2 inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {leaveTypes.length} {leaveTypes.length === 1 ? 'leave type' : 'leave types'}
              </span>
            </div>
          </div>
          <form
            className="mt-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onCreateLeaveType();
            }}
          >
            <input
              value={newLeaveTypeLabel}
              onChange={(e) => setNewLeaveTypeLabel(e.target.value)}
              placeholder="New leave type name (e.g. Bereavement)"
              className="field-input flex-1"
            />
            <ColorSwatchPicker value={newLeaveTypeColor} onChange={setNewLeaveTypeColor} />
            <button
              type="submit"
              className="action-button text-sm"
              disabled={createLeaveTypePending || !newLeaveTypeLabel.trim()}
            >
              Add
            </button>
          </form>
        </div>
        <div className="border-t border-border">
          {leaveTypes.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground text-center">No leave types yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {leaveTypes.map((lt) => (
                <LeaveTypeRow
                  key={lt.id}
                  leaveType={lt}
                  onToggleActive={() => onToggleLeaveTypeActive(lt)}
                  onRename={(label) => onRenameLeaveType(lt, label)}
                  onDelete={() => onDeleteLeaveType(lt)}
                  deletePending={deleteLeaveTypePending}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

// Color swatch picker — opens a small popover with the curated palette
// when clicked. Renders the current value as a filled circle. Keeps
// the saved color in sync via ``onChange``.
const ColorSwatchPicker: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="flex h-9 w-12 items-center justify-center rounded-md border border-border bg-card hover:border-foreground/40 transition"
        title="Pick a color"
      >
        <span className="h-4 w-4 rounded-full" style={{ backgroundColor: value }} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 rounded-lg border border-border bg-card p-2 shadow-lg">
          <div className="grid grid-cols-4 gap-1.5">
            {LEAVE_TYPE_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => { onChange(c.value); setOpen(false); }}
                title={c.label}
                className={`h-7 w-7 rounded-full border-2 transition ${c.value === value ? 'border-foreground' : 'border-transparent hover:border-muted-foreground/40'}`}
                style={{ backgroundColor: c.value }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// One row in the Leave Types card. Handles its own inline-edit state so
// the parent doesn't have to track which row is being renamed.
const LeaveTypeRow: React.FC<{
  leaveType: LeaveType;
  onToggleActive: () => void;
  onRename: (label: string) => void;
  onDelete: () => void;
  deletePending: boolean;
}> = ({ leaveType: lt, onToggleActive, onRename, onDelete, deletePending }) => {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(lt.label);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== lt.label) {
      onRename(trimmed);
    }
    setEditing(false);
  };

  return (
    <li className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-muted/20">
      <span className="inline-block h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: lt.color }} />
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { setDraft(lt.label); setEditing(false); }
            }}
            className="field-input w-full text-sm py-1"
          />
        ) : (
          <span className={`font-medium ${lt.is_active ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
            {lt.label}
          </span>
        )}
      </div>
      <span
        className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium ${
          lt.is_active
            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
            : 'bg-muted text-muted-foreground'
        }`}
      >
        {lt.is_active ? 'Active' : 'Inactive'}
      </span>
      <button
        type="button"
        onClick={onToggleActive}
        className="text-xs text-muted-foreground hover:text-foreground transition"
      >
        {lt.is_active ? 'Deactivate' : 'Reactivate'}
      </button>
      <button
        type="button"
        onClick={() => { setDraft(lt.label); setEditing(true); }}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition"
      >
        <Pencil className="h-3 w-3" />
        Edit
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={deletePending}
        className="inline-flex items-center gap-1 text-xs text-destructive hover:underline disabled:opacity-50"
      >
        <Trash2 className="h-3 w-3" />
        Delete
      </button>
    </li>
  );
};

export const AdminPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user: currentUser, refreshUser, tenant: currentTenant } = useAuth();
  const { dataUrl: tenantLogoDataUrl } = useTenantLogo();
  const { data: users, isLoading, error, refetch: refetchUsers } = useUsers();
  const { data: projects, isLoading: projectsLoading, error: projectsError } = useProjects({ limit: 500 });
  const { data: notificationsSummary } = useNotifications();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const resetPassword = useResetUserPassword();
  // Unified invite hook. The backend dispatches Auth0 vs legacy
  // verification per user; UI doesn't need to think about it.
  const sendInvite = useSendInvite();
  const bulkDeleteUsers = useBulkDeleteUsers();
  const { data: departments = [] } = useDepartments();
  const { data: clientsList = [] } = useClients();
  const createClient = useCreateClient();
  const [newClientName, setNewClientName] = useState('');
  const [showNewClientInput, setShowNewClientInput] = useState(false);
  const createDepartment = useCreateDepartment();
  const [selectedUserIds, setSelectedUserIds] = useState<Set<number>>(new Set());
  const [resetPasswordUserId, setResetPasswordUserId] = useState<number | null>(null);
  const [actionMenuUserId, setActionMenuUserId] = useState<number | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [resetPasswordError, setResetPasswordError] = useState('');
  const [orgChartExpanded, setOrgChartExpanded] = useState(false);

  const toggleUserSelection = (userId: number) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const selectAllUsers = () => {
    const ids = filtered
      .filter((u) => u.id !== currentUser?.id)
      .map((u) => u.id);
    setSelectedUserIds(new Set(ids));
  };

  const clearSelection = () => setSelectedUserIds(new Set());

  const handleBulkDelete = async () => {
    if (selectedUserIds.size === 0) return;
    const confirmed = window.confirm(`Are you sure you want to delete ${selectedUserIds.size} user(s)? This action cannot be undone.`);
    if (!confirmed) return;
    await bulkDeleteUsers.mutateAsync(Array.from(selectedUserIds));
    setSelectedUserIds(new Set());
  };

  // ── Bulk actions (D-005) ────────────────────────────────────────────────
  // No bulk endpoints on the backend for invite/deactivate, so we loop the
  // per-user endpoints. CSV export builds client-side from the selected
  // rows (already in memory) so we don't need a new backend filter param.
  const [isBulkSendingInvite, setIsBulkSendingInvite] = useState(false);
  const [isBulkDeactivating, setIsBulkDeactivating] = useState(false);
  const [isBulkExporting, setIsBulkExporting] = useState(false);

  const handleBulkSendInvite = async () => {
    if (selectedUserIds.size === 0 || isBulkSendingInvite) return;
    const ids = Array.from(selectedUserIds);
    const confirmed = window.confirm(
      `Send invite email to ${ids.length} user${ids.length === 1 ? '' : 's'}?`
    );
    if (!confirmed) return;
    setIsBulkSendingInvite(true);
    let sent = 0;
    let skipped = 0;
    for (const id of ids) {
      try {
        // Unified send-invite. Backend dispatches Auth0 vs legacy path
        // per user, so we don't need to pre-sort the selection.
        await sendInvite.mutateAsync(id);
        sent += 1;
      } catch {
        // Per-user failures (inactive, external, no email) are expected for
        // some rows. Count and continue so a partial bulk-action surfaces a
        // useful summary instead of bailing on first error.
        skipped += 1;
      }
    }
    setIsBulkSendingInvite(false);
    setSelectedUserIds(new Set());
    window.alert(
      skipped === 0
        ? `Invitation re-sent to ${sent} user${sent === 1 ? '' : 's'}.`
        : `Invitation re-sent to ${sent} user${sent === 1 ? '' : 's'}; ${skipped} skipped (inactive, external, or no email).`
    );
  };

  const handleBulkDeactivate = async () => {
    if (selectedUserIds.size === 0 || isBulkDeactivating) return;
    const ids = Array.from(selectedUserIds);
    const confirmed = window.confirm(
      `Disable login for ${ids.length} user${ids.length === 1 ? '' : 's'}? They won't be able to log in until you re-enable them.`
    );
    if (!confirmed) return;
    setIsBulkDeactivating(true);
    let updated = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await updateUser.mutateAsync({ id, data: { is_active: false } });
        updated += 1;
      } catch {
        failed += 1;
      }
    }
    setIsBulkDeactivating(false);
    setSelectedUserIds(new Set());
    if (failed > 0) {
      window.alert(`Disabled login for ${updated} user${updated === 1 ? '' : 's'}; ${failed} failed.`);
    }
  };

  const handleBulkExport = () => {
    if (selectedUserIds.size === 0 || isBulkExporting) return;
    setIsBulkExporting(true);
    try {
      const selected = (users ?? []).filter((u) => selectedUserIds.has(u.id));
      const escape = (value: unknown) => {
        const s = value == null ? '' : String(value);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = ['Full name', 'Email', 'Username', 'Role', 'Department', 'Title', 'Active', 'Created at'];
      const rows = selected.map((u) => [
        u.full_name,
        u.email,
        u.username,
        u.role,
        u.department ?? '',
        u.title ?? '',
        u.is_active ? 'yes' : 'no',
        u.created_at,
      ]);
      const csv = [header, ...rows].map((row) => row.map(escape).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `users-selected-${selected.length}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setIsBulkExporting(false);
    }
  };

  const isPlatformAdmin = useIsPlatformAdmin();
  const isAdminUser = currentUser?.role === 'ADMIN' || currentUser?.role === 'PLATFORM_ADMIN';
  const roles = isPlatformAdmin ? ALL_ROLES : TENANT_ROLES;
  const canManageEmployeeProjects =
    currentUser?.role === 'ADMIN' || currentUser?.role === 'PLATFORM_ADMIN' ||
    currentUser?.role === 'MANAGER' ||
    currentUser?.role === 'VIEWER';

  React.useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const [showModal, setShowModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [selectedUserDetails, setSelectedUserDetails] = useState<User | null>(null);
  const [clientAssignPanelUserId, setClientAssignPanelUserId] = useState<number | null>(null);
  const { data: clientAssignments = [], isLoading: clientAssignmentsLoading } = useUserClientAssignments(clientAssignPanelUserId);
  const addClientAssignment = useAddUserClientAssignment();
  const removeClientAssignment = useRemoveUserClientAssignment();
  const [form, setForm] = useState<FormState>(emptyForm());
  const [formError, setFormError] = useState('');
  const [search, setSearch] = useState(() => searchParams.get('search') ?? '');
  const [roleFilter, setRoleFilter] = useState<'ALL' | UserRole>(() => {
    const role = searchParams.get('role');
    if (role === 'EMPLOYEE' || role === 'MANAGER' || role === 'VIEWER' || role === 'ADMIN' || role === 'PLATFORM_ADMIN') {
      return role as UserRole;
    }
    return 'ALL';
  });
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>(() => {
    const status = searchParams.get('status');
    if (status === 'ACTIVE' || status === 'INACTIVE') {
      return status;
    }
    return 'ALL';
  });
  // Attention filter — driven by the dashboard Action Queue links so a
  // click-through into user management lands the admin on the exact
  // subset the queue called out (no_manager rows, stale unverified
  // invites). 'NONE' is the default.
  const [attentionFilter, setAttentionFilter] = useState<'NONE' | 'NO_MANAGER' | 'UNVERIFIED'>(() => {
    const status = searchParams.get('status');
    if (status === 'NO_MANAGER') return 'NO_MANAGER';
    if ((searchParams.get('verified') ?? '').toUpperCase() === 'NO') return 'UNVERIFIED';
    return 'NONE';
  });
  // Audience filter — separate from the role filter because internal
  // vs external is an orthogonal axis (an external manager and an
  // internal manager are both 'MANAGER'). 'ALL' shows everyone.
  const [audienceFilter, setAudienceFilter] = useState<'ALL' | 'INTERNAL' | 'EXTERNAL'>('ALL');
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [showNoProjectModal, setShowNoProjectModal] = useState(false);
  // Post-create confirmation state. We carry enough context to pick
  // the right copy: synthetic placeholder addresses must never be
  // shown to the admin, and the line about "verification email sent"
  // only fires when the backend actually sent one.
  const [userActionSummary, setUserActionSummary] = useState<{
    action: 'created' | 'updated';
    fullName: string;
    email: string;
    isExternal: boolean;
    verificationEmailSent: boolean;
  } | null>(null);
  const createdUserSummary = userActionSummary; // keep compat reference
  const userListSectionRef = React.useRef<HTMLDivElement | null>(null);

  // Team Timesheets tab state. Read from the ?tab= URL param so the
  // Inbox-page shortcut deep-links here and so refresh stays on the
  // tab the user had open. Tab changes are mirrored back to the URL
  // so the next refresh / share lands on the same view.
  // Workforce setup (Departments + Leave Types) is admin-only; managers
  // landing on the page via a stale link fall back to the users tab.
  // Legacy ``?tab=departments`` and ``?tab=leave_types`` map to the
  // unified ``workforce`` tab so old bookmarks still land somewhere
  // useful.
  const [activeTab, setActiveTab] = useState<'users' | 'timesheets' | 'workforce'>(() => {
    const t = searchParams.get('tab');
    // 'timesheets' (Approved Timesheets) and 'workforce' (Org Structure
    // & Policies) are admin-only. Managers landing on those via stale
    // URLs fall back to 'users' (My Team) so they don't see an empty
    // tab body.
    const adminOnly =
      t === 'workforce' || t === 'departments' || t === 'leave_types' || t === 'timesheets';
    if (adminOnly && !isAdminUser) return 'users';
    if (t === 'timesheets') return 'timesheets';
    if (adminOnly) return 'workforce';
    return 'users';
  });
  // Track if the URL change came from us so we don't fight the
  // setSearchParams effect below (URL→state would otherwise re-sync
  // immediately and clobber any other state we just set).
  const tabSyncRef = React.useRef<'users' | 'timesheets' | 'workforce' | null>(null);
  React.useEffect(() => {
    const t = searchParams.get('tab');
    const valid: typeof activeTab | null =
      t === 'timesheets'
        ? 'timesheets'
        : (t === 'workforce' || t === 'departments' || t === 'leave_types')
          ? 'workforce'
          : t === 'users'
            ? 'users'
            : null;
    if ((valid === 'workforce' || valid === 'timesheets') && !isAdminUser) {
      if (activeTab !== 'users') setActiveTab('users');
      return;
    }
    if (valid && valid !== activeTab) {
      setActiveTab(valid);
    }
    // Intentionally do NOT reset to 'users' when the param is absent:
    // routes that come in without ``tab`` (e.g. dashboard quick-chips
    // pass only ``?role=...``) should leave the current tab alone.
    tabSyncRef.current = null;
  }, [searchParams, activeTab, isAdminUser]);
  const changeTab = React.useCallback((next: typeof activeTab) => {
    setActiveTab(next);
    tabSyncRef.current = next;
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === 'users') {
          // 'users' is the default — keep the URL clean.
          params.delete('tab');
        } else {
          params.set('tab', next);
        }
        return params;
      },
      { replace: true },
    );
  }, [setSearchParams]);
  const deleteDepartment = useDeleteDepartment();
  const [newDepartmentName, setNewDepartmentName] = useState('');

  const { data: leaveTypesAll = [] } = useLeaveTypes(true);
  const createLeaveType = useCreateLeaveType();
  const updateLeaveType = useUpdateLeaveType();
  const deleteLeaveType = useDeleteLeaveType();
  const [newLeaveTypeLabel, setNewLeaveTypeLabel] = useState('');
  const [newLeaveTypeColor, setNewLeaveTypeColor] = useState('#6b7280');
  // Multi-select employee filter. Empty array = all employees (current
  // server behaviour). The query stays unfiltered server-side so a
  // PDF/CSV export can rebuild its scope from the same client-side
  // dataset without re-fetching.
  const [tsEmployeeIds, setTsEmployeeIds] = useState<number[]>([]);
  const [tsEmployeePickerOpen, setTsEmployeePickerOpen] = useState(false);
  const [tsStartDate, setTsStartDate] = useState(format(startOfMonth(new Date()), 'yyyy-MM-dd'));
  const [tsEndDate, setTsEndDate] = useState(format(endOfMonth(new Date()), 'yyyy-MM-dd'));
  const [tsStatus, setTsStatus] = useState('');
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [expandedWeekKey, setExpandedWeekKey] = useState<string | null>(null);
  const tsWeekStartsOn = useWeekStartsOn();
  const [sourceAttachmentId, setSourceAttachmentId] = useState<number | null>(null);
  const [sourceAttachmentFilename, setSourceAttachmentFilename] = useState<string>('');
  const [sourceAttachmentUrl, setSourceAttachmentUrl] = useState<string | null>(null);
  const [sourceAttachmentMime, setSourceAttachmentMime] = useState<string | null>(null);
  const [sourceAttachmentHtml, setSourceAttachmentHtml] = useState<string | null>(null);
  const [sourceAttachmentLoading, setSourceAttachmentLoading] = useState(false);
  const [sourceAttachmentError, setSourceAttachmentError] = useState<string | null>(null);
  const closeSourceAttachment = React.useCallback(() => {
    setSourceAttachmentId(null);
    if (sourceAttachmentUrl) URL.revokeObjectURL(sourceAttachmentUrl);
    setSourceAttachmentUrl(null);
    setSourceAttachmentHtml(null);
    setSourceAttachmentMime(null);
    setSourceAttachmentError(null);
  }, [sourceAttachmentUrl]);
  // Spreadsheets render as HTML, PDFs/images render in an iframe.
  // Everything else gets a download CTA so the modal never silently
  // triggers a download just by opening.
  const isSpreadsheetMime = (m: string | null | undefined) => {
    if (!m) return false;
    const lower = m.toLowerCase();
    return (
      lower.includes('openxmlformats') ||
      lower === 'application/vnd.ms-excel' ||
      lower.includes('csv')
    );
  };
  const isInlineRenderableMime = (m: string | null | undefined) => {
    if (!m) return false;
    const lower = m.toLowerCase();
    return lower.startsWith('image/') || lower === 'application/pdf';
  };

  // Fetch all team entries in the date range; the multi-employee
  // filter is applied client-side below. Single-employee filtering used
  // to live server-side via the user_id query param, but moving the
  // filter into the client lets the export buttons rebuild their scope
  // (e.g. zip per employee) without re-fetching per employee.
  const { data: teamEntriesUnfiltered = [], isFetching: tsLoading } = useQuery({
    queryKey: ['team-timesheets', tsStartDate, tsEndDate, tsStatus],
    queryFn: () =>
      timeentriesAPI.listAll({
        start_date: tsStartDate || undefined,
        end_date: tsEndDate || undefined,
        status: tsStatus || undefined,
        sort_by: 'entry_date',
        sort_order: 'desc',
        limit: 500,
      }).then((r: { data: TimeEntry[] }) => r.data),
    enabled: activeTab === 'timesheets',
  });

  // Approved ingestion timesheets with no line items (total-hours-only
  // PDFs). Routed through the dedicated admin endpoint so the Team
  // Timesheets tab works for ADMIN — the reviewer-queue endpoint at
  // /ingestion/timesheets is gated to reviewers and explicitly excludes
  // ADMIN, so calling that path from this admin-scoped tab returns 403
  // and the table loses summary-only timesheets.
  // Full approved-ingestion set (including those that materialized into
  // TimeEntry rows). The TABLE filters this down to summary-only rows so
  // materialized timesheets aren't double-rendered, but the CSV/PDF
  // lookup needs the full set so a materialized TimeEntry can join back
  // to its source PDF for Client / Supervisor / Source = "Inbox".
  const { data: approvedIngestionAll = [] } = useQuery({
    queryKey: ['team-timesheets-ingestion-all', tsStartDate, tsEndDate],
    queryFn: () =>
      adminAPI.listApprovedIngestionTimesheets().then(
        (r) => (r.data as IngestionTimesheetSummary[]),
      ),
    enabled: activeTab === 'timesheets' && (!tsStatus || tsStatus === 'APPROVED'),
  });
  const approvedIngestionTimesheetsUnfiltered = React.useMemo(
    () => (approvedIngestionAll as IngestionTimesheetSummary[]).filter(
      (ts) => !ts.time_entries_created && ts.total_hours,
    ),
    [approvedIngestionAll],
  );

  // Client-side multi-employee filter. Empty selection = show all.
  const employeeIdSet = React.useMemo(() => new Set(tsEmployeeIds), [tsEmployeeIds]);
  const teamEntries = React.useMemo(() => {
    if (employeeIdSet.size === 0) return teamEntriesUnfiltered;
    return (teamEntriesUnfiltered as TimeEntry[]).filter((e) => employeeIdSet.has(e.user_id));
  }, [teamEntriesUnfiltered, employeeIdSet]);
  const approvedIngestionTimesheets = React.useMemo(() => {
    // Filter to the active date range FIRST so every downstream consumer
    // (table render, export picker, PDF/CSV generators) sees the same
    // in-range set. The backend endpoint is currently date-agnostic, so
    // without this filter an employee whose only approved-ingestion row
    // is outside the toolbar's date window leaks into the export picker.
    const inRange = (ts: IngestionTimesheetSummary) => {
      const start = ts.period_start ?? ts.reviewed_at?.slice(0, 10) ?? null;
      const end = ts.period_end ?? start;
      if (!start) return true; // No period info — keep, the user can still see/export it.
      if (tsStartDate && end && end < tsStartDate) return false;
      if (tsEndDate && start > tsEndDate) return false;
      return true;
    };
    const dateScoped = (approvedIngestionTimesheetsUnfiltered as IngestionTimesheetSummary[])
      .filter(inRange);
    if (employeeIdSet.size === 0) return dateScoped;
    return dateScoped.filter(
      (ts) => ts.employee_id !== null && ts.employee_id !== undefined && employeeIdSet.has(ts.employee_id),
    );
  }, [approvedIngestionTimesheetsUnfiltered, employeeIdSet, tsStartDate, tsEndDate]);

  // CSV export. Includes both real TimeEntry rows AND approved-
  // ingestion summary rows (rendered as one row per ingestion
  // timesheet) so an employee whose only submission was approved via
  // the inbox queue isn't silently missing from the export. When
  // ``employeeIds`` is non-empty, only those employees' rows are
  // included; otherwise the entire current view is exported.
  const handleExportTeamTimesheetsCsv = (employeeIds?: number[]) => {
    const scopedEntries: TimeEntry[] =
      employeeIds && employeeIds.length > 0
        ? (teamEntries as TimeEntry[]).filter((e) => employeeIds.includes(e.user_id))
        : (teamEntries as TimeEntry[]);
    const scopedIngestion: IngestionTimesheetSummary[] =
      employeeIds && employeeIds.length > 0
        ? (approvedIngestionTimesheets as IngestionTimesheetSummary[]).filter(
            (ts) => ts.employee_id !== null && ts.employee_id !== undefined && employeeIds.includes(ts.employee_id),
          )
        : (approvedIngestionTimesheets as IngestionTimesheetSummary[]);
    if (scopedEntries.length === 0 && scopedIngestion.length === 0) return;

    // Wider column shape so inbox-approved external work surfaces its
    // Client + Supervisor + Approved-by separately from Project (often
    // blank for inbox rows). Matches the ApprovalsPage CSV exactly so
    // an admin gets the same shape regardless of which surface they
    // export from.
    const header = [
      'Employee',
      'Source',
      'Client',
      'Project',
      'Task',
      'Date',
      'Hours',
      'Supervisor',
      'Approved by',
      'Status',
    ];
    const escape = (value: unknown) => {
      const s = value == null ? '' : String(value);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const clientNameById = new Map<number, string>(
      (clientsList ?? []).map((c: Client) => [c.id, c.name] as [number, string]),
    );
    const projectClientById = new Map<number, string>();
    for (const p of (projects ?? [])) {
      const cn = clientNameById.get(p.client_id);
      if (cn) projectClientById.set(p.id, cn);
    }
    const userById = new Map<number, User>((users ?? []).map((u) => [u.id, u]));
    // Lookup map for inbox-derived TimeEntry rows. Use the FULL
    // approved-ingestion set (including materialized ones) so a
    // TimeEntry whose source PDF already produced day-by-day entries
    // can still join back to find its client / supervisor. The
    // *table* uses the filtered "summary-only" set to avoid double-
    // render; the CSV needs the join, hence the full set here.
    const inboxByTimesheetId = new Map<string, IngestionTimesheetSummary>();
    (approvedIngestionAll as IngestionTimesheetSummary[]).forEach((ts) =>
      inboxByTimesheetId.set(String(ts.id), ts),
    );
    const entryRows = scopedEntries.map((entry) => {
      const inboxLink = entry.ingestion_timesheet_id
        ? inboxByTimesheetId.get(String(entry.ingestion_timesheet_id))
        : null;
      const isInboxDerived = Boolean(inboxLink);
      const inboxClientName = inboxLink
        ? (inboxLink.client_name || inboxLink.extracted_client_name || '')
        : '';
      return [
        entry.user?.full_name ?? '',
        isInboxDerived ? 'Inbox' : 'Internal',
        isInboxDerived ? inboxClientName : (projectClientById.get(entry.project_id) ?? ''),
        // Project blank for inbox-derived entries (external work has no
        // internal project label); internal entries surface the project.
        isInboxDerived ? '' : (entry.project?.name ?? ''),
        entry.task?.name ?? '',
        entry.entry_date,
        Number(entry.hours),
        isInboxDerived ? (inboxLink?.extracted_supervisor_name ?? '') : '',
        entry.approved_by_name ?? (entry.approved_by ? userById.get(entry.approved_by)?.full_name ?? '' : ''),
        entry.status,
      ];
    });
    const ingestionRows = scopedIngestion.map((ts) => {
      const employeeName =
        (ts.employee_id ? userById.get(ts.employee_id)?.full_name : null)
        ?? ts.employee_name
        ?? ts.extracted_employee_name
        ?? '';
      // Date emits the full period range so the row matches the table
      // display "Apr 13 - Apr 19". Single-day periods collapse.
      const periodLabel = (() => {
        const s = ts.period_start ?? '';
        const e = ts.period_end ?? '';
        if (!s) return '';
        if (!e || e === s) return s;
        return `${s} - ${e}`;
      })();
      return [
        employeeName,
        'Inbox',
        ts.client_name ?? '',
        '', // Project: empty for inbox rows until a project gets attached
        '',
        periodLabel,
        Number(ts.total_hours ?? 0),
        ts.extracted_supervisor_name ?? '',
        ts.reviewer_name ?? '',
        'APPROVED',
      ];
    });
    // Group rows by employee + sort each group by date so an admin
    // reading the CSV sees one contiguous block per person rather
    // than two employees interleaved by date. Per-employee subtotal
    // row at the end of each block. Grand total at the very end.
    // Hours column is index 6 across both entry and ingestion shapes.
    const allRows = [...entryRows, ...ingestionRows];
    const groups = new Map<string, typeof allRows>();
    for (const row of allRows) {
      const employee = String(row[0] ?? '');
      const existing = groups.get(employee);
      if (existing) existing.push(row);
      else groups.set(employee, [row]);
    }
    // Sort each group by Date (column 5) ascending. Date is either an
    // ISO string (YYYY-MM-DD) or a period range "YYYY-MM-DD - YYYY-MM-DD";
    // sorting on the leading date works for both.
    const sortedEmployees = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
    const orderedRows: typeof allRows = [];
    let grandTotal = 0;
    for (const employee of sortedEmployees) {
      const rows = groups.get(employee)!;
      rows.sort((a, b) => String(a[5] ?? '').localeCompare(String(b[5] ?? '')));
      orderedRows.push(...rows);
      const subtotal = rows.reduce((sum, row) => sum + (Number(row[6]) || 0), 0);
      grandTotal += subtotal;
      orderedRows.push([`${employee} subtotal`, '', '', '', '', '', subtotal, '', '', '']);
    }
    const totalRow = ['Total', '', '', '', '', '', grandTotal, '', '', ''];
    const csv = [header, ...orderedRows, totalRow]
      .map((row) => row.map(escape).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `team-timesheets-${tsStartDate || 'all'}-to-${tsEndDate || 'all'}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // ── PDF / print exports ──────────────────────────────────────────
  // The toolbar Export button opens a centered modal where the user
  // chooses format (CSV / PDF / Print) and which employees to include.
  // For PDF, 1 employee = single file, 2+ = ZIP bundle. Print opens
  // the first selected employee in a new tab and triggers print on load.

  const buildBranding = React.useCallback<() => PdfTenantBranding>(() => ({
    name: currentTenant?.name ?? 'Tenant',
    logoDataUrl: tenantLogoDataUrl,
    logoMime: currentTenant?.logo_mime_type ?? null,
  }), [currentTenant?.name, currentTenant?.logo_mime_type, tenantLogoDataUrl]);

  const buildFilters = React.useCallback<() => PdfReportFilters>(() => ({
    startDate: tsStartDate || null,
    endDate: tsEndDate || null,
    status: tsStatus || null,
  }), [tsStartDate, tsEndDate, tsStatus]);

  // Centered export modal. The Export button on the toolbar opens it
  // directly — one click, one screen. The user picks format (CSV / PDF
  // / Print) at the top and employees below, then hits Generate.
  type ExportFormat = 'csv' | 'pdf' | 'print';
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('pdf');
  const [pdfPickerSelection, setPdfPickerSelection] = useState<Set<number>>(new Set());
  const [pdfPickerSearch, setPdfPickerSearch] = useState('');
  const pdfPickerRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!exportModalOpen) return;
    const handler = (e: MouseEvent) => {
      if (!pdfPickerRef.current) return;
      if (!pdfPickerRef.current.contains(e.target as Node)) setExportModalOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [exportModalOpen]);

  // Employees with at least one row in the current view — either real
  // TimeEntry rows OR approved-ingestion summary rows that get merged
  // into the table. Including ingestion-only employees keeps the
  // picker consistent with what the user sees in the table; otherwise
  // someone whose only timesheet was approved via the inbox queue
  // (no line items extracted) would be missing from PDF exports.
  const employeesWithEntries = React.useMemo(() => {
    const allUsers = users ?? [];
    const userById = new Map<number, User>(allUsers.map((u) => [u.id, u]));
    const ids = new Set<number>();
    for (const e of teamEntries as TimeEntry[]) ids.add(e.user_id);
    for (const ts of approvedIngestionTimesheets as IngestionTimesheetSummary[]) {
      if (ts.employee_id) ids.add(ts.employee_id);
    }
    return Array.from(ids)
      .map((id) => userById.get(id))
      .filter((u): u is User => Boolean(u))
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [teamEntries, approvedIngestionTimesheets, users]);

  // When the modal opens, pre-seed the selection from the toolbar
  // filter when it's non-empty — that's the most likely intent. Empty
  // toolbar = empty selection (user explicitly chooses what to export).
  const openExportModal = () => {
    setExportFormat('pdf');
    setPdfPickerSelection(new Set(tsEmployeeIds.length > 0 ? tsEmployeeIds : []));
    setPdfPickerSearch('');
    setExportModalOpen(true);
  };

  const buildEmployeeReports = React.useCallback(
    async (employeeIds: number[]): Promise<{ employee: User; blob: Blob }[]> => {
      if (employeeIds.length === 0) return [];
      const allUsers = users ?? [];
      const userById = new Map<number, User>(allUsers.map((u) => [u.id, u]));
      // An employee is exportable if they have real entries OR
      // approved-ingestion summary rows in the current view.
      const entriesByEmployee = new Map<number, TimeEntry[]>();
      for (const e of teamEntries as TimeEntry[]) {
        const list = entriesByEmployee.get(e.user_id) ?? [];
        list.push(e);
        entriesByEmployee.set(e.user_id, list);
      }
      const ingestionByEmployee = new Map<number, IngestionTimesheetSummary[]>();
      for (const ts of approvedIngestionTimesheets as IngestionTimesheetSummary[]) {
        if (!ts.employee_id) continue;
        const list = ingestionByEmployee.get(ts.employee_id) ?? [];
        list.push(ts);
        ingestionByEmployee.set(ts.employee_id, list);
      }

      // Resolve client names per project so the PDF can render a
      // unified Client / Project / Days / Hours table for real entries.
      // Projects load with project.client_id; clients load with name.
      const clientNameById = new Map<number, string>(
        (clientsList ?? []).map((c: { id: number; name: string }) => [c.id, c.name]),
      );
      const clientByProjectId = new Map<number, string>();
      for (const p of projects ?? []) {
        const cn = clientNameById.get(p.client_id);
        if (cn) clientByProjectId.set(p.id, cn);
      }

      const branding = buildBranding();
      const filters = buildFilters();
      const reports: { employee: User; blob: Blob }[] = [];
      for (const id of employeeIds) {
        const employee = userById.get(id);
        if (!employee) continue;
        const entries = entriesByEmployee.get(id) ?? [];
        const ingestionRows = ingestionByEmployee.get(id) ?? [];
        if (entries.length === 0 && ingestionRows.length === 0) continue;
        const manager = employee.manager_id ? userById.get(employee.manager_id) : null;
        const supervisorNames = ingestionRows
          .map((ts) => (ts.extracted_supervisor_name || '').trim())
          .filter((s): s is string => Boolean(s));
        const approverNames = ingestionRows
          .map((ts) => (ts.reviewer_name || '').trim())
          .filter((s): s is string => Boolean(s));
        const blob = buildEmployeeTimesheetPdf({
          employee,
          entries,
          ingestionTimesheets: ingestionRows.map((ts) => ({
            client_name: ts.client_name ?? null,
            period_start: ts.period_start ?? null,
            period_end: ts.period_end ?? null,
            total_hours: ts.total_hours ?? null,
          })),
          managerName: manager?.full_name ?? null,
          supervisorNames,
          approverNames,
          clientByProjectId,
          branding,
          filters,
        });
        reports.push({ employee, blob });
      }
      return reports;
    },
    [teamEntries, approvedIngestionTimesheets, users, projects, clientsList, buildBranding, buildFilters],
  );

  const generatePdfFromPicker = async () => {
    const employeeIds = [...pdfPickerSelection];
    if (employeeIds.length === 0) return;
    setExportModalOpen(false);
    const reports = await buildEmployeeReports(employeeIds);
    if (reports.length === 0) return;

    if (reports.length === 1) {
      const { employee, blob } = reports[0];
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = employeePdfFilename(employee.full_name, buildFilters());
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      return;
    }

    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    const filters = buildFilters();
    for (const { employee, blob } of reports) {
      const buf = await blob.arrayBuffer();
      zip.file(employeePdfFilename(employee.full_name, filters), buf);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const link = document.createElement('a');
    link.href = url;
    const stamp = tsStartDate && tsEndDate ? `-${tsStartDate}-to-${tsEndDate}` : '';
    link.download = `team-timesheets${stamp}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const generatePrintFromPicker = async () => {
    const employeeIds = [...pdfPickerSelection];
    if (employeeIds.length === 0) return;
    setExportModalOpen(false);
    const reports = await buildEmployeeReports(employeeIds);
    if (reports.length === 0) return;
    // Print prints the first selected report. Printing many PDFs
    // simultaneously is hostile to the user — they get N native print
    // dialogs in sequence. The popover hints at this.
    const first = reports[0];
    const url = URL.createObjectURL(first.blob);
    const win = window.open(url, '_blank');
    if (!win) {
      const link = document.createElement('a');
      link.href = url;
      link.download = employeePdfFilename(first.employee.full_name, buildFilters());
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return;
    }
    win.addEventListener('load', () => {
      try {
        win.focus();
        win.print();
      } catch {
        // Older browsers throw on print() for cross-origin blobs.
        // The user can still print from the new tab manually.
      }
    });
  };

  const filteredPickerEmployees = React.useMemo(() => {
    const q = pdfPickerSearch.trim().toLowerCase();
    if (!q) return employeesWithEntries;
    return employeesWithEntries.filter((u) => u.full_name.toLowerCase().includes(q));
  }, [employeesWithEntries, pdfPickerSearch]);

  const runExport = async () => {
    const employeeIds = [...pdfPickerSelection];
    if (employeeIds.length === 0) return;
    if (exportFormat === 'csv') {
      handleExportTeamTimesheetsCsv(employeeIds);
      setExportModalOpen(false);
      return;
    }
    if (exportFormat === 'pdf') {
      await generatePdfFromPicker();
      return;
    }
    await generatePrintFromPicker();
  };

  const unlockUser = useUnlockUserTimesheet();
  const addAlias = useAddUserEmailAlias();
  const deleteAlias = useDeleteUserEmailAlias();
  const { data: editingUserAliases = [] } = useUserEmailAliases(
    editingUser?.id ?? null,
    Boolean(editingUser?.id),
  );
  // Live list of clients linked to the user we're currently editing.
  // Separate from the read-only "user details" panel further down the
  // page (line ~2860) so the edit form can show + mutate the same
  // many-to-many user_client_assignments rows the inbox cascade writes
  // to. New-user creates skip this hook (no userId yet); the pills
  // appear once the user is saved and the form is reopened.
  const { data: editingUserClientAssignments = [] } = useUserClientAssignments(
    editingUser?.id ?? null,
    Boolean(editingUser?.id),
  );

  React.useEffect(() => {
    if (!editingUser) return;
    setForm((f) => ({ ...f, extraEmails: editingUserAliases.map((a) => a.email) }));
  }, [editingUser?.id, editingUserAliases]);

  React.useEffect(() => {
    const nextSearch = searchParams.get('search') ?? '';
    const nextRole = searchParams.get('role');
    const nextStatus = searchParams.get('status');
    const nextVerified = (searchParams.get('verified') ?? '').toUpperCase();

    setSearch(nextSearch);
    setRoleFilter(nextRole === 'EMPLOYEE' || nextRole === 'MANAGER' || nextRole === 'VIEWER' || nextRole === 'ADMIN' || nextRole === 'PLATFORM_ADMIN' ? (nextRole as UserRole) : 'ALL');
    setStatusFilter(nextStatus === 'ACTIVE' || nextStatus === 'INACTIVE' ? nextStatus : 'ALL');

    // Dashboard attention chips: ?status=NO_MANAGER and ?verified=NO.
    if (nextStatus === 'NO_MANAGER') {
      setAttentionFilter('NO_MANAGER');
    } else if (nextVerified === 'NO') {
      setAttentionFilter('UNVERIFIED');
    } else {
      setAttentionFilter('NONE');
    }
  }, [searchParams]);

  React.useEffect(() => {
    if (isLoading || projectsLoading || !users) return;

    const userIdParam = searchParams.get('userId');
    const parsedUserId = userIdParam ? Number(userIdParam) : NaN;
    if (!Number.isFinite(parsedUserId)) {
      return;
    }

    const matchedUser = users.find((candidate) => candidate.id === parsedUserId) ?? null;
    setSelectedUserDetails(matchedUser);
  }, [searchParams, isLoading, projectsLoading, users]);

  React.useEffect(() => {
    if (isLoading || projectsLoading) return;

    const hasDashboardFilter =
      searchParams.has('userId') ||
      searchParams.has('role') ||
      searchParams.has('status') ||
      searchParams.has('search');

    if (!hasDashboardFilter) return;

    requestAnimationFrame(() => {
      userListSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [searchParams, isLoading, projectsLoading]);

  React.useEffect(() => {
    if (actionMenuUserId === null) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-user-action-menu]')) setActionMenuUserId(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [actionMenuUserId]);

  React.useEffect(() => {
    if (!showModal) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [showModal]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    setClientAssignPanelUserId(selectedUserDetails?.id ?? null);
  }, [selectedUserDetails?.id]);

  if (isLoading || projectsLoading) return <Loading />;
  if (error || projectsError) return <Error message="Failed to load user management data" />;

  const allowedSupervisorRoles = getAllowedSupervisorRoles(form.role);
  const supervisors = (users ?? [])
    .filter((u) => allowedSupervisorRoles.includes(u.role))
    .filter((u) => u.id !== editingUser?.id)
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
  const usersByManager = (users ?? []).reduce<Record<number, User[]>>((acc, user) => {
    if (!user.manager_id) return acc;
    if (!acc[user.manager_id]) acc[user.manager_id] = [];
    acc[user.manager_id].push(user);
    return acc;
  }, {});
  Object.values(usersByManager).forEach((items) => items.sort((a, b) => a.full_name.localeCompare(b.full_name)));

  const visibleUserIds = new Set((users ?? []).map((u) => u.id));
  const topLevelUsers = (users ?? [])
    .filter((u) => !u.manager_id || !visibleUserIds.has(u.manager_id))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));

  const activeProjects = (projects ?? []).filter((project: Project) => project.is_active);
  const normalizedSearch = search.trim().toLowerCase();

  const searchSuggestions = Array.from(
    new Set(
      (users ?? []).flatMap((u: User) =>
        [u.full_name, u.email, u.department].filter((v): v is string => Boolean(v))
      )
    )
  ).sort();

  // Attention sub-filter predicate. NO_MANAGER mirrors the Action
  // Queue's orphan rule. UNVERIFIED uses isPendingInvite so the
  // dashboard Pending Invites tile and this filtered list show the
  // same set. (The Action Queue's >7d stale-invite badge is a
  // separate follow-up signal and not surfaced here.)
  const ORPHAN_ROLES = new Set<UserRole>(['EMPLOYEE', 'MANAGER']);
  const matchesAttention = (u: User): boolean => {
    if (attentionFilter === 'NO_MANAGER') {
      return Boolean(u.is_active) && !u.is_external && ORPHAN_ROLES.has(u.role) && u.manager_id == null;
    }
    if (attentionFilter === 'UNVERIFIED') {
      return isPendingInvite(u);
    }
    return true;
  };

  const filtered = (users ?? []).filter((u) => {
    const matchesSearch =
      normalizedSearch.length === 0 ||
      u.full_name.toLowerCase().includes(normalizedSearch) ||
      u.email.toLowerCase().includes(normalizedSearch) ||
      u.role.toLowerCase().includes(normalizedSearch) ||
      (u.department ?? '').toLowerCase().includes(normalizedSearch);

    const matchesRole = roleFilter === 'ALL' || u.role === roleFilter;
    const matchesStatus =
      statusFilter === 'ALL' ||
      (statusFilter === 'ACTIVE' && u.is_active) ||
      (statusFilter === 'INACTIVE' && !u.is_active);
    const matchesAudience =
      audienceFilter === 'ALL' ||
      (audienceFilter === 'INTERNAL' && !u.is_external) ||
      (audienceFilter === 'EXTERNAL' && Boolean(u.is_external));

    return matchesSearch && matchesRole && matchesStatus && matchesAudience && matchesAttention(u);
  });

  const userManagementAlerts = (notificationsSummary?.items ?? []).filter(
    (item) => item.route === '/admin' && !item.is_read
  );
  const employeesWithoutProjects = (users ?? []).filter(
    (u) => u.role === 'EMPLOYEE' && u.is_active && (u.project_ids ?? []).length === 0
  );
  const usersById = (users ?? []).reduce<Record<number, User>>((acc, user) => {
    acc[user.id] = user;
    return acc;
  }, {});

  const getManagerDisplayName = (managerId?: number | null): string => {
    if (!managerId) return 'Unassigned';
    if (usersById[managerId]?.full_name) return usersById[managerId].full_name;
    if (currentUser?.id === managerId) return currentUser.full_name;
    return 'Unknown';
  };

  const getUserProjectDetails = (user: User): Project[] => {
    const assignedIds = user.project_ids ?? [];
    return (projects ?? []).filter((project: Project) => assignedIds.includes(project.id));
  };

  const openCreate = () => {
    if (!isAdminUser) return;
    setEditingUser(null);
    setForm(emptyForm());
    setFormError('');
    setShowModal(true);
  };

  const openEdit = (u: User) => {
    if (!isAdminUser && (!canManageEmployeeProjects || u.role === 'ADMIN' || u.role === 'PLATFORM_ADMIN')) {
      return;
    }

    setEditingUser(u);
    const normalizedDepartment = normalizeDepartment(u.department);
    const normalizedManagerId = (() => {
      if (!u.manager_id) return null;
      const manager = (users ?? []).find((candidate) => candidate.id === u.manager_id);
      if (!manager) return null;
      if (!isSupervisorCompatibleForRoleAndDepartment(u.role, normalizedDepartment, manager)) return null;
      return u.manager_id;
    })();

    // Hydrate additional_roles from the user's roles list, excluding
    // the primary active role. Defensively dedupe and filter to the
    // set that the UI knows how to render.
    const allRoles = (u.roles ?? []).filter((r): r is UserRole => Boolean(r));
    const additional = Array.from(new Set(allRoles.filter((r) => r !== u.role)))
      .filter((r) => ADDITIONAL_ROLE_OPTIONS.includes(r));

    setForm({
      full_name: u.full_name,
      email: u.email,
      extraEmails: [],
      phones: u.phones ?? [],
      username: u.username ?? '',
      title: u.title ?? '',
      department: u.department ?? '',
      role: u.role,
      additional_roles: additional,
      is_active: u.is_active,
      can_review: u.can_review ?? false,
      audience: (u.is_external ?? false) ? 'external' : 'internal',
      manager_id: normalizedManagerId,
      project_ids: u.project_ids ?? [],
      default_client_id: u.default_client_id ?? null,
    });
    setFormError('');
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingUser(null);
    setFormError('');
    setShowNewClientInput(false);
    setNewClientName('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (editingUser && isProjectOnlyEdit) {
      try {
        await updateUser.mutateAsync({
          id: editingUser.id,
          data: {
            project_ids: form.project_ids,
          },
        });
        await refetchUsers();
        closeModal();
      } catch (err: unknown) {
        setFormError(extractErrorMessage(err));
      }
      return;
    }

    const normalizedFullName = form.full_name.trim();
    const normalizedEmail = form.email.trim().toLowerCase();
    const normalizedUsername = form.username.trim().toLowerCase();
    const normalizedTitle = form.title.trim();
    const normalizedDepartment = form.department.trim();

    // Only two fields are mandatory: full name and the audience (the
    // Internal vs External chip). Everything else is optional and the
    // backend synthesizes safe placeholders for blank email/username.
    if (!normalizedFullName) {
      setFormError('Full name is required');
      return;
    }
    if (form.audience === null) {
      setFormError('Pick user type before saving');
      return;
    }

    // Username, when supplied, still needs the platform's 3-char
    // minimum so the admin doesn't accidentally save something that
    // would later 422 on update.
    if (normalizedUsername && normalizedUsername.length < 3) {
      setFormError('Username must be at least 3 characters');
      return;
    }

    // Combined roles list: primary first, additional after, deduped.
    // The portal picker uses this set to decide whether to show.
    const combinedRoles: UserRole[] = Array.from(
      new Set([form.role, ...form.additional_roles]),
    );

    const isExternal = form.audience === 'external';

    // Offer verification email when the admin first adds a real email
    // (replacing the synthesized @local.invalid placeholder).
    const previousEmail = (editingUser?.email ?? '').toLowerCase();
    const previousWasPlaceholder = previousEmail === '' || previousEmail.endsWith('@local.invalid');
    const emailJustAdded = (
      Boolean(editingUser)
      && !isExternal
      && previousWasPlaceholder
      && Boolean(normalizedEmail)
      && !normalizedEmail.endsWith('@local.invalid')
    );

    try {
      if (editingUser) {
        const payload: UserMutationPayload = {
          full_name: normalizedFullName,
          // Only include email in the patch when the admin actually
          // typed one. Omitting leaves the existing value untouched.
          ...(normalizedEmail ? { email: normalizedEmail } : {}),
          title: normalizedTitle || null,
          department: normalizedDepartment || null,
          role: form.role,
          roles: combinedRoles,
          is_active: form.is_active,
          can_review: isExternal ? false : form.can_review,
          is_external: isExternal,
          manager_id: isExternal ? null : form.manager_id,
          project_ids: isExternal || form.role !== 'EMPLOYEE' ? [] : form.project_ids,
          default_client_id: form.default_client_id,
          phones: form.phones.filter(Boolean),
        };
        await updateUser.mutateAsync({ id: editingUser.id, data: payload });

        // Sync extra emails: add new ones, remove deleted ones.
        const existingAliasEmails = editingUserAliases.map((a) => a.email);
        const desiredEmails = form.extraEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
        const toAdd = desiredEmails.filter((e) => !existingAliasEmails.includes(e));
        const toDelete = editingUserAliases.filter((a) => !desiredEmails.includes(a.email));
        await Promise.all([
          ...toAdd.map((e) => addAlias.mutateAsync({ userId: editingUser.id, email: e })),
          ...toDelete.map((a) => deleteAlias.mutateAsync({ userId: editingUser.id, aliasId: a.id })),
        ]);

        if (emailJustAdded) {
          // window.confirm is intentional: the admin's flow is "save
          // then react to a single decision," and a heavier modal here
          // would interrupt the table refresh. Confirm dismisses
          // cleanly on Esc / Cancel and the row is already saved.
          const sendNow = window.confirm(
            `Send a verification email to ${normalizedEmail} now?\n\n`
            + 'OK = send now. Cancel = save the email but skip verification (you can resend from the table later).',
          );
          if (sendNow) {
            try {
              // Unified send-invite: backend dispatches Auth0 invite vs
              // legacy verification email based on user.auth0_sub.
              await sendInvite.mutateAsync(editingUser.id);
            } catch (err) {
              // Don't fail the whole save if the email send fails;
              // surface as an inline note instead.
              setFormError(`Saved, but verification email failed: ${extractErrorMessage(err)}`);
            }
          }
        }
        setUserActionSummary({
          action: 'updated',
          fullName: form.full_name,
          email: form.email,
          isExternal: form.audience === 'external',
          verificationEmailSent: false,
        });
      } else {
        if (!isAdminUser) {
          setFormError('Only admins can create users');
          return;
        }
        const result = await createUser.mutateAsync({
          ...form,
          full_name: normalizedFullName,
          // Send blank as undefined so the backend synthesizes a
          // placeholder rather than failing EmailStr validation on "".
          email: normalizedEmail || undefined,
          username: normalizedUsername || undefined,
          title: normalizedTitle || null,
          department: normalizedDepartment || null,
          can_review: isExternal ? false : form.can_review,
          is_external: isExternal,
          manager_id: isExternal ? null : form.manager_id,
          project_ids: isExternal || form.role !== 'EMPLOYEE' ? [] : form.project_ids,
          default_client_id: form.default_client_id,
          phones: form.phones.filter(Boolean),
        });
        // If the admin checked any additional portals, patch the new
        // user with the combined roles list. Backend UserCreate doesn't
        // accept a roles list (defaults to [role]), so we follow up with PUT.
        if (form.additional_roles.length > 0 && result?.user?.id) {
          await updateUser.mutateAsync({
            id: result.user.id,
            data: { roles: combinedRoles },
          });
        }
        // POST extra emails as aliases now that we have a user ID.
        const newUserId = result?.user?.id;
        if (newUserId) {
          const desiredEmails = form.extraEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
          await Promise.all(desiredEmails.map((e) => addAlias.mutateAsync({ userId: newUserId, email: e })));
        }

        setUserActionSummary({
          action: 'created',
          fullName: result?.user?.full_name || normalizedFullName,
          email: result?.user?.email || normalizedEmail || '',
          isExternal: Boolean(result?.user?.is_external),
          verificationEmailSent: Boolean(result?.verification_email_sent),
        });
      }
      await refetchUsers();
      closeModal();
    } catch (err: unknown) {
      setFormError(extractErrorMessage(err));
    }
  };

  const handleToggleActive = async (u: User) => {
    if (!isAdminUser) return;
    await updateUser.mutateAsync({ id: u.id, data: { is_active: !u.is_active } });
  };

  const handleDelete = async (id: number) => {
    if (!isAdminUser) return;
    await deleteUser.mutateAsync(id);
    setConfirmDeleteId(null);
  };

  const handleResetPassword = async () => {
    if (!resetPasswordUserId || !resetPasswordValue.trim()) return;
    setResetPasswordError('');
    if (resetPasswordValue.length < 8) {
      setResetPasswordError('Password must be at least 8 characters.');
      return;
    }
    try {
      await resetPassword.mutateAsync({ id: resetPasswordUserId, newPassword: resetPasswordValue });
      setResetPasswordUserId(null);
      setResetPasswordValue('');
    } catch (err: unknown) {
      setResetPasswordError(extractErrorMessage(err));
    }
  };

  const canEditUser = (u: User) => {
    if (isAdminUser) return true;
    return canManageEmployeeProjects && u.role !== 'ADMIN' && u.role !== 'PLATFORM_ADMIN';
  };

  // Unified Send invite. Backend dispatches Auth0 vs legacy path per user.
  // Used by the kebab "Send invite" item and by the bulk-bar loop. Replaces
  // the prior handleResendVerification / handleResendInvite split.
  const handleSendInvite = async (u: User) => {
    setActionMenuUserId(null);
    try {
      await sendInvite.mutateAsync(u.id);
      alert(`Invite sent to ${u.email}.`);
    } catch (err: unknown) {
      alert(extractErrorMessage(err));
    }
  };

  const isProjectOnlyEdit = Boolean(editingUser && !isAdminUser);

  const handleProjectToggle = (projectId: number) => {
    setForm((current) => ({
      ...current,
      project_ids: current.project_ids.includes(projectId)
        ? current.project_ids.filter((id) => id !== projectId)
        : [...current.project_ids, projectId],
    }));
  };

  const scrollToUserList = () => {
    requestAnimationFrame(() => {
      userListSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const applyUserListFilter = (nextRole: 'ALL' | UserRole, nextStatus: 'ALL' | 'ACTIVE' | 'INACTIVE') => {
    setSearch('');
    setRoleFilter(nextRole);
    setStatusFilter(nextStatus);
    scrollToUserList();
  };

  // When the user has a bulk selection going, dim the page and block
  // clicks on anything that isn't the bulk bar or a row checkbox. This
  // makes the bar feel modal: commit or cancel, no escape to the kebab
  // or inline Edit (which would act on a single user and leave the
  // selection in an ambiguous state).
  const selectionActive = isAdminUser && selectedUserIds.size > 0;

  return (
    <>
    {/* Subtle scrim that signals the page is in bulk-action mode while
        a selection exists. The scrim is visual only; row checkboxes
        stay above it (z-40 elsewhere) so the user can still adjust the
        selection. Per-row actions (inline Edit, kebab) are inert below
        the scrim, which is the behavior we want. */}
    {selectionActive && (
      <div
        aria-hidden="true"
        className="fixed inset-0 z-30 bg-black/30 backdrop-blur-[1px] pointer-events-none"
      />
    )}
    <div
      className="space-y-6"
      // When a bulk selection is active, the whole page is inert except
      // for the row checkboxes (which use [data-bulk-select] to opt back
      // into pointer events via the CSS rule below) and the floating
      // bar (rendered outside this div).
      style={selectionActive ? { pointerEvents: 'none' } : undefined}
    >
      {selectionActive && (
        // Local style: re-enable pointer events on row checkboxes so the
        // user can still tune the selection while everything else is locked.
        <style>{`[data-bulk-select] { pointer-events: auto !important; }`}</style>
      )}
      <div>
        <div className="flex items-center justify-between mb-6">
          <div>
            {/* Title varies by role: admins see "User Management" (the
                full workspace roster); pure managers see "My Team" (their
                direct reports only). Same component renders both, but
                the wording disambiguates which surface the user is on
                so the manager portal stops feeling like a copy of the
                admin portal. */}
            <h1 className="text-3xl font-bold">
              {activeTab === 'timesheets'
                ? 'Approved Timesheets'
                : activeTab === 'workforce'
                  ? 'Org Structure & Policies'
                  : isAdminUser
                    ? 'User Management'
                    : 'My Team'}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {activeTab === 'timesheets'
                // Count both manual time entries and inbox-approved
                // weekly submissions. The table renders both sources;
                // the header counter must too. Counting was previously
                // ``teamEntries.length`` only, which reported zero for
                // tenants that submit timesheets via the inbox flow.
                ? `${teamEntries.length + approvedIngestionTimesheets.length} entries`
                : activeTab === 'workforce'
                  ? "Manage your organization's structure and leave policies."
                  : isAdminUser
                    ? `${(users ?? []).length} total users`
                    : `${(users ?? []).length} direct ${(users ?? []).length === 1 ? 'report' : 'reports'}`}
            </p>
          </div>
          {isAdminUser && activeTab === 'users' && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowExportModal(true)}
                className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition"
              >
                <Upload className="w-4 h-4" />
                Export
              </button>
              <button
                onClick={() => setShowImportModal(true)}
                className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition"
              >
                <Download className="w-4 h-4" />
                Import
              </button>
              <button
                onClick={openCreate}
                className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 shadow"
              >
                <PlusCircle className="w-4 h-4" />
                New User
              </button>
            </div>
          )}
          {isAdminUser && activeTab === 'timesheets' && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openExportModal}
                // Enable when there's ANY exportable row — either a real
                // ``TimeEntry`` or an inbox-approved ingestion summary.
                // Gating purely on ``teamEntries.length`` made the button
                // appear dead for tenants whose only data is via the
                // inbox flow even though the export modal handles those
                // rows correctly.
                disabled={teamEntries.length === 0 && approvedIngestionTimesheets.length === 0}
                className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Upload className="w-4 h-4" />
                Export
              </button>
            </div>
          )}
        </div>

        {/* Export modal. Single-button entry point on the toolbar opens
            this. Format choice (CSV / PDF / Print) lives at the top as
            a segmented control; the employee list below is the same
            for all three formats. Pre-seeded with the toolbar's
            employee selection when non-empty. */}
        {exportModalOpen && (() => {
          const generateLabel = (() => {
            const count = pdfPickerSelection.size;
            if (exportFormat === 'csv') return 'Download CSV';
            if (exportFormat === 'pdf') {
              if (count <= 1) return 'Download PDF';
              return `Download ZIP (${count})`;
            }
            return 'Open in new tab';
          })();
          const formatHint = (() => {
            if (exportFormat === 'csv') return 'One row per time entry. Filters apply.';
            if (exportFormat === 'pdf') return 'One PDF per employee. Bundled as a ZIP when multiple are picked.';
            return 'Opens the first selected employee in a new tab and triggers print.';
          })();
          const FormatButton: React.FC<{ value: ExportFormat; label: string }> = ({ value, label }) => (
            <button
              type="button"
              onClick={() => setExportFormat(value)}
              className={`flex-1 px-3 py-2 text-xs font-medium transition ${
                exportFormat === value
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
              }`}
            >
              {label}
            </button>
          );
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
              <div
                ref={pdfPickerRef}
                className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl flex flex-col max-h-[80vh]"
                role="dialog"
                aria-modal="true"
                aria-labelledby="export-modal-title"
              >
                <div className="px-5 py-4 border-b border-border">
                  <p id="export-modal-title" className="text-base font-semibold">Export team timesheets</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Pick a format and choose which employees to include.
                  </p>
                </div>
                <div className="px-5 pt-4">
                  <div className="inline-flex w-full overflow-hidden rounded-lg border border-border">
                    <FormatButton value="csv" label="CSV" />
                    <FormatButton value="pdf" label="PDF" />
                    <FormatButton value="print" label="Print" />
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">{formatHint}</p>
                </div>
                <div className="px-5 pt-3">
                  <input
                    type="text"
                    placeholder="Search employees…"
                    value={pdfPickerSearch}
                    onChange={(e) => setPdfPickerSearch(e.target.value)}
                    className="field-input w-full text-sm py-2"
                    autoFocus
                  />
                </div>
                <div className="px-5 py-2 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    {pdfPickerSelection.size === 0
                      ? `${employeesWithEntries.length} available`
                      : `${pdfPickerSelection.size} selected`}
                  </span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      onClick={() => setPdfPickerSelection(new Set(employeesWithEntries.map((u) => u.id)))}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setPdfPickerSelection(new Set())}
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto border-t border-border">
                  {filteredPickerEmployees.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">No employees with entries in this view.</p>
                  ) : (
                    filteredPickerEmployees.map((u) => {
                      const checked = pdfPickerSelection.has(u.id);
                      return (
                        <button
                          type="button"
                          key={u.id}
                          onClick={() => {
                            setPdfPickerSelection((prev) => {
                              const next = new Set(prev);
                              if (next.has(u.id)) next.delete(u.id);
                              else next.add(u.id);
                              return next;
                            });
                          }}
                          className="flex w-full items-center gap-2.5 px-5 py-2 text-sm text-left hover:bg-muted/60 transition"
                        >
                          <span
                            className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center ${
                              checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                            }`}
                          >
                            {checked && <Check className="w-3 h-3" />}
                          </span>
                          <span className="truncate">{u.full_name}</span>
                        </button>
                      );
                    })
                  )}
                </div>
                <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setExportModalOpen(false)}
                    className="px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={pdfPickerSelection.size === 0}
                    onClick={runExport}
                    className="px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {generateLabel}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Tab switcher */}
        <div className="flex gap-1 border-b mb-6">
          <button
            onClick={() => changeTab('users')}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              activeTab === 'users'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <UserCircle className="w-4 h-4" />Users
          </button>
          {isAdminUser && (
            <button
              onClick={() => changeTab('timesheets')}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
                activeTab === 'timesheets'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Clock className="w-4 h-4" />Approved Timesheets
            </button>
          )}
          {isAdminUser && (
            <button
              onClick={() => changeTab('workforce')}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
                activeTab === 'workforce'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Users className="w-4 h-4" />Org Structure & Policies
            </button>
          )}
        </div>

        {/* Team Timesheets tab — admin only. Managers see their version
            of this surface at /approvals?tab=approved (scope=mine). */}
        {isAdminUser && activeTab === 'timesheets' && (
          <div>
            {/* Filters */}
            <div className="flex flex-wrap items-start gap-3 mb-5">
              <EmployeeMultiSelectPicker
                allEmployees={(users ?? []).filter((u) => u.is_active && u.role === 'EMPLOYEE')}
                selectedIds={tsEmployeeIds}
                onChange={setTsEmployeeIds}
                open={tsEmployeePickerOpen}
                onOpenChange={setTsEmployeePickerOpen}
              />

              <DateRangePickerCalendar
                startDate={tsStartDate}
                endDate={tsEndDate}
                onStartDateChange={setTsStartDate}
                onEndDateChange={setTsEndDate}
              />

              {/* Same shape as the employee picker + date range picker
                  so all filter pills read as one visual family. The
                  native <select> is layered transparently across the
                  whole pill so clicks anywhere open the dropdown. */}
              <div className="relative inline-flex items-center gap-2 rounded-lg border border-border bg-card pl-3 pr-9 py-2 text-sm hover:border-primary/40 transition cursor-pointer">
                <ListFilter className="w-4 h-4 text-muted-foreground" />
                <span className="text-foreground">
                  {tsStatus
                    ? `Status: ${tsStatus.charAt(0) + tsStatus.slice(1).toLowerCase()}`
                    : 'Status: All'}
                </span>
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground absolute right-2.5 pointer-events-none" />
                <select
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  value={tsStatus}
                  onChange={(e) => setTsStatus(e.target.value)}
                  aria-label="Status filter"
                >
                  <option value="" className="bg-card text-foreground">Status: All</option>
                  <option value="DRAFT" className="bg-card text-foreground">Status: Draft</option>
                  <option value="SUBMITTED" className="bg-card text-foreground">Status: Submitted</option>
                  <option value="APPROVED" className="bg-card text-foreground">Status: Approved</option>
                  <option value="REJECTED" className="bg-card text-foreground">Status: Rejected</option>
                </select>
              </div>
            </div>

            {/* Wide-range warning */}
            {tsStartDate && tsEndDate && differenceInCalendarDays(parseISO(tsEndDate), parseISO(tsStartDate)) > 31 && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>
                  Range exceeds 31 days. Loading {teamEntries.length} entries; consider narrowing the range for a quicker review.
                </span>
              </div>
            )}

            {/* Entries table — grouped by employee + project, expandable */}
            {(() => {
              type AggRow = {
                key: string;
                employeeName: string;
                projectName: string;
                totalHours: number;
                minDate: string;
                maxDate: string;
                statuses: Set<string>;
                entries: TimeEntry[];
                // Inbox-approved PDFs grouped under this employee+client.
                // Empty for pure internal rows. When non-empty, the row's
                // expand view renders a week-by-week PDF list instead of
                // (or alongside) the per-day entries view.
                ingestionSummaries: IngestionTimesheetSummary[];
                ingestionOnly?: boolean;
              };
              const map = new Map<string, AggRow>();
              (teamEntries as TimeEntry[]).forEach((entry) => {
                const k = `${entry.user_id}-${entry.project_id}`;
                const existing = map.get(k);
                if (existing) {
                  existing.totalHours += Number(entry.hours);
                  if (entry.entry_date < existing.minDate) existing.minDate = entry.entry_date;
                  if (entry.entry_date > existing.maxDate) existing.maxDate = entry.entry_date;
                  existing.statuses.add(entry.status);
                  existing.entries.push(entry);
                } else {
                  map.set(k, {
                    key: k,
                    employeeName: entry.user?.full_name ?? 'N/A',
                    projectName: entry.project?.name ?? 'N/A',
                    totalHours: Number(entry.hours),
                    minDate: entry.entry_date,
                    maxDate: entry.entry_date,
                    statuses: new Set([entry.status]),
                    entries: [entry],
                    ingestionSummaries: [],
                  });
                }
              });

              // Merge approved ingestion timesheets that have no line entries
              // (summary-only PDFs). Aggregated per (employee, client) so
              // external employees with many PDFs collapse to a single row
              // with the same Month → Week → details hierarchy as internal
              // employees. Date filtering already happens upstream in
              // ``approvedIngestionTimesheets``.
              (approvedIngestionTimesheets as IngestionTimesheetSummary[])
                .forEach((ts) => {
                  const employeeKey = ts.employee_id != null
                    ? `ext-${ts.employee_id}`
                    : `ext-name-${(ts.employee_name ?? ts.extracted_employee_name ?? '?').toLowerCase()}`;
                  const clientKey = ts.client_id != null
                    ? `c-${ts.client_id}`
                    : `c-name-${(ts.client_name ?? '?').toLowerCase()}`;
                  const k = `${employeeKey}-${clientKey}`;
                  const periodStart = ts.period_start ?? ts.reviewed_at?.slice(0, 10) ?? '';
                  const periodEnd = ts.period_end ?? periodStart;
                  const hours = Number(ts.total_hours ?? 0);
                  const existing = map.get(k);
                  if (existing) {
                    existing.totalHours += hours;
                    if (periodStart && (!existing.minDate || periodStart < existing.minDate)) existing.minDate = periodStart;
                    if (periodEnd && (!existing.maxDate || periodEnd > existing.maxDate)) existing.maxDate = periodEnd;
                    existing.statuses.add('APPROVED');
                    existing.ingestionSummaries.push(ts);
                  } else {
                    map.set(k, {
                      key: k,
                      employeeName: ts.employee_name ?? ts.extracted_employee_name ?? 'N/A',
                      projectName: ts.client_name ?? 'N/A',
                      totalHours: hours,
                      minDate: periodStart,
                      maxDate: periodEnd,
                      statuses: new Set(['APPROVED']),
                      entries: [],
                      ingestionSummaries: [ts],
                      ingestionOnly: true,
                    });
                  }
                });

              const rows = Array.from(map.values());
              const statusPriority = (s: Set<string>) => {
                if (s.has('REJECTED')) return 'REJECTED';
                if (s.has('DRAFT')) return 'DRAFT';
                if (s.has('SUBMITTED')) return 'SUBMITTED';
                return 'APPROVED';
              };
              const toggleRow = (key: string) => {
                setExpandedRowKey((prev) => {
                  const next = prev === key ? null : key;
                  setExpandedWeekKey(null); // reset week drill-in when switching employees
                  return next;
                });
              };
              return (
                <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
                  {tsLoading ? (
                    <p className="text-sm text-muted-foreground p-6 text-center">Loading…</p>
                  ) : rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-6 text-center">No time entries found for the selected filters.</p>

                  ) : (
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 border-b border-border text-left">
                        <tr>
                          <th className="px-4 py-3 font-semibold text-foreground w-6"></th>
                          <th className="px-4 py-3 font-semibold text-foreground">Employee</th>
                          <th className="px-4 py-3 font-semibold text-foreground">Project</th>
                          <th className="px-4 py-3 font-semibold text-foreground">Date Range</th>
                          <th className="px-4 py-3 font-semibold text-foreground">Days</th>
                          <th className="px-4 py-3 font-semibold text-foreground">Total Hours</th>
                          <th className="px-4 py-3 font-semibold text-foreground">Status</th>
                          <th className="px-4 py-3 font-semibold text-foreground w-10"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => {
                          const status = statusPriority(row.statuses);
                          const isExpanded = expandedRowKey === row.key;
                          const safeDate = (d: string) => d ? new Date(d + 'T00:00:00') : null;
                          const minD = safeDate(row.minDate);
                          const maxD = safeDate(row.maxDate);
                          const dateRange = !minD ? 'N/A'
                            : !maxD || row.minDate === row.maxDate
                              ? format(minD, 'MMM d, yyyy')
                              : `${format(minD, 'MMM d')} – ${format(maxD, 'MMM d, yyyy')}`;
                          const sortedEntries = [...row.entries].sort((a, b) => a.entry_date.localeCompare(b.entry_date));
                          return (
                            <>
                              <tr
                                key={row.key}
                                className="border-t border-border hover:bg-muted/40 cursor-pointer"
                                onClick={() => toggleRow(row.key)}
                              >
                                <td className="px-4 py-2.5 text-muted-foreground text-xs select-none">
                                  {isExpanded ? '▼' : '▶'}
                                </td>
                                <td className="px-4 py-2.5 font-medium text-foreground">{row.employeeName}</td>
                                <td className="px-4 py-2.5 text-muted-foreground">
                                  {row.projectName}
                                  {row.ingestionOnly && (
                                    <span className="ml-2 inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                      Client
                                    </span>
                                  )}
                                </td>
                                <td className="px-4 py-2.5 text-muted-foreground">{dateRange}</td>
                                <td className="px-4 py-2.5 text-muted-foreground">
                                  {row.ingestionOnly
                                    ? `${row.ingestionSummaries.length} ${row.ingestionSummaries.length === 1 ? 'submission' : 'submissions'}`
                                    : row.entries.length}
                                </td>
                                <td className="px-4 py-2.5 text-foreground font-medium">{fmtHrs(row.totalHours)}h</td>
                                <td className="px-4 py-2.5">
                                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                                    status === 'APPROVED' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' :
                                    status === 'SUBMITTED' ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' :
                                    status === 'REJECTED' ? 'bg-red-500/15 text-red-600 dark:text-red-400' :
                                    'bg-muted text-muted-foreground'
                                  }`}>{row.statuses.size > 1 ? 'MIXED' : status}</span>
                                </td>
                                <td className="px-4 py-2.5">
                                  {/* Attachment access moves into the per-PDF
                                      row inside the expand view — keeps the
                                      summary row clean and avoids picking
                                      one attachment to surface when there
                                      are many under the same row. */}
                                </td>
                              </tr>
                              {row.ingestionOnly && isExpanded && (() => {
                                // External / inbox-approved rows: bucket by
                                // the week the PDF's ``period_start`` lands
                                // in (rule #1 from the design discussion —
                                // multi-week PDFs land whole in the start
                                // week, intentional simplification). Each
                                // week expands to the per-PDF list with the
                                // paperclip attachment link.
                                type IngWeekBucket = {
                                  key: string;
                                  start: Date;
                                  end: Date;
                                  summaries: IngestionTimesheetSummary[];
                                  totalHours: number;
                                };
                                const ingWeekMap = new Map<string, IngWeekBucket>();
                                row.ingestionSummaries.forEach((ts) => {
                                  const periodStart = ts.period_start ?? ts.reviewed_at?.slice(0, 10) ?? '';
                                  if (!periodStart) return;
                                  const d = parseISO(periodStart);
                                  const wStart = startOfWeek(d, { weekStartsOn: tsWeekStartsOn });
                                  const wEnd = endOfWeek(d, { weekStartsOn: tsWeekStartsOn });
                                  const key = format(wStart, 'yyyy-MM-dd');
                                  const existing = ingWeekMap.get(key);
                                  const hours = Number(ts.total_hours ?? 0);
                                  if (existing) {
                                    existing.summaries.push(ts);
                                    existing.totalHours += hours;
                                  } else {
                                    ingWeekMap.set(key, {
                                      key, start: wStart, end: wEnd,
                                      summaries: [ts],
                                      totalHours: hours,
                                    });
                                  }
                                });
                                const ingWeeks = Array.from(ingWeekMap.values()).sort(
                                  (a, b) => a.key.localeCompare(b.key),
                                );
                                const activeIngWeek = expandedWeekKey
                                  ? ingWeeks.find((w) => w.key === expandedWeekKey) ?? null
                                  : null;

                                const openAttachment = async (attachmentId: number, filename: string) => {
                                  setSourceAttachmentId(attachmentId);
                                  setSourceAttachmentFilename(filename);
                                  setSourceAttachmentUrl(null);
                                  setSourceAttachmentHtml(null);
                                  setSourceAttachmentMime(null);
                                  setSourceAttachmentError(null);
                                  setSourceAttachmentLoading(true);
                                  try {
                                    const res = await adminAPI.getApprovedIngestionAttachmentHtml(attachmentId);
                                    setSourceAttachmentHtml(res.data.html);
                                    setSourceAttachmentMime(res.data.mime_type);
                                    if (res.data.filename) setSourceAttachmentFilename(res.data.filename);
                                  } catch (err: unknown) {
                                    const httpStatus = (err as { response?: { status?: number } }).response?.status;
                                    if (httpStatus === 400 || httpStatus === undefined) {
                                      try {
                                        const fileRes = await adminAPI.getApprovedIngestionAttachmentFile(attachmentId);
                                        setSourceAttachmentUrl(fileRes.url);
                                        setSourceAttachmentMime(fileRes.mime);
                                      } catch (fileErr) {
                                        setSourceAttachmentError(extractErrorMessage(fileErr) || 'Could not load attachment.');
                                      }
                                    } else {
                                      setSourceAttachmentError(extractErrorMessage(err) || 'Could not load attachment.');
                                    }
                                  } finally {
                                    setSourceAttachmentLoading(false);
                                  }
                                };

                                return (
                                  <tr className="bg-muted/20 border-t border-border">
                                    <td colSpan={8} className="px-6 py-4">
                                      {!activeIngWeek ? (
                                        <div className="space-y-2">
                                          {ingWeeks.length === 0 && (
                                            <p className="text-xs text-muted-foreground">No submissions.</p>
                                          )}
                                          {ingWeeks.map((w) => (
                                            <button
                                              key={w.key}
                                              type="button"
                                              onClick={() => setExpandedWeekKey(w.key)}
                                              className="w-full flex items-center justify-between rounded-lg border border-border bg-card/60 px-4 py-3 text-left hover:bg-card hover:border-primary/40 transition"
                                            >
                                              <div className="min-w-0">
                                                <p className="text-sm font-medium text-foreground">
                                                  Week of {format(w.start, 'MMM d')} – {format(w.end, 'MMM d, yyyy')}
                                                </p>
                                                <p className="text-xs text-muted-foreground mt-0.5">
                                                  {w.summaries.length} {w.summaries.length === 1 ? 'submission' : 'submissions'}
                                                </p>
                                              </div>
                                              <div className="flex items-center gap-3 flex-shrink-0">
                                                <span className="text-sm font-medium text-foreground">{fmtHrs(w.totalHours)}h</span>
                                                <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                                                  APPROVED
                                                </span>
                                                <ChevronRight className="w-4 h-4 text-muted-foreground" />
                                              </div>
                                            </button>
                                          ))}
                                        </div>
                                      ) : (
                                        <div className="space-y-3">
                                          <button
                                            type="button"
                                            onClick={() => setExpandedWeekKey(null)}
                                            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition"
                                          >
                                            <ChevronLeft className="w-3.5 h-3.5" />
                                            Back to weeks
                                          </button>
                                          <p className="text-sm font-medium text-foreground">
                                            Week of {format(activeIngWeek.start, 'MMM d')} – {format(activeIngWeek.end, 'MMM d, yyyy')}
                                            <span className="text-muted-foreground font-normal">
                                              {' · '}{fmtHrs(activeIngWeek.totalHours)}h · {activeIngWeek.summaries.length} {activeIngWeek.summaries.length === 1 ? 'submission' : 'submissions'}
                                            </span>
                                          </p>
                                          {activeIngWeek.summaries.map((ts) => {
                                            const periodStart = ts.period_start ?? '';
                                            const periodEnd = ts.period_end ?? periodStart;
                                            const periodLabel = periodStart
                                              ? (periodEnd && periodEnd !== periodStart
                                                  ? `${format(parseISO(periodStart), 'MMM d')} – ${format(parseISO(periodEnd), 'MMM d, yyyy')}`
                                                  : format(parseISO(periodStart), 'MMM d, yyyy'))
                                              : 'N/A';
                                            return (
                                              <div
                                                key={ts.id}
                                                className="rounded-lg border border-border bg-card/60 px-4 py-3"
                                              >
                                                <div className="flex flex-wrap items-start justify-between gap-3">
                                                  <div className="min-w-0">
                                                    <div className="flex items-center gap-2 text-sm">
                                                      <span className="font-medium text-foreground">{periodLabel}</span>
                                                      <span className="text-muted-foreground">·</span>
                                                      <span className="text-muted-foreground">{ts.client_name ?? 'Unspecified client'}</span>
                                                    </div>
                                                    {ts.extracted_supervisor_name && (
                                                      <p className="mt-1.5 text-xs text-muted-foreground">
                                                        Supervisor: <span className="text-foreground">{ts.extracted_supervisor_name}</span>
                                                      </p>
                                                    )}
                                                  </div>
                                                  <div className="flex items-center gap-3 flex-shrink-0">
                                                    <span className="text-sm font-medium text-foreground">
                                                      {fmtHrs(Number(ts.total_hours ?? 0))}h
                                                    </span>
                                                    <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                                                      APPROVED
                                                    </span>
                                                    {ts.attachment_id && (
                                                      <button
                                                        type="button"
                                                        title="View source timesheet file"
                                                        onClick={() => openAttachment(ts.attachment_id!, ts.subject ?? `Timesheet-${ts.id}`)}
                                                        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition"
                                                      >
                                                        <Paperclip className="h-3.5 w-3.5" />
                                                      </button>
                                                    )}
                                                  </div>
                                                </div>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })()}
                              {!row.ingestionOnly && isExpanded && (() => {
                                // Bucket the row's entries by ISO week-start key.
                                type WeekBucket = {
                                  key: string;
                                  start: Date;
                                  end: Date;
                                  entries: TimeEntry[];
                                  totalHours: number;
                                  statuses: Set<string>;
                                };
                                const weekMap = new Map<string, WeekBucket>();
                                sortedEntries.forEach((e) => {
                                  const d = parseISO(e.entry_date);
                                  const wStart = startOfWeek(d, { weekStartsOn: tsWeekStartsOn });
                                  const wEnd = endOfWeek(d, { weekStartsOn: tsWeekStartsOn });
                                  const key = format(wStart, 'yyyy-MM-dd');
                                  const existing = weekMap.get(key);
                                  if (existing) {
                                    existing.entries.push(e);
                                    existing.totalHours += Number(e.hours);
                                    existing.statuses.add(e.status);
                                  } else {
                                    weekMap.set(key, {
                                      key,
                                      start: wStart,
                                      end: wEnd,
                                      entries: [e],
                                      totalHours: Number(e.hours),
                                      statuses: new Set([e.status]),
                                    });
                                  }
                                });
                                const weeks = Array.from(weekMap.values()).sort(
                                  (a, b) => a.key.localeCompare(b.key),
                                );
                                const activeWeek = expandedWeekKey
                                  ? weeks.find((w) => w.key === expandedWeekKey) ?? null
                                  : null;
                                const weekStatus = (s: Set<string>) => {
                                  if (s.has('REJECTED')) return 'REJECTED';
                                  if (s.has('DRAFT')) return 'DRAFT';
                                  if (s.has('SUBMITTED')) return 'SUBMITTED';
                                  return 'APPROVED';
                                };
                                return (
                                  <tr className="bg-muted/20 border-t border-border">
                                    <td colSpan={8} className="px-6 py-4">
                                      {!activeWeek ? (
                                        <div className="space-y-2">
                                          {weeks.length === 0 && (
                                            <p className="text-xs text-muted-foreground">No entries.</p>
                                          )}
                                          {weeks.map((w) => {
                                            const ws = weekStatus(w.statuses);
                                            return (
                                              <button
                                                key={w.key}
                                                type="button"
                                                onClick={() => setExpandedWeekKey(w.key)}
                                                className="w-full flex items-center justify-between rounded-lg border border-border bg-card/60 px-4 py-3 text-left hover:bg-card hover:border-primary/40 transition"
                                              >
                                                <div className="min-w-0">
                                                  <p className="text-sm font-medium text-foreground">
                                                    Week of {format(w.start, 'MMM d')} – {format(w.end, 'MMM d, yyyy')}
                                                  </p>
                                                  <p className="text-xs text-muted-foreground mt-0.5">
                                                    {w.entries.length} {w.entries.length === 1 ? 'entry' : 'entries'}
                                                  </p>
                                                </div>
                                                <div className="flex items-center gap-3 flex-shrink-0">
                                                  <span className="text-sm font-medium text-foreground">{fmtHrs(w.totalHours)}h</span>
                                                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                                                    ws === 'APPROVED' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' :
                                                    ws === 'SUBMITTED' ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' :
                                                    ws === 'REJECTED' ? 'bg-red-500/15 text-red-600 dark:text-red-400' :
                                                    'bg-muted text-muted-foreground'
                                                  }`}>
                                                    {w.statuses.size > 1 ? 'MIXED' : ws}
                                                  </span>
                                                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                                                </div>
                                              </button>
                                            );
                                          })}
                                        </div>
                                      ) : (
                                        <div className="space-y-3">
                                          <button
                                            type="button"
                                            onClick={() => setExpandedWeekKey(null)}
                                            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition"
                                          >
                                            <ChevronLeft className="w-3.5 h-3.5" />
                                            Back to weeks
                                          </button>
                                          <p className="text-sm font-medium text-foreground">
                                            Week of {format(activeWeek.start, 'MMM d')} – {format(activeWeek.end, 'MMM d, yyyy')}
                                            <span className="text-muted-foreground font-normal"> · {fmtHrs(activeWeek.totalHours)}h · {activeWeek.entries.length} entries</span>
                                          </p>
                                          {activeWeek.entries.map((entry) => {
                                            const eStatus = entry.status;
                                            const submittedAt = entry.submitted_at
                                              ? format(new Date(entry.submitted_at), 'MMM d, yyyy · h:mm a')
                                              : null;
                                            const approvedAt = entry.approved_at
                                              ? format(new Date(entry.approved_at), 'MMM d, yyyy · h:mm a')
                                              : null;
                                            return (
                                              <div
                                                key={entry.id}
                                                className="rounded-lg border border-border bg-card/60 px-4 py-3"
                                              >
                                                <div className="flex flex-wrap items-start justify-between gap-3">
                                                  <div className="min-w-0">
                                                    <div className="flex items-center gap-2 text-sm">
                                                      <span className="font-medium text-foreground">
                                                        {format(new Date(entry.entry_date + 'T00:00:00'), 'EEE, MMM d')}
                                                      </span>
                                                      <span className="text-muted-foreground">·</span>
                                                      <span className="text-muted-foreground">{entry.task?.name ?? 'No task'}</span>
                                                    </div>
                                                    {entry.description && (
                                                      <div className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
                                                        <MessageSquare className="w-3 h-3 mt-0.5 flex-shrink-0" />
                                                        <ExpandableDescription text={entry.description} />
                                                      </div>
                                                    )}
                                                  </div>
                                                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                                                    <div className="flex items-center gap-3">
                                                      <span className="text-sm font-medium text-foreground">
                                                        {fmtHrs(Number(entry.hours))}h
                                                      </span>
                                                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                                                        eStatus === 'APPROVED' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' :
                                                        eStatus === 'SUBMITTED' ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' :
                                                        eStatus === 'REJECTED' ? 'bg-red-500/15 text-red-600 dark:text-red-400' :
                                                        'bg-muted text-muted-foreground'
                                                      }`}>{eStatus}</span>
                                                    </div>
                                                    {(() => {
                                                      const block = formatTimeBlock(entry.start_time, entry.end_time);
                                                      return block ? (
                                                        <span className="text-[11px] text-muted-foreground tabular-nums">{block}</span>
                                                      ) : null;
                                                    })()}
                                                  </div>
                                                </div>

                                                {(submittedAt || approvedAt || entry.rejection_reason) && (
                                                  <div className="mt-3 grid gap-1.5 text-xs text-muted-foreground sm:grid-cols-2">
                                                    {submittedAt && (
                                                      <div className="flex items-center gap-1.5">
                                                        <Clock className="w-3 h-3 flex-shrink-0" />
                                                        <span>Submitted {submittedAt}</span>
                                                      </div>
                                                    )}
                                                    {approvedAt && eStatus === 'APPROVED' && (
                                                      <div className="flex items-center gap-1.5">
                                                        <UserCheck className="w-3 h-3 flex-shrink-0 text-emerald-500" />
                                                        <span>
                                                          Approved by{' '}
                                                          <span className="text-foreground">{entry.approved_by_name ?? `user #${entry.approved_by ?? '?'}`}</span>
                                                          {' · '}{approvedAt}
                                                        </span>
                                                      </div>
                                                    )}
                                                    {eStatus === 'REJECTED' && entry.rejection_reason && (
                                                      <div className="flex items-start gap-1.5 sm:col-span-2">
                                                        <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5 text-red-500" />
                                                        <span>
                                                          Rejected
                                                          {entry.approved_by_name ? <> by <span className="text-foreground">{entry.approved_by_name}</span></> : null}
                                                          {approvedAt ? ` · ${approvedAt}` : ''}
                                                          <span className="block mt-0.5 text-foreground">{entry.rejection_reason}</span>
                                                        </span>
                                                      </div>
                                                    )}
                                                  </div>
                                                )}
                                              </div>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })()}
                            </>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {/* Source file slide-over.
            Render path branches on what's available:
              - HTML (spreadsheets): rendered via dangerouslySetInnerHTML
                from the server-rendered xlsx_render output.
              - PDF / image blob URL: iframe (browser renders inline).
              - Anything else: explicit Download button so opening the
                modal never silently triggers a file download. */}
        {sourceAttachmentId !== null && (
          <div className="fixed inset-0 z-50 flex justify-end">
            <div className="absolute inset-0 bg-black/30" onClick={closeSourceAttachment} />
            <div className="relative bg-card border-l border-border shadow-xl w-full max-w-3xl flex flex-col">
              <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Source File</p>
                  <p className="font-semibold text-foreground truncate max-w-md">{sourceAttachmentFilename}</p>
                </div>
                <button
                  onClick={closeSourceAttachment}
                  className="inline-flex h-8 w-8 items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex-1 overflow-auto p-4">
                {sourceAttachmentLoading ? (
                  <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Loading…</div>
                ) : sourceAttachmentHtml ? (
                  // Server-rendered xlsx/csv HTML. xlsx_render returns
                  // a sanitized table snippet — safe to inject. We wrap
                  // it so column widths don't blow past the panel.
                  <div
                    className="text-sm overflow-x-auto [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted/40 [&_th]:font-medium"
                    dangerouslySetInnerHTML={{ __html: sourceAttachmentHtml }}
                  />
                ) : sourceAttachmentUrl && (isInlineRenderableMime(sourceAttachmentMime) || isSpreadsheetMime(sourceAttachmentMime)) ? (
                  <iframe src={sourceAttachmentUrl} className="h-full w-full border-0 min-h-[70vh]" title={sourceAttachmentFilename} />
                ) : sourceAttachmentUrl ? (
                  <div className="flex flex-col items-start gap-3">
                    <p className="text-sm text-muted-foreground">
                      This file type can't be previewed in the browser.
                    </p>
                    <a
                      href={sourceAttachmentUrl}
                      download={sourceAttachmentFilename || undefined}
                      className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted transition"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download {sourceAttachmentFilename || 'file'}
                    </a>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                    {sourceAttachmentError ?? 'Failed to load file.'}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {isAdminUser && activeTab === 'workforce' && (
          <WorkforceSetupPanel
            departments={departments}
            leaveTypes={leaveTypesAll}
            newDepartmentName={newDepartmentName}
            setNewDepartmentName={setNewDepartmentName}
            createDepartmentPending={createDepartment.isPending}
            deleteDepartmentPending={deleteDepartment.isPending}
            onCreateDepartment={(name) => createDepartment.mutate(name, {
              onSuccess: () => setNewDepartmentName(''),
              onError: () => alert('Failed to create department (it may already exist).'),
            })}
            onDeleteDepartment={(id, name) => {
              if (!window.confirm(`Remove department "${name}"? Users currently assigned will keep the value as a legacy reference.`)) return;
              deleteDepartment.mutate(id);
            }}
            newLeaveTypeLabel={newLeaveTypeLabel}
            setNewLeaveTypeLabel={setNewLeaveTypeLabel}
            newLeaveTypeColor={newLeaveTypeColor}
            setNewLeaveTypeColor={setNewLeaveTypeColor}
            createLeaveTypePending={createLeaveType.isPending}
            deleteLeaveTypePending={deleteLeaveType.isPending}
            onCreateLeaveType={() => {
              const label = newLeaveTypeLabel.trim();
              if (!label) return;
              createLeaveType.mutate(
                { label, color: newLeaveTypeColor },
                {
                  onSuccess: () => {
                    setNewLeaveTypeLabel('');
                    setNewLeaveTypeColor('#6b7280');
                  },
                  onError: () => alert('Failed to create leave type (code may already exist).'),
                },
              );
            }}
            onToggleLeaveTypeActive={(lt) => updateLeaveType.mutate({ id: lt.id, data: { is_active: !lt.is_active } })}
            onRenameLeaveType={(lt, label) => updateLeaveType.mutate({ id: lt.id, data: { label } })}
            onDeleteLeaveType={(lt) => {
              if (!window.confirm(`Permanently delete "${lt.label}"? This is only possible if no time-off requests reference it; otherwise deactivate instead.`)) return;
              deleteLeaveType.mutate(lt.id, {
                onError: (err: unknown) => {
                  const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
                  alert(detail || 'Failed to delete leave type.');
                },
              });
            }}
          />
        )}

        {activeTab === 'users' && (<><div className="grid grid-cols-1 md:grid-cols-[1fr_200px_200px] gap-3 mb-5">
          <SearchInput
            value={search}
            onChange={setSearch}
            suggestions={searchSuggestions}
            onSelect={(val) => {
              const match = (users ?? []).find(
                (u) => u.full_name === val || u.email === val
              );
              if (match) {
                setSearch('');
                setSelectedUserDetails(match);
              }
            }}
            placeholder="Search by name, email, role, department..."
            className="w-full px-3 py-2 border rounded-lg"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'ALL' | 'ACTIVE' | 'INACTIVE')}
            className="w-full px-3 py-2 border rounded-lg"
          >
            <option value="ALL">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
          <select
            value={audienceFilter}
            onChange={(e) => setAudienceFilter(e.target.value as 'ALL' | 'INTERNAL' | 'EXTERNAL')}
            className="w-full px-3 py-2 border rounded-lg"
            title="Internal employees log into the app; external are contractors / vendors with no login."
          >
            <option value="ALL">Internal + External</option>
            <option value="INTERNAL">Internal only</option>
            <option value="EXTERNAL">External only</option>
          </select>
        </div>
        {/* Attention filter chip — surfaced when the admin clicked
            through from the dashboard Action Queue. The X button
            clears the filter (also rewrites the URL so a refresh
            doesn't bring it back). */}
        {attentionFilter !== 'NONE' && (
          <div className="mb-5 flex items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              {attentionFilter === 'NO_MANAGER'
                ? `Showing ${filtered.length} user${filtered.length === 1 ? '' : 's'} without a manager`
                : `Showing ${filtered.length} pending invitation${filtered.length === 1 ? '' : 's'}`}
              <button
                type="button"
                onClick={() => {
                  setAttentionFilter('NONE');
                  // Strip the URL param so refresh doesn't re-apply.
                  setSearchParams((prev) => {
                    const next = new URLSearchParams(prev);
                    if (next.get('status') === 'NO_MANAGER') next.delete('status');
                    next.delete('verified');
                    return next;
                  }, { replace: true });
                }}
                className="text-primary/70 hover:text-primary"
                aria-label="Clear attention filter"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-6">
          {(() => {
            const allSelected = roleFilter === 'ALL' && statusFilter !== 'INACTIVE';
            const totalUsers = (users ?? []).length;
            return (
              <button
                type="button"
                onClick={() => applyUserListFilter('ALL', 'ALL')}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${allSelected ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground'}`}
              >
                All
                <span className={`font-bold ${allSelected ? 'text-primary' : 'text-foreground'}`}>{totalUsers}</span>
              </button>
            );
          })()}
          {roles.map((role) => {
            const count = (users ?? []).filter((u) => u.role === role).length;
            const isSelected = roleFilter === role && statusFilter === 'ALL';
            return (
              <button
                key={role}
                type="button"
                onClick={() => applyUserListFilter(role, 'ALL')}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${isSelected ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground'}`}
              >
                {role}
                <span className={`font-bold ${isSelected ? 'text-primary' : 'text-foreground'}`}>{count}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => applyUserListFilter('ALL', 'INACTIVE')}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${roleFilter === 'ALL' && statusFilter === 'INACTIVE' ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground'}`}
          >
            Inactive
            <span className={`font-bold ${roleFilter === 'ALL' && statusFilter === 'INACTIVE' ? 'text-primary' : 'text-foreground'}`}>{(users ?? []).filter((u) => !u.is_active).length}</span>
          </button>
        </div>

        {isAdminUser && userManagementAlerts.length > 0 && (
        <div className="bg-card border rounded-xl p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">Active User Management Alerts</h2>
            <span className="text-xs font-semibold rounded-full bg-red-100 text-red-700 px-2 py-0.5">
              {notificationsSummary?.route_counts?.admin ?? 0}
            </span>
          </div>
          <div className="space-y-2">
            {userManagementAlerts.map((alert) => {
              const isNoProjectAlert = alert.title.toLowerCase().includes('project access');
              return (
                <div
                  key={alert.id}
                  className={`rounded-lg border p-3 bg-muted/20 ${isNoProjectAlert ? 'cursor-pointer hover:bg-muted/40 transition-colors' : ''}`}
                  onClick={isNoProjectAlert ? () => setShowNoProjectModal(true) : undefined}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">{alert.title}</p>
                    <div className="flex items-center gap-2">
                      {isNoProjectAlert && (
                        <span className="text-xs text-primary font-medium">View employees →</span>
                      )}
                      <span className="text-[11px] font-semibold rounded-full bg-red-100 text-red-700 px-2 py-0.5">
                        {alert.count > 99 ? '99+' : alert.count}
                      </span>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">{alert.message}</p>
                </div>
              );
            })}
          </div>
        </div>
        )}

        {isAdminUser && (
          <div className="bg-card border rounded-xl mb-6 overflow-hidden">
            <button
              type="button"
              onClick={() => setOrgChartExpanded((prev) => !prev)}
              aria-expanded={orgChartExpanded}
              aria-controls="admin-org-chart-body"
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/40 transition"
            >
              <h2 className="text-lg font-semibold">Org Chart</h2>
              <ChevronDown
                className={cn(
                  'h-4 w-4 text-muted-foreground transition-transform duration-200',
                  orgChartExpanded && 'rotate-180',
                )}
                aria-hidden="true"
              />
            </button>
            {orgChartExpanded && (
              <div id="admin-org-chart-body" className="border-t px-4 pb-4 pt-4">
                <OrganizationalChart
                  users={users ?? []}
                  usersByManager={usersByManager}
                  topLevelUsers={topLevelUsers}
                  currentUserId={currentUser?.id}
                />
              </div>
            )}
          </div>
        )}

        <div ref={userListSectionRef} className="surface-card overflow-hidden">
          {/* BulkSelectBar moved OUT of this wrapper — see render block
              below the closing of the inert page wrapper. Keeping it
              inside would inherit pointer-events: none from the
              selection-active wrapper above and the bar's own buttons
              would silently fail clicks. */}
          <table className="w-full text-sm">
            <thead className="border-b border-border">
              <tr>
                {isAdminUser && (() => {
                  const selectable = filtered.filter((u) => u.id !== currentUser?.id);
                  const selectedSelectable = selectable.filter((u) => selectedUserIds.has(u.id)).length;
                  const allSelected = selectable.length > 0 && selectedSelectable === selectable.length;
                  // Indeterminate when some-but-not-all are selected. Communicates
                  // "I have a partial selection" instead of looking fully checked
                  // when the current user (yourself) is the only one excluded.
                  const someSelected = selectedSelectable > 0 && !allSelected;
                  return (
                    <th className="w-10 px-4 py-3" data-bulk-select>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => { if (el) el.indeterminate = someSelected; }}
                        onChange={(e) => e.target.checked ? selectAllUsers() : clearSelection()}
                        className="rounded border-gray-300"
                        aria-label={
                          allSelected ? `Deselect all ${selectable.length} users`
                            : someSelected ? `${selectedSelectable} of ${selectable.length} users selected`
                            : `Select all ${selectable.length} users`
                        }
                      />
                    </th>
                  );
                })()}
                <th className="text-left px-4 py-3 font-semibold">Name</th>
                <th className="text-left px-4 py-3 font-semibold">Email</th>
                <th className="text-left px-4 py-3 font-semibold">Role</th>
                <th className="text-left px-4 py-3 font-semibold">Title</th>
                <th className="text-left px-4 py-3 font-semibold">Department</th>
                <th className="text-left px-4 py-3 font-semibold">Status</th>
                <th className="text-right px-4 py-3 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={isAdminUser ? 9 : 8} className="text-center py-10 text-muted-foreground">
                    No users found
                  </td>
                </tr>
              )}
              {filtered.map((u) => (
                <tr key={u.id} className={`h-11 hover:bg-muted transition-colors ${!u.is_active ? 'opacity-50' : ''} ${selectedUserIds.has(u.id) ? 'bg-primary/5' : ''}`}>
                  {isAdminUser && (
                    <td className="w-10 px-4 py-3" data-bulk-select>
                      {u.id !== currentUser?.id ? (
                        <input
                          type="checkbox"
                          checked={selectedUserIds.has(u.id)}
                          onChange={() => toggleUserSelection(u.id)}
                          className="rounded border-gray-300"
                        />
                      ) : (
                        <span />
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3 font-medium">
                    <button
                      onClick={() => setSelectedUserDetails(u)}
                      className="text-left underline underline-offset-2 hover:text-primary"
                    >
                      {u.full_name}
                    </button>
                    {u.id === currentUser?.id && (
                      <span className="ml-2 text-[10px] text-muted-foreground border rounded-full px-1.5 py-0.5">you</span>
                    )}
                    {u.timesheet_locked && (
                      <button
                        className="ml-1 text-amber-500 hover:text-amber-700"
                        title={u.timesheet_locked_reason ?? 'Timesheet locked. Click to unlock.'}
                        onClick={(e) => { e.stopPropagation(); unlockUser.mutate(u.id); }}
                      >
                        🔒
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {u.email?.endsWith('@local.invalid') ? 'N/A' : u.email}
                  </td>
                  <td className="px-4 py-3">{roleBadge(u.role, u.roles, u.is_external)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{u.title || 'N/A'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{u.department || 'N/A'}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleToggleActive(u)}
                      disabled={!isAdminUser || u.id === currentUser?.id || selectionActive}
                      title={
                        u.id === currentUser?.id ? "Can't deactivate yourself"
                          : selectionActive ? 'Finish the bulk action first'
                          : undefined
                      }
                      className={`inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium transition ${
                        u.is_active
                          ? 'bg-[var(--success-light)] text-[var(--success)]'
                          : 'bg-[var(--bg-surface-3)] text-[var(--text-secondary)]'
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      {u.is_active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    {/* While a bulk selection is active, hide the per-row
                        action affordances so the user can't trigger a
                        single-row action with an ambiguous selected set
                        in the background. The floating bar is the only
                        place actions live during a selection. */}
                    <div className={`flex items-center justify-end gap-1 ${selectionActive ? 'invisible' : ''}`} data-user-action-menu>
                      {/* Inline Edit. The 90%-case action gets one click; the
                          rest stay behind the kebab. Only shown when the
                          admin actually has edit rights on this row. */}
                      {canEditUser(u) && (
                        <button
                          type="button"
                          onClick={() => openEdit(u)}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 transition"
                          title="Edit user"
                        >
                          <Pencil className="h-3 w-3" />
                          Edit
                        </button>
                      )}
                      <UserActionMenu
                        isOpen={actionMenuUserId === u.id}
                        onToggle={() => setActionMenuUserId(actionMenuUserId === u.id ? null : u.id)}
                        onClose={() => setActionMenuUserId(null)}
                        canManage={isAdminUser && u.id !== currentUser?.id}
                        canManageAuth={isAdminUser && u.id !== currentUser?.id && !u.is_external}
                        isSelf={u.id === currentUser?.id}
                        isSendInviteDisabled={sendInvite.isPending}
                        isActive={u.is_active}
                        onSendInvite={() => handleSendInvite(u)}
                        onResetPassword={() => { setResetPasswordUserId(u.id); setResetPasswordValue(''); setResetPasswordError(''); }}
                        onDisableLogin={() => updateUser.mutate({ id: u.id, data: { is_active: false } })}
                        onDelete={() => setConfirmDeleteId(u.id)}
                        onManageOwnAccount={() => navigate('/profile')}
                        onViewTimesheets={() => navigate(`/user-management/${u.id}/timesheets`)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></>)}
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 bg-[rgba(0,0,0,0.15)]">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-user-modal-title"
            className="ml-auto flex h-full w-full max-w-[420px] flex-col bg-card shadow-[0_4px_16px_rgba(0,0,0,0.08)]"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
              <h2 id="edit-user-modal-title" className="text-lg font-bold">
                {editingUser ? `Edit User · ${editingUser.full_name}` : 'New User'}
              </h2>
              <button onClick={closeModal} className="p-1.5 rounded-lg hover:bg-muted">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 space-y-4 overflow-y-auto px-6 py-6">
                {isProjectOnlyEdit ? (
                  <>
                    <div className="rounded-lg bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                      Managers can only update project access for employees. Updating access for <span className="font-medium text-foreground">{editingUser?.full_name}</span>.
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2">Project Access</label>
                      <div className="max-h-60 overflow-y-auto rounded border p-3 space-y-2 bg-muted/10">
                        {activeProjects.length === 0 && (
                          <p className="text-sm text-muted-foreground">No active projects available.</p>
                        )}
                        {activeProjects.map((project: Project) => (
                          <label key={project.id} className="flex items-start gap-3 text-sm">
                            <input
                              type="checkbox"
                              checked={form.project_ids.includes(project.id)}
                              onChange={() => handleProjectToggle(project.id)}
                              disabled={!canManageEmployeeProjects}
                              className="mt-0.5 rounded"
                            />
                            <span>
                              <span className="font-medium text-foreground">{project.name}</span>
                              {project.client?.name && (
                                <span className="block text-xs text-muted-foreground">{project.client.name}</span>
                              )}
                            </span>
                          </label>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        Selected projects control project visibility for this report.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        User type
                        <span className="ml-1 text-destructive" aria-hidden>*</span>
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        {(['internal', 'external'] as const).map((opt) => {
                          const checked = form.audience === opt;
                          const label = opt === 'internal' ? 'Internal' : 'External';
                          return (
                            <button
                              key={opt}
                              type="button"
                              onClick={() => setForm((f) => ({ ...f, audience: opt }))}
                              className={cn(
                                'rounded-lg border px-3 py-2 text-sm font-semibold transition',
                                checked
                                  ? 'border-primary bg-primary/10 ring-1 ring-primary/40'
                                  : 'border-border hover:bg-muted/40',
                              )}
                              aria-pressed={checked}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">
                        Full Name
                        <span className="ml-1 text-destructive" aria-hidden>*</span>
                      </label>
                      <input
                        required
                        value={form.full_name}
                        onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
                        className="w-full px-3 py-2 border rounded-lg"
                        placeholder="Jane Smith"
                      />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-sm font-medium">Email</label>
                        <button
                          type="button"
                          disabled={form.extraEmails.length >= MAX_EMAIL_ALIASES}
                          onClick={() => setForm((f) => ({ ...f, extraEmails: [...f.extraEmails, ''] }))}
                          className="text-xs text-primary hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
                        >
                          + Add Email
                        </button>
                      </div>
                      {/* Primary email row */}
                      <div className="flex items-center gap-2 mb-1.5">
                        <input
                          type="email"
                          value={form.email}
                          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                          className="flex-1 px-3 py-2 border rounded-lg text-sm"
                          placeholder="jane@example.com"
                        />
                        <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                          Primary
                        </span>
                      </div>
                      {/* Extra email rows */}
                      {form.extraEmails.map((extra, idx) => (
                        <div key={idx} className="flex items-center gap-2 mb-1.5">
                          <input
                            type="email"
                            value={extra}
                            onChange={(e) => {
                              const val = e.target.value;
                              setForm((f) => {
                                const next = [...f.extraEmails];
                                next[idx] = val;
                                return { ...f, extraEmails: next };
                              });
                            }}
                            className="flex-1 px-3 py-2 border rounded-lg text-sm"
                            placeholder="other@example.com"
                          />
                          <button
                            type="button"
                            title="Set as primary"
                            disabled={!extra.trim() || !extra.includes('@')}
                            onClick={() => {
                              const trimmed = extra.trim().toLowerCase();
                              setForm((f) => {
                                const oldPrimary = f.email;
                                const nextExtras = f.extraEmails
                                  .map((e, i) => (i === idx ? oldPrimary : e))
                                  .filter((e) => e !== trimmed);
                                return { ...f, email: trimmed, extraEmails: nextExtras };
                              });
                            }}
                            className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed transition"
                          >
                            Set primary
                          </button>
                          <button
                            type="button"
                            aria-label="Remove email"
                            onClick={() =>
                              setForm((f) => ({
                                ...f,
                                extraEmails: f.extraEmails.filter((_, i) => i !== idx),
                              }))
                            }
                            className="shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                    {/* Phone numbers: primary + up to 2 extras */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-sm font-medium">Phone</label>
                        <button
                          type="button"
                          disabled={form.phones.length >= MAX_PHONES}
                          onClick={() => setForm((f) => ({ ...f, phones: [...f.phones, ''] }))}
                          className="text-xs text-primary hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
                        >
                          + Add Phone
                        </button>
                      </div>
                      {form.phones.length === 0 && (
                        <input
                          type="tel"
                          placeholder="+1 555 000 0000"
                          className="w-full px-3 py-2 border rounded-lg text-sm"
                          onFocus={() => setForm((f) => ({ ...f, phones: [''] }))}
                          readOnly
                        />
                      )}
                      {form.phones.map((phone, idx) => (
                        <div key={idx} className="flex items-center gap-2 mb-1.5">
                          <input
                            type="tel"
                            value={phone}
                            onChange={(e) => {
                              const val = e.target.value;
                              setForm((f) => {
                                const next = [...f.phones];
                                next[idx] = val;
                                return { ...f, phones: next };
                              });
                            }}
                            className="flex-1 px-3 py-2 border rounded-lg text-sm"
                            placeholder="+1 555 000 0000"
                          />
                          {idx === 0 && form.phones.length > 0 && (
                            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                              Primary
                            </span>
                          )}
                          {idx > 0 && (
                            <button
                              type="button"
                              title="Set as primary"
                              onClick={() => {
                                setForm((f) => {
                                  const next = [...f.phones];
                                  const [primary] = next.splice(idx, 1);
                                  next.unshift(primary);
                                  return { ...f, phones: next };
                                });
                              }}
                              className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary transition"
                            >
                              Set primary
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label="Remove phone"
                            onClick={() =>
                              setForm((f) => ({ ...f, phones: f.phones.filter((_, i) => i !== idx) }))
                            }
                            className="shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">Username</label>
                      <input
                        type="text"
                        value={form.username}
                        onChange={(e) => setForm((f) => ({ ...f, username: e.target.value.toLowerCase() }))}
                        className="w-full px-3 py-2 border rounded-lg"
                        placeholder="jane.smith"
                        minLength={3}
                      />
                    </div>
                    {form.audience === 'internal' && (<>
                    <div>
                      <label className="block text-sm font-medium mb-1">Role</label>
                      <select
                        value={form.role}
                        onChange={(e) => {
                          const nextRole = e.target.value as UserRole;
                          setForm((f) => {
                            const nextAllowedSupervisorRoles = getAllowedSupervisorRoles(nextRole);
                            const nextManagerId =
                              f.manager_id &&
                              (users ?? []).some(
                                (candidate) =>
                                  candidate.id === f.manager_id &&
                                  candidate.id !== editingUser?.id &&
                                  nextAllowedSupervisorRoles.includes(candidate.role)
                              )
                                ? f.manager_id
                                : null;

                            // Drop the new primary from additional_roles
                            // so the combined list never duplicates.
                            const nextAdditional = f.additional_roles.filter((r) => r !== nextRole);

                            return {
                              ...f,
                              role: nextRole,
                              additional_roles: nextAdditional,
                              manager_id: nextManagerId,
                              project_ids: nextRole === 'EMPLOYEE' ? f.project_ids : [],
                            };
                          });
                        }}
                        className="w-full px-3 py-2 border rounded-lg"
                      >
                        {roles.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>
                    {/* Additional roles for multi-portal users. */}
                    {form.role !== 'EMPLOYEE' && form.role !== 'PLATFORM_ADMIN' && (
                      <div>
                        <label className="block text-sm font-medium mb-1">
                          Additional portals
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            access to other roles for the same login
                          </span>
                        </label>
                        <div className="space-y-1.5 rounded border px-3 py-2">
                          {ADDITIONAL_ROLE_OPTIONS.filter((r) => r !== form.role).map((r) => {
                            const checked = form.additional_roles.includes(r);
                            return (
                              <label key={r} className="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    setForm((f) => {
                                      const next = e.target.checked
                                        ? Array.from(new Set([...f.additional_roles, r]))
                                        : f.additional_roles.filter((existing) => existing !== r);
                                      return { ...f, additional_roles: next };
                                    });
                                  }}
                                  className="h-4 w-4"
                                />
                                <span>{r}</span>
                              </label>
                            );
                          })}
                          <p className="text-[11px] text-muted-foreground pt-1">
                            When more than one portal is checked, the user picks one at login and can switch via the topbar.
                          </p>
                        </div>
                      </div>
                    )}
                    {(form.role === 'MANAGER' || form.role === 'EMPLOYEE') && (
                      <div>
                        <label className="block text-sm font-medium mb-1">Title</label>
                        <input
                          required
                          value={form.title}
                          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                          className="w-full px-3 py-2 border rounded-lg"
                          placeholder={form.role === 'MANAGER' ? 'Manager' : 'Senior Software Engineer'}
                        />
                      </div>
                    )}
                    {(form.role === 'MANAGER' || form.role === 'EMPLOYEE' || form.role === 'ADMIN') && (
                      <div>
                        <label className="block text-sm font-medium mb-1">Department</label>
                        <div className="flex gap-2">
                          <select
                            required={form.role === 'MANAGER'}
                            value={form.department}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v === '__new__') {
                                const name = window.prompt('New department name')?.trim();
                                if (!name) return;
                                createDepartment.mutate(name, {
                                  onSuccess: (created) => setForm((f) => ({ ...f, department: created.name })),
                                  onError: () => alert('Failed to create department (it may already exist).'),
                                });
                                return;
                              }
                              setForm((f) => ({ ...f, department: v }));
                            }}
                            className="flex-1 px-3 py-2 border rounded-lg"
                          >
                            <option value="">{form.role === 'MANAGER' ? 'Select a department' : 'No department'}</option>
                            {departments.map((d) => (
                              <option key={d.id} value={d.name}>{d.name}</option>
                            ))}
                            {form.department && !departments.some((d) => d.name === form.department) && (
                              <option value={form.department}>{form.department} (legacy)</option>
                            )}
                            <option value="__new__">+ Add new department…</option>
                          </select>
                        </div>
                      </div>
                    )}
                    <div>
                      <label className="block text-sm font-medium mb-1">Reports To</label>
                      <select
                        value={form.manager_id ?? ''}
                        onChange={(e) => setForm((f) => ({ ...f, manager_id: e.target.value ? Number(e.target.value) : null }))}
                        className="w-full px-3 py-2 border rounded-lg"
                      >
                        <option value="">Unassigned</option>
                        {supervisors
                          .filter((supervisor) => supervisor.id !== editingUser?.id)
                          .map((supervisor) => (
                            <option key={supervisor.id} value={supervisor.id}>{supervisor.full_name}</option>
                          ))}
                      </select>
                    </div>
                    </>)}
                  </>
                )}
                {!isProjectOnlyEdit && form.audience === 'external' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium mb-1">Title</label>
                      <input
                        value={form.title}
                        onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                        className="w-full px-3 py-2 border rounded-lg"
                        placeholder="e.g. Senior Software Engineer"
                      />
                    </div>
                    <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-sm font-medium">Primary client</label>
                      <button
                        type="button"
                        onClick={() => { setShowNewClientInput((v) => !v); setNewClientName(''); }}
                        className="text-xs text-primary hover:underline"
                      >
                        {showNewClientInput ? 'Cancel' : '+ Add client'}
                      </button>
                    </div>
                    {showNewClientInput ? (
                      <div className="flex items-center gap-2">
                        <input
                          autoFocus
                          type="text"
                          value={newClientName}
                          onChange={(e) => setNewClientName(e.target.value)}
                          placeholder="Client name"
                          className="flex-1 px-3 py-2 border rounded-lg text-sm"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              if (!newClientName.trim()) return;
                              createClient.mutateAsync({ name: newClientName.trim() }).then((c) => {
                                setForm((f) => ({ ...f, default_client_id: c.id }));
                                setShowNewClientInput(false);
                                setNewClientName('');
                              });
                            }
                          }}
                        />
                        <button
                          type="button"
                          disabled={!newClientName.trim() || createClient.isPending}
                          onClick={() => {
                            if (!newClientName.trim()) return;
                            createClient.mutateAsync({ name: newClientName.trim() }).then((c) => {
                              setForm((f) => ({ ...f, default_client_id: c.id }));
                              setShowNewClientInput(false);
                              setNewClientName('');
                            });
                          }}
                          className="px-3 py-2 rounded bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 hover:bg-primary/90 transition"
                        >
                          {createClient.isPending ? '…' : 'Add'}
                        </button>
                      </div>
                    ) : (
                      <select
                        value={form.default_client_id ?? ''}
                        onChange={(e) => setForm((f) => ({ ...f, default_client_id: e.target.value ? Number(e.target.value) : null }))}
                        className="w-full px-3 py-2 border rounded-lg"
                      >
                        <option value="">No default</option>
                        {clientsList.map((client: { id: number; name: string }) => (
                          <option key={client.id} value={client.id}>{client.name}</option>
                        ))}
                      </select>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">Select the client this person works with most often. This will be used by default for their timesheets.</p>

                    {/* ── Linked clients (multi-pill). Mirrors the underlying
                         user_client_assignments table the inbox cascade writes
                         to. Only renders for existing users (new users have no
                         id yet; assignments can be managed after save). The
                         dropdown above is the "default pinned" client; this
                         list is the full set of clients the user works with. */}
                    {editingUser?.id && (
                      <div className="mt-4">
                        <label className="block text-sm font-medium mb-1">Other clients</label>
                        <p className="text-xs text-muted-foreground mb-2">
                          Add any other clients this person works with.
                        </p>
                        <div className="flex flex-wrap gap-2 mb-2">
                          {editingUserClientAssignments.length === 0 && (
                            <p className="text-xs text-muted-foreground italic">No clients added yet.</p>
                          )}
                          {editingUserClientAssignments.map((a: { id: number; client_id: number; client_name: string; client_type: string }) => (
                            <span
                              key={a.client_id}
                              className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs"
                            >
                              <span className="font-medium text-foreground">{a.client_name}</span>
                              {a.client_type === 'internal' && (
                                <span className="text-[9px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">Internal</span>
                              )}
                              <button
                                type="button"
                                onClick={() => removeClientAssignment.mutate({ userId: editingUser.id, clientId: a.client_id })}
                                disabled={removeClientAssignment.isPending}
                                className="text-muted-foreground transition hover:text-destructive disabled:opacity-50"
                                aria-label={`Remove ${a.client_name}`}
                                title="Remove link"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                        <select
                          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                          value=""
                          onChange={(e) => {
                            const clientId = Number(e.target.value);
                            if (clientId) addClientAssignment.mutate({ userId: editingUser.id, clientId });
                          }}
                          disabled={addClientAssignment.isPending}
                        >
                          <option value="">+ Add another client</option>
                          {clientsList
                            .filter((c: Client) => c.id !== form.default_client_id)
                            .filter((c: Client) => !editingUserClientAssignments.some((a: { client_id: number }) => a.client_id === c.id))
                            .map((c: Client) => (
                              <option key={c.id} value={c.id}>{c.name}{c.client_type === 'internal' ? ' (Internal)' : ''}</option>
                            ))}
                        </select>
                      </div>
                    )}
                    </div>
                  </div>
                )}
                {!isProjectOnlyEdit && form.audience === 'internal' && form.role === 'EMPLOYEE' && (
                  <div>
                    <label className="block text-sm font-medium mb-2">Project Access</label>
                    <div className="max-h-44 overflow-y-auto rounded border p-3 space-y-2 bg-muted/10">
                      {activeProjects.length === 0 && (
                        <p className="text-sm text-muted-foreground">No active projects available.</p>
                      )}
                      {activeProjects.map((project: Project) => (
                        <label key={project.id} className="flex items-start gap-3 text-sm">
                          <input
                            type="checkbox"
                            checked={form.project_ids.includes(project.id)}
                            onChange={() => handleProjectToggle(project.id)}
                            disabled={!canManageEmployeeProjects}
                            className="mt-0.5 rounded"
                          />
                          <span>
                            <span className="font-medium text-foreground">{project.name}</span>
                            {project.client?.name && (
                              <span className="block text-xs text-muted-foreground">{project.client.name}</span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Selected projects control project visibility for this report.
                    </p>
                  </div>
                )}
                {!isProjectOnlyEdit && (
                  <div className={cn(
                    'grid gap-3',
                    form.audience === 'internal' ? 'md:grid-cols-2' : 'md:grid-cols-1',
                  )}>
                    <label className="flex items-center gap-2">
                      <input
                        id="is_active"
                        type="checkbox"
                        checked={form.is_active}
                        onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                        className="rounded"
                      />
                      <span className="text-sm font-medium">Active account</span>
                    </label>
                    {form.audience === 'internal' && (
                    <label className="flex items-center gap-2">
                      <input
                        id="can_review"
                        type="checkbox"
                        checked={form.can_review}
                        onChange={(e) => setForm((f) => ({ ...f, can_review: e.target.checked }))}
                        className="rounded"
                      />
                      <span className="text-sm font-medium">Reviewer access</span>
                    </label>
                    )}
                    {/* Legacy "External user" checkbox is intentionally
                        removed — the Internal/External chip at the top
                        of the form is the single source of truth. */}
                    <label className="hidden">
                      <input
                        id="is_external_legacy"
                        type="checkbox"
                        checked={false}
                        readOnly
                      />
                      <span className="text-sm font-medium">External user</span>
                    </label>
                  </div>
                )}
              </div>

              <div className="shrink-0 border-t px-6 py-4">
                {formError && (
                  <p className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{formError}</p>
                )}

                <div className="flex gap-3">
                  <button
                    type="submit"
                    disabled={createUser.isPending || updateUser.isPending}
                    className="flex-1 px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
                  >
                    {createUser.isPending || updateUser.isPending ? 'Saving...' : editingUser ? (isProjectOnlyEdit ? 'Save Project Access' : 'Save Changes') : 'Create User'}
                  </button>
                  <button
                    type="button"
                    onClick={closeModal}
                    className="flex-1 px-4 py-2 bg-muted rounded hover:bg-muted/90"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {isAdminUser && confirmDeleteId !== null && (() => {
        const userToDelete = (users ?? []).find((u) => u.id === confirmDeleteId);
        return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
          <div className="bg-card rounded-xl shadow-2xl w-full max-w-sm p-6">
            <h2 className="text-lg font-bold mb-2">Delete User</h2>
            <p className="text-sm text-muted-foreground mb-1">
              Are you sure you want to permanently delete:
            </p>
            <p className="font-semibold text-foreground mb-1">{userToDelete?.full_name}</p>
            <p className="text-xs text-muted-foreground mb-5">{userToDelete?.email?.endsWith('@local.invalid') ? 'No email set' : userToDelete?.email}</p>
            <p className="text-xs text-red-600 mb-5">This action cannot be undone.</p>
            <div className="flex gap-3">
              <button
                onClick={() => handleDelete(confirmDeleteId)}
                disabled={deleteUser.isPending}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                {deleteUser.isPending ? 'Deleting...' : 'Delete'}
              </button>
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="flex-1 px-4 py-2 bg-muted rounded hover:bg-muted/90"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Reset password modal */}
      {resetPasswordUserId !== null && (() => {
        const targetUser = (users ?? []).find((u) => u.id === resetPasswordUserId);
        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
            <div className="bg-card rounded-xl shadow-2xl w-full max-w-sm p-6">
              <h2 className="text-lg font-bold mb-2">Reset Password</h2>
              <p className="text-sm text-muted-foreground mb-1">
                Set a new password for:
              </p>
              <p className="font-semibold text-foreground mb-1">{targetUser?.full_name}</p>
              <p className="text-xs text-muted-foreground mb-4">{targetUser?.email?.endsWith('@local.invalid') ? 'No email set' : targetUser?.email}</p>
              <input
                type="password"
                value={resetPasswordValue}
                onChange={(e) => setResetPasswordValue(e.target.value)}
                placeholder="New password (min 8 characters)"
                className="field-input mb-2"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleResetPassword(); }}
              />
              <p className="text-xs text-muted-foreground mb-3">User will be prompted to change it on next login.</p>
              {resetPasswordError && (
                <p className="text-xs text-destructive mb-3">{resetPasswordError}</p>
              )}
              <div className="flex gap-3">
                <button
                  onClick={handleResetPassword}
                  disabled={resetPassword.isPending || !resetPasswordValue.trim()}
                  className="flex-1 px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
                >
                  {resetPassword.isPending ? 'Resetting...' : 'Reset Password'}
                </button>
                <button
                  onClick={() => { setResetPasswordUserId(null); setResetPasswordValue(''); setResetPasswordError(''); }}
                  className="flex-1 px-4 py-2 bg-muted rounded hover:bg-muted/90"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Post-create confirmation. Copy depends on whether the user
          is external, whether they have a real email on file, and
          whether the backend queued a verification message. */}
      {userActionSummary && (() => {
        const { action, fullName, email, isExternal, verificationEmailSent } = userActionSummary;
        const isPlaceholderEmail = !email || email.toLowerCase().endsWith('@local.invalid');
        let detail: string;
        if (action === 'updated') {
          detail = isExternal
            ? 'External user record updated.'
            : 'User profile saved successfully.';
        } else if (isExternal) {
          detail = 'Created as an external user. Record-only, no login access.';
        } else if (verificationEmailSent && !isPlaceholderEmail) {
          detail = `A verification email was sent to ${email}.`;
        } else {
          detail = 'Add an email address later to send a verification link.';
        }
        return (
          <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4"
            onKeyDown={(e) => { if (e.key === 'Escape') setUserActionSummary(null); }}
          >
            <div className="bg-card rounded-xl border border-border shadow-2xl w-full max-w-sm p-6">
              <div className="flex flex-col items-center text-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                  <CheckCircle2 className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-foreground">
                    {action === 'created' ? 'User created' : 'Changes saved'}
                  </h2>
                  <p className="text-sm font-medium text-foreground mt-0.5">{fullName}</p>
                  <p className="text-sm text-muted-foreground mt-1">{detail}</p>
                </div>
              </div>
              <div className="flex justify-center mt-5">
                <button
                  autoFocus
                  className="px-6 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition"
                  onClick={() => setUserActionSummary(null)}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {showNoProjectModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
          <div className="bg-card rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <div>
                <h2 className="text-lg font-bold">Employees Without Project Access</h2>
                <p className="text-sm text-muted-foreground mt-0.5">{employeesWithoutProjects.length} active employees with no projects assigned</p>
              </div>
              <button onClick={() => setShowNoProjectModal(false)} className="p-1.5 rounded hover:bg-muted">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1">
              {employeesWithoutProjects.length === 0 ? (
                <p className="text-sm text-muted-foreground p-6">All employees have project access assigned.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 border-b sticky top-0">
                    <tr>
                      <th className="text-left px-4 py-3 font-semibold">Name</th>
                      <th className="text-left px-4 py-3 font-semibold">Email</th>
                      <th className="text-left px-4 py-3 font-semibold">Department</th>
                      <th className="text-right px-4 py-3 font-semibold">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {employeesWithoutProjects.map((u) => (
                      <tr key={u.id} className="hover:bg-muted/10">
                        <td className="px-4 py-3 font-medium">{u.full_name}</td>
                        <td className="px-4 py-3 text-muted-foreground">{u.email?.endsWith('@local.invalid') ? 'N/A' : u.email}</td>
                        <td className="px-4 py-3 text-muted-foreground">{u.department || 'N/A'}</td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => {
                              setShowNoProjectModal(false);
                              openEdit(u);
                            }}
                            className="flex items-center gap-1.5 ml-auto px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs hover:bg-primary/90"
                          >
                            <Pencil className="w-3 h-3" />
                            Assign Projects
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {selectedUserDetails && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4 py-6">
          {/* max-h + flex-col so the modal frame caps to the viewport
              and the body scrolls instead of pushing the header off
              the top when a user has lots of project access rows. */}
          <div className="bg-card rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b flex-shrink-0">
              <h2 className="text-lg font-bold">User Details</h2>
              <button onClick={() => setSelectedUserDetails(null)} className="p-1.5 rounded hover:bg-muted">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-5 overflow-y-auto flex-1 min-h-0">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Full Name</p>
                  <p className="font-medium">{selectedUserDetails.full_name}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Email</p>
                  <p className="font-medium">{selectedUserDetails.email?.endsWith('@local.invalid') ? 'N/A' : selectedUserDetails.email}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Role</p>
                  <div className="mt-1">{roleBadge(selectedUserDetails.role, selectedUserDetails.roles, selectedUserDetails.is_external)}</div>
                </div>
                <div>
                  <p className="text-muted-foreground">Status</p>
                  <p className="font-medium">{selectedUserDetails.is_active ? 'Active' : 'Inactive'}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Title</p>
                  <p className="font-medium">{selectedUserDetails.title || 'N/A'}</p>
                </div>
                {!selectedUserDetails.is_external && (
                  <>
                    <div>
                      <p className="text-muted-foreground">Department</p>
                      <p className="font-medium">{selectedUserDetails.department || 'N/A'}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Reports To</p>
                      <p className="font-medium">{getManagerDisplayName(selectedUserDetails.manager_id)}</p>
                    </div>
                  </>
                )}
                <div>
                  <p className="text-muted-foreground">Default client</p>
                  <p className="font-medium">
                    {(() => {
                      const cid = selectedUserDetails.default_client_id;
                      if (cid == null) return 'N/A';
                      const c = clientsList.find((x: Client) => x.id === cid);
                      return c?.name ?? `Client #${cid}`;
                    })()}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Created</p>
                  <p className="font-medium">{format(new Date(selectedUserDetails.created_at), 'MMM d, yyyy')}</p>
                </div>
              </div>

              {!selectedUserDetails.is_external && (
                <div>
                  <h3 className="font-semibold mb-2">Project & Client Access</h3>
                  {getUserProjectDetails(selectedUserDetails).length === 0 ? (
                    <p className="text-sm text-muted-foreground">No project access assigned.</p>
                  ) : (
                    <div className="space-y-2">
                      {getUserProjectDetails(selectedUserDetails).map((project: Project) => (
                        <div key={project.id} className="rounded-lg border px-3 py-2 text-sm">
                          <p className="font-medium">{project.name}</p>
                          <p className="text-muted-foreground">Client: {project.client?.name || 'N/A'}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div>
                <h3 className="font-semibold mb-2">Client Assignments</h3>
                <p className="text-[10.5px] text-muted-foreground/70 mb-3">
                  All clients this employee works at.
                </p>
                {clientAssignmentsLoading ? (
                  <p className="text-sm text-muted-foreground">Loading...</p>
                ) : (
                  <div className="space-y-2">
                    {/* Implicit "default client" row: when the user has
                        a default_client_id but no explicit assignments,
                        surface the default with a pill so the section
                        isn't misleadingly empty. The default is
                        editable from the Edit User panel; this is
                        display-only to avoid duplicating the writable
                        control here. */}
                    {clientAssignments.length === 0 && selectedUserDetails.default_client_id != null && (() => {
                      const c = clientsList.find((x: Client) => x.id === selectedUserDetails.default_client_id);
                      if (!c) return null;
                      return (
                        <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium">{c.name}</span>
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${c.client_type === 'internal' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>
                              {c.client_type === 'internal' ? 'Internal' : 'External'}
                            </span>
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                              Default
                            </span>
                          </div>
                          <span className="text-[11px] text-muted-foreground">Edit to change</span>
                        </div>
                      );
                    })()}
                    {clientAssignments.length === 0 && selectedUserDetails.default_client_id == null && (
                      <p className="text-sm text-muted-foreground">No client assignments yet.</p>
                    )}
                    {clientAssignments.map((a: { id: number; client_id: number; client_name: string; client_type: string }) => (
                      <div key={a.client_id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{a.client_name}</span>
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${a.client_type === 'internal' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>
                            {a.client_type === 'internal' ? 'Internal' : 'External'}
                          </span>
                          {selectedUserDetails.default_client_id === a.client_id && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                              Default
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {selectedUserDetails.default_client_id !== a.client_id && (
                            <button
                              type="button"
                              onClick={() => {
                                const uid = selectedUserDetails.id;
                                const cid = a.client_id;
                                updateUser.mutate(
                                  { id: uid, data: { default_client_id: cid } },
                                  {
                                    onSuccess: () => {
                                      // Reflect immediately in the modal
                                      // snapshot; the query-invalidation
                                      // refetch happens in the background.
                                      setSelectedUserDetails((u) => (u ? { ...u, default_client_id: cid } : u));
                                    },
                                  },
                                );
                              }}
                              disabled={updateUser.isPending}
                              className="text-xs text-primary hover:underline disabled:opacity-50"
                              title="Set as the default client for this user"
                            >
                              Make default
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => removeClientAssignment.mutate({ userId: selectedUserDetails.id, clientId: a.client_id })}
                            disabled={removeClientAssignment.isPending}
                            className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded"
                            title="Remove assignment"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-3">
                  <select
                    className="w-full px-3 py-2 border rounded text-sm"
                    value=""
                    onChange={(e) => {
                      const clientId = Number(e.target.value);
                      if (clientId) addClientAssignment.mutate({ userId: selectedUserDetails.id, clientId });
                    }}
                    disabled={addClientAssignment.isPending}
                  >
                    <option value="">+ Assign a client...</option>
                    {clientsList
                      .filter((c: Client) => !clientAssignments.some((a: { client_id: number }) => a.client_id === c.id))
                      .map((c: Client) => (
                        <option key={c.id} value={c.id}>{c.name} {c.client_type === 'internal' ? '(Internal)' : ''}</option>
                      ))
                    }
                  </select>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t flex flex-wrap items-center gap-2 flex-shrink-0">
              {canEditUser(selectedUserDetails) && (
                <button
                  onClick={() => {
                    const u = selectedUserDetails;
                    setSelectedUserDetails(null);
                    openEdit(u);
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
                >
                  <Pencil className="w-4 h-4" />
                  Edit User
                </button>
              )}
              <button
                onClick={() => {
                  const uid = selectedUserDetails.id;
                  setSelectedUserDetails(null);
                  navigate(`/user-management/${uid}/timesheets`);
                }}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-foreground hover:bg-muted transition"
              >
                <Clock className="w-4 h-4" />
                Timesheets
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    {showImportModal && (
      <ImportUsersModal onClose={() => setShowImportModal(false)} />
    )}
    {showExportModal && (
      <ExportModal onClose={() => setShowExportModal(false)} />
    )}
    {/* Bulk-actions bar lives OUTSIDE the inert page wrapper so its
        buttons stay clickable while the rest of the page is locked.
        Renders nothing when no users are selected. */}
    {isAdminUser && (() => {
      const selectedUsers = (users ?? []).filter((u) => selectedUserIds.has(u.id));
      const allExternal = selectedUsers.length > 0 && selectedUsers.every((u) => u.is_external);
      return (
        <BulkSelectBar
          selectedCount={selectedUserIds.size}
          totalCount={filtered.filter((u) => u.id !== currentUser?.id).length}
          onSelectAll={selectAllUsers}
          onClearSelection={clearSelection}
          onDelete={handleBulkDelete}
          isDeleting={bulkDeleteUsers.isPending}
          onSendInvite={handleBulkSendInvite}
          isSendingInvite={isBulkSendingInvite}
          sendInviteDisabled={allExternal}
          sendInviteDisabledTitle={allExternal ? "External users have no login. Invite doesn't apply." : undefined}
          onExport={handleBulkExport}
          isExporting={isBulkExporting}
          onDeactivate={handleBulkDeactivate}
          isDeactivating={isBulkDeactivating}
          itemLabel="user"
        />
      );
    })()}
    </>
  );
};
