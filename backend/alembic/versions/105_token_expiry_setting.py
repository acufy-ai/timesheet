"""Tenant-configurable sign-in session length (access-token expiry).

Seed-only migration: adds the ``access_token_expire_minutes`` key to the
``setting_definitions`` catalog so a tenant admin can choose how long a sign-in
stays valid before it is re-checked (15m / 30m / 1h / 2h / 4h / 8h). No schema
change. Idempotent via ON CONFLICT DO NOTHING, so re-running and the fleet
runner are safe.

Default stays 30 minutes, matching the pre-existing global
``ACCESS_TOKEN_EXPIRE_MINUTES`` so behavior is unchanged until an admin opts in.
The value is read at token-issue time (login / refresh / switch-role) per
tenant; platform-admin tokens (no tenant) keep the global default.

Revision ID: 105_token_expiry_setting
Revises: 104_task_dependencies
"""
from alembic import op
import sqlalchemy as sa

from app.seed_setting_definitions import seed_sync

revision = "105_token_expiry_setting"
down_revision = "104_task_dependencies"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Seed the new catalog key. Idempotent (ON CONFLICT DO NOTHING) so existing
    # rows and operator edits are untouched.
    seed_sync(op.get_bind())


def downgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "DELETE FROM setting_definitions WHERE key = 'access_token_expire_minutes'"
        )
    )
