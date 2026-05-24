"""Add last_fetch_error and last_fetch_failed_at to mailboxes.

Revision ID: 051_mailbox_last_fetch_error
Revises: 050_seed_email_template_fields
Create Date: 2026-05-13
"""
from alembic import op
import sqlalchemy as sa

revision = "051_mailbox_last_fetch_error"
down_revision = "050_seed_email_template_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("mailboxes", sa.Column("last_fetch_error", sa.String(1024), nullable=True))
    op.add_column("mailboxes", sa.Column("last_fetch_failed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("mailboxes", "last_fetch_failed_at")
    op.drop_column("mailboxes", "last_fetch_error")
