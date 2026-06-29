"""Add custom_dashboards (configurable Insights dashboards)

Revision ID: 108_custom_dashboards
Revises: 107_client_note_proj_task
Create Date: 2026-06-29

A user-built dashboard for the Insights tab: name + a JSONB widget layout, owned
by a user, optionally shared (read-only) to the whole tenant. The layout is an
opaque array of widget instances interpreted by the frontend.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "108_custom_dashboards"
down_revision = "107_client_note_proj_task"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "custom_dashboards",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tenant_id", sa.Integer(), nullable=False),
        sa.Column("owner_user_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("is_shared", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("layout", JSONB(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_foreign_key(
        "fk_custom_dashboards_tenant_id_tenants",
        "custom_dashboards", "tenants", ["tenant_id"], ["id"], ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_custom_dashboards_owner_user_id_users",
        "custom_dashboards", "users", ["owner_user_id"], ["id"], ondelete="SET NULL",
    )
    op.create_index("ix_custom_dashboards_tenant_id", "custom_dashboards", ["tenant_id"])
    op.create_index("ix_custom_dashboards_owner_user_id", "custom_dashboards", ["owner_user_id"])


def downgrade() -> None:
    op.drop_index("ix_custom_dashboards_owner_user_id", table_name="custom_dashboards")
    op.drop_index("ix_custom_dashboards_tenant_id", table_name="custom_dashboards")
    op.drop_constraint("fk_custom_dashboards_owner_user_id_users", "custom_dashboards", type_="foreignkey")
    op.drop_constraint("fk_custom_dashboards_tenant_id_tenants", "custom_dashboards", type_="foreignkey")
    op.drop_table("custom_dashboards")
