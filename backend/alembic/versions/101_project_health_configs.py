"""PSA: configurable project-health thresholds.

project_health_configs holds the tunable rules behind the good / at-risk /
needs-attention classification. Two scopes share the table: user_id IS NULL is
the workspace default; a set user_id is a manager's personal override. Each rule
group (budget / schedule / margin) can be toggled. Built additively; the
hardcoded fallbacks stay as the last resort when no row exists.

Revision ID: 101_project_health_configs
Revises: 100_revenue_recognition
"""
from alembic import op
import sqlalchemy as sa

revision = "101_project_health_configs"
down_revision = "100_revenue_recognition"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project_health_configs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("budget_enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("over_budget_pct", sa.Numeric(6, 2), nullable=False, server_default="100"),
        sa.Column("high_burn_pct", sa.Numeric(6, 2), nullable=False, server_default="80"),
        sa.Column("schedule_enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("ending_soon_days", sa.Numeric(6, 0), nullable=False, server_default="7"),
        sa.Column("overdue_days", sa.Numeric(6, 0), nullable=False, server_default="30"),
        sa.Column("margin_enabled", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("low_margin_pct", sa.Numeric(6, 2), nullable=False, server_default="15"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("tenant_id", "user_id", name="uq_project_health_config_scope"),
    )
    op.create_index("ix_project_health_configs_tenant_id", "project_health_configs", ["tenant_id"])
    op.create_index("ix_project_health_configs_user_id", "project_health_configs", ["user_id"])


def downgrade() -> None:
    op.drop_table("project_health_configs")
