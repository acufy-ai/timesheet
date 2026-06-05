from datetime import datetime, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.client import Client
from app.models.ingested_email import IngestedEmail
from app.models.ingestion_timesheet import (
    IngestionAuditActorType,
    IngestionAuditLog,
    IngestionTimesheet,
)
from app.models.user import User


async def get_ingestion_timesheet(
    session: AsyncSession,
    timesheet_id: int,
    tenant_id: int,
) -> IngestionTimesheet | None:
    result = await session.execute(
        select(IngestionTimesheet)
        .where(
            (IngestionTimesheet.id == timesheet_id) &
            (IngestionTimesheet.tenant_id == tenant_id)
        )
        .options(
            selectinload(IngestionTimesheet.line_items),
            selectinload(IngestionTimesheet.audit_log),
            selectinload(IngestionTimesheet.email).selectinload(IngestedEmail.attachments),
            selectinload(IngestionTimesheet.employee),
            selectinload(IngestionTimesheet.client),
        )
    )
    return result.scalar_one_or_none()


async def list_ingestion_timesheets(
    session: AsyncSession,
    tenant_id: int,
    status: str | None = None,
    client_id: int | None = None,
    employee_id: int | None = None,
    employee_ids: list[int] | None = None,
    reviewer_id: int | None = None,
    email_id: int | None = None,
    search: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[IngestionTimesheet]:
    """List ingestion timesheets with optional filters.

    ``employee_ids`` and ``reviewer_id`` are the D-061 additions that
    power the manager-scoped Approved Timesheets view. ``employee_ids``
    constrains the rows to a manager's direct reports;
    ``reviewer_id`` scopes inbox-approved PDFs to the ones a specific
    manager personally actioned. Both are additive — passing them
    together yields the union semantics the redesign needs (rows where
    the employee is mine OR I reviewed the PDF myself).
    """
    query = (
        select(IngestionTimesheet)
        .join(IngestionTimesheet.email)
        .where(IngestionTimesheet.tenant_id == tenant_id)
        .options(
            selectinload(IngestionTimesheet.employee),
            selectinload(IngestionTimesheet.client),
            selectinload(IngestionTimesheet.email),
            selectinload(IngestionTimesheet.reviewer),
        )
        .order_by(IngestionTimesheet.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    if status:
        query = query.where(IngestionTimesheet.status == status)
    if client_id:
        query = query.where(IngestionTimesheet.client_id == client_id)
    if employee_id:
        query = query.where(IngestionTimesheet.employee_id == employee_id)
    if employee_ids is not None or reviewer_id is not None:
        # Union: either the timesheet belongs to one of my direct
        # reports OR I'm the reviewer. We OR them inside a single
        # ``where`` so that managers see both flavours in one query
        # even when there's overlap.
        clauses = []
        if employee_ids is not None:
            # Empty list → match nothing (avoids accidentally matching
            # rows where employee_id IS NULL via SQL three-valued logic).
            if not employee_ids:
                # Force-empty result for this branch
                clauses.append(IngestionTimesheet.id == -1)
            else:
                clauses.append(IngestionTimesheet.employee_id.in_(employee_ids))
        if reviewer_id is not None:
            clauses.append(IngestionTimesheet.reviewer_id == reviewer_id)
        if clauses:
            query = query.where(or_(*clauses))
    if email_id:
        query = query.where(IngestionTimesheet.email_id == email_id)
    if search:
        # Outer-join User (resolved employee) and Client so we can match
        # the search against their names too. Outer because employee_id
        # and client_id are nullable (e.g. promoted-from-skip rows have
        # neither resolved yet), and search must still surface those
        # rows when the term matches subject/sender/llm_summary.
        #
        # Before this change the server-side search only checked
        # llm_summary + subject + sender_email, so any employee whose
        # name didn't appear in the email itself (typical for forwarded
        # timesheets) was unfindable. Adding User.full_name +
        # User.email + Client.name closes that gap.
        query = query.outerjoin(User, IngestionTimesheet.employee_id == User.id)
        query = query.outerjoin(Client, IngestionTimesheet.client_id == Client.id)
        like_value = f"%{search.strip()}%"
        query = query.where(
            or_(
                IngestionTimesheet.llm_summary.ilike(like_value),
                IngestedEmail.subject.ilike(like_value),
                IngestedEmail.sender_email.ilike(like_value),
                User.full_name.ilike(like_value),
                User.email.ilike(like_value),
                Client.name.ilike(like_value),
            )
        )

    result = await session.execute(query)
    return list(result.scalars().all())


async def write_audit_log(
    session: AsyncSession,
    timesheet_id: int,
    user_id: int | None,
    action: str,
    *,
    tenant_id: int,
    actor_type: IngestionAuditActorType = IngestionAuditActorType.user,
    previous_value: dict | None = None,
    new_value: dict | None = None,
    comment: str | None = None,
) -> None:
    # tenant_id is keyword-only and required so a caller that forgets it
    # fails loudly at the call site (TypeError) instead of writing a row
    # with a NULL tenant_id that the schema would reject later.
    entry = IngestionAuditLog(
        tenant_id=tenant_id,
        ingestion_timesheet_id=timesheet_id,
        user_id=user_id,
        action=action,
        actor_type=actor_type,
        previous_value=previous_value,
        new_value=new_value,
        comment=comment,
        created_at=datetime.now(timezone.utc),
    )
    session.add(entry)
