"""Split rejected_by/rejected_at apart from approved_by/approved_at on time_entries.

Reconstructed migration. The original 067 file was lost (created inside the
parked approval-notification-redesign work and never committed), but its schema
is already applied to some environments. This recreates the revision so the
alembic chain 066 -> 067 -> 068 is complete and idempotent: columns are added
only IF NOT EXISTS, so it is a no-op where they already exist and applies them
where they do not.

Revision ID: 067_reject_columns_split
Revises: 066_tenant_id_defense_in_depth
"""
from alembic import op

revision = "067_reject_columns_split"
down_revision = "066_tenant_id_defense_in_depth"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE time_entries "
        "ADD COLUMN IF NOT EXISTS rejected_by INTEGER REFERENCES users(id)"
    )
    op.execute(
        "ALTER TABLE time_entries "
        "ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP WITH TIME ZONE"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE time_entries DROP COLUMN IF EXISTS rejected_at")
    op.execute("ALTER TABLE time_entries DROP COLUMN IF EXISTS rejected_by")
