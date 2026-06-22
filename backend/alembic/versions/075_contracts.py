"""Add contracts table

Revision ID: 075_contracts
Revises: 074_client_assignment_role
Create Date: 2026-06-17

Phase B of the Clients-redesign port. A client's agreements (MSA / SOW etc.).
`value` is an optional fixed contract value. The signed document is stored via
the existing storage service (local/S3); we keep the storage key + original
filename + size here, never the bytes.
"""
from alembic import op
import sqlalchemy as sa

revision = "075_contracts"
down_revision = "074_client_assignment_role"
branch_labels = None
depends_on = None

CONTRACT_STATUSES = ("draft", "active", "on_hold", "completed", "churned")


def upgrade() -> None:
    # Drop any orphan enum from a prior half-applied run, then let create_table
    # emit exactly one CREATE TYPE (the sa.Enum column, create_type default).
    op.execute("DROP TYPE IF EXISTS contractstatus")
    op.create_table(
        "contracts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tenant_id", sa.Integer(), nullable=False),
        sa.Column("client_id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("kind", sa.String(length=120), nullable=True),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("value", sa.Numeric(14, 2), nullable=True),
        sa.Column(
            "status",
            sa.Enum(*CONTRACT_STATUSES, name="contractstatus"),
            nullable=False,
            server_default="draft",
        ),
        # Attached signed document (storage service key + metadata). Null = none.
        sa.Column("document_key", sa.String(length=255), nullable=True),
        sa.Column("document_name", sa.String(length=512), nullable=True),
        sa.Column("document_size", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_contracts_client_id", "contracts", ["client_id"])
    op.create_index("ix_contracts_tenant_id", "contracts", ["tenant_id"])


def downgrade() -> None:
    op.drop_table("contracts")
    op.execute("DROP TYPE contractstatus")
