"""Reminder worker per-recipient dedup table.

Revision ID: 065_sent_reminders
Revises: 064_mailbox_auto_disable
Create Date: 2026-05-28

Records every reminder email actually sent, keyed on (tenant, user,
period_start, kind). The worker checks this table before sending so a
transient mid-loop failure on tick N doesn't re-notify already-notified
recipients on tick N+1.

A separate housekeeping job will prune rows older than 90 days.
"""
from alembic import op
import sqlalchemy as sa


revision = "065_sent_reminders"
down_revision = "064_mailbox_auto_disable"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sent_reminders",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("reminder_kind", sa.String(length=32), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_sent_reminders_tenant_id",
        "sent_reminders",
        ["tenant_id"],
    )
    op.create_index(
        "ix_sent_reminders_user_id",
        "sent_reminders",
        ["user_id"],
    )
    op.create_index(
        "ix_sent_reminders_tenant_sent_at",
        "sent_reminders",
        ["tenant_id", "sent_at"],
    )
    op.create_unique_constraint(
        "uq_sent_reminders_recipient_period_kind",
        "sent_reminders",
        ["tenant_id", "user_id", "period_start", "reminder_kind"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_sent_reminders_recipient_period_kind",
        "sent_reminders",
        type_="unique",
    )
    op.drop_index("ix_sent_reminders_tenant_sent_at", table_name="sent_reminders")
    op.drop_index("ix_sent_reminders_user_id", table_name="sent_reminders")
    op.drop_index("ix_sent_reminders_tenant_id", table_name="sent_reminders")
    op.drop_table("sent_reminders")
