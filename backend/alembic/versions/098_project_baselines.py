"""PSA Phase 0.3: project baselines (the plan snapshot EVM measures against).

One project may have several baselines over its life; a partial unique index
enforces at most one active baseline per project.

Revision ID: 098_project_baselines
Revises: 097_cost_rates
"""
from alembic import op
import sqlalchemy as sa

revision = "098_project_baselines"
down_revision = "097_cost_rates"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project_baselines",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False, server_default="Baseline"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("planned_hours", sa.Numeric(12, 2), nullable=True),
        sa.Column("planned_cost", sa.Numeric(14, 2), nullable=True),
        sa.Column("planned_revenue", sa.Numeric(14, 2), nullable=True),
        sa.Column("currency", sa.String(length=10), nullable=True, server_default="USD"),
        sa.Column("baseline_start", sa.Date(), nullable=True),
        sa.Column("baseline_end", sa.Date(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("captured_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_project_baselines_tenant_id", "project_baselines", ["tenant_id"])
    op.create_index("ix_project_baselines_project_id", "project_baselines", ["project_id"])
    # At most one ACTIVE baseline per project.
    op.create_index(
        "uq_project_baseline_active",
        "project_baselines",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text("is_active"),
    )


def downgrade() -> None:
    op.drop_index("uq_project_baseline_active", table_name="project_baselines")
    op.drop_index("ix_project_baselines_project_id", table_name="project_baselines")
    op.drop_index("ix_project_baselines_tenant_id", table_name="project_baselines")
    op.drop_table("project_baselines")
