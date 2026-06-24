"""Per-entry approval routing: time_entries.approver_manager_id

Revision ID: 090_time_entry_approver_manager
Revises: 089_multi_manager_assignments
Create Date: 2026-06-23

When an employee has multiple managers, a time entry can be ROUTED to a specific
manager for approval. This adds a nullable `approver_manager_id` FK:

  - Set  -> only that manager (the one it was submitted to) approves the entry.
  - NULL -> any of the employee's managers may approve (the default / back-compat).

Nullable + ON DELETE SET NULL (if a manager is removed, the entry falls back to
"any manager"). Additive — enforcement is gated by the `approval_by_assigned_manager`
tenant setting; with the setting off this column is simply ignored.
"""
import sqlalchemy as sa
from alembic import op


revision = "090_time_entry_approver_manager"
down_revision = "089_multi_manager_assignments"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "time_entries",
        sa.Column("approver_manager_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_time_entries_approver_manager_id",
        "time_entries",
        ["approver_manager_id"],
    )
    op.create_foreign_key(
        "fk_time_entries_approver_manager_id",
        "time_entries", "users",
        ["approver_manager_id"], ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_time_entries_approver_manager_id", "time_entries", type_="foreignkey"
    )
    op.drop_index(
        "ix_time_entries_approver_manager_id", table_name="time_entries"
    )
    op.drop_column("time_entries", "approver_manager_id")
