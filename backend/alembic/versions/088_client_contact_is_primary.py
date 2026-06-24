"""Add client_contacts.is_primary + backfill from inline client contact

Revision ID: 088_client_contact_is_primary
Revises: 087_project_contract_id
Create Date: 2026-06-23

The client carried an inline single contact (clients.contact_name/email/phone)
that duplicated the richer client_contacts model. This adds an `is_primary` flag
to client_contacts and backfills a primary contact row from the inline fields for
any client that has inline contact info but no contacts yet — so the primary
contact becomes part of the unified contacts collection.

IMPORTANT: clients.contact_email is KEPT. The email ingestion pipeline still
falls back to its domain to route incoming email to a client, so it is NOT
removed here. This migration is purely additive: it surfaces the inline contact
as a proper (primary) ClientContact row without changing routing.
"""
import sqlalchemy as sa
from alembic import op


revision = "088_client_contact_is_primary"
down_revision = "087_project_contract_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "client_contacts",
        sa.Column(
            "is_primary", sa.Boolean(), nullable=False, server_default="false"
        ),
    )

    # Backfill: for each client that has an inline contact name OR email but no
    # client_contacts rows yet, create one primary contact from the inline data.
    # emails/phones are JSONB arrays of {label, address}/{label, number}.
    op.execute(
        """
        INSERT INTO client_contacts
            (tenant_id, client_id, name, role, emails, phones, is_primary,
             created_at, updated_at)
        SELECT
            c.tenant_id,
            c.id,
            COALESCE(NULLIF(btrim(c.contact_name), ''), 'Primary contact'),
            NULL,
            CASE
                WHEN NULLIF(btrim(c.contact_email), '') IS NOT NULL
                THEN jsonb_build_array(jsonb_build_object('label', 'Primary', 'address', btrim(c.contact_email)))
                ELSE '[]'::jsonb
            END,
            CASE
                WHEN NULLIF(btrim(c.contact_phone), '') IS NOT NULL
                THEN jsonb_build_array(jsonb_build_object('label', 'Primary', 'number', btrim(c.contact_phone)))
                ELSE '[]'::jsonb
            END,
            true,
            now(),
            now()
        FROM clients c
        WHERE (NULLIF(btrim(c.contact_name), '') IS NOT NULL
               OR NULLIF(btrim(c.contact_email), '') IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM client_contacts cc WHERE cc.client_id = c.id
          )
        """
    )


def downgrade() -> None:
    op.drop_column("client_contacts", "is_primary")
