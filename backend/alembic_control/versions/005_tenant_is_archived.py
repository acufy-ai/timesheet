"""tenants.is_archived: soft-delete flag for hard-delete UI action

Adds an ``is_archived`` boolean to the control-plane tenants table.
Archived tenants stay in the row store (so the platform_audit_events
that reference them remain readable) but are filtered out of every
operational query: list, login routing, dashboard counts.

The HTTP "Delete tenant" action sets this flag plus a status flip to
``suspended``. Truly dropping the per-tenant Postgres database stays
a manual operator step (you can't drop a DB while async connections
to it are open; doing it from an HTTP handler is the wrong tool for
the job).

Revision ID: 005_tenant_is_archived
Revises: 004_platform_audit_events
Create Date: 2026-05-19
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "005_tenant_is_archived"
down_revision: Union[str, None] = "004_platform_audit_events"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column(
            "is_archived",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    # Index helps the "WHERE is_archived = false" filter that every
    # operational query will pick up. Small fleet for now, but the
    # index is cheap insurance.
    op.create_index(
        "ix_tenants_is_archived",
        "tenants",
        ["is_archived"],
    )


def downgrade() -> None:
    op.drop_index("ix_tenants_is_archived", table_name="tenants")
    op.drop_column("tenants", "is_archived")
