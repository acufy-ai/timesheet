"""Add status enum columns to clients and projects

Revision ID: 071_client_project_status
Revises: 070_customization_settings
Create Date: 2026-06-17

Phase A of the Clients-redesign port. Adds a lifecycle ``status`` to clients
(active / prospect / on_hold / churned) and projects (planning / in_progress /
on_hold / completed). Existing rows default to the sensible "live" value
(clients -> active, projects -> planning) so nothing is left null.

The project ``is_active`` boolean stays as-is (orthogonal: a Completed project
can still be is_active=false). Status is the richer lifecycle signal the UI
shows as a pill.
"""
from alembic import op
import sqlalchemy as sa

revision = "071_client_project_status"
down_revision = "070_customization_settings"
branch_labels = None
depends_on = None

CLIENT_STATUSES = ("active", "prospect", "on_hold", "churned")
PROJECT_STATUSES = ("planning", "in_progress", "on_hold", "completed")


def upgrade() -> None:
    op.execute(
        "CREATE TYPE clientstatus AS ENUM ('active', 'prospect', 'on_hold', 'churned')"
    )
    op.add_column(
        "clients",
        sa.Column(
            "status",
            sa.Enum(*CLIENT_STATUSES, name="clientstatus"),
            nullable=False,
            server_default="active",
        ),
    )

    op.execute(
        "CREATE TYPE projectstatus AS ENUM ('planning', 'in_progress', 'on_hold', 'completed')"
    )
    op.add_column(
        "projects",
        sa.Column(
            "status",
            sa.Enum(*PROJECT_STATUSES, name="projectstatus"),
            nullable=False,
            server_default="planning",
        ),
    )


def downgrade() -> None:
    op.drop_column("projects", "status")
    op.execute("DROP TYPE projectstatus")
    op.drop_column("clients", "status")
    op.execute("DROP TYPE clientstatus")
