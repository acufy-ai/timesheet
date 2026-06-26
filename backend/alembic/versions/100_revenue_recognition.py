"""PSA Phase 3: per-project revenue recognition method.

projects.revenue_recognition: 'as_billed' (T&M, default) | 'percent_complete'
(fixed-fee, recognizes (contract/budget) x % work complete vs. the baseline).

Revision ID: 100_revenue_recognition
Revises: 099_resource_allocations
"""
from alembic import op
import sqlalchemy as sa

revision = "100_revenue_recognition"
down_revision = "099_resource_allocations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("revenue_recognition", sa.String(length=20), nullable=False, server_default="as_billed"),
    )


def downgrade() -> None:
    op.drop_column("projects", "revenue_recognition")
