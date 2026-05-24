"""Add user_client_assignments table

Revision ID: 053_user_client_assignments
Revises: 052_client_type
Create Date: 2026-05-14
"""
from alembic import op
import sqlalchemy as sa

revision = "053_user_client_assignments"
down_revision = "052_client_type"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_client_assignments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tenant_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("client_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "client_id", name="uq_user_client"),
    )
    op.create_index("ix_user_client_assignments_client_id", "user_client_assignments", ["client_id"])
    op.create_index("ix_user_client_assignments_tenant_id", "user_client_assignments", ["tenant_id"])
    op.create_index("ix_user_client_assignments_user_id", "user_client_assignments", ["user_id"])


def downgrade() -> None:
    op.drop_table("user_client_assignments")
