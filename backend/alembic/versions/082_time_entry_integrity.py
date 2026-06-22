"""Time-entry integrity: unique ingestion line item + bounded hours

Revision ID: 082_time_entry_integrity
Revises: 081_userrole_client
Create Date: 2026-06-22

Two DB-level backstops for the time_entries table, both surfaced by the
production-readiness audit:

1. A UNIQUE index on ``ingestion_line_item_id`` (partial, non-NULL only).
   Sync idempotency previously relied entirely on application logic; this
   makes a double-sync of the same ingestion line item impossible at the DB.
   Replaces the existing plain btree index (the unique index also serves
   lookups, so we drop the old one).

2. A CHECK constraint bounding ``hours`` to (0, 24]. Schema validators now
   reject out-of-range hours on the way in; this guarantees no path (bulk
   insert, future endpoint, manual sync) can ever persist a nonsensical
   hours value into billable time.

Both are written idempotently (IF EXISTS / IF NOT EXISTS) so the fleet
runner can apply them to every tenant DB and the legacy timesheet_db safely.
"""
from alembic import op

revision = "082_time_entry_integrity"
down_revision = "081_userrole_client"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Partial UNIQUE index on ingestion_line_item_id (non-NULL rows only).
    op.execute("DROP INDEX IF EXISTS ix_time_entries_ingestion_line_item_id")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_time_entries_ingestion_line_item_id "
        "ON time_entries (ingestion_line_item_id) "
        "WHERE ingestion_line_item_id IS NOT NULL"
    )

    # 2. CHECK constraint: 0 < hours <= 24.
    op.execute(
        "ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS ck_time_entries_hours_range"
    )
    op.execute(
        "ALTER TABLE time_entries "
        "ADD CONSTRAINT ck_time_entries_hours_range "
        "CHECK (hours > 0 AND hours <= 24)"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS ck_time_entries_hours_range"
    )
    op.execute("DROP INDEX IF EXISTS uq_time_entries_ingestion_line_item_id")
    # Restore the original plain index.
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_time_entries_ingestion_line_item_id "
        "ON time_entries (ingestion_line_item_id)"
    )
