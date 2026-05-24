"""password_invite_tokens: one-time-use tokens for the local password-set flow

Revision ID: 048
Revises: 047
Create Date: 2026-05-11
"""
from alembic import op
import sqlalchemy as sa

revision = "048_password_invite_tokens"
down_revision = "047_user_auth0_sub"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "password_invite_tokens",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("jti", sa.String(length=64), nullable=False, unique=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("purpose", sa.String(length=32), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_password_invite_tokens_jti", "password_invite_tokens", ["jti"], unique=True)
    op.create_index("ix_password_invite_tokens_user_id", "password_invite_tokens", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_password_invite_tokens_user_id", table_name="password_invite_tokens")
    op.drop_index("ix_password_invite_tokens_jti", table_name="password_invite_tokens")
    op.drop_table("password_invite_tokens")
