"""F-007: scope users.email and users.username uniqueness per-tenant.

Drops the legacy single-column unique constraints (``users_email_key``,
``users_username_key``) and replaces them with composite unique
constraints on ``(tenant_id, email)`` and ``(tenant_id, username)``.

The non-unique btree indexes ``ix_users_email`` and ``ix_users_username``
that login uses to look up by bare email are preserved.

Before deploying this migration to a tenant DB, run the pre-check at the
top of ``upgrade`` to abort cleanly if any duplicate emails would block
the new constraints. Failing fast in upgrade is preferable to a
half-applied migration.

Revision ID: 054_user_email_per_tenant_unique
Revises: 053_user_client_assignments
Create Date: 2026-05-15
"""
from alembic import op
import sqlalchemy as sa

revision = "054_user_email_per_tenant_unique"
down_revision = "053_user_client_assignments"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()

    # Pre-check: if any (tenant_id, email) or (tenant_id, username) pair
    # currently has more than one row, the new constraint will fail.
    # Abort with a clear error rather than partially applying.
    dup_email = bind.execute(sa.text(
        "SELECT tenant_id, email, COUNT(*) c FROM users "
        "GROUP BY tenant_id, email HAVING COUNT(*) > 1 LIMIT 5"
    )).fetchall()
    dup_username = bind.execute(sa.text(
        "SELECT tenant_id, username, COUNT(*) c FROM users "
        "GROUP BY tenant_id, username HAVING COUNT(*) > 1 LIMIT 5"
    )).fetchall()
    if dup_email or dup_username:
        raise RuntimeError(
            f"Cannot apply 054: existing duplicate (tenant_id, email) rows: "
            f"{dup_email!r}; duplicate (tenant_id, username) rows: {dup_username!r}. "
            "Resolve duplicates before retrying."
        )

    # Drop legacy single-column unique constraints. They exist on
    # per-tenant DBs but were already absent from the legacy timesheet_db,
    # so use IF EXISTS to keep the migration idempotent across both.
    op.execute("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key")
    op.execute("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key")

    # Add composite uniques.
    op.create_unique_constraint("uq_users_tenant_email", "users", ["tenant_id", "email"])
    op.create_unique_constraint("uq_users_tenant_username", "users", ["tenant_id", "username"])

    # ix_users_email / ix_users_username already exist as non-unique
    # btree indexes on every audited DB; no need to create them here.


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP CONSTRAINT IF EXISTS uq_users_tenant_email")
    op.execute("ALTER TABLE users DROP CONSTRAINT IF EXISTS uq_users_tenant_username")
    # Re-create legacy globals. If this fails due to cross-tenant
    # duplicates, the operator is downgrading after onboarding tenants
    # that share an email - they will need to resolve manually.
    op.create_unique_constraint("users_email_key", "users", ["email"])
    op.create_unique_constraint("users_username_key", "users", ["username"])
