"""Add managed titles table + users.title_id FK; backfill from distinct
user.title per tenant and link users. Mirrors the departments rollout.

Revision ID: 096_titles
Revises: 095_refresh_token_rotation_grace
"""
from alembic import op
import sqlalchemy as sa

revision = "096_titles"
down_revision = "095_refresh_token_rotation_grace"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "titles",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("tenant_id", "name", name="uq_titles_tenant_name"),
    )
    op.create_index("ix_titles_tenant_id", "titles", ["tenant_id"])

    op.add_column("users", sa.Column("title_id", sa.Integer(), nullable=True))
    op.create_index("ix_users_title_id", "users", ["title_id"])
    op.create_foreign_key(
        "fk_users_title_id",
        "users", "titles",
        ["title_id"], ["id"],
        ondelete="SET NULL",
    )

    # Backfill: one title row per (tenant_id, distinct trimmed title).
    op.execute(
        """
        INSERT INTO titles (tenant_id, name, created_at, updated_at)
        SELECT DISTINCT tenant_id, btrim(title), NOW(), NOW()
        FROM users
        WHERE title IS NOT NULL
          AND btrim(title) <> ''
          AND tenant_id IS NOT NULL
        ON CONFLICT (tenant_id, name) DO NOTHING;
        """
    )

    # Link each user to its title row.
    op.execute(
        """
        UPDATE users u
        SET title_id = t.id
        FROM titles t
        WHERE u.tenant_id = t.tenant_id
          AND u.title IS NOT NULL
          AND lower(btrim(u.title)) = lower(t.name)
          AND u.title_id IS NULL;
        """
    )


def downgrade() -> None:
    op.drop_constraint("fk_users_title_id", "users", type_="foreignkey")
    op.drop_index("ix_users_title_id", table_name="users")
    op.drop_column("users", "title_id")
    op.drop_index("ix_titles_tenant_id", table_name="titles")
    op.drop_table("titles")
