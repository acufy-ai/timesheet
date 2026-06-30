"""Add client-facing project health (separate from internal health_override)

Revision ID: 110_project_client_health
Revises: 109_dashboard_share
Create Date: 2026-06-30

Client Portal Redesign, Phase 1. `projects.health_override` is the INTERNAL RAG
(excellent/at-risk/critical/blocked/on-track) and must never be shown to a
client. This adds a CLIENT-SAFE health the team sets explicitly for the portal:

  client_health      'on_track' | 'at_risk' | 'off_track' | NULL  (NULL = hidden)
  client_health_note free-text context shown with the pill

Both nullable; NULL client_health means the portal omits the health pill
entirely (a client never sees a default/derived state). No DB CHECK on the
allowed set on purpose: the allowlist is enforced in the input Pydantic schema
only, so a response serializing an odd stored value can never 500 (see the
response-schema-validator trap). Additive, non-destructive.
"""
from alembic import op
import sqlalchemy as sa

revision = "110_project_client_health"
down_revision = "109_dashboard_share"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("client_health", sa.Text(), nullable=True))
    op.add_column("projects", sa.Column("client_health_note", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("projects", "client_health_note")
    op.drop_column("projects", "client_health")
