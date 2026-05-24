from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from app.models.tenant import Tenant, TenantStatus


async def get_tenant(db: AsyncSession, tenant_id: int) -> Tenant | None:
    return await db.get(Tenant, tenant_id)


async def get_tenant_by_slug(db: AsyncSession, slug: str) -> Tenant | None:
    result = await db.execute(select(Tenant).where(Tenant.slug == slug))
    return result.scalar_one_or_none()


async def list_tenants(db: AsyncSession) -> list[Tenant]:
    result = await db.execute(select(Tenant).order_by(Tenant.name))
    return list(result.scalars().all())


async def create_tenant(db: AsyncSession, name: str, slug: str) -> Tenant:
    # Legacy write (shared per-tenant DB). Keeps every code path that
    # still reads through `app.models.tenant.Tenant` working.
    tenant = Tenant(name=name, slug=slug, status=TenantStatus.active)
    db.add(tenant)
    await db.commit()
    await db.refresh(tenant)

    # Control-plane mirror. The slug-to-DB router (see app/db_tenant.py)
    # reads tenants from acufy_control.tenants. Without this row, every
    # cross-tenant request from a platform admin or via service token
    # fails with "Unknown tenant" because the routing layer can't find
    # the slug. We mirror just the columns the router needs; per-tenant
    # DB connection fields (db_name/host/...) stay NULL until/unless a
    # tenant is flipped to is_isolated=true.
    from app.db_control import AsyncControlSessionLocal
    from app.models.control import ControlTenant
    from app.models.control.tenant import ControlTenantStatus
    async with AsyncControlSessionLocal() as control_session:
        existing = await control_session.execute(
            select(ControlTenant).where(ControlTenant.slug == slug)
        )
        if existing.scalar_one_or_none() is None:
            control_session.add(ControlTenant(
                # Keep the same id as the legacy row so cross-DB lookups
                # by tenant_id keep working without a translation step.
                id=tenant.id,
                name=name,
                slug=slug,
                status=ControlTenantStatus.active,
            ))
            await control_session.commit()

    return tenant


async def update_tenant(db: AsyncSession, tenant: Tenant, **kwargs) -> Tenant:
    for key, value in kwargs.items():
        setattr(tenant, key, value)
    db.add(tenant)
    await db.commit()
    await db.refresh(tenant)
    return tenant
