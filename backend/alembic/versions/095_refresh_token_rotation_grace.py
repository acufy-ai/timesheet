"""refresh token rotation grace window

Adds rotated_at + replaced_by_jti to refresh_tokens so a just-rotated token
replayed within a short grace window (concurrent refresh / second tab / reload
mid-flight) can return its successor instead of 401-ing the user out.

Revision ID: 095_refresh_token_rotation_grace
Revises: 094_collapse_client_roles
"""
from alembic import op
import sqlalchemy as sa


revision = "095_refresh_token_rotation_grace"
down_revision = "094_collapse_client_roles"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "refresh_tokens",
        sa.Column("rotated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "refresh_tokens",
        sa.Column("replaced_by_jti", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("refresh_tokens", "replaced_by_jti")
    op.drop_column("refresh_tokens", "rotated_at")
