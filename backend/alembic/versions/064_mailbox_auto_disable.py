"""Mailbox auto-disable on repeated fetch failures.

Revision ID: 064_mailbox_auto_disable
Revises: 063_time_entry_user_date_index
Create Date: 2026-05-28

Adds two columns to ``mailboxes`` so the worker can disable a mailbox
that has failed to fetch repeatedly (typically: wrong credentials,
permanently-down provider, blocked by firewall), instead of logging
the same failure on every scheduled run.

  - ``consecutive_fetch_failures``: incremented on each failed fetch,
    reset to 0 on each successful fetch.
  - ``auto_disabled_reason``: human-readable message shown in the UI
    when the mailbox is disabled by the worker (vs disabled by an
    admin). NULL means the mailbox was either never disabled or was
    disabled manually.

The existing ``is_active`` column stays as the single source of truth
for "should the worker include this mailbox in the next fetch?" — the
worker flips it to False when the failure count crosses the threshold.
"""
from alembic import op
import sqlalchemy as sa


revision = "064_mailbox_auto_disable"
down_revision = "063_time_entry_user_date_index"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "mailboxes",
        sa.Column(
            "consecutive_fetch_failures",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "mailboxes",
        sa.Column("auto_disabled_reason", sa.String(length=1024), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("mailboxes", "auto_disabled_reason")
    op.drop_column("mailboxes", "consecutive_fetch_failures")
