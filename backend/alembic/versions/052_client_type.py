"""Add client_type enum column to clients

Revision ID: 052_client_type
Revises: 051_mailbox_last_fetch_error
Create Date: 2026-05-14
"""
from alembic import op
import sqlalchemy as sa

revision = "052_client_type"
down_revision = "051_mailbox_last_fetch_error"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE TYPE clienttype AS ENUM ('internal', 'external')")
    op.add_column(
        "clients",
        sa.Column(
            "client_type",
            sa.Enum("internal", "external", name="clienttype"),
            nullable=False,
            server_default="external",
        ),
    )


def downgrade() -> None:
    op.drop_column("clients", "client_type")
    op.execute("DROP TYPE clienttype")
