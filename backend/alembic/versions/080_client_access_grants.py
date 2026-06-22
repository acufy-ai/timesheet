"""Client portal access: grants table + per-project exposure flag

Revision ID: 080_client_access_grants
Revises: 079_user_task_access
Create Date: 2026-06-21

Foundation for the Client Portal feature. Adds:
  - client_access_grants: one row per scoped grant to a CLIENT-role user
    (whole project XOR single task) with a JSONB CRUD capability list.
  - projects.client_access_enabled: per-project PM toggle; a grant is only
    active on a project where this is on. Defaults false (feature dark until
    a PM opts a project in).
The tenant-admin kill switch (client_portal_enabled) is a setting-definition
seed, handled separately in seed_setting_definitions.py — not a schema change.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.seed_setting_definitions import seed_sync

revision = "080_client_access_grants"
down_revision = "079_user_task_access"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "client_access_grants",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tenant_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=True),
        sa.Column("task_id", sa.Integer(), nullable=True),
        sa.Column("capabilities", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.CheckConstraint(
            "(project_id IS NOT NULL) <> (task_id IS NOT NULL)",
            name="ck_client_access_grant_one_scope",
        ),
    )
    op.create_index("ix_client_access_grants_tenant_id", "client_access_grants", ["tenant_id"])
    op.create_index("ix_client_access_grants_user_id", "client_access_grants", ["user_id"])
    op.create_index("ix_client_access_grants_project_id", "client_access_grants", ["project_id"])
    op.create_index("ix_client_access_grants_task_id", "client_access_grants", ["task_id"])
    op.create_index("ix_client_access_grants_user_tenant", "client_access_grants", ["user_id", "tenant_id"])

    op.add_column(
        "projects",
        sa.Column("client_access_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )

    # Seed the tenant-admin kill switch (client_portal_enabled) into the
    # setting-definitions catalog. Idempotent (ON CONFLICT DO NOTHING).
    seed_sync(op.get_bind())


def downgrade() -> None:
    op.get_bind().execute(
        sa.text("DELETE FROM setting_definitions WHERE key = 'client_portal_enabled'")
    )
    op.drop_column("projects", "client_access_enabled")
    op.drop_table("client_access_grants")
