"""M2: defense-in-depth tenant_id on three child tables.

Revision ID: 066_tenant_id_defense_in_depth
Revises: 065_sent_reminders
Create Date: 2026-05-28

Three tables (``time_entry_edit_history``, ``ingestion_timesheet_line_items``,
``ingestion_audit_log``) carry tenant-scoped data via their parent row but
don't have a ``tenant_id`` column themselves. Per-tenant DB isolation is
the primary boundary, so cross-tenant leakage is impossible today, but
the missing column makes:

  - direct SQL queries that filter by tenant_id less expressive,
  - any future shared-DB tenant a footgun, and
  - the eventual Phase 3.F cleanup uneven (it'd drop tenant_id from
    some tables but never have it on others).

This migration adds the column to each, backfills from the parent, and
adds a composite (tenant_id, parent_id) index that matches the most
common query shape.
"""
from alembic import op
import sqlalchemy as sa


revision = "066_tenant_id_defense_in_depth"
down_revision = "065_sent_reminders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── time_entry_edit_history ───────────────────────────────────
    op.add_column(
        "time_entry_edit_history",
        sa.Column("tenant_id", sa.Integer(), nullable=True),
    )
    # Backfill from the parent time_entries row. Using raw SQL because
    # the Alembic op layer doesn't expose a typed update-from-join.
    op.execute(
        """
        UPDATE time_entry_edit_history
        SET tenant_id = te.tenant_id
        FROM time_entries te
        WHERE time_entry_edit_history.time_entry_id = te.id
        """
    )
    # Now that every row has a value, lock the column down.
    op.alter_column(
        "time_entry_edit_history",
        "tenant_id",
        existing_type=sa.Integer(),
        nullable=False,
    )
    op.create_foreign_key(
        "fk_time_entry_edit_history_tenant",
        "time_entry_edit_history",
        "tenants",
        ["tenant_id"],
        ["id"],
    )
    op.create_index(
        "ix_time_entry_edit_history_tenant_entry",
        "time_entry_edit_history",
        ["tenant_id", "time_entry_id"],
    )

    # ── ingestion_timesheet_line_items ────────────────────────────
    op.add_column(
        "ingestion_timesheet_line_items",
        sa.Column("tenant_id", sa.Integer(), nullable=True),
    )
    op.execute(
        """
        UPDATE ingestion_timesheet_line_items
        SET tenant_id = its.tenant_id
        FROM ingestion_timesheets its
        WHERE ingestion_timesheet_line_items.ingestion_timesheet_id = its.id
        """
    )
    op.alter_column(
        "ingestion_timesheet_line_items",
        "tenant_id",
        existing_type=sa.Integer(),
        nullable=False,
    )
    op.create_foreign_key(
        "fk_ingestion_timesheet_line_items_tenant",
        "ingestion_timesheet_line_items",
        "tenants",
        ["tenant_id"],
        ["id"],
    )
    op.create_index(
        "ix_ingestion_line_items_tenant_timesheet",
        "ingestion_timesheet_line_items",
        ["tenant_id", "ingestion_timesheet_id"],
    )

    # ── ingestion_audit_log ───────────────────────────────────────
    op.add_column(
        "ingestion_audit_log",
        sa.Column("tenant_id", sa.Integer(), nullable=True),
    )
    op.execute(
        """
        UPDATE ingestion_audit_log
        SET tenant_id = its.tenant_id
        FROM ingestion_timesheets its
        WHERE ingestion_audit_log.ingestion_timesheet_id = its.id
        """
    )
    op.alter_column(
        "ingestion_audit_log",
        "tenant_id",
        existing_type=sa.Integer(),
        nullable=False,
    )
    op.create_foreign_key(
        "fk_ingestion_audit_log_tenant",
        "ingestion_audit_log",
        "tenants",
        ["tenant_id"],
        ["id"],
    )
    op.create_index(
        "ix_ingestion_audit_log_tenant_timesheet",
        "ingestion_audit_log",
        ["tenant_id", "ingestion_timesheet_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_ingestion_audit_log_tenant_timesheet", table_name="ingestion_audit_log")
    op.drop_constraint("fk_ingestion_audit_log_tenant", "ingestion_audit_log", type_="foreignkey")
    op.drop_column("ingestion_audit_log", "tenant_id")

    op.drop_index("ix_ingestion_line_items_tenant_timesheet", table_name="ingestion_timesheet_line_items")
    op.drop_constraint("fk_ingestion_timesheet_line_items_tenant", "ingestion_timesheet_line_items", type_="foreignkey")
    op.drop_column("ingestion_timesheet_line_items", "tenant_id")

    op.drop_index("ix_time_entry_edit_history_tenant_entry", table_name="time_entry_edit_history")
    op.drop_constraint("fk_time_entry_edit_history_tenant", "time_entry_edit_history", type_="foreignkey")
    op.drop_column("time_entry_edit_history", "tenant_id")
