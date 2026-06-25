"""Collapse the two-tier client portal roles back to a single CLIENT role.

Product decision: client-side users invited by a PM are tagged simply CLIENT
again (the CLIENT_MANAGER / CLIENT_EMPLOYEE split is retired for the invite
flow). This data migration converts EXISTING client users to the flat CLIENT
role so the whole client population is single-role.

  - role column: CLIENT_MANAGER / CLIENT_EMPLOYEE -> CLIENT
  - roles JSONB array: replace those values with "CLIENT" and dedupe (a user
    could already carry CLIENT alongside a sub-role).

Postgres can't DROP an enum value, so CLIENT_MANAGER / CLIENT_EMPLOYEE remain in
the userrole type after this (harmless, just unused by new rows). The two-tier
tables (client_employee_links, client_task_review) are left in place; they
simply stop being written for the now-flat client users.
"""
from alembic import op


revision = "094_collapse_client_roles"
down_revision = "093_client_note_author_fk"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Active role.
    op.execute(
        "UPDATE users SET role = 'CLIENT' "
        "WHERE role IN ('CLIENT_MANAGER', 'CLIENT_EMPLOYEE')"
    )
    # roles JSONB: map both sub-roles to CLIENT, then dedupe the array so a user
    # who had e.g. ["CLIENT","CLIENT_MANAGER"] ends up with just ["CLIENT"].
    op.execute(
        """
        UPDATE users
        SET roles = (
            SELECT jsonb_agg(DISTINCT mapped)
            FROM (
                SELECT CASE
                    WHEN v IN ('"CLIENT_MANAGER"'::jsonb, '"CLIENT_EMPLOYEE"'::jsonb)
                    THEN '"CLIENT"'::jsonb ELSE v END AS mapped
                FROM jsonb_array_elements(roles) AS v
            ) AS m
        )
        WHERE roles @> '["CLIENT_MANAGER"]'::jsonb
           OR roles @> '["CLIENT_EMPLOYEE"]'::jsonb
        """
    )


def downgrade() -> None:
    # Not reversible: we cannot tell which flat CLIENT users were originally
    # managers vs employees. This is a one-way collapse by product decision.
    pass
