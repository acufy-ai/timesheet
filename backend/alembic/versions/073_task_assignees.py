"""Add task_assignees M:N table

Revision ID: 073_task_assignees
Revises: 072_project_manager_id
Create Date: 2026-06-17

Phase A of the Clients-redesign port. Which employees are assigned to a task.
Follows the existing assignment-table pattern (user_project_access,
user_client_assignments): a composite-key M:N link carrying tenant_id for
defense in depth, with cascade deletes on both sides.
"""
from alembic import op
import sqlalchemy as sa

revision = "073_task_assignees"
down_revision = "072_project_manager_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "task_assignees",
        sa.Column("task_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("tenant_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("task_id", "user_id"),
    )
    op.create_index("ix_task_assignees_user_id", "task_assignees", ["user_id"])
    op.create_index("ix_task_assignees_tenant_id", "task_assignees", ["tenant_id"])


def downgrade() -> None:
    op.drop_table("task_assignees")
