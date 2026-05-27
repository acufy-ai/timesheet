"""platform_admins.auth0_sub: link to Auth0 identity for PA login

Adds an ``auth0_sub`` column to the control-plane platform_admins
table so PA login can resolve an Auth0-issued token back to the local
PA row. Mirrors the per-tenant ``users.auth0_sub`` column added in
migration 047 of the tenant tree.

The column is nullable: pre-migration PAs continue to authenticate via
bcrypt; the first login through Auth0 (Custom Database lazy migration)
writes their ``auth0_sub`` and from that point forward they're
recognised by Auth0 directly. Unique index so two PAs can't end up
linked to the same Auth0 user.

Revision ID: 006_platform_admin_auth0_sub
Revises: 005_tenant_is_archived
Create Date: 2026-05-26
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "006_platform_admin_auth0_sub"
down_revision: Union[str, None] = "005_tenant_is_archived"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "platform_admins",
        sa.Column("auth0_sub", sa.String(length=255), nullable=True),
    )
    op.create_index(
        "ix_platform_admins_auth0_sub",
        "platform_admins",
        ["auth0_sub"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_platform_admins_auth0_sub", table_name="platform_admins")
    op.drop_column("platform_admins", "auth0_sub")
