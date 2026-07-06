"""Add attendance_events (clock-in / clock-out presence log)

Revision ID: 113_attendance_events
Revises: 112_project_access_role
Create Date: 2026-07-05

A pure presence signal: users clock in / out and their manager is notified.
Append-only event log; never touches time entries or billable hours.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "113_attendance_events"
down_revision = "112_project_access_role"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create the enum idempotently via raw SQL, then reference it in the column
    # WITHOUT letting SQLAlchemy emit a second CREATE TYPE (create_type=False).
    op.execute(
        "DO $$ BEGIN "
        "IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendanceeventtype') THEN "
        "CREATE TYPE attendanceeventtype AS ENUM ('clock_in', 'clock_out'); "
        "END IF; END $$;"
    )
    attendance_type = postgresql.ENUM(
        "clock_in", "clock_out", name="attendanceeventtype", create_type=False,
    )

    op.create_table(
        "attendance_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tenant_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("event_type", attendance_type, nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("note", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_attendance_events_tenant_id", "attendance_events", ["tenant_id"])
    op.create_index("ix_attendance_events_user_id", "attendance_events", ["user_id"])
    op.create_index("ix_attendance_events_occurred_at", "attendance_events", ["occurred_at"])


def downgrade() -> None:
    op.drop_index("ix_attendance_events_occurred_at", table_name="attendance_events")
    op.drop_index("ix_attendance_events_user_id", table_name="attendance_events")
    op.drop_index("ix_attendance_events_tenant_id", table_name="attendance_events")
    op.drop_table("attendance_events")
    sa.Enum(name="attendanceeventtype").drop(op.get_bind(), checkfirst=True)
