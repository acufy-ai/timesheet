"""Add project_id + task_id to client_notes

Revision ID: 107_client_note_proj_task
Revises: 106_project_health_5tier
Create Date: 2026-06-29

A client note can optionally target a specific project and task. When a task is
set, the note authoring also writes the note body into that task's
``blocked_reason`` (handled in the API, not here). Both columns are nullable so
plain client-level notes keep working. ON DELETE SET NULL so deleting a project
or task doesn't cascade-delete the note (the note's text survives; it just
loses its link).
"""
from alembic import op
import sqlalchemy as sa

revision = "107_client_note_proj_task"
down_revision = "106_project_health_5tier"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("client_notes", sa.Column("project_id", sa.Integer(), nullable=True))
    op.add_column("client_notes", sa.Column("task_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_client_notes_project_id_projects",
        "client_notes", "projects", ["project_id"], ["id"], ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_client_notes_task_id_tasks",
        "client_notes", "tasks", ["task_id"], ["id"], ondelete="SET NULL",
    )
    op.create_index("ix_client_notes_project_id", "client_notes", ["project_id"])
    op.create_index("ix_client_notes_task_id", "client_notes", ["task_id"])


def downgrade() -> None:
    op.drop_index("ix_client_notes_task_id", table_name="client_notes")
    op.drop_index("ix_client_notes_project_id", table_name="client_notes")
    op.drop_constraint("fk_client_notes_task_id_tasks", "client_notes", type_="foreignkey")
    op.drop_constraint("fk_client_notes_project_id_projects", "client_notes", type_="foreignkey")
    op.drop_column("client_notes", "task_id")
    op.drop_column("client_notes", "project_id")
