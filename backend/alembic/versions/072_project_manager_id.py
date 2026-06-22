"""Add manager_id (project manager) to projects

Revision ID: 072_project_manager_id
Revises: 071_client_project_status
Create Date: 2026-06-17

Phase A of the Clients-redesign port. A project's manager_id points at the
internal user (a manager) who runs the engagement. Nullable: a project can be
unassigned. ON DELETE SET NULL so removing a user doesn't cascade-delete their
projects. The app constrains the choice to the client's assigned PMs, but the
FK only enforces "a real user".
"""
from alembic import op
import sqlalchemy as sa

revision = "072_project_manager_id"
down_revision = "071_client_project_status"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("manager_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_projects_manager_id_users",
        "projects",
        "users",
        ["manager_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_projects_manager_id", "projects", ["manager_id"])


def downgrade() -> None:
    op.drop_index("ix_projects_manager_id", table_name="projects")
    op.drop_constraint("fk_projects_manager_id_users", "projects", type_="foreignkey")
    op.drop_column("projects", "manager_id")
