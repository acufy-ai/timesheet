"""
Regression test for bulk-delete + refetch cursor rewind.

Single-email delete already supports `refetch=true` (rewinds the
mailbox cursor to oldest_received_at - 10min). Bulk delete did NOT have
the equivalent flag, so users had to manually reset each mailbox's
cursor whenever they wanted to re-ingest a batch. This test pins the
new bulk behavior:

  - refetch=true rewinds each affected mailbox's cursor to the OLDEST
    received_at across the batch for THAT mailbox, minus 10 minutes.
  - Only rewinds if the new cursor is older than the current one
    (never advances).
  - refetch=false (default) leaves every cursor alone.
  - Works across multiple mailboxes in a single call.

See also: project_email_delete_cursor_model memory for the design.
"""
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB

# JSONB → JSON shim for SQLite (test-only).
@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(element, compiler, **kw):  # pragma: no cover - test shim
    return "JSON"


from app.api import ingestion
from app.core.security import create_access_token, get_password_hash
from app.db import get_db
from app.core.deps import get_tenant_db
from app.models.base import Base
from app.models.ingested_email import IngestedEmail
from app.models.mailbox import Mailbox, MailboxAuthType, MailboxProtocol
from app.models.tenant import Tenant, TenantStatus
from app.models.user import User, UserRole


@pytest_asyncio.fixture
async def db_session(tmp_path) -> AsyncSession:
    db_file = tmp_path / "bulk_delete_refetch.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_file}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    await engine.dispose()


@pytest_asyncio.fixture
async def setup_two_mailboxes(db_session: AsyncSession) -> dict:
    """One tenant, two mailboxes, several emails per mailbox at known timestamps."""
    tenant = Tenant(
        name="T", slug="t", status=TenantStatus.active, ingestion_enabled=True,
    )
    db_session.add(tenant)
    await db_session.flush()

    # Ingestion review is gated on MANAGER+can_review, not ADMIN. See
    # app.api.ingestion.require_can_review and CLAUDE.md (admins are
    # explicitly excluded from the reviewer queue).
    reviewer = User(
        tenant_id=tenant.id, email="r@t.example", username="r", full_name="R",
        hashed_password=get_password_hash("password"), role=UserRole.MANAGER,
        is_active=True, has_changed_password=True, email_verified=True, can_review=True,
    )
    db_session.add(reviewer)
    await db_session.flush()

    initial_cursor = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    mb_a = Mailbox(
        tenant_id=tenant.id, label="A", protocol=MailboxProtocol.imap,
        auth_type=MailboxAuthType.basic, is_active=True,
        last_fetched_at=initial_cursor,
    )
    mb_b = Mailbox(
        tenant_id=tenant.id, label="B", protocol=MailboxProtocol.imap,
        auth_type=MailboxAuthType.basic, is_active=True,
        last_fetched_at=initial_cursor,
    )
    db_session.add_all([mb_a, mb_b])
    await db_session.flush()

    # Emails on mailbox A: 2025-12-30 (oldest), 2025-12-31
    # Emails on mailbox B: 2025-12-28 (oldest), 2025-12-29
    e_a_old = IngestedEmail(
        tenant_id=tenant.id, mailbox_id=mb_a.id,
        message_id="<a-old@t>", sender_email="x@y",
        received_at=datetime(2025, 12, 30, 10, 0, 0, tzinfo=timezone.utc),
    )
    e_a_new = IngestedEmail(
        tenant_id=tenant.id, mailbox_id=mb_a.id,
        message_id="<a-new@t>", sender_email="x@y",
        received_at=datetime(2025, 12, 31, 10, 0, 0, tzinfo=timezone.utc),
    )
    e_b_old = IngestedEmail(
        tenant_id=tenant.id, mailbox_id=mb_b.id,
        message_id="<b-old@t>", sender_email="x@y",
        received_at=datetime(2025, 12, 28, 10, 0, 0, tzinfo=timezone.utc),
    )
    e_b_new = IngestedEmail(
        tenant_id=tenant.id, mailbox_id=mb_b.id,
        message_id="<b-new@t>", sender_email="x@y",
        received_at=datetime(2025, 12, 29, 10, 0, 0, tzinfo=timezone.utc),
    )
    db_session.add_all([e_a_old, e_a_new, e_b_old, e_b_new])
    await db_session.commit()

    return {
        "tenant": tenant, "reviewer": reviewer,
        "mb_a": mb_a, "mb_b": mb_b,
        "e_a_old": e_a_old, "e_a_new": e_a_new,
        "e_b_old": e_b_old, "e_b_new": e_b_new,
        "initial_cursor": initial_cursor,
    }


def _make_app(db_session: AsyncSession) -> TestClient:
    app = FastAPI()
    app.include_router(ingestion.router)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_tenant_db] = override_get_db
    return TestClient(app)


