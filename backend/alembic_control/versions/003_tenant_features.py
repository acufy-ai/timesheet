"""tenant_features table: per-tenant feature flags

Adds an explicit table for billing/entitlement flags Acufy controls on
each tenant. Lives in the control plane (not per-tenant DB) because
these are platform-side decisions, not tenant-managed settings.

Two flags shipping with this migration:
  - ``custom_outbound_email`` — tenant can pick non-default outbound
    (OAuth mailbox or custom SMTP) instead of platform default.
  - ``custom_email_template`` — tenant can edit invitation email body.

Future flags get added as columns here without a separate table per
feature.

Revision ID: 003_tenant_features
Revises: 002_tenant_db_connection
Create Date: 2026-05-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "003_tenant_features"
down_revision: Union[str, None] = "002_tenant_db_connection"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "tenant_features",
        sa.Column("tenant_id", sa.Integer(), nullable=False),
        sa.Column(
            "custom_outbound_email",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column(
            "custom_email_template",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("tenant_id"),
    )

    # One row per existing tenant with both flags FALSE. This is the
    # baseline that the resolver code can read from cleanly (instead of
    # having to handle "no row" specially).
    op.execute(
        """
        INSERT INTO tenant_features (tenant_id, custom_outbound_email, custom_email_template)
        SELECT id, false, false FROM tenants
        ON CONFLICT (tenant_id) DO NOTHING
        """
    )

    # Backfill ``custom_outbound_email = TRUE`` for tenants that already
    # have an actively-connected OAuth mailbox. Without this, the
    # outbound-source toggle we ship in B.1 would silently flip these
    # tenants from "OAuth mailbox" (current implicit behavior) to
    # "platform default", a regression at cutover.
    #
    # The mailboxes table is per-tenant DB, so we can't cross-join here
    # from control plane. Instead the backfill query relies on the
    # provisioning script (``backend/scripts/backfill_tenant_features.py``)
    # which iterates tenants and checks each. Leaving this comment as
    # the record of why this migration doesn't do the mailbox-aware
    # backfill itself.
    pass


def downgrade() -> None:
    op.drop_table("tenant_features")
