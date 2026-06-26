"""Task dependencies (Phase 2, part 4): blocking edges between tasks.

A row (task_id -> depends_on_task_id) means depends_on_task_id blocks task_id
(the predecessor must finish first). Edges are validated app-side to stay within
one project and acyclic. Both task FKs cascade-delete so removing a task removes
its edges. Unique edge + no-self-edge guards enforced at the DB level too.

Revision ID: 104_task_dependencies
Revises: 103_taskstatus_blocked
"""
from alembic import op
import sqlalchemy as sa

revision = "104_task_dependencies"
down_revision = "103_taskstatus_blocked"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "task_dependencies",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("task_id", sa.Integer(), sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("depends_on_task_id", sa.Integer(), sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("task_id", "depends_on_task_id", name="uq_task_dependency_edge"),
        sa.CheckConstraint("task_id <> depends_on_task_id", name="ck_task_dependency_no_self"),
    )
    op.create_index("ix_task_dependencies_tenant_id", "task_dependencies", ["tenant_id"])
    op.create_index("ix_task_dependencies_task_id", "task_dependencies", ["task_id"])
    op.create_index("ix_task_dependencies_depends_on_task_id", "task_dependencies", ["depends_on_task_id"])


def downgrade() -> None:
    op.drop_index("ix_task_dependencies_depends_on_task_id", table_name="task_dependencies")
    op.drop_index("ix_task_dependencies_task_id", table_name="task_dependencies")
    op.drop_index("ix_task_dependencies_tenant_id", table_name="task_dependencies")
    op.drop_table("task_dependencies")
