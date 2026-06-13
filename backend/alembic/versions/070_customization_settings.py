"""Seed the customization catalog keys and drop the redundant enforced_nav_mode.

Revision ID: 070_customization_settings
Revises: 069_seed_enforced_nav_mode
Create Date: 2026-06-12

No DDL. Re-runs the idempotent catalog seed so the new ``customization``
keys (default_nav_layout, nav_switch_enabled, nav_switch_user_ids,
default_theme, default_palette, default_landing, default_page_size) land on
existing deployments, then removes the now-redundant ``enforced_nav_mode``
key. The navigation-switch policy (default_nav_layout + nav_switch_enabled +
nav_switch_user_ids) supersedes enforced_nav_mode.

Uses INSERT ... ON CONFLICT DO NOTHING for the seed so existing operator
edits are untouched.

Reversible: downgrade deletes the new keys and restores enforced_nav_mode.
"""
from alembic import op
from sqlalchemy import text

from app.seed_setting_definitions import seed_sync

revision = "070_customization_settings"
down_revision = "069_seed_enforced_nav_mode"
branch_labels = None
depends_on = None

NEW_KEYS = [
    "default_nav_layout",
    "nav_switch_enabled",
    "nav_switch_user_ids",
    "default_theme",
    "default_palette",
    "default_landing",
    "default_page_size",
]


def upgrade() -> None:
    connection = op.get_bind()
    # Insert the new customization keys (idempotent).
    seed_sync(connection)
    # Remove the superseded key from existing deployments.
    connection.execute(
        text("DELETE FROM setting_definitions WHERE key = 'enforced_nav_mode'")
    )
    # Drop any stored tenant override for the removed key so it leaves no orphan.
    connection.execute(
        text("DELETE FROM tenant_settings WHERE key = 'enforced_nav_mode'")
    )


def downgrade() -> None:
    connection = op.get_bind()
    connection.execute(
        text("DELETE FROM setting_definitions WHERE key = ANY(:keys)"),
        {"keys": NEW_KEYS},
    )
    # Restore the enforced_nav_mode catalog row (best-effort parity with 069).
    connection.execute(
        text(
            """
            INSERT INTO setting_definitions (
                key, category, data_type, default_value, validation,
                label, description, is_public, sort_order, added_in
            ) VALUES (
                'enforced_nav_mode', 'time_entry', 'string',
                CAST('"off"' AS jsonb),
                CAST('{"enum": ["off", "sidebar", "topbar"]}' AS jsonb),
                'Enforce navigation layout',
                'Lock the primary navigation layout for all users. ''off'' lets each user choose their own (sidebar or top bar).',
                true, 90, '1.0.0'
            )
            ON CONFLICT (key) DO NOTHING
            """
        )
    )
