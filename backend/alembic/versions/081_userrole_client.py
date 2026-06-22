"""Add CLIENT to the userrole enum

Revision ID: 081_userrole_client
Revises: 080_client_access_grants
Create Date: 2026-06-21

The users.role column is a Postgres ENUM; adding CLIENT to the Python enum
isn't enough — the DB type must learn the new label too. Mirrors the pattern
used in migration 002 for PLATFORM_ADMIN. IF NOT EXISTS keeps it idempotent
across the fleet.
"""
from alembic import op

revision = "081_userrole_client"
down_revision = "080_client_access_grants"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE userrole ADD VALUE IF NOT EXISTS 'CLIENT'")


def downgrade() -> None:
    # Postgres cannot drop an enum value; leaving CLIENT in place is harmless.
    pass
