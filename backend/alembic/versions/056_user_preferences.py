"""Add users.preferences JSONB column for per-user UI prefs

Revision ID: 056_user_preferences
Revises: 055_drop_legacy_email_idx
Create Date: 2026-05-18
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "056_user_preferences"
down_revision = "055_drop_legacy_email_idx"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "preferences",
            JSONB().with_variant(sa.JSON(), "sqlite"),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "preferences")
