"""Composite index on time_entries(user_id, entry_date).

Revision ID: 063_time_entry_user_date_index
Revises: 062_time_entry_no_self_approve
Create Date: 2026-05-28

list_user_entries() filters by both user_id and entry_date. Two single
indexes force a merge plan; a composite covers the common access shape
cheaply and is a strict speedup on the per-user history view.
"""
from alembic import op


revision = "063_time_entry_user_date_index"
down_revision = "062_time_entry_no_self_approve"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_time_entries_user_date",
        "time_entries",
        ["user_id", "entry_date"],
    )


def downgrade() -> None:
    op.drop_index("ix_time_entries_user_date", table_name="time_entries")
