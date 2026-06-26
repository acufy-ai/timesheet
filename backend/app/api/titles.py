from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, get_tenant_db, require_role
from app.models.title import Title
from app.models.user import User
from app.schemas import TitleCreate, TitleResponse

router = APIRouter(prefix="/titles", tags=["titles"])


@router.get("", response_model=list[TitleResponse])
async def list_titles(
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(get_current_user),
) -> list[Title]:
    """Any authenticated user can read the tenant's title list (used in dropdowns)."""
    if current_user.tenant_id is None:
        return []
    result = await db.execute(
        select(Title)
        .where(Title.tenant_id == current_user.tenant_id)
        .order_by(Title.name.asc())
    )
    return list(result.scalars().all())


@router.post("", response_model=TitleResponse, status_code=status.HTTP_201_CREATED)
async def create_title(
    body: TitleCreate,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> Title:
    if current_user.tenant_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Tenant context required")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Name cannot be empty")
    title = Title(tenant_id=current_user.tenant_id, name=name)
    db.add(title)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Title with that name already exists")
    await db.refresh(title)
    return title


@router.delete("/{title_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_title(
    title_id: int,
    db: AsyncSession = Depends(get_tenant_db),
    current_user: User = Depends(require_role("ADMIN", "PLATFORM_ADMIN")),
) -> None:
    result = await db.execute(
        select(Title).where(Title.id == title_id)
    )
    title = result.scalar_one_or_none()
    if title is None or title.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Title not found")
    await db.delete(title)
    await db.commit()
