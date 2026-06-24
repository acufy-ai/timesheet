"""Backfill all project codes to the sequential PR#### scheme

Revision ID: 084_backfill_project_codes
Revises: 083_user_token_version
Create Date: 2026-06-22

New projects auto-get a PR#### code (PR0001, PR0002, ...). This backfill brings
EXISTING projects onto the same scheme so codes are uniform. Per tenant_id,
projects are renumbered by creation order (lowest id = PR0001), overwriting any
prior code (MOB, AI-P, PR003, blanks, ...).

Heads-up: the email-ingestion pipeline can match an incoming project_code
against Project.code. Renumbering changes those codes, so any in-flight email
referencing an OLD code (e.g. "MOB") will no longer resolve by code until the
sender uses the new PR#### value. This was an explicit, accepted decision.

Runs against every tenant DB and the legacy timesheet_db. Partitioning by
tenant_id keeps each tenant's sequence independent (each per-tenant DB holds one
tenant; the legacy DB may hold several, so the partition matters there).

Postgres-only (uses row_number() window + format()). The app's tenant DBs are
all Postgres; the SQLite test harness never runs Alembic.
"""
from alembic import op

revision = "084_backfill_project_codes"
down_revision = "083_user_token_version"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Assign PR + 4-digit zero-padded sequence per tenant, ordered by id.
    op.execute(
        """
        WITH seq AS (
            SELECT id,
                   row_number() OVER (PARTITION BY tenant_id ORDER BY id) AS rn
            FROM projects
        )
        UPDATE projects p
        SET code = 'PR' || to_char(seq.rn, 'FM0000')
        FROM seq
        WHERE p.id = seq.id
        """
    )


def downgrade() -> None:
    # The pre-backfill codes (MOB, AI-P, blanks, ...) are not recoverable, so the
    # downgrade is a no-op rather than a guess. Codes remain PR####.
    pass
