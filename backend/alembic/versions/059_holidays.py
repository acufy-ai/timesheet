"""Org-wide holidays: ``holidays`` table.

Revision ID: 059_holidays
Revises: 058_submission_cadence_settings
Create Date: 2026-05-20

Creates the per-tenant holidays table. Org-wide for v1 (country
column nullable); future per-region scoping is purely additive.
"""
from alembic import op
import sqlalchemy as sa

revision = "059_holidays"
down_revision = "058_submission_cadence_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "holidays",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column(
            "holiday_type",
            sa.Enum("PUBLIC", "COMPANY", name="holiday_type"),
            nullable=False,
            server_default="COMPANY",
        ),
        sa.Column("country", sa.String(length=2), nullable=True),
        sa.Column(
            "created_by",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("tenant_id", "date", name="uq_holidays_tenant_date"),
    )
    op.create_index("ix_holidays_tenant_id", "holidays", ["tenant_id"])
    op.create_index("ix_holidays_date", "holidays", ["date"])


def downgrade() -> None:
    op.drop_index("ix_holidays_date", table_name="holidays")
    op.drop_index("ix_holidays_tenant_id", table_name="holidays")
    op.drop_table("holidays")
    sa.Enum(name="holiday_type").drop(op.get_bind(), checkfirst=True)
