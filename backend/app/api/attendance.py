"""Clock in / out attendance.

A pure PRESENCE signal, entirely separate from time entries and billable hours.
Anyone who reports to a manager can clock in/out; their manager is notified
in-app (via the notifications endpoint, which reads recent events) and by email
(fire-and-forget, gated on the manager's personal preference).
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, get_tenant_db
from app.core.timezone_utils import now_for_tenant, today_for_tenant
from app.models.assignments import EmployeeManagerAssignment
from app.models.attendance import AttendanceEvent, AttendanceEventType
from app.models.tenant import Tenant
from app.models.user import User
from app.schemas import (
    AttendanceClockRequest,
    AttendanceEventOut,
    AttendanceStatus,
    TeamAttendanceResponse,
    TeamAttendanceRow,
)
from app.services.notification_emails import notify_attendance_event

router = APIRouter(prefix="/attendance", tags=["attendance"])


async def _tenant_now(db: AsyncSession, tenant_id: int) -> datetime:
    tenant_row = await db.get(Tenant, tenant_id)
    return now_for_tenant(tenant_row.timezone if tenant_row else None)


async def _events_today(db: AsyncSession, user_id: int, tenant_id: int) -> list[AttendanceEvent]:
    tenant_row = await db.get(Tenant, tenant_id)
    tz = tenant_row.timezone if tenant_row else None
    now = now_for_tenant(tz)
    day = now.date()
    rows = (await db.execute(
        select(AttendanceEvent)
        .where(
            AttendanceEvent.user_id == user_id,
            AttendanceEvent.tenant_id == tenant_id,
        )
        .order_by(AttendanceEvent.occurred_at.asc())
    )).scalars().all()
    # Keep events whose moment falls on the tenant's local "today". occurred_at is
    # stored tz-aware (tenant tz), so compare in that same zone; a naive row is
    # assumed already local.
    out: list[AttendanceEvent] = []
    for e in rows:
        occ = e.occurred_at
        local_date = occ.astimezone(now.tzinfo).date() if occ.tzinfo is not None else occ.date()
        if local_date == day:
            out.append(e)
    return out


def _status_from_events(events: list[AttendanceEvent]) -> AttendanceStatus:
    last = events[-1] if events else None
    clocked_in = last is not None and last.event_type == AttendanceEventType.clock_in
    since = None
    if clocked_in:
        # start of the current session = the last clock_in
        for e in reversed(events):
            if e.event_type == AttendanceEventType.clock_in:
                since = e.occurred_at
                break
    return AttendanceStatus(
        clocked_in=clocked_in,
        since=since,
        last_event=(last.event_type.value if last else None),
        events_today=[AttendanceEventOut.model_validate(e) for e in events],
    )


@router.get("/me", response_model=AttendanceStatus)
async def get_my_attendance(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """The caller's own clock-in/out status + today's events."""
    events = await _events_today(db, current_user.id, current_user.tenant_id)
    return _status_from_events(events)


async def _record(
    db: AsyncSession,
    current_user: User,
    event_type: AttendanceEventType,
    note: str | None,
) -> AttendanceStatus:
    events = await _events_today(db, current_user.id, current_user.tenant_id)
    status = _status_from_events(events)
    # Guard against nonsensical toggles.
    if event_type == AttendanceEventType.clock_in and status.clocked_in:
        raise HTTPException(status_code=409, detail="You are already clocked in.")
    if event_type == AttendanceEventType.clock_out and not status.clocked_in:
        raise HTTPException(status_code=409, detail="You are not clocked in.")

    now = await _tenant_now(db, current_user.tenant_id)
    ev = AttendanceEvent(
        tenant_id=current_user.tenant_id,
        user_id=current_user.id,
        event_type=event_type,
        occurred_at=now,
        note=(note or None),
    )
    db.add(ev)
    await db.commit()
    await db.refresh(ev)

    # Notify the user's manager(s). In-app is surfaced by the notifications
    # endpoint reading these events; here we fire the (gated) email.
    await _notify_managers(db, current_user, ev)

    events = await _events_today(db, current_user.id, current_user.tenant_id)
    return _status_from_events(events)


async def _notify_managers(db: AsyncSession, employee: User, ev: AttendanceEvent) -> None:
    """Email each manager the employee reports to, unless that manager has turned
    attendance emails off in their preferences. Fire-and-forget."""
    mgr_ids = (await db.execute(
        select(EmployeeManagerAssignment.manager_id)
        .where(EmployeeManagerAssignment.employee_id == employee.id)
    )).scalars().all()
    if not mgr_ids:
        return
    managers = (await db.execute(
        select(User).where(User.id.in_(mgr_ids))
    )).scalars().all()
    when = ev.occurred_at.strftime("%I:%M %p").lstrip("0")
    action = "clocked in" if ev.event_type == AttendanceEventType.clock_in else "clocked out"
    for m in managers:
        prefs = m.preferences or {}
        if prefs.get("attendance_emails") is False:
            continue
        if not m.email:
            continue
        await notify_attendance_event(
            manager_email=m.email,
            manager_name=m.full_name or m.email,
            employee_name=employee.full_name or employee.email,
            action=action,
            when=when,
            db=db,
        )


@router.post("/clock-in", response_model=AttendanceStatus)
async def clock_in(
    body: AttendanceClockRequest | None = None,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    return await _record(db, current_user, AttendanceEventType.clock_in, body.note if body else None)


@router.post("/clock-out", response_model=AttendanceStatus)
async def clock_out(
    body: AttendanceClockRequest | None = None,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    return await _record(db, current_user, AttendanceEventType.clock_out, body.note if body else None)


@router.get("/team", response_model=TeamAttendanceResponse)
async def get_team_attendance(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
):
    """Current clock-in/out status of the caller's direct reports today. Drives
    the manager 'Who's in' tile."""
    tenant_row = await db.get(Tenant, current_user.tenant_id)
    tz = tenant_row.timezone if tenant_row else None
    day = today_for_tenant(tz)

    report_ids = (await db.execute(
        select(EmployeeManagerAssignment.employee_id)
        .where(EmployeeManagerAssignment.manager_id == current_user.id)
    )).scalars().all()
    report_ids = list(dict.fromkeys(report_ids))  # dedup
    if not report_ids:
        return TeamAttendanceResponse(date=day, in_count=0, total=0, rows=[])

    users = {u.id: u for u in (await db.execute(
        select(User).where(User.id.in_(report_ids))
    )).scalars().all()}

    rows: list[TeamAttendanceRow] = []
    in_count = 0
    for uid in report_ids:
        u = users.get(uid)
        if u is None:
            continue
        events = await _events_today(db, uid, current_user.tenant_id)
        st = _status_from_events(events)
        last = events[-1] if events else None
        if st.clocked_in:
            in_count += 1
        rows.append(TeamAttendanceRow(
            user_id=uid,
            full_name=u.full_name or u.email,
            clocked_in=st.clocked_in,
            since=st.since,
            last_event_at=(last.occurred_at if last else None),
            last_event=(last.event_type.value if last else None),
        ))
    # Clocked-in first, then by name.
    rows.sort(key=lambda r: (0 if r.clocked_in else 1, r.full_name.lower()))
    return TeamAttendanceResponse(date=day, in_count=in_count, total=len(rows), rows=rows)
