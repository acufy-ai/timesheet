"""Add billed_rate / billed_currency snapshot columns to time_entries

Revision ID: 086_time_entry_billed_rate
Revises: 085_user_department_id
Create Date: 2026-06-23

Time entries had NO rate column: revenue was always recomputed live as
hours x project.billable_rate, so editing a project (or role) rate silently
re-priced already-approved history. This adds a "frozen receipt": when an entry
is approved, the resolved rate (role-rate card -> project rate fallback) and its
currency are stamped onto the entry and never change again.

Both columns are nullable: DRAFT/SUBMITTED/REJECTED entries carry no snapshot;
only APPROVED entries get one. Existing approved rows are left NULL (no
trustworthy historical rate exists to backfill); reporting falls back to the
live project rate for those until they're re-approved. Additive — nothing reads
these as required.
"""
import sqlalchemy as sa
from alembic import op


revision = "086_time_entry_billed_rate"
down_revision = "085_user_department_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "time_entries",
        sa.Column("billed_rate", sa.Numeric(12, 2), nullable=True),
    )
    op.add_column(
        "time_entries",
        sa.Column("billed_currency", sa.String(length=10), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("time_entries", "billed_currency")
    op.drop_column("time_entries", "billed_rate")
