"""PSA Phase 0.1: per-user cost rate + frozen cost snapshot on time entries.

Adds users.cost_rate / cost_currency (the loaded hourly cost of a person) and
time_entries.cost_rate / cost_currency (the frozen snapshot stamped at approval,
parallel to billed_rate). Cost feeds margin / WIP / EVM; it never mutates the
revenue path.

Revision ID: 097_cost_rates
Revises: 096_titles
"""
from alembic import op
import sqlalchemy as sa

revision = "097_cost_rates"
down_revision = "096_titles"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("cost_rate", sa.Numeric(12, 2), nullable=True))
    op.add_column("users", sa.Column("cost_currency", sa.String(length=10), nullable=True))
    op.add_column("time_entries", sa.Column("cost_rate", sa.Numeric(12, 2), nullable=True))
    op.add_column("time_entries", sa.Column("cost_currency", sa.String(length=10), nullable=True))


def downgrade() -> None:
    op.drop_column("time_entries", "cost_currency")
    op.drop_column("time_entries", "cost_rate")
    op.drop_column("users", "cost_currency")
    op.drop_column("users", "cost_rate")
