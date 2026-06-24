"""Multi-manager: employee_manager_assignments many-to-many + is_primary

Revision ID: 089_multi_manager_assignments
Revises: 088_client_contact_is_primary
Create Date: 2026-06-23

An employee could have only ONE manager: employee_manager_assignments.employee_id
was the PRIMARY KEY, capping the table at one row per employee. This is the
keystone change that unblocks the multi-manager case ("20h approved by Manager A,
20h by Manager B").

  - Add `is_primary` (bool). Every existing row is the employee's primary manager.
  - Change the primary key from (employee_id) to (employee_id, manager_id) so an
    employee can have multiple manager rows.
  - A partial unique index keeps at most ONE primary manager per employee.

Backfill: existing rows -> is_primary = true (they were the sole manager).

Postgres-only DDL (the SQLite test harness never runs Alembic).
"""
import sqlalchemy as sa
from alembic import op


revision = "089_multi_manager_assignments"
down_revision = "088_client_contact_is_primary"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1) New column; existing rows become the primary manager.
    op.add_column(
        "employee_manager_assignments",
        sa.Column("is_primary", sa.Boolean(), nullable=False, server_default="true"),
    )

    # 2) Swap the primary key: (employee_id) -> (employee_id, manager_id).
    #    The PK constraint name follows the default convention.
    op.drop_constraint(
        "employee_manager_assignments_pkey",
        "employee_manager_assignments",
        type_="primary",
    )
    op.create_primary_key(
        "employee_manager_assignments_pkey",
        "employee_manager_assignments",
        ["employee_id", "manager_id"],
    )

    # 3) At most one primary manager per employee.
    op.create_index(
        "uq_emp_mgr_one_primary",
        "employee_manager_assignments",
        ["employee_id"],
        unique=True,
        postgresql_where=sa.text("is_primary"),
    )

    # New default for future rows is false (a row is primary only when set so).
    op.alter_column(
        "employee_manager_assignments",
        "is_primary",
        server_default="false",
    )


def downgrade() -> None:
    op.drop_index(
        "uq_emp_mgr_one_primary", table_name="employee_manager_assignments"
    )
    # Collapse back to one row per employee: keep the primary (or any) row.
    op.execute(
        """
        DELETE FROM employee_manager_assignments a
        USING employee_manager_assignments b
        WHERE a.employee_id = b.employee_id
          AND a.manager_id <> b.manager_id
          AND (
            (b.is_primary AND NOT a.is_primary)
            OR (a.is_primary = b.is_primary AND a.manager_id > b.manager_id)
          )
        """
    )
    op.drop_constraint(
        "employee_manager_assignments_pkey",
        "employee_manager_assignments",
        type_="primary",
    )
    op.create_primary_key(
        "employee_manager_assignments_pkey",
        "employee_manager_assignments",
        ["employee_id"],
    )
    op.drop_column("employee_manager_assignments", "is_primary")
