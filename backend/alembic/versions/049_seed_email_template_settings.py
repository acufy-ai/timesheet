"""Seed setting_definitions with the four email-template catalog keys.

Revision ID: 049_seed_email_template_settings
Revises: 048_password_invite_tokens
Create Date: 2026-05-11

No DDL. Re-runs the idempotent catalog seed so the four new keys
(invite_email_subject, invite_email_intro, reset_email_subject,
reset_email_intro) land on existing deployments. Uses INSERT ... ON CONFLICT
DO NOTHING so existing rows are untouched.

Reversible: downgrade deletes just the four new keys.
"""
from alembic import op
from sqlalchemy import text

from app.seed_setting_definitions import seed_sync

revision = "049_seed_email_template_settings"
down_revision = "048_password_invite_tokens"
branch_labels = None
depends_on = None

NEW_KEYS = [
    "invite_email_subject",
    "invite_email_intro",
    "reset_email_subject",
    "reset_email_intro",
]


def upgrade() -> None:
    connection = op.get_bind()
    seed_sync(connection)


def downgrade() -> None:
    connection = op.get_bind()
    connection.execute(
        text("DELETE FROM setting_definitions WHERE key = ANY(:keys)"),
        {"keys": NEW_KEYS},
    )
