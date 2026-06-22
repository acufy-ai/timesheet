"""Add project_managers M:N table (multiple PMs per project)

Revision ID: 078_project_managers
Revises: 077_contacts_roles_notes
Create Date: 2026-06-17

A project can have more than one project manager. projects.manager_id is kept
(set to the first PM) for back-compat with anything still reading the single
field; the source of truth for the UI is this join table.
"""
from alembic import op
import sqlalchemy as sa

revision = "078_project_managers"
down_revision = "077_contacts_roles_notes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project_managers",
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("tenant_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("project_id", "user_id"),
    )
    op.create_index("ix_project_managers_user_id", "project_managers", ["user_id"])
    op.create_index("ix_project_managers_tenant_id", "project_managers", ["tenant_id"])
    # Backfill from the existing single manager_id so current projects keep their PM.
    op.execute(
        """
        INSERT INTO project_managers (project_id, user_id, tenant_id)
        SELECT id, manager_id, tenant_id FROM projects WHERE manager_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_table("project_managers")
