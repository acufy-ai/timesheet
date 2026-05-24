"""Add ``start_time`` and ``end_time`` to ``time_entries``.

The redesigned My Time editor (D-060) supports optional time-block
entry. Both columns are nullable: an entry can still be
hours-only (``8h on Project X``) or carry a precise span
(``8:00 AM - 10:00 AM``). The ``hours`` column stays the source of
truth for billing / approval / reports - the time block is metadata
that helps the user reason about their day.

Revision ID: 060_time_entry_start_end_time
Revises: 059_holidays
Create Date: 2026-05-21
"""
from alembic import op
import sqlalchemy as sa


revision = "060_time_entry_start_end_time"
down_revision = "059_holidays"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("time_entries", sa.Column("start_time", sa.Time(), nullable=True))
    op.add_column("time_entries", sa.Column("end_time", sa.Time(), nullable=True))


def downgrade() -> None:
    op.drop_column("time_entries", "end_time")
    op.drop_column("time_entries", "start_time")
