"""Stamp client note authorship: add client_notes.author_user_id FK

Revision ID: 093_client_note_author_fk
Revises: 092_client_task_review
Create Date: 2026-06-24

client_notes.author was a free-text string the caller could supply/override, so a
note could claim any name. This adds author_user_id (FK to the real user) so
authorship is provable; the `author` string is kept as a denormalized display
name (now server-stamped from the logged-in user, never caller-supplied).

Backfill: where an existing note's author string matches exactly one user's
full_name in the same tenant, link it. Ambiguous / unmatched authors stay NULL
(the string still displays).
"""
import sqlalchemy as sa
from alembic import op


revision = "093_client_note_author_fk"
down_revision = "092_client_task_review"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "client_notes",
        sa.Column("author_user_id", sa.Integer(), nullable=True),
    )
    op.create_index("ix_client_notes_author_user_id", "client_notes", ["author_user_id"])
    op.create_foreign_key(
        "fk_client_notes_author_user_id",
        "client_notes", "users",
        ["author_user_id"], ["id"],
        ondelete="SET NULL",
    )

    # Backfill: link only when the author string maps to EXACTLY one user in the
    # note's tenant (avoid mislinking on duplicate names).
    op.execute(
        """
        UPDATE client_notes n
        SET author_user_id = m.uid
        FROM (
            SELECT u.tenant_id, u.full_name, MIN(u.id) AS uid, COUNT(*) AS c
            FROM users u
            GROUP BY u.tenant_id, u.full_name
        ) m
        WHERE m.c = 1
          AND m.tenant_id = n.tenant_id
          AND m.full_name = n.author
          AND n.author_user_id IS NULL
        """
    )


def downgrade() -> None:
    op.drop_constraint("fk_client_notes_author_user_id", "client_notes", type_="foreignkey")
    op.drop_index("ix_client_notes_author_user_id", table_name="client_notes")
    op.drop_column("client_notes", "author_user_id")
