"""PSA Phase 2: resource allocations + per-user weekly capacity.

resource_allocations = planned bookings of a person to a project over a window
(forward-looking capacity planning, distinct from logged time). users gets
weekly_capacity_hours (available hours/week) to measure allocation/utilization
against.

Revision ID: 099_resource_allocations
Revises: 098_project_baselines
"""
from alembic import op
import sqlalchemy as sa

revision = "099_resource_allocations"
down_revision = "098_project_baselines"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("weekly_capacity_hours", sa.Numeric(5, 2), nullable=True, server_default="40"))

    op.create_table(
        "resource_allocations",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("percent", sa.Numeric(5, 2), nullable=True),
        sa.Column("hours_per_week", sa.Numeric(6, 2), nullable=True),
        sa.Column("role", sa.String(length=120), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_resource_allocations_tenant_id", "resource_allocations", ["tenant_id"])
    op.create_index("ix_resource_allocations_user_id", "resource_allocations", ["user_id"])
    op.create_index("ix_resource_allocations_project_id", "resource_allocations", ["project_id"])
    op.create_index("ix_resource_allocations_start_date", "resource_allocations", ["start_date"])
    op.create_index("ix_resource_allocations_end_date", "resource_allocations", ["end_date"])


def downgrade() -> None:
    op.drop_table("resource_allocations")
    op.drop_column("users", "weekly_capacity_hours")
