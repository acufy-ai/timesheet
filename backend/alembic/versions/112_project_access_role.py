"""Add user_project_access.role (per-project billing role for a resource)

Revision ID: 112_project_access_role
Revises: 111_project_percent_complete
Create Date: 2026-07-01

Demo-prep A3: a resource can hold different roles on different projects (a
Developer on one, a Tester on another) and bill at the client's rate for the
role they actually play on that project. The role lives on the project-roster
row (user_project_access), not on the person, so it varies per project. NULL
falls back to the user's global title. Additive, non-destructive.
"""
from alembic import op
import sqlalchemy as sa

revision = "112_project_access_role"
down_revision = "111_project_percent_complete"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("user_project_access", sa.Column("role", sa.String(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column("user_project_access", "role")
