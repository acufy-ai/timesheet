"""Add users.approval_cc_email_addresses (per-employee approval CC list).

Reconstructed migration. The original 068 file was lost (created inside the
parked approval-notification-redesign work and never committed), but its schema
is already applied to some environments and some DBs are stamped at this
revision. This recreates the revision so the alembic chain is complete and
idempotent: the column is added only IF NOT EXISTS.

Revision ID: 068_user_approval_cc
Revises: 067_reject_columns_split
"""
from alembic import op

revision = "068_user_approval_cc"
down_revision = "067_reject_columns_split"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS approval_cc_email_addresses JSONB "
        "NOT NULL DEFAULT '[]'::jsonb"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS approval_cc_email_addresses")