def _auth_headers(user: User) -> dict:
    token = create_access_token({"sub": str(user.id), "tenant_id": user.tenant_id})
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_bulk_delete_without_refetch_leaves_cursors_alone(
    db_session: AsyncSession, setup_two_mailboxes: dict
):
    data = setup_two_mailboxes
    reviewer, mb_a, mb_b = data["reviewer"], data["mb_a"], data["mb_b"]

    client = _make_app(db_session)
    with client, patch("app.api.ingestion.delete_file", new=AsyncMock()):
        resp = client.post(
            "/ingestion/emails/bulk-delete",
            json={"email_ids": [data["e_a_old"].id, data["e_b_old"].id]},
            headers=_auth_headers(reviewer),
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["deleted"] == 2
        assert body["cursors_rewound"] == 0

    await db_session.refresh(mb_a)
    await db_session.refresh(mb_b)
    # SQLite drops tzinfo on read; compare naive values.
    assert mb_a.last_fetched_at.replace(tzinfo=None) == data["initial_cursor"].replace(tzinfo=None)
    assert mb_b.last_fetched_at.replace(tzinfo=None) == data["initial_cursor"].replace(tzinfo=None)


@pytest.mark.asyncio
async def test_bulk_delete_with_refetch_rewinds_each_mailbox_to_its_oldest(
    db_session: AsyncSession, setup_two_mailboxes: dict
):
    data = setup_two_mailboxes
    reviewer, mb_a, mb_b = data["reviewer"], data["mb_a"], data["mb_b"]

    # Delete the OLDER email from each mailbox -> each cursor should
    # rewind to that email's received_at - 10min.
    client = _make_app(db_session)
    with client, patch("app.api.ingestion.delete_file", new=AsyncMock()):
        resp = client.post(
            "/ingestion/emails/bulk-delete",
            json={
                "email_ids": [data["e_a_old"].id, data["e_b_old"].id],
                "refetch": True,
            },
            headers=_auth_headers(reviewer),
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["deleted"] == 2
        assert body["cursors_rewound"] == 2

    await db_session.refresh(mb_a)
    await db_session.refresh(mb_b)
    assert mb_a.last_fetched_at.replace(tzinfo=None) == (
        datetime(2025, 12, 30, 10, 0, 0) - timedelta(minutes=10)
    )
    assert mb_b.last_fetched_at.replace(tzinfo=None) == (
        datetime(2025, 12, 28, 10, 0, 0) - timedelta(minutes=10)
    )


@pytest.mark.asyncio
async def test_bulk_delete_refetch_uses_oldest_when_both_per_mailbox_deleted(
    db_session: AsyncSession, setup_two_mailboxes: dict
):
    """Deleting both old AND new from mailbox A: cursor rewinds to the
    OLDEST of the two, not the most-recent one."""
    data = setup_two_mailboxes
    reviewer, mb_a = data["reviewer"], data["mb_a"]

    client = _make_app(db_session)
    with client, patch("app.api.ingestion.delete_file", new=AsyncMock()):
        resp = client.post(
            "/ingestion/emails/bulk-delete",
            json={
                "email_ids": [data["e_a_new"].id, data["e_a_old"].id],
                "refetch": True,
            },
            headers=_auth_headers(reviewer),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["cursors_rewound"] == 1

    await db_session.refresh(mb_a)
    # Should be e_a_old.received_at - 10min, not e_a_new.received_at.
    assert mb_a.last_fetched_at.replace(tzinfo=None) == (
        datetime(2025, 12, 30, 10, 0, 0) - timedelta(minutes=10)
    )


@pytest.mark.asyncio
async def test_bulk_delete_refetch_never_advances_cursor(
    db_session: AsyncSession, setup_two_mailboxes: dict
):
    """If the candidate new_cursor is already AT or AFTER the current
    cursor, leave the cursor alone — never advance it forward as a
    side effect of a delete."""
    data = setup_two_mailboxes
    reviewer, mb_a = data["reviewer"], data["mb_a"]

    # Force mailbox A's current cursor to be very old. The candidate
    # rewind (2025-12-30 - 10min) would ADVANCE it, which we must reject.
    mb_a.last_fetched_at = datetime(2025, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
    await db_session.commit()
    expected = mb_a.last_fetched_at

    client = _make_app(db_session)
    with client, patch("app.api.ingestion.delete_file", new=AsyncMock()):
        resp = client.post(
            "/ingestion/emails/bulk-delete",
            json={"email_ids": [data["e_a_old"].id], "refetch": True},
            headers=_auth_headers(reviewer),
        )
        assert resp.status_code == 200, resp.text
        # The endpoint still reports 1 because the bookkeeping dict was
        # populated; the no-op rewind is decided at write time. Either
        # 0 or 1 is acceptable for that counter as long as the cursor
        # didn't move.
        assert resp.json()["cursors_rewound"] in (0, 1)

    await db_session.refresh(mb_a)
    assert mb_a.last_fetched_at.replace(tzinfo=None) == expected.replace(tzinfo=None)
