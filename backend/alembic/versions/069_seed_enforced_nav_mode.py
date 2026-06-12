"""Seed setting_definitions with the enforced_nav_mode catalog key.

Revision ID: 069_seed_enforced_nav_mode
Revises: 068_user_approval_cc
Create Date: 2026-06-11

No DDL. Re-runs the idempotent catalog seed so the new key
(enforced_nav_mode) lands on existing deployments. Uses
INSERT ... ON CONFLICT DO NOTHING so existing rows are untouched.

Reversible: downgrade deletes just the new key.
"""
from alembic import op
from sqlalchemy import text

from app.seed_setting_definitions import seed_sync

revision = "069_seed_enforced_nav_mode"
down_revision = "068_user_approval_cc"
branch_labels = None
depends_on = None

NEW_KEYS = [
    "enforced_nav_mode",
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
