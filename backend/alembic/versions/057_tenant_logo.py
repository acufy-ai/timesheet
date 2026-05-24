"""Add logo_storage_key to tenants for the per-tenant branding logo.

The logo lives in the per-tenant DB (not the control plane) so each
tenant's logo is physically isolated by the DB-per-tenant boundary the
app already enforces. The column stores the storage backend's key
(e.g. ``tenant-logos/webilent-technology-inc/abc123.png``) - the file
itself goes through ``app.services.storage`` like any other upload.

Revision ID: 057_tenant_logo
Revises: 056_user_preferences
Create Date: 2026-05-19
"""
from alembic import op
import sqlalchemy as sa

revision = "057_tenant_logo"
down_revision = "056_user_preferences"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tenants", sa.Column("logo_storage_key", sa.String(512), nullable=True))
    op.add_column("tenants", sa.Column("logo_mime_type", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("tenants", "logo_mime_type")
    op.drop_column("tenants", "logo_storage_key")
