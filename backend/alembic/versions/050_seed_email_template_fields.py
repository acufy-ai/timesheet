"""Replace intro-based email template keys with split field keys.

Revision ID: 050_seed_email_template_fields
Revises: 049_seed_email_template_settings
Create Date: 2026-05-11

Drops the old invite_email_intro / reset_email_intro keys (added in 049)
and seeds the new split fields: greeting, body, button_label, signoff
(plus subject which already existed). Uses the idempotent seed_sync so
existing keys are untouched.
"""
from alembic import op
from sqlalchemy import text

from app.seed_setting_definitions import seed_sync

revision = "050_seed_email_template_fields"
down_revision = "049_seed_email_template_settings"
branch_labels = None
depends_on = None

OLD_KEYS = ["invite_email_intro", "reset_email_intro"]

NEW_KEYS = [
    "invite_email_greeting", "invite_email_body", "invite_email_button_label", "invite_email_signoff",
    "reset_email_greeting",  "reset_email_body",  "reset_email_button_label",  "reset_email_signoff",
]


def upgrade() -> None:
    connection = op.get_bind()
    # Remove stale intro keys from both the definition catalog and any
    # tenant values that may have been written against them.
    connection.execute(
        text("DELETE FROM tenant_settings WHERE key = ANY(:keys)"),
        {"keys": OLD_KEYS},
    )
    connection.execute(
        text("DELETE FROM setting_definitions WHERE key = ANY(:keys)"),
        {"keys": OLD_KEYS},
    )
    seed_sync(connection)


def downgrade() -> None:
    connection = op.get_bind()
    connection.execute(
        text("DELETE FROM setting_definitions WHERE key = ANY(:keys)"),
        {"keys": NEW_KEYS},
    )
