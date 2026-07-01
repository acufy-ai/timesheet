"""Add projects.percent_complete (manager-entered work completion 0-100)

Revision ID: 111_project_percent_complete
Revises: 110_project_client_health
Create Date: 2026-07-01

Demo-prep Section B: make project health a DERIVED value that follows logically
from its inputs. `percent_complete` is one of the four hand-entered inputs the
PM owns (with budgeted hours, planned duration, hours logged). Health is then
derived from it (schedule pace = %complete / %time elapsed; budget pace =
%complete / %hours burned) instead of dollar-burn alone, which used to let a
project read "0% done but 85% risk with 170 hours logged".

Nullable: when unset, health falls back to the task-completion ratio. Additive,
non-destructive.
"""
from alembic import op
import sqlalchemy as sa

revision = "111_project_percent_complete"
down_revision = "110_project_client_health"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("percent_complete", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("projects", "percent_complete")
