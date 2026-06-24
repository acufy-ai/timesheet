"""Link projects to contracts (project.contract_id)

Revision ID: 087_project_contract_id
Revises: 086_time_entry_billed_rate
Create Date: 2026-06-23

The `contracts` table was an orphaned document cabinet: a Contract (MSA/SOW) had
a value and dates but no link to the work delivered under it, so "are we within
the contract value?" was unanswerable. This adds a nullable `projects.contract_id`
FK so a project can be tied to a contract; contract burn (approved billed amounts
vs contract value) is then computable.

Nullable + ON DELETE SET NULL: a project may have no contract, and deleting a
contract simply unlinks its projects rather than cascading. Additive.
"""
import sqlalchemy as sa
from alembic import op


revision = "087_project_contract_id"
down_revision = "086_time_entry_billed_rate"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("contract_id", sa.Integer(), nullable=True),
    )
    op.create_index("ix_projects_contract_id", "projects", ["contract_id"])
    op.create_foreign_key(
        "fk_projects_contract_id",
        "projects", "contracts",
        ["contract_id"], ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_projects_contract_id", "projects", type_="foreignkey")
    op.drop_index("ix_projects_contract_id", table_name="projects")
    op.drop_column("projects", "contract_id")
