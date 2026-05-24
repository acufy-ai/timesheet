"""Org-wide holiday management.

GET    /holidays                  — list, any authenticated tenant user
POST   /holidays                  — admin only
POST   /holidays/bulk             — admin only (import-many)
PATCH  /holidays/{id}             — admin only
DELETE /holidays/{id}             — admin only
GET    /holidays/suggestions      — admin only (preview public holidays
                                   for a country/year via python-holidays)
"""
from datetime import date as _date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, get_tenant_db, require_role
from app.models.holiday import Holiday, HolidayType
from app.models.user import User
from app.schemas import (
    HolidayBulkCreate,
    HolidayCreate,
    HolidayResponse,
    HolidaySuggestion,
    HolidaySuggestionsResponse,
    HolidayTypeEnum,
    HolidayUpdate,
)

router = APIRouter(prefix="/holidays", tags=["holidays"])


@router.get("", response_model=list[HolidayResponse])
async def list_holidays(
    start_date: Optional[_date] = Query(None, description="Inclusive lower bound."),
    end_date: Optional[_date] = Query(None, description="Inclusive upper bound."),
    country: Optional[str] = Query(
        None,
        min_length=2,
        max_length=2,
        description=(
            "Optional ISO-2 country filter. When provided, returns holidays "
            "tagged with that country plus org-wide holidays (country IS NULL). "
            "Omit to return everything. This filter is for display only — "
            "the late-detection logic still treats every holiday as covering."
        ),
    ),
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> list[Holiday]:
    """Every authenticated tenant user can read holidays — they show
    up on every employee's calendar."""
    if current_user.tenant_id is None:
        return []
    query = select(Holiday).where(Holiday.tenant_id == current_user.tenant_id)
    if start_date is not None:
        query = query.where(Holiday.date >= start_date)
    if end_date is not None:
        query = query.where(Holiday.date <= end_date)
    if country is not None:
        upper = country.upper()
        query = query.where(or_(Holiday.country == upper, Holiday.country.is_(None)))
    query = query.order_by(Holiday.date.asc())
    result = await db.execute(query)
    return list(result.scalars().all())


@router.post("", response_model=HolidayResponse, status_code=status.HTTP_201_CREATED)
async def create_holiday(
    body: HolidayCreate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> Holiday:
    if current_user.tenant_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Tenant context required",
        )
    holiday = Holiday(
        tenant_id=current_user.tenant_id,
        date=body.date,
        name=body.name.strip(),
        holiday_type=HolidayType(body.holiday_type.value),
        country=body.country.upper() if body.country else None,
        created_by=current_user.id,
    )
    db.add(holiday)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A holiday already exists on {body.date.isoformat()}",
        )
    await db.refresh(holiday)
    return holiday


@router.post("/bulk", response_model=list[HolidayResponse], status_code=status.HTTP_201_CREATED)
async def bulk_create_holidays(
    body: HolidayBulkCreate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> list[Holiday]:
    """Used by the public-holiday import flow. Existing dates are
    silently skipped so the admin can re-run an import without
    409-ing on previously-added rows."""
    if current_user.tenant_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Tenant context required",
        )
    existing_rows = await db.execute(
        select(Holiday.date).where(Holiday.tenant_id == current_user.tenant_id)
    )
    existing_dates = {row[0] for row in existing_rows.all()}
    created: list[Holiday] = []
    for entry in body.holidays:
        if entry.date in existing_dates:
            continue
        holiday = Holiday(
            tenant_id=current_user.tenant_id,
            date=entry.date,
            name=entry.name.strip(),
            holiday_type=HolidayType(entry.holiday_type.value),
            country=entry.country.upper() if entry.country else None,
            created_by=current_user.id,
        )
        db.add(holiday)
        created.append(holiday)
        existing_dates.add(entry.date)
    await db.commit()
    for h in created:
        await db.refresh(h)
    return created


@router.get("/countries", response_model=list[str])
async def list_holiday_countries(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> list[str]:
    """Distinct, non-null country codes present in this tenant's
    holidays. Used to populate the calendar's location filter so a
    user is only offered countries that actually have holidays in
    the system. Defined before ``/{holiday_id}`` so FastAPI's path
    matcher doesn't shadow it with the int-id route."""
    if current_user.tenant_id is None:
        return []
    result = await db.execute(
        select(Holiday.country)
        .where(
            Holiday.tenant_id == current_user.tenant_id,
            Holiday.country.is_not(None),
        )
        .distinct()
        .order_by(Holiday.country.asc())
    )
    return [row[0] for row in result.all() if row[0]]


@router.get("/suggestions", response_model=HolidaySuggestionsResponse)
async def suggest_public_holidays(
    country: str = Query(..., min_length=2, max_length=2),
    year: int = Query(..., ge=1970, le=2100),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> HolidaySuggestionsResponse:
    """Return the list of public holidays for a country/year so the
    admin can preview before importing. Powered by the
    ``python-holidays`` library, which ships with 100+ country
    calendars. The list is not persisted until the admin posts to
    ``/holidays/bulk``."""
    try:
        import holidays as _holidays_lib  # type: ignore
    except ImportError as exc:  # pragma: no cover
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Public-holiday source not installed (python-holidays).",
        ) from exc

    country_code = country.upper()
    try:
        calendar = _holidays_lib.country_holidays(country_code, years=[year])
    except (KeyError, NotImplementedError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Country code {country_code!r} is not supported.",
        ) from exc

    suggestions: list[HolidaySuggestion] = [
        HolidaySuggestion(date=d, name=name, country=country_code)
        for d, name in sorted(calendar.items())
    ]
    return HolidaySuggestionsResponse(
        country=country_code, year=year, holidays=suggestions
    )


# ──────────────────────────────────────────────────────────────────────
# Per-id routes. Declared last so static paths above (``/countries``,
# ``/suggestions``) are matched before this generic ``/{holiday_id}``
# variable rule.
# ──────────────────────────────────────────────────────────────────────


@router.patch("/{holiday_id}", response_model=HolidayResponse)
async def update_holiday(
    holiday_id: int,
    body: HolidayUpdate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> Holiday:
    result = await db.execute(select(Holiday).where(Holiday.id == holiday_id))
    holiday = result.scalar_one_or_none()
    if holiday is None or holiday.tenant_id != current_user.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Holiday not found"
        )
    if body.name is not None:
        holiday.name = body.name.strip()
    if body.holiday_type is not None:
        holiday.holiday_type = HolidayType(body.holiday_type.value)
    await db.commit()
    await db.refresh(holiday)
    return holiday


@router.delete("/{holiday_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_holiday(
    holiday_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> None:
    result = await db.execute(select(Holiday).where(Holiday.id == holiday_id))
    holiday = result.scalar_one_or_none()
    if holiday is None or holiday.tenant_id != current_user.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Holiday not found"
        )
    await db.delete(holiday)
    await db.commit()
