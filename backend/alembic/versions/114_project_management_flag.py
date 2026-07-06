"""Add tenants.project_management_enabled (per-tenant tree)

Revision ID: 114_project_management_flag
Revises: 113_attendance_events
Create Date: 2026-07-06

Per-tenant toggle for the project-management module. Default true so existing
tenants keep it. Idempotent add_column (checks first) since this tree also runs
against the legacy shared timesheet_db.
"""
from alembic import op
import sqlalchemy as sa

revision = "114_project_management_flag"
down_revision = "113_attendance_events"
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    return column in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    if not _has_column("tenants", "project_management_enabled"):
        op.add_column(
            "tenants",
            sa.Column(
                "project_management_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            ),
        )


def downgrade() -> None:
    if _has_column("tenants", "project_management_enabled"):
        op.drop_column("tenants", "project_management_enabled")
