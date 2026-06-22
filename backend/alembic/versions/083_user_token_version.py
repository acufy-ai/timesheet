"""Add users.token_version for immediate force-logout

Revision ID: 083_user_token_version
Revises: 082_time_entry_integrity
Create Date: 2026-06-22

Access tokens are stateless JWTs. The Redis jti-denylist (added earlier) makes
*self*-logout immediate, but an admin force-logout of another user couldn't
kill that user's in-flight access token — the admin never holds it. This column
fixes that: every access token carries the ``token_version`` it was minted at,
get_current_user rejects a mismatch, and force-logout / revoke-all-sessions
increments it — instantly invalidating every outstanding access token for that
user with a single DB write and no per-token bookkeeping.

Idempotent (IF NOT EXISTS) so the fleet runner can apply it to every tenant DB
and the legacy timesheet_db safely.
"""
from alembic import op

revision = "083_user_token_version"
down_revision = "082_time_entry_integrity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS token_version")
