"""Five-tier project health: per-project override + excellent threshold.

Additive, all nullable / server-defaulted, so existing rows behave exactly as
before:
  - projects.health_override: nullable String(20). NULL = use the auto-computed
    health tier; a set value (excellent | on-track | at-risk | critical) is a
    manager's deliberate override that wins over the computed value.
  - project_health_configs.excellent_under_pct: Numeric(6,2), default 50 — budget
    burn at/below which a healthy project reads "excellent" rather than
    "on-track". Existing config rows get 50 via server_default.

No health data to backfill: project health was always computed on the fly, so
the only persisted health value going forward is the override added here.

Revision ID: 106_project_health_5tier
Revises: 105_token_expiry_setting
"""
from alembic import op
import sqlalchemy as sa

revision = "106_project_health_5tier"
down_revision = "105_token_expiry_setting"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("health_override", sa.String(length=20), nullable=True),
    )
    op.add_column(
        "project_health_configs",
        sa.Column(
            "excellent_under_pct",
            sa.Numeric(6, 2),
            nullable=False,
            server_default="50",
        ),
    )


def downgrade() -> None:
    op.drop_column("project_health_configs", "excellent_under_pct")
    op.drop_column("projects", "health_override")
