"""Add user_task_access M:N table

Revision ID: 079_user_task_access
Revises: 078_project_managers
Create Date: 2026-06-21

Per-user task-level access grant for the User Management redesign. Mirrors
user_project_access but at the task grain, so a user can be granted specific
tasks within a project (the user form's project & task access tree). Carries
tenant_id for defense in depth, with cascade deletes on both sides.
"""
from alembic import op
import sqlalchemy as sa

revision = "079_user_task_access"
down_revision = "078_project_managers"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_task_access",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("task_id", sa.Integer(), nullable=False),
        sa.Column("tenant_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("user_id", "task_id"),
    )
    op.create_index("ix_user_task_access_task_id", "user_task_access", ["task_id"])
    op.create_index("ix_user_task_access_tenant_id", "user_task_access", ["tenant_id"])


def downgrade() -> None:
    op.drop_table("user_task_access")
