"""Add users.department_id FK to departments + backfill from free-text department

Revision ID: 085_user_department_id
Revises: 084_backfill_project_codes
Create Date: 2026-06-23

Wires the orphaned `departments` table to users. Until now `users.department` was
a free-text string and the managed `Department` table was disconnected (no FK,
no rollup). This adds a nullable `users.department_id` FK and backfills it from
the existing string:

  - For every distinct non-empty `users.department` value (per tenant), ensure a
    `departments` row exists with that name (insert if missing), then point the
    user's `department_id` at it.

The free-text `users.department` column is KEPT alongside the FK (additive
rollout). A later migration can drop it once everything reads the FK.

Postgres-only backfill (the SQLite test harness never runs Alembic). Runs against
every tenant DB and the legacy timesheet_db; partitioning the name-match by
tenant_id keeps each tenant's department namespace independent.
"""
import sqlalchemy as sa
from alembic import op


revision = "085_user_department_id"
down_revision = "084_backfill_project_codes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("department_id", sa.Integer(), nullable=True),
    )
    op.create_index("ix_users_department_id", "users", ["department_id"])
    op.create_foreign_key(
        "fk_users_department_id",
        "users", "departments",
        ["department_id"], ["id"],
        ondelete="SET NULL",
    )

    # 1) Ensure a departments row exists for every distinct free-text value
    #    currently on a user (per tenant). Trim + skip blanks.
    op.execute(
        """
        INSERT INTO departments (tenant_id, name, created_at, updated_at)
        SELECT DISTINCT u.tenant_id, btrim(u.department), now(), now()
        FROM users u
        WHERE u.department IS NOT NULL
          AND btrim(u.department) <> ''
          AND u.tenant_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM departments d
            WHERE d.tenant_id = u.tenant_id
              AND lower(d.name) = lower(btrim(u.department))
          )
        """
    )

    # 2) Point each user's department_id at the matching departments row
    #    (case-insensitive name match within the same tenant).
    op.execute(
        """
        UPDATE users u
        SET department_id = d.id
        FROM departments d
        WHERE u.tenant_id = d.tenant_id
          AND u.department IS NOT NULL
          AND lower(btrim(u.department)) = lower(d.name)
          AND u.department_id IS NULL
        """
    )


def downgrade() -> None:
    op.drop_constraint("fk_users_department_id", "users", type_="foreignkey")
    op.drop_index("ix_users_department_id", table_name="users")
    op.drop_column("users", "department_id")
