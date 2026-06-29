"""Add public share columns to custom_dashboards

Revision ID: 109_dashboard_share
Revises: 108_custom_dashboards
Create Date: 2026-06-29

Smartsheet-style sharing: a dashboard can be published behind an opaque,
revocable token that renders it read-only with no login. The owner picks the
data mode:
  - 'live'     → the public view re-queries the owner's metrics on each load.
  - 'snapshot' → the public view renders frozen data captured at share time
                 (and re-captured when the owner hits "Refresh snapshot").
share_token is NULL until the dashboard is published; setting it back to NULL
revokes the link.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "109_dashboard_share"
down_revision = "108_custom_dashboards"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("custom_dashboards", sa.Column("share_token", sa.String(length=64), nullable=True))
    op.add_column(
        "custom_dashboards",
        sa.Column("share_mode", sa.String(length=16), nullable=False, server_default="live"),
    )
    op.add_column("custom_dashboards", sa.Column("share_snapshot", JSONB(), nullable=True))
    op.add_column(
        "custom_dashboards",
        sa.Column("share_created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_custom_dashboards_share_token",
        "custom_dashboards",
        ["share_token"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_custom_dashboards_share_token", table_name="custom_dashboards")
    op.drop_column("custom_dashboards", "share_created_at")
    op.drop_column("custom_dashboards", "share_snapshot")
    op.drop_column("custom_dashboards", "share_mode")
    op.drop_column("custom_dashboards", "share_token")
