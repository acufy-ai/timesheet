"""user.auth0_sub: map Auth0 identity to local user

Revision ID: 047
Revises: 046
Create Date: 2026-05-09
"""
from alembic import op
import sqlalchemy as sa

revision = "047_user_auth0_sub"
down_revision = "046_role_revamp"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("auth0_sub", sa.String(length=128), nullable=True),
    )
    op.create_index(
        "ix_users_auth0_sub",
        "users",
        ["auth0_sub"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_users_auth0_sub", table_name="users")
    op.drop_column("users", "auth0_sub")
