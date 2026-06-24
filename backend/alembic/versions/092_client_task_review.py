"""Client-side task review: CLIENT_MANAGER reviews CLIENT_EMPLOYEE task updates

Revision ID: 092_client_task_review
Revises: 091_two_tier_client_portal
Create Date: 2026-06-24

When a CLIENT_EMPLOYEE updates a task they're assigned, a review row is created
(or reset to pending) so their CLIENT_MANAGER can approve or send it back. This
mirrors the internal approval pattern at the client tier, kept lightweight (one
row per task+employee, latest state wins).

Status: pending | approved | rejected.
"""
import sqlalchemy as sa
from alembic import op


revision = "092_client_task_review"
down_revision = "091_two_tier_client_portal"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "client_task_reviews",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id"), nullable=False, index=True),
        sa.Column("task_id", sa.Integer(), sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("employee_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("manager_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("task_id", "employee_user_id", name="uq_client_task_review_task_employee"),
    )


def downgrade() -> None:
    op.drop_table("client_task_reviews")
