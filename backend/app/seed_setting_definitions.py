"""
Seed data for the ``setting_definitions`` catalog.

Idempotent: running the seed twice produces the same result as once. Uses
INSERT ... ON CONFLICT (key) DO NOTHING so existing rows are untouched —
operators who tweak a ``default_value`` or ``validation`` in production
won't have their changes clobbered on a redeploy.

Importable from both Alembic migrations (``upgrade()`` calls ``seed_sync``
with the live connection) and standalone scripts / tests (``seed_async``
works with an async session).

Keep the CATALOG dict in sync with:
  - app/core/tenant_settings.py — the accessor uses the same keys.
  - The UI catalog-driven form on the frontend (fetched dynamically via
    the settings endpoint, so no frontend edits are needed per-key).
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text

# Each entry: category, data_type, default_value, validation, label,
# description, is_public, sort_order. default_value is Python; seeded as JSON.
CATALOG: dict[str, dict[str, Any]] = {
    # ── time_entry ─────────────────────────────────────────────────
    "time_entry_past_days": {
        "category": "time_entry",
        "data_type": "int",
        "default_value": 30,
        "validation": {"min": 0, "max": 365},
        "label": "Time entry lookback (days)",
        "description": "How many days in the past employees can log time.",
        "is_public": True,
        "sort_order": 10,
    },
    "time_entry_future_days": {
        "category": "time_entry",
        "data_type": "int",
        "default_value": 7,
        "validation": {"min": 0, "max": 90},
        "label": "Time entry future window (days)",
        "description": "How many days ahead employees can log time.",
        "is_public": True,
        "sort_order": 20,
    },
    "max_hours_per_entry": {
        "category": "time_entry",
        "data_type": "float",
        "default_value": 12.0,
        "validation": {"min": 0.5, "max": 24},
        "label": "Max hours per entry",
        "description": "Maximum hours allowed on a single time entry.",
        "is_public": True,
        "sort_order": 30,
    },
    "max_hours_per_day": {
        "category": "time_entry",
        "data_type": "float",
        "default_value": 12.0,
        "validation": {"min": 0.5, "max": 24},
        "label": "Max hours per day",
        "description": "Maximum total hours across all entries on a single day.",
        "is_public": True,
        "sort_order": 40,
    },
    "max_hours_per_week": {
        "category": "time_entry",
        "data_type": "float",
        "default_value": 60.0,
        "validation": {"min": 1, "max": 168},
        "label": "Max hours per week",
        "description": "Maximum total hours across all entries in a single week.",
        "is_public": True,
        "sort_order": 50,
    },
    "min_submit_weekly_hours": {
        "category": "time_entry",
        "data_type": "float",
        "default_value": 0.0,
        "validation": {"min": 0, "max": 168},
        "label": "Minimum weekly hours to submit",
        "description": "Minimum hours an employee must log before they can submit for the week.",
        "is_public": True,
        "sort_order": 60,
    },
    "allow_partial_week_submit": {
        "category": "time_entry",
        "data_type": "bool",
        "default_value": False,
        "validation": {},
        "label": "Allow partial week submission",
        "description": "Allow employees to submit timesheets before the week is complete.",
        "is_public": True,
        "sort_order": 70,
    },
    "week_start_day": {
        "category": "time_entry",
        "data_type": "int",
        "default_value": 0,
        "validation": {"min": 0, "max": 1, "enum": [0, 1]},
        "label": "Week start day",
        "description": "First day of the work week used to group timesheets (0 = Sunday, 1 = Monday).",
        "is_public": True,
        "sort_order": 80,
    },
    "tenant_default_timezone": {
        "category": "time_entry",
        "data_type": "string",
        "default_value": "UTC",
        "validation": {},
        "label": "Default timezone",
        "description": "Timezone used for deadlines, reminders, reports, and the inbox fetch schedule.",
        "is_public": True,
        "sort_order": 5,
    },
    # ── customization ──────────────────────────────────────────────
    # Team-wide UI/UX defaults and the navigation-switch policy. All public
    # so the just-logged-in shell can read them without an admin round-trip:
    # the shell uses default_nav_layout / nav_switch_enabled / nav_switch_user_ids
    # to decide each user's primary-nav layout and whether they may change it,
    # and default_theme / default_palette / default_landing / default_page_size
    # seed a brand-new user's preferences on first login.
    "default_nav_layout": {
        "category": "customization",
        "data_type": "string",
        "default_value": "sidebar",
        "validation": {"enum": ["sidebar", "sidebar_collapsed", "topbar"]},
        "label": "Default navigation layout",
        "description": "The navigation layout new users start with: expanded sidebar, collapsed icon rail, or top bar. Users who are allowed to switch can change their own afterward.",
        "is_public": True,
        "sort_order": 10,
    },
    "nav_switch_enabled": {
        "category": "customization",
        "data_type": "bool",
        "default_value": True,
        "validation": {},
        "label": "Let users switch their navigation layout",
        "description": "When on, every user may choose their own navigation layout. When off, non-admins are locked to the default layout and the switch control is hidden (admins can always switch). Use the exception list below to allow specific users while this is off.",
        "is_public": True,
        "sort_order": 20,
    },
    "nav_switch_user_ids": {
        "category": "customization",
        "data_type": "json",
        "default_value": [],
        "validation": {},
        "label": "Navigation switch exceptions",
        "description": "Users who may switch their own navigation layout even when switching is turned off for the team. Admins can always switch and do not need to be listed.",
        "is_public": True,
        "sort_order": 30,
    },
    "default_theme": {
        "category": "customization",
        "data_type": "string",
        "default_value": "system",
        "validation": {"enum": ["light", "dark", "system"]},
        "label": "Default theme",
        "description": "The color theme new users start with. 'Follow system' matches the user's operating-system light/dark setting.",
        "is_public": True,
        "sort_order": 40,
    },
    "default_palette": {
        "category": "customization",
        "data_type": "string",
        "default_value": "",
        "validation": {
            "enum": [
                "",
                "violet-night",
                "emerald-night",
                "amber-night",
                "cyan-light",
                "rose-light",
                "sapphire-light",
            ]
        },
        "label": "Default color palette",
        "description": "Optional brand color palette new users start with. Leave blank to use the app default.",
        "is_public": True,
        "sort_order": 50,
    },
    "default_landing": {
        "category": "customization",
        "data_type": "string",
        "default_value": "dashboard",
        "validation": {
            "enum": ["dashboard", "my-time", "time-off", "calendar", "approvals"]
        },
        "label": "Default landing page",
        "description": "The page new users see first after they log in.",
        "is_public": True,
        "sort_order": 60,
    },
    "default_page_size": {
        "category": "customization",
        "data_type": "int",
        "default_value": 25,
        "validation": {"min": 10, "max": 200, "enum": [10, 25, 50, 100]},
        "label": "Default page size",
        "description": "How many rows new users see per page in lists and tables.",
        "is_public": True,
        "sort_order": 70,
    },
    # ── staffing ───────────────────────────────────────────────────
    # Who can be staffed onto a project/task. Public so the project and task
    # editors can read it without an admin round-trip. Default OFF keeps staffing
    # inside the project's management chain (a PM's direct reports). When ON, the
    # pool widens to the client's whole management chain + their reports.
    "allow_cross_team_staffing": {
        "category": "staffing",
        "data_type": "bool",
        "default_value": False,
        "validation": {},
        "label": "Allow cross-team staffing",
        "description": "When off, a project's team and a task's assignees can only be chosen from the project manager's own direct reports. When on, the pool widens to everyone in the client's management chain and their reports, so specialists from other teams can be staffed. Use the exception list below to allow specific managers while this is off.",
        "is_public": True,
        "sort_order": 10,
    },
    "cross_team_staffing_user_ids": {
        "category": "staffing",
        "data_type": "json",
        "default_value": [],
        "validation": {},
        "label": "Cross-team staffing exceptions",
        "description": "Managers who may staff across teams even when cross-team staffing is turned off for the workspace. Admins can always staff across teams and do not need to be listed.",
        "is_public": True,
        "sort_order": 20,
    },
    # ── approvals ──────────────────────────────────────────────────
    # Multi-manager approval routing. Default OFF preserves the legacy behavior
    # (an employee's single reporting manager approves all of their entries).
    # When ON: an employee may report to multiple managers; a time entry can be
    # submitted to a specific manager (approver_manager_id) who alone approves
    # it, and approval becomes per-entry (partial weeks allowed).
    "approval_by_assigned_manager": {
        "category": "approvals",
        "data_type": "bool",
        "default_value": False,
        "validation": {},
        "label": "Route approvals to the assigned manager",
        "description": "When off, an employee's reporting manager approves all of their time entries as one weekly batch. When on, an employee can report to multiple managers and each entry is approved by the manager it was submitted to (or any of the employee's managers if unspecified), so two managers can each approve their own hours in the same week.",
        "is_public": True,
        "sort_order": 10,
    },
    # ── time_off ───────────────────────────────────────────────────
    "time_off_past_days": {
        "category": "time_off",
        "data_type": "int",
        "default_value": 7,
        "validation": {"min": 0, "max": 365},
        "label": "Time-off request lookback (days)",
        "description": "How many days in the past employees can request time off.",
        "is_public": True,
        "sort_order": 10,
    },
    "time_off_future_days": {
        "category": "time_off",
        "data_type": "int",
        "default_value": 365,
        "validation": {"min": 0, "max": 730},
        "label": "Time-off request future window (days)",
        "description": "How many days ahead employees can request time off.",
        "is_public": True,
        "sort_order": 20,
    },
    "time_off_advance_notice_days": {
        "category": "time_off",
        "data_type": "int",
        "default_value": 3,
        "validation": {"min": 0, "max": 90},
        "label": "Advance notice required (days)",
        "description": "Minimum days notice required before a time-off request date.",
        "is_public": True,
        "sort_order": 30,
    },
    "time_off_max_consecutive_days": {
        "category": "time_off",
        "data_type": "int",
        "default_value": 30,
        "validation": {"min": 1, "max": 365},
        "label": "Max consecutive days off",
        "description": "Maximum number of consecutive days allowed in a single time-off request.",
        "is_public": True,
        "sort_order": 40,
    },
    "allow_overlapping_time_off": {
        "category": "time_off",
        "data_type": "bool",
        "default_value": False,
        "validation": {},
        "label": "Allow overlapping time-off requests",
        "description": "Allow multiple employees to have approved time off on the same day.",
        "is_public": True,
        "sort_order": 50,
    },
    # ── security ───────────────────────────────────────────────────
    "max_failed_login_attempts": {
        "category": "security",
        "data_type": "int",
        "default_value": 5,
        "validation": {"min": 1, "max": 20},
        "label": "Max failed login attempts",
        "description": "Number of failed logins before an account is temporarily locked.",
        "is_public": False,
        "sort_order": 10,
    },
    "lockout_duration_minutes": {
        "category": "security",
        "data_type": "int",
        "default_value": 15,
        "validation": {"min": 1, "max": 1440},
        "label": "Lockout duration (minutes)",
        "description": "How long an account remains locked after too many failed login attempts.",
        "is_public": False,
        "sort_order": 20,
    },
    "access_token_expire_minutes": {
        "category": "security",
        "data_type": "int",
        "default_value": 30,
        "validation": {"enum": [15, 30, 60, 120, 240, 480]},
        "label": "Sign-in session length",
        "description": (
            "How long a sign-in stays valid before it's re-checked. Shorter is "
            "more secure (a stolen session expires sooner); longer is more "
            "convenient. A new value applies the next time a person signs in or "
            "their session refreshes. People stay signed in across this through "
            "the usual refresh, so a shorter length does not log anyone out early."
        ),
        "is_public": False,
        "sort_order": 30,
    },
    # ── reminders ──────────────────────────────────────────────────
    # Submission cadence drives reminders AND the manager-dashboard
    # "late" signal. Internal default is weekly (employees submit on a
    # weekly cycle); external default is monthly (contractors invoice
    # monthly). Tenants can flip either. A "daily" enum value is
    # intentionally not offered: daily nudges live as reminder cadence
    # settings, not as a submission-period cadence.
    "submission_cadence_internal": {
        "category": "reminders",
        "data_type": "string",
        "default_value": "weekly",
        "validation": {"enum": ["weekly", "monthly"]},
        "label": "Employee submission cadence",
        "description": "How often internal employees are expected to submit timesheets. Drives the late/critical signal on the manager dashboard.",
        "is_public": False,
        "sort_order": 1,
    },
    "submission_cadence_external": {
        "category": "reminders",
        "data_type": "string",
        "default_value": "monthly",
        "validation": {"enum": ["weekly", "monthly"]},
        "label": "Contractor submission cadence",
        "description": "How often external contractors are expected to submit timesheets.",
        "is_public": False,
        "sort_order": 2,
    },
    "late_grace_business_days": {
        "category": "reminders",
        "data_type": "int",
        "default_value": 1,
        "validation": {"min": 0, "max": 10},
        "label": "Late grace (business days)",
        "description": "How many business days after the deadline before a user is flagged late on the manager dashboard.",
        "is_public": False,
        "sort_order": 3,
    },
    "reminder_internal_enabled": {
        "category": "reminders",
        "data_type": "bool",
        "default_value": False,
        "validation": {},
        "label": "Enable employee reminders",
        "description": "Send timesheet deadline reminders to internal employees.",
        "is_public": False,
        "sort_order": 10,
    },
    "reminder_internal_deadline_day": {
        "category": "reminders",
        "data_type": "string",
        "default_value": "friday",
        "validation": {
            "enum": ["monday", "tuesday", "wednesday", "thursday", "friday"]
        },
        "label": "Deadline day",
        "description": "Day of the week timesheets are due.",
        "is_public": False,
        "sort_order": 20,
    },
    "reminder_internal_deadline_time": {
        "category": "reminders",
        "data_type": "time",
        "default_value": "17:00",
        "validation": {},
        "label": "Deadline time",
        "description": "Time of day timesheets are due.",
        "is_public": False,
        "sort_order": 30,
    },
    "reminder_internal_lock_enabled": {
        "category": "reminders",
        "data_type": "bool",
        "default_value": False,
        "validation": {},
        "label": "Auto-lock after deadline",
        "description": "Lock timesheets automatically once the submission deadline passes.",
        "is_public": False,
        "sort_order": 40,
    },
    "reminder_internal_recipients": {
        "category": "reminders",
        "data_type": "string",
        "default_value": "all",
        "validation": {},
        "label": "Recipients",
        "description": "Who receives employee reminders: all eligible employees, or a chosen list.",
        "is_public": False,
        "sort_order": 50,
    },
    "reminder_external_enabled": {
        "category": "reminders",
        "data_type": "bool",
        "default_value": False,
        "validation": {},
        "label": "Enable contractor reminders",
        "description": "Send timesheet deadline reminders to external contractors.",
        "is_public": False,
        "sort_order": 60,
    },
    "reminder_external_deadline_day_of_month": {
        "category": "reminders",
        "data_type": "int",
        "default_value": 28,
        "validation": {"min": 1, "max": 31},
        "label": "Deadline day of month",
        "description": "Day of the month external timesheets are due. If the month has fewer days (e.g. February), the deadline falls on the last day.",
        "is_public": False,
        "sort_order": 70,
    },
    "reminder_external_deadline_time": {
        "category": "reminders",
        "data_type": "time",
        "default_value": "17:00",
        "validation": {},
        "label": "Deadline time",
        "description": "Time of day external timesheets are due.",
        "is_public": False,
        "sort_order": 80,
    },
    # ── notifications ──────────────────────────────────────────────
    "notification_ttl_days": {
        "category": "notifications",
        "data_type": "int",
        "default_value": 7,
        "validation": {"min": 1, "max": 90},
        "label": "Notification retention",
        "description": "How long notifications remain visible before expiring.",
        "is_public": False,
        "sort_order": 10,
    },
    "approval_history_ttl_days": {
        "category": "notifications",
        "data_type": "int",
        "default_value": 7,
        "validation": {"min": 1, "max": 365},
        "label": "Approval history window",
        "description": "How far back the approval history shows by default.",
        "is_public": False,
        "sort_order": 20,
    },
    "daily_submission_deadline_time": {
        "category": "notifications",
        "data_type": "time",
        "default_value": "10:00",
        "validation": {},
        "label": "Daily submission cutoff",
        "description": "Entries submitted after this time appear as overdue in the daily overview.",
        "is_public": False,
        "sort_order": 30,
    },
    "missing_yesterday_notify_after_hour": {
        "category": "notifications",
        "data_type": "int",
        "default_value": 8,
        "validation": {"min": 0, "max": 23},
        "label": "Missing yesterday alert",
        "description": "Hour of day (0-23) after which an employee is alerted about yesterday's missing time.",
        "is_public": False,
        "sort_order": 40,
    },
    "manager_missing_team_notify_after_hour": {
        "category": "notifications",
        "data_type": "int",
        "default_value": 14,
        "validation": {"min": 0, "max": 23},
        "label": "Manager missing-team alert",
        "description": "Time of day managers are notified about missing team entries.",
        "is_public": False,
        "sort_order": 50,
    },
    # ── email ──────────────────────────────────────────────────────
    "outbound_email_source": {
        "category": "email",
        "data_type": "string",
        "default_value": "platform",
        "validation": {"enum": ["platform", "oauth_mailbox", "custom_smtp"]},
        "label": "Outbound email source",
        "description": (
            "Where outbound emails (invitations, password resets) are sent from. "
            "'platform' uses the Acufy default. 'oauth_mailbox' uses the tenant's "
            "connected Google/Microsoft mailbox. 'custom_smtp' uses the tenant's "
            "SMTP credentials below. The 'oauth_mailbox' and 'custom_smtp' options "
            "require the Custom Outbound Email feature flag."
        ),
        "is_public": False,
        "sort_order": 5,
    },
    "smtp_host": {
        "category": "email",
        "data_type": "string",
        "default_value": "",
        "validation": {},
        "label": "SMTP host",
        "description": "Outbound email server hostname. Leave blank to use platform default.",
        "is_public": False,
        "sort_order": 10,
    },
    "smtp_port": {
        "category": "email",
        "data_type": "int",
        "default_value": 587,
        "validation": {"min": 1, "max": 65535},
        "label": "SMTP port",
        "description": "Outbound email server port.",
        "is_public": False,
        "sort_order": 20,
    },
    "smtp_username": {
        "category": "email",
        "data_type": "string",
        "default_value": "",
        "validation": {},
        "label": "SMTP username",
        "description": "Username for SMTP authentication.",
        "is_public": False,
        "sort_order": 30,
    },
    "smtp_password": {
        "category": "email",
        "data_type": "string",
        "default_value": "",
        "validation": {},
        "label": "SMTP password",
        "description": "Password for SMTP authentication. Stored encrypted.",
        "is_public": False,
        "sort_order": 40,
    },
    "smtp_from_address": {
        "category": "email",
        "data_type": "string",
        "default_value": "",
        "validation": {},
        "label": "From address",
        "description": "Email address that appears in the From field.",
        "is_public": False,
        "sort_order": 50,
    },
    "smtp_from_name": {
        "category": "email",
        "data_type": "string",
        "default_value": "",
        "validation": {},
        "label": "From name",
        "description": "Display name that appears in the From field.",
        "is_public": False,
        "sort_order": 60,
    },
    "smtp_use_tls": {
        "category": "email",
        "data_type": "bool",
        "default_value": True,
        "validation": {},
        "label": "Use TLS",
        "description": "Enable TLS encryption for outbound email.",
        "is_public": False,
        "sort_order": 70,
    },
    # ── email templates (B.3) ─────────────────────────────────────
    # Tenants with custom_email_template feature flag can override individual
    # fields of invitation and password-reset emails. Each field maps to a
    # distinct visual element in the email card. Leave blank to use the
    # platform default for that field.
    "invite_email_subject": {
        "category": "email_templates",
        "data_type": "string",
        "default_value": "",
        "validation": {"max_length": 200},
        "label": "Invitation: subject line",
        "description": "Subject line shown in the recipient's inbox.",
        "is_public": False,
        "sort_order": 100,
    },
    "invite_email_greeting": {
        "category": "email_templates",
        "data_type": "string",
        "default_value": "",
        "validation": {"max_length": 200},
        "label": "Invitation: greeting",
        "description": "First line of the email body. The recipient's first name is always prepended automatically.",
        "is_public": False,
        "sort_order": 105,
    },
    "invite_email_body": {
        "category": "email_templates",
        "data_type": "string",
        "default_value": "",
        "validation": {"max_length": 500},
        "label": "Invitation: body message",
        "description": "Main paragraph shown below the greeting.",
        "is_public": False,
        "sort_order": 110,
    },
    "invite_email_button_label": {
        "category": "email_templates",
        "data_type": "string",
        "default_value": "",
        "validation": {"max_length": 60},
        "label": "Invitation: button label",
        "description": "Text on the action button.",
        "is_public": False,
        "sort_order": 115,
    },
    "invite_email_signoff": {
        "category": "email_templates",
        "data_type": "string",
        "default_value": "",
        "validation": {"max_length": 200},
        "label": "Invitation: sign-off",
        "description": "Footer line below the button, e.g. 'Sent by Acme Corp HR'.",
        "is_public": False,
        "sort_order": 120,
    },
    "reset_email_subject": {
        "category": "email_templates",
        "data_type": "string",
        "default_value": "",
        "validation": {"max_length": 200},
        "label": "Password reset: subject line",
        "description": "Subject line shown in the recipient's inbox.",
        "is_public": False,
        "sort_order": 130,
    },
    "reset_email_greeting": {
        "category": "email_templates",
        "data_type": "string",
        "default_value": "",
        "validation": {"max_length": 200},
        "label": "Password reset: greeting",
        "description": "First line of the email body. The recipient's first name is always prepended automatically.",
        "is_public": False,
        "sort_order": 135,
    },
    "reset_email_body": {
        "category": "email_templates",
        "data_type": "string",
        "default_value": "",
        "validation": {"max_length": 500},
        "label": "Password reset: body message",
        "description": "Main paragraph shown below the greeting.",
        "is_public": False,
        "sort_order": 140,
    },
    "reset_email_button_label": {
        "category": "email_templates",
        "data_type": "string",
        "default_value": "",
        "validation": {"max_length": 60},
        "label": "Password reset: button label",
        "description": "Text on the action button.",
        "is_public": False,
        "sort_order": 145,
    },
    "reset_email_signoff": {
        "category": "email_templates",
        "data_type": "string",
        "default_value": "",
        "validation": {"max_length": 200},
        "label": "Password reset: sign-off",
        "description": "Footer line below the button.",
        "is_public": False,
        "sort_order": 150,
    },
    # ── email ingestion / fetch scheduling ────────────────────────
    # These keys predate the catalog and are written by the Mailboxes admin
    # UI, not the main settings form. Included here so PATCH /tenant-settings
    # still accepts them after the catalog-strict validation landed.
    "fetch_emails_enabled": {
        "category": "email",
        "data_type": "bool",
        "default_value": False,
        "validation": {},
        "label": "Enable scheduled email fetch",
        "description": "Automatically fetch email from configured mailboxes on a schedule.",
        "is_public": False,
        "sort_order": 100,
    },
    "fetch_emails_interval_minutes": {
        "category": "email",
        "data_type": "int",
        "default_value": 15,
        "validation": {"min": 1, "max": 1440},
        "label": "Fetch interval (minutes)",
        "description": "How often to poll mailboxes for new email.",
        "is_public": False,
        "sort_order": 110,
    },
    "fetch_emails_days": {
        "category": "email",
        "data_type": "string",
        "default_value": "mon,tue,wed,thu,fri",
        "validation": {},
        "label": "Fetch days",
        "description": "Comma-separated days of the week when fetch runs (e.g. mon,tue,wed,thu,fri).",
        "is_public": False,
        "sort_order": 120,
    },
    "fetch_emails_start_time": {
        "category": "email",
        "data_type": "time",
        "default_value": "08:00",
        "validation": {},
        "label": "Fetch start time",
        "description": "Time of day (24-hour) when scheduled fetch begins each day.",
        "is_public": False,
        "sort_order": 130,
    },
    "fetch_emails_end_time": {
        "category": "email",
        "data_type": "time",
        "default_value": "20:00",
        "validation": {},
        "label": "Fetch end time",
        "description": "Time of day (24-hour) when scheduled fetch stops each day.",
        "is_public": False,
        "sort_order": 140,
    },
    # Tenant-admin kill switch for the Client Portal. When off (default), no
    # client account can sign in and no grant is active, regardless of any
    # per-project toggle. Public so the UI can hide the portal/grant surfaces.
    "client_portal_enabled": {
        "category": "client_portal",
        "data_type": "bool",
        "default_value": False,
        "validation": {},
        "label": "Enable client portal",
        "description": "Allow external client users to sign in and access projects/tasks shared with them. When off, all client access is disabled workspace-wide.",
        "is_public": True,
        "sort_order": 10,
    },
}


# ─────────────────────────────────────────────────────────────────────────────
# Seed helpers
# ─────────────────────────────────────────────────────────────────────────────


def seed_sync(connection) -> int:
    """
    Synchronous seed, suitable for Alembic ``op.get_bind()`` connections.

    Returns the number of rows inserted. Existing rows are left alone
    (ON CONFLICT DO NOTHING) so operator edits aren't overwritten.
    """
    dialect = connection.dialect.name
    inserted = 0

    for key, defn in CATALOG.items():
        params = {
            "key": key,
            "category": defn["category"],
            "data_type": defn["data_type"],
            "default_value": json.dumps(defn["default_value"]),
            "validation": json.dumps(defn.get("validation") or {}),
            "label": defn["label"],
            "description": defn["description"],
            "is_public": defn.get("is_public", False),
            "sort_order": defn.get("sort_order", 0),
            "added_in": defn.get("added_in", "1.0.0"),
        }

        if dialect == "postgresql":
            stmt = text(
                """
                INSERT INTO setting_definitions (
                    key, category, data_type, default_value, validation,
                    label, description, is_public, sort_order, added_in
                ) VALUES (
                    :key, :category, :data_type,
                    CAST(:default_value AS jsonb), CAST(:validation AS jsonb),
                    :label, :description, :is_public, :sort_order, :added_in
                )
                ON CONFLICT (key) DO NOTHING
                """
            )
        else:
            # SQLite (test harness): JSON is text, ON CONFLICT uses INSERT OR IGNORE.
            stmt = text(
                """
                INSERT OR IGNORE INTO setting_definitions (
                    key, category, data_type, default_value, validation,
                    label, description, is_public, sort_order, added_in
                ) VALUES (
                    :key, :category, :data_type, :default_value, :validation,
                    :label, :description, :is_public, :sort_order, :added_in
                )
                """
            )
        result = connection.execute(stmt, params)
        inserted += result.rowcount if result.rowcount and result.rowcount > 0 else 0

    return inserted


async def seed_async(session) -> int:
    """Async counterpart for tests / standalone scripts using AsyncSession."""
    # Run the sync body inside the session's sync connection via run_sync.
    async def _run(sync_session):  # pragma: no cover - trivial wrapper
        return seed_sync(sync_session.connection())

    return await session.run_sync(lambda s: seed_sync(s.connection()))


if __name__ == "__main__":  # pragma: no cover - manual invocation
    import asyncio

    from app.db import AsyncSessionLocal

    async def _main() -> None:
        async with AsyncSessionLocal() as session:
            inserted = await seed_async(session)
            await session.commit()
            print(f"Seeded setting_definitions: +{inserted} rows")

    asyncio.run(_main())
