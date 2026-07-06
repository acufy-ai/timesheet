"""tenants.project_management_enabled (control plane)

Adds a project-management-module toggle to the control-plane tenants
table, mirrored from the legacy tenants row on update (same as
ingestion_enabled). Default true so existing tenants keep the module.

Revision ID: 007_tenant_project_management
Revises: 006_platform_admin_auth0_sub
Create Date: 2026-07-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "007_tenant_project_management"
down_revision: Union[str, None] = "006_platform_admin_auth0_sub"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
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
    op.drop_column("tenants", "project_management_enabled")
