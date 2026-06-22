"""Add task priority/status and client company/since (fidelity pass)

Revision ID: 076_task_fields_client_fields
Revises: 075_contracts
Create Date: 2026-06-17

Brings the schema up to the clients-redesign prototype's task + client fields:
- tasks.priority  (low / medium / high), default medium
- tasks.status    (to_do / in_progress / done), default to_do
- clients.company (legal/display company name), nullable
- clients.since   (client-since date), nullable

Enum types are created with a guard so a half-applied retry won't fail on a
pre-existing type. add_column with sa.Enum does NOT re-emit CREATE TYPE (only
create_table does), so the guarded CREATE TYPE + plain add_column is safe.
"""
from alembic import op
import sqlalchemy as sa

revision = "076_task_fields_client_fields"
down_revision = "075_contracts"
branch_labels = None
depends_on = None

TASK_PRIORITIES = ("low", "medium", "high")
TASK_STATUSES = ("to_do", "in_progress", "done")


def _create_enum(name: str, values) -> None:
    vals = ", ".join(f"'{v}'" for v in values)
    op.execute(
        f"DO $$ BEGIN CREATE TYPE {name} AS ENUM ({vals}); "
        f"EXCEPTION WHEN duplicate_object THEN NULL; END $$;"
    )


def upgrade() -> None:
    _create_enum("taskpriority", TASK_PRIORITIES)
    _create_enum("taskstatus", TASK_STATUSES)
    op.add_column(
        "tasks",
        sa.Column(
            "priority",
            sa.Enum(*TASK_PRIORITIES, name="taskpriority", create_type=False),
            nullable=False, server_default="medium",
        ),
    )
    op.add_column(
        "tasks",
        sa.Column(
            "status",
            sa.Enum(*TASK_STATUSES, name="taskstatus", create_type=False),
            nullable=False, server_default="to_do",
        ),
    )
    op.add_column("clients", sa.Column("company", sa.String(length=255), nullable=True))
    op.add_column("clients", sa.Column("since", sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column("clients", "since")
    op.drop_column("clients", "company")
    op.drop_column("tasks", "status")
    op.drop_column("tasks", "priority")
    op.execute("DROP TYPE IF EXISTS taskstatus")
    op.execute("DROP TYPE IF EXISTS taskpriority")
