"""Add assignment_role to user_client_assignments

Revision ID: 074_client_assignment_role
Revises: 073_task_assignees
Create Date: 2026-06-17

Phase A of the Clients-redesign port. Distinguishes project managers from plain
team members on a client roster. A user can be a PM on one client and a member
on another, so the role lives on the assignment row (not the user). Existing
rows default to 'member'.
"""
from alembic import op
import sqlalchemy as sa

revision = "074_client_assignment_role"
down_revision = "073_task_assignees"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE TYPE clientassignmentrole AS ENUM ('pm', 'member')")
    op.add_column(
        "user_client_assignments",
        sa.Column(
            "assignment_role",
            sa.Enum("pm", "member", name="clientassignmentrole"),
            nullable=False,
            server_default="member",
        ),
    )


def downgrade() -> None:
    op.drop_column("user_client_assignments", "assignment_role")
    op.execute("DROP TYPE clientassignmentrole")
