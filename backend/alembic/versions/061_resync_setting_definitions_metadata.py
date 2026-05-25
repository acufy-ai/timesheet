"""Re-sync setting_definitions labels and descriptions from the seed catalog.

The seed helper uses ``INSERT ... ON CONFLICT DO NOTHING`` so existing rows
are not touched. That preserves operator edits, but it also means
metadata refinements in the seed catalog (clearer wording, removing dev-
leakage like "0 = Sunday, 1 = Monday.") never reach already-seeded
tenants.

This migration is a one-shot resync of ``label``, ``description``,
``category``, and ``sort_order`` for keys that already exist in the
table, using the values currently in
``app.seed_setting_definitions.CATALOG``. ``default_value`` and
``validation`` are intentionally NOT updated here so any tenant-customized
defaults stay put.

Revision ID: 061
Revises: 060
Create Date: 2026-05-25
"""
from __future__ import annotations

from alembic import op
from sqlalchemy import text

from app.seed_setting_definitions import CATALOG

revision = "061_resync_setting_metadata"
down_revision = "060_time_entry_start_end_time"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    for key, defn in CATALOG.items():
        bind.execute(
            text(
                """
                UPDATE setting_definitions
                   SET label = :label,
                       description = :description,
                       category = :category,
                       sort_order = :sort_order
                 WHERE key = :key
                """
            ),
            {
                "key": key,
                "label": defn["label"],
                "description": defn["description"],
                "category": defn["category"],
                "sort_order": defn.get("sort_order", 0),
            },
        )


def downgrade() -> None:
    # No reversible action: we did not record the prior label/description
    # values. The seed catalog at any prior migration revision is the
    # canonical source for what those values were.
    pass
