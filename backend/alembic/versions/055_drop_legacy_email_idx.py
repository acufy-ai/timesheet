"""F-007 follow-up: drop the legacy global UNIQUE indexes on
users.email and users.username from the shared DB.

The composite constraints from 054 already enforce per-tenant uniqueness.
The bare-column UNIQUE indexes survived in some DBs because they were
created implicitly with the old single-column UNIQUE constraints and
not all environments removed them when the constraints were dropped.

Their presence means a user created in tenant B with an email already
used in tenant A's shared mirror cannot be mirrored, and consequently
their login fails (shared-DB email->tenant lookup resolves to the
wrong tenant).

This migration is idempotent: every DROP is IF EXISTS, and the new
non-unique btree indexes (which were already present as ix_users_email
in every DB) are re-created only when missing.

Revision ID: 055_drop_legacy_email_unique_indexes
Revises: 054_user_email_per_tenant_unique
Create Date: 2026-05-15
"""
from alembic import op


revision = "055_drop_legacy_email_idx"
down_revision = "054_user_email_per_tenant_unique"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop the legacy UNIQUE indexes if present. Names vary by lineage:
    #   - ix_users_email / ix_users_username: created as UNIQUE by SQLAlchemy
    #     when models had ``unique=True, index=True`` on the columns.
    # Both should be replaced with non-unique btree indexes for lookup
    # speed (login resolves email->tenant by reading the shared DB).
    op.execute("DROP INDEX IF EXISTS ix_users_email")
    op.execute("DROP INDEX IF EXISTS ix_users_username")
    # Recreate as plain non-unique indexes.
    op.execute("CREATE INDEX IF NOT EXISTS ix_users_email ON users (email)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_users_username ON users (username)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_users_email")
    op.execute("DROP INDEX IF EXISTS ix_users_username")
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email ON users (email)")
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username ON users (username)")
