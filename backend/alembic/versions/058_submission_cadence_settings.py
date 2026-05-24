"""Seed setting_definitions with submission_cadence_internal,
submission_cadence_external, and late_grace_business_days.

Revision ID: 058_submission_cadence_settings
Revises: 057_tenant_logo
Create Date: 2026-05-20

No DDL. Re-runs the idempotent catalog seed so the three new keys land
on existing deployments. Defaults match the cadence implied by the
existing reminder fields (weekly internal, monthly external) so there
is no behavior change for current tenants until they explicitly flip
a value.
"""
from alembic import op
from sqlalchemy import text

from app.seed_setting_definitions import seed_sync

revision = "058_submission_cadence_settings"
down_revision = "057_tenant_logo"
branch_labels = None
depends_on = None

NEW_KEYS = [
    "submission_cadence_internal",
    "submission_cadence_external",
    "late_grace_business_days",
]


def upgrade() -> None:
    connection = op.get_bind()
    seed_sync(connection)


def downgrade() -> None:
    connection = op.get_bind()
    connection.execute(
        text("DELETE FROM setting_definitions WHERE key = ANY(:keys)"),
        {"keys": NEW_KEYS},
    )
