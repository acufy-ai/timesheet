"""Add 'blocked' to the taskstatus enum (Phase 2 causal data, part 2).

tasks.status is a Postgres ENUM (taskstatus); adding `blocked` to the Python
enum isn't enough, the DB type must learn the label too. Mirrors the pattern
used for the userrole enum in migrations 002 / 081 / 091. We only ADD the value
(never use it in this same transaction), so it is safe inside Alembic's
transaction on PG 12+. IF NOT EXISTS keeps it idempotent across the fleet.

The blocked_reason column already shipped in 102_task_estimate_and_dates, so a
task can be marked blocked with a reason once this value exists.

Revision ID: 103_taskstatus_blocked
Revises: 102_task_estimate_and_dates
"""
from alembic import op

revision = "103_taskstatus_blocked"
down_revision = "102_task_estimate_and_dates"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE taskstatus ADD VALUE IF NOT EXISTS 'blocked'")


def downgrade() -> None:
    # Postgres cannot drop an enum value; leaving 'blocked' in place is harmless.
    pass
