"""platform_audit_events table: control-plane audit log

The Dashboard's "Recent platform activity" widget and the new
/platform/audit page both read from this single append-only table.
Captures tenant lifecycle, feature toggles, platform-admin changes,
credential rotations, and system-actor events (background fetch
failures, migrations).

Indexes are tuned for the audit page filters: by category, by tenant,
by actor, all clustered with created_at DESC for chronological reads.

Revision ID: 004_platform_audit_events
Revises: 003_tenant_features
Create Date: 2026-05-18
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "004_platform_audit_events"
down_revision: Union[str, None] = "003_tenant_features"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "platform_audit_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "category",
            sa.Enum(
                "tenant",
                "feature",
                "admin",
                "credentials",
                "migration",
                "system",
                name="platform_audit_category",
            ),
            nullable=False,
        ),
        sa.Column("event", sa.String(length=120), nullable=False),
        sa.Column(
            "severity",
            sa.Enum(
                "info",
                "warn",
                "critical",
                name="platform_audit_severity",
            ),
            nullable=False,
            server_default="info",
        ),
        # Actor. ``actor_user_id`` is null for system-actor events
        # (background jobs, migration runner). ``actor_email`` is
        # denormalized so the audit page still has a useful label after
        # a PA account is removed.
        sa.Column("actor_user_id", sa.Integer(), nullable=True),
        sa.Column("actor_email", sa.String(length=255), nullable=True),
        sa.Column("actor_label", sa.String(length=120), nullable=True),
        # Tenant context. Null for events not bound to a tenant
        # (e.g., platform admin created).
        sa.Column("tenant_id", sa.Integer(), nullable=True),
        sa.Column("tenant_slug", sa.String(length=100), nullable=True),
        sa.Column("tenant_name", sa.String(length=255), nullable=True),
        sa.Column("summary", sa.String(length=500), nullable=False),
        sa.Column(
            "before_state",
            JSONB().with_variant(sa.Text(), "sqlite"),
            nullable=True,
        ),
        sa.Column(
            "after_state",
            JSONB().with_variant(sa.Text(), "sqlite"),
            nullable=True,
        ),
        sa.Column("request_ip", sa.String(length=45), nullable=True),
        sa.Column("user_agent", sa.String(length=500), nullable=True),
        sa.Column("route", sa.String(length=255), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    # Indexes for the audit-page filter combos. created_at descending is
    # implicit via the index direction default; queries that need DESC
    # (most do) will still use these indexes.
    op.create_index(
        "ix_platform_audit_created_at",
        "platform_audit_events",
        ["created_at"],
    )
    op.create_index(
        "ix_platform_audit_category_created",
        "platform_audit_events",
        ["category", "created_at"],
    )
    op.create_index(
        "ix_platform_audit_tenant_created",
        "platform_audit_events",
        ["tenant_id", "created_at"],
    )
    op.create_index(
        "ix_platform_audit_actor_created",
        "platform_audit_events",
        ["actor_user_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_platform_audit_actor_created", table_name="platform_audit_events")
    op.drop_index("ix_platform_audit_tenant_created", table_name="platform_audit_events")
    op.drop_index("ix_platform_audit_category_created", table_name="platform_audit_events")
    op.drop_index("ix_platform_audit_created_at", table_name="platform_audit_events")
    op.drop_table("platform_audit_events")
    op.execute("DROP TYPE IF EXISTS platform_audit_severity")
    op.execute("DROP TYPE IF EXISTS platform_audit_category")
