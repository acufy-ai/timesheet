"""CHECK constraint: approved_by must differ from user_id.

Revision ID: 062_time_entry_no_self_approve
Revises: 061_resync_setting_metadata
Create Date: 2026-05-28

Defense-in-depth at the schema level: a user cannot approve their own
time entry. The API layer and the CRUD layer both check this; the
constraint catches any future direct-SQL writes that bypass both.
"""
from alembic import op


revision = "062_time_entry_no_self_approve"
down_revision = "061_resync_setting_metadata"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_check_constraint(
        "ck_time_entries_no_self_approve",
        "time_entries",
        "approved_by IS NULL OR approved_by <> user_id",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_time_entries_no_self_approve",
        "time_entries",
        type_="check",
    )
