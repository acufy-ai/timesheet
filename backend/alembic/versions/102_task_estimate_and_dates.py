"""Task causal data (Phase 2, part 1): estimate + dates + blocker reason.

Pure additive, all nullable. Existing tasks get NULL for every column, which the
project-health "why" logic treats as "unknown" (never zero hours, never overdue).
The `blocked` status value itself lands in the next migration (enum ALTER); this
one only adds the columns that carry estimate / schedule / blocker-reason data.

Revision ID: 102_task_estimate_and_dates
Revises: 101_project_health_configs
"""
from alembic import op
import sqlalchemy as sa

revision = "102_task_estimate_and_dates"
down_revision = "101_project_health_configs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("estimated_hours", sa.Numeric(8, 2), nullable=True))
    op.add_column("tasks", sa.Column("start_date", sa.Date(), nullable=True))
    op.add_column("tasks", sa.Column("due_date", sa.Date(), nullable=True))
    op.add_column("tasks", sa.Column("blocked_reason", sa.Text(), nullable=True))
    op.create_index("ix_tasks_due_date", "tasks", ["due_date"])


def downgrade() -> None:
    op.drop_index("ix_tasks_due_date", table_name="tasks")
    op.drop_column("tasks", "blocked_reason")
    op.drop_column("tasks", "due_date")
    op.drop_column("tasks", "start_date")
    op.drop_column("tasks", "estimated_hours")
