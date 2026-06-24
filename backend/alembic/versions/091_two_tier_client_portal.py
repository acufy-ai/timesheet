"""Two-tier client portal: roles, per-client self-manage toggle, employee links

Revision ID: 091_two_tier_client_portal
Revises: 090_time_entry_approver_manager
Create Date: 2026-06-24

Adds the schema for a two-tier client portal:
  - Two new userrole enum values: CLIENT_MANAGER, CLIENT_EMPLOYEE.
  - clients.client_self_manage_enabled (bool, default false): when on, a client
    manager may invite/create their own client employees; when off, our internal
    team provisions them.
  - client_employee_links: maps a CLIENT_EMPLOYEE to their CLIENT_MANAGER within
    a client org (employee_user_id -> manager_user_id, client_id).

Data migration: existing CLIENT users become CLIENT_MANAGER (the senior, our-side
granted role), and their `roles` JSONB array is updated to match. This runs on
every DB the per-tenant tree is applied to.

Note on enum values: Postgres 12+ allows ALTER TYPE ... ADD VALUE inside a
transaction, but a newly added value cannot be USED in the same transaction it
was added. So the ADD VALUE statements are committed first (autocommit), then the
data migration that references CLIENT_MANAGER runs in the normal migration tx.
"""
import sqlalchemy as sa
from alembic import op


revision = "091_two_tier_client_portal"
down_revision = "090_time_entry_approver_manager"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1) Add the new enum values. A value added by ALTER TYPE cannot be USED in
    #    the same transaction, so commit the migration's open transaction first;
    #    each ALTER TYPE then auto-commits, and a fresh transaction is started for
    #    the rest. IF NOT EXISTS keeps it idempotent across the legacy +
    #    per-tenant DBs.
    op.execute("COMMIT")
    op.execute("ALTER TYPE userrole ADD VALUE IF NOT EXISTS 'CLIENT_MANAGER'")
    op.execute("ALTER TYPE userrole ADD VALUE IF NOT EXISTS 'CLIENT_EMPLOYEE'")
    op.execute("BEGIN")

    # 2) Per-client self-manage toggle.
    op.add_column(
        "clients",
        sa.Column(
            "client_self_manage_enabled", sa.Boolean(),
            nullable=False, server_default="false",
        ),
    )

    # 3) Employee -> client-manager link table.
    op.create_table(
        "client_employee_links",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id"), nullable=False, index=True),
        sa.Column("employee_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("manager_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("employee_user_id", name="uq_client_employee_one_manager"),
    )

    # 4) Data migration: existing CLIENT users -> CLIENT_MANAGER (active role +
    #    the roles JSONB array). They keep all their grants; they're now the
    #    senior client-side role that can delegate.
    op.execute(
        """
        UPDATE users
        SET role = 'CLIENT_MANAGER'
        WHERE role = 'CLIENT'
        """
    )
    # Replace a "CLIENT" entry in the roles array with "CLIENT_MANAGER".
    op.execute(
        """
        UPDATE users
        SET roles = (
            SELECT jsonb_agg(CASE WHEN v = '"CLIENT"'::jsonb THEN '"CLIENT_MANAGER"'::jsonb ELSE v END)
            FROM jsonb_array_elements(roles) AS v
        )
        WHERE roles @> '["CLIENT"]'::jsonb
        """
    )


def downgrade() -> None:
    # Revert the data migration (CLIENT_MANAGER -> CLIENT). Note: Postgres can't
    # DROP an enum value, so CLIENT_MANAGER / CLIENT_EMPLOYEE remain in the type
    # after downgrade (harmless, unused).
    op.execute("UPDATE users SET role = 'CLIENT' WHERE role IN ('CLIENT_MANAGER', 'CLIENT_EMPLOYEE')")
    op.execute(
        """
        UPDATE users
        SET roles = (
            SELECT jsonb_agg(CASE WHEN v IN ('"CLIENT_MANAGER"'::jsonb, '"CLIENT_EMPLOYEE"'::jsonb) THEN '"CLIENT"'::jsonb ELSE v END)
            FROM jsonb_array_elements(roles) AS v
        )
        WHERE roles @> '["CLIENT_MANAGER"]'::jsonb OR roles @> '["CLIENT_EMPLOYEE"]'::jsonb
        """
    )
    op.drop_table("client_employee_links")
    op.drop_column("clients", "client_self_manage_enabled")
