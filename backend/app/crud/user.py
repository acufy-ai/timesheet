from sqlalchemy import delete, update, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload
from app.models.user import User, UserRole
from app.models.project import Project
from app.models.task import Task
from app.models.time_entry import TimeEntry
from app.models.time_off_request import TimeOffRequest
from app.models.assignments import EmployeeManagerAssignment, UserProjectAccess, UserTaskAccess
from app.schemas import UserCreate, UserUpdate
from app.core.security import get_password_hash
from typing import Optional
import secrets
import string


async def get_user_by_id(db: AsyncSession, user_id: int) -> Optional[User]:
    """Get user by ID."""
    result = await db.execute(
        select(User)
        .where(User.id == user_id)
        .options(
            selectinload(User.manager_assignment),
            selectinload(User.manager_assignments),
            selectinload(User.project_access),
            selectinload(User.task_access),
        )
    )
    return result.scalars().first()


async def get_user_by_email(db: AsyncSession, email: str) -> Optional[User]:
    """Get user by primary email or by any of their alias addresses."""
    from app.models.user_email_alias import UserEmailAlias

    normalized_email = email.strip().lower()
    result = await db.execute(
        select(User)
        .where(User.email == normalized_email)
        .options(
            selectinload(User.manager_assignment),
            selectinload(User.manager_assignments),
            selectinload(User.project_access),
            selectinload(User.task_access),
        )
    )
    user = result.scalars().first()
    if user is not None:
        return user

    alias_row = (await db.execute(
        select(UserEmailAlias.user_id).where(
            sa_func.lower(UserEmailAlias.email) == normalized_email
        )
    )).scalar_one_or_none()
    if alias_row is None:
        return None
    return await get_user_by_id(db, alias_row)


async def get_users_by_email(db: AsyncSession, email: str) -> list[User]:
    """All users sharing a primary email. An email is unique per (tenant, email),
    not globally (migration 054), so the same address can exist in several
    tenants. Login uses this to disambiguate by password. Ordered by tenant_id
    for deterministic results."""
    normalized_email = email.strip().lower()
    rows = (await db.execute(
        select(User)
        .where(User.email == normalized_email)
        .options(
            selectinload(User.manager_assignment),
            selectinload(User.manager_assignments),
            selectinload(User.project_access),
            selectinload(User.task_access),
        )
        .order_by(User.tenant_id)
    )).scalars().all()
    return list(rows)


async def get_user_by_username(db: AsyncSession, username: str) -> Optional[User]:
    """Get user by username."""
    normalized_username = username.strip().lower()
    result = await db.execute(
        select(User).where(User.username == normalized_username)
    )
    return result.scalars().first()


async def _sync_user_assignments(
    db: AsyncSession,
    user: User,
    role: UserRole,
    manager_id: Optional[int],
    project_ids: list[int],
    task_ids: Optional[list[int]] = None,
    manager_ids: Optional[list[int]] = None,
    primary_manager_id: Optional[int] = None,
) -> None:
    await db.execute(delete(UserProjectAccess).where(UserProjectAccess.user_id == user.id))
    await db.execute(delete(UserTaskAccess).where(UserTaskAccess.user_id == user.id))
    await db.execute(delete(EmployeeManagerAssignment).where(EmployeeManagerAssignment.employee_id == user.id))

    # Resolve the manager set. Multi-manager callers pass manager_ids (+ an
    # optional primary); legacy callers pass a single manager_id (treated as the
    # sole, primary manager). The two are unioned so either path works.
    resolved_manager_ids: list[int] = []
    for mid in ([*(manager_ids or []), manager_id]):
        if mid is not None and mid not in resolved_manager_ids:
            resolved_manager_ids.append(mid)

    if resolved_manager_ids:
        allowed_manager_roles = _allowed_manager_roles_for_role(role)
        if not allowed_manager_roles:
            raise ValueError("Selected role cannot have a supervisor")

        # Choose the primary: an explicit primary_manager_id if it's in the set,
        # else the legacy manager_id if present, else the first manager.
        primary = None
        if primary_manager_id in resolved_manager_ids:
            primary = primary_manager_id
        elif manager_id in resolved_manager_ids:
            primary = manager_id
        else:
            primary = resolved_manager_ids[0]

        for mid in resolved_manager_ids:
            if mid == user.id:
                raise ValueError("A user cannot be their own manager")
            manager = await get_user_by_id(db, mid)
            if not manager or manager.role not in allowed_manager_roles:
                raise ValueError("Selected supervisor is invalid")
            if user.tenant_id is not None and manager.tenant_id != user.tenant_id:
                raise ValueError("Selected supervisor must belong to the same tenant")
            db.add(EmployeeManagerAssignment(
                employee_id=user.id, manager_id=mid, is_primary=(mid == primary)))

    unique_project_ids = sorted(set(project_ids or []))
    if unique_project_ids:
        # Validate that all projects belong to the same tenant as the user
        query = select(Project.id).where(Project.id.in_(unique_project_ids))
        if user.tenant_id is not None:
            query = query.where(Project.tenant_id == user.tenant_id)
        result = await db.execute(query)
        valid_project_ids = {project_id for project_id in result.scalars().all()}
        missing_ids = [
            project_id for project_id in unique_project_ids if project_id not in valid_project_ids]
        if missing_ids:
            raise ValueError("One or more selected projects are invalid or belong to a different tenant")
        db.add_all(
            [UserProjectAccess(user_id=user.id, project_id=project_id)
             for project_id in unique_project_ids]
        )

    # Per-user task access (mirror of project access, validated to the tenant).
    unique_task_ids = sorted(set(task_ids or []))
    if not unique_task_ids:
        return
    tquery = select(Task.id).where(Task.id.in_(unique_task_ids))
    if user.tenant_id is not None:
        tquery = tquery.where(Task.tenant_id == user.tenant_id)
    tresult = await db.execute(tquery)
    valid_task_ids = {task_id for task_id in tresult.scalars().all()}
    missing_task_ids = [t for t in unique_task_ids if t not in valid_task_ids]
    if missing_task_ids:
        raise ValueError("One or more selected tasks are invalid or belong to a different tenant")
    db.add_all(
        [UserTaskAccess(user_id=user.id, task_id=task_id, tenant_id=user.tenant_id)
         for task_id in unique_task_ids]
    )


def _normalize_profile_text(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


async def _resolve_department_id(
    db: AsyncSession,
    *,
    tenant_id: Optional[int],
    name: Optional[str],
    explicit_id: Optional[int] = None,
) -> Optional[int]:
    """Resolve a department FK during the additive rollout.

    Priority:
      1. An explicit department_id (validated to this tenant).
      2. Otherwise, match the free-text `name` to a Department row (case-
         insensitive, per tenant), creating the row if it doesn't exist yet —
         so the FK stays in sync with the name the form still sends.
    Returns None when there's nothing to resolve.
    """
    from app.models.department import Department

    if explicit_id is not None:
        row = (await db.execute(
            select(Department).where(
                Department.id == explicit_id,
                Department.tenant_id == tenant_id,
            )
        )).scalars().first()
        return row.id if row else None

    clean = _normalize_profile_text(name)
    if not clean or tenant_id is None:
        return None

    existing = (await db.execute(
        select(Department).where(
            Department.tenant_id == tenant_id,
            sa_func.lower(Department.name) == clean.lower(),
        )
    )).scalars().first()
    if existing:
        return existing.id

    dept = Department(tenant_id=tenant_id, name=clean)
    db.add(dept)
    await db.flush()
    return dept.id


def _validate_role_profile(
    role: UserRole,
    title: Optional[str],
    department: Optional[str],
    is_external: bool = False,
) -> None:
    """Validate the title/department fields against the role.

    External users are exempt: they exist purely as anchors for ingested
    timesheets / emails, never log in, and have no place on the
    org-chart, so requiring a title or department for them would force
    the admin to fabricate values just to clear the form.
    """
    if is_external:
        return
    if role == UserRole.MANAGER:
        if not title:
            raise ValueError("Manager title is required")
        if not department:
            raise ValueError("Manager department is required")
    elif role == UserRole.EMPLOYEE:
        if not title:
            raise ValueError("Employee title is required")


def _allowed_manager_roles_for_role(role: UserRole) -> set[UserRole]:
    if role in {UserRole.EMPLOYEE, UserRole.MANAGER, UserRole.ADMIN, UserRole.VIEWER}:
        return {UserRole.MANAGER, UserRole.ADMIN, UserRole.VIEWER}
    return set()


def _slugify_for_username(value: str) -> str:
    """Convert a free-text name into a username-safe slug.

    ``Jane Smith`` -> ``jane.smith``
    ``O'Brien-Smith, Ana`` -> ``obrien.smith.ana``
    ``  spaces   here  `` -> ``spaces.here``

    Returns ``""`` when nothing usable is left after sanitization; the
    caller picks a different fallback in that case.
    """
    import re
    lowered = (value or "").strip().lower()
    # Collapse anything not a-z/0-9 into a single separator, then
    # split on that separator so repeated separators don't survive.
    parts = [p for p in re.split(r"[^a-z0-9]+", lowered) if p]
    return ".".join(parts)


async def _generate_unique_username(
    db: AsyncSession,
    *,
    full_name: str | None,
    email: str | None,
    tenant_id: int | None,
) -> str:
    """Pick a readable, tenant-scoped-unique username for a new user.

    Precedence:
      1. Slug of ``full_name`` (``Jane Smith`` -> ``jane.smith``).
      2. Local part of ``email`` slugified (``jane.smith@x.com`` -> ``jane.smith``).
      3. ``user-<random hex>`` last-resort - only when both above produce
         empty slugs (e.g. full_name is only emoji / non-Latin script).

    Collisions are resolved by appending ``2``, ``3``, ... and re-checking
    against the per-tenant ``users`` table. We check against the current
    session's DB (per-tenant for isolated tenants, shared otherwise);
    the shared-DB mirror gets the same value via the create flow's
    mirror call, which also has its own ON CONFLICT safety net.
    """
    base = _slugify_for_username(full_name or "")
    if not base and email:
        local_part = email.split("@", 1)[0]
        base = _slugify_for_username(local_part)
    if not base:
        # Absolute last resort - keeps the column non-empty and unique.
        return f"user-{secrets.token_hex(6)}"

    # Tenant-scoped uniqueness: candidate, candidate2, candidate3, ...
    candidate = base
    suffix = 1
    while True:
        stmt = select(User.id).where(User.username == candidate)
        if tenant_id is not None:
            stmt = stmt.where(User.tenant_id == tenant_id)
        taken = (await db.execute(stmt)).scalar_one_or_none()
        if taken is None:
            return candidate
        suffix += 1
        candidate = f"{base}{suffix}"
        # Safety net: don't spin forever. Beyond ~50 collisions on the
        # same base, fall back to random; a real human won't be the 50th
        # Jane Smith in one tenant.
        if suffix > 50:
            return f"{base}-{secrets.token_hex(4)}"


def _generate_default_password() -> str:
    """Generate a secure default password for new users (meets password policy)."""
    # Guarantee at least one of each required character type
    required = [
        secrets.choice(string.ascii_uppercase),
        secrets.choice(string.ascii_lowercase),
        secrets.choice(string.digits),
        secrets.choice("!@#$%^&*"),
    ]
    # Fill remaining length with random chars
    chars = string.ascii_letters + string.digits + "!@#$%^&*"
    remaining = [secrets.choice(chars) for _ in range(12)]
    combined = required + remaining
    # Shuffle to avoid predictable positions
    result = list(combined)
    import random
    random.SystemRandom().shuffle(result)
    return ''.join(result)


async def create_user(
    db: AsyncSession,
    user_create: UserCreate,
    *,
    provision_auth0: bool = True,
) -> tuple["User", str, Optional[str]]:
    """Create a new user.

    Returns ``(user, plaintext_password, auth0_invite_url)``:

      - ``plaintext_password`` is the temp bcrypt password we generate
        for the local row. With Auth0 in the loop the user never sees
        it (Auth0 owns the real password) but the column is still
        non-null and the value is needed for the Auth0-disabled
        fallback path so existing callers keep working unchanged.
      - ``auth0_invite_url`` is the password-change ticket from Auth0
        when provisioning succeeded; ``None`` when Auth0 is disabled,
        the user is external (never logs in), the email is a synthetic
        placeholder, or Auth0 provisioning failed and we fell back to
        the bcrypt-only path. Callers use this to decide whether to
        send the "set your password" invitation email.

    Only ``full_name`` and ``is_external`` are required from the caller.
    Email and username are optional. When blank we synthesize unique
    placeholders so the NOT NULL + UNIQUE columns stay satisfied:

      - email    → ``no-email+<random>@local.invalid``
      - username → ``user-<random>``

    The placeholder uses the ``.invalid`` reserved TLD (RFC 2606) so
    nothing accidentally tries to deliver to it. The admin can patch a
    real email onto the user later via PUT /users/{id}, at which point
    the frontend offers a "send verification email now?" prompt.

    Set ``provision_auth0=False`` to skip the Auth0 round-trip — used
    by the CSV bulk-import flow where we provision Auth0 in a separate
    pass to keep the per-row latency manageable.
    """
    role = user_create.role or UserRole.EMPLOYEE
    normalized_title = _normalize_profile_text(user_create.title)
    normalized_department = _normalize_profile_text(user_create.department)
    _validate_role_profile(
        role, normalized_title, normalized_department,
        is_external=bool(user_create.is_external),
    )
    resolved_department_id = await _resolve_department_id(
        db,
        tenant_id=user_create.tenant_id,
        name=normalized_department,
        explicit_id=getattr(user_create, "department_id", None),
    )

    # Always generate a secure random temporary password; ignore any client-supplied value.
    password = _generate_default_password()

    raw_email = (user_create.email or "").strip().lower()
    raw_username = (user_create.username or "").strip().lower()

    if not raw_email:
        # Random suffix keeps the unique constraint happy without
        # leaking sequential ids. invalid.local is reserved by RFC.
        raw_email = f"no-email+{secrets.token_hex(8)}@local.invalid"
    if not raw_username:
        # Derive a readable username from full_name first, then email,
        # then a random hex as last resort. Tenant-scoped uniqueness
        # is checked against the current session's users table.
        raw_username = await _generate_unique_username(
            db,
            full_name=user_create.full_name,
            email=None if raw_email.endswith("@local.invalid") else raw_email,
            tenant_id=user_create.tenant_id,
        )

    cleaned_phones = [p.strip() for p in (user_create.phones or []) if p.strip()][:3]

    db_user = User(
        tenant_id=user_create.tenant_id,
        email=raw_email,
        username=raw_username,
        full_name=user_create.full_name.strip(),
        title=normalized_title,
        department=normalized_department,
        department_id=resolved_department_id,
        hashed_password=get_password_hash(password),
        has_changed_password=False,
        email_verified=False,
        role=role,
        # Multi-role rows are made via PUT /users/{id} roles=[...].
        roles=[role.value],
        is_active=user_create.is_active,
        can_review=user_create.can_review,
        is_external=user_create.is_external,
        default_client_id=user_create.default_client_id,
        phones=cleaned_phones,
    )
    db.add(db_user)
    try:
        await db.flush()
        await _sync_user_assignments(
            db,
            db_user,
            role,
            user_create.manager_id,
            user_create.project_ids,
            getattr(user_create, "task_ids", None),
            manager_ids=getattr(user_create, "manager_ids", None),
            primary_manager_id=getattr(user_create, "primary_manager_id", None),
        )
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise
    except ValueError:
        await db.rollback()
        raise

    # Mirror a minimal stub of this user into the shared DB. Login
    # (``/auth/login``) looks the user up in the shared DB first to
    # discover their tenant, then re-fetches the canonical row from the
    # per-tenant DB. Without the mirror the tenant DB has the only copy
    # and login can't resolve the email at all. We do this for every
    # tenant DB that is isolated from the shared DB; the no-op case
    # (non-isolated tenants whose shared session IS the same as ``db``)
    # falls through cleanly because the row already exists.
    await _mirror_user_to_shared_db(db_user, hashed_password=db_user.hashed_password)

    # Auth0 provisioning happens after the local row is committed so
    # we can bind the returned ``sub`` in a small follow-up transaction.
    # We skip it for external users (never log in), placeholder emails
    # (no real address to deliver an invite to), and when the caller or
    # the global config opts out.
    auth0_invite_url: Optional[str] = None
    eligible_for_auth0 = (
        provision_auth0
        and not db_user.is_external
        and not db_user.email.endswith("@local.invalid")
    )
    if eligible_for_auth0:
        from app.core.config import settings as _settings
        if _settings.auth0_mgmt_enabled:
            auth0_invite_url = await _provision_auth0_for_new_user(db, db_user)

    user = await get_user_by_id(db, db_user.id)
    return user, password, auth0_invite_url


async def _mirror_user_to_shared_db(db_user: User, *, hashed_password: str) -> None:
    """Insert a stub of the new user into the shared DB if needed.

    Login resolves an email to a tenant via the shared ``users`` table,
    then re-fetches the canonical row from the per-tenant DB. The new
    admin-create flow only writes to the per-tenant DB, so without this
    mirror, users created post-isolation can't log in. We INSERT only
    the columns required for the login lookup (email + tenant_id) and
    a copy of the bcrypt hash so the legacy fallback path also still
    works for users created before Auth0 provisioning succeeds. If the
    row already exists in the shared DB (e.g. tenant isn't isolated,
    so shared and per-tenant are the same DB) the INSERT is a no-op.
    """
    import logging
    from sqlalchemy import text
    from app.db import AsyncSessionLocal

    logger = logging.getLogger(__name__)

    try:
        async with AsyncSessionLocal() as shared_db:
            await shared_db.execute(
                text(
                    """
                    INSERT INTO users (
                        tenant_id, email, username, full_name,
                        hashed_password, role, roles, is_active,
                        can_review, is_external, email_verified,
                        has_changed_password, timesheet_locked,
                        phones, auth0_sub
                    )
                    VALUES (
                        :tenant_id, :email, :username, :full_name,
                        :hashed_password, :role,
                        CAST(:roles AS jsonb), :is_active,
                        :can_review, :is_external, :email_verified,
                        :has_changed_password, :timesheet_locked,
                        CAST(:phones AS jsonb), :auth0_sub
                    )
                    ON CONFLICT (tenant_id, email) DO NOTHING
                    """
                ),
                {
                    "tenant_id": db_user.tenant_id,
                    "email": db_user.email,
                    "username": db_user.username,
                    "full_name": db_user.full_name,
                    "hashed_password": hashed_password,
                    "role": db_user.role.value if hasattr(db_user.role, "value") else str(db_user.role),
                    "roles": _json_dumps(db_user.roles or []),
                    "is_active": db_user.is_active,
                    "can_review": db_user.can_review,
                    "is_external": db_user.is_external,
                    "email_verified": db_user.email_verified,
                    "has_changed_password": db_user.has_changed_password,
                    "timesheet_locked": bool(db_user.timesheet_locked),
                    "phones": _json_dumps(db_user.phones or []),
                    "auth0_sub": db_user.auth0_sub,
                },
            )
            await shared_db.commit()
    except Exception as exc:
        # Mirror failure shouldn't block user creation — the per-tenant
        # row already exists. We log loudly so ops can backfill if a
        # mirror gets lost; login will be broken for this user until then.
        logger.error(
            "shared-DB mirror failed for user %s (id=%s): %s",
            db_user.email, db_user.id, exc,
        )


def _json_dumps(value) -> str:
    """Compact JSON for inserting into JSONB columns via raw SQL."""
    import json as _json
    return _json.dumps(value)


async def _mirror_user_update_to_shared_db(
    db_user: User,
    *,
    previous_email: Optional[str] = None,
) -> None:
    """Sync an UPDATE on a per-tenant user row to the shared-DB mirror.

    Login resolves email -> tenant_id via the shared ``users`` table, so
    every mutation to the email/username/identity-relevant fields must
    propagate to the shared row or login (and password reset, verification,
    etc.) will silently misroute.

    When ``previous_email`` differs from the current email, the helper
    DELETEs the shared-DB row keyed by ``(tenant_id, previous_email)``
    AFTER the post-update row is upserted - that order ensures we never
    momentarily have zero rows for the user.

    If no shared row matches the post-update state, INSERTs one - this
    self-heals any pre-existing drift like the post-cutover users that
    were created in a per-tenant DB without a shared mirror.

    Best-effort: any failure is logged but does not roll back the
    per-tenant commit. Ops should monitor for ``shared-DB mirror update
    failed`` log lines and backfill manually if they appear.
    """
    import logging
    from sqlalchemy import text
    from app.db import AsyncSessionLocal

    logger = logging.getLogger(__name__)
    payload = {
        "tenant_id": db_user.tenant_id,
        "email": db_user.email,
        "username": db_user.username,
        "full_name": db_user.full_name,
        "hashed_password": db_user.hashed_password,
        "role": db_user.role.value if hasattr(db_user.role, "value") else str(db_user.role),
        "roles": _json_dumps(db_user.roles or []),
        "is_active": db_user.is_active,
        "can_review": db_user.can_review,
        "is_external": db_user.is_external,
        "email_verified": db_user.email_verified,
        "has_changed_password": db_user.has_changed_password,
        "timesheet_locked": bool(db_user.timesheet_locked),
        "phones": _json_dumps(db_user.phones or []),
        "auth0_sub": db_user.auth0_sub,
        "tenant_user_id": db_user.id,
    }

    try:
        async with AsyncSessionLocal() as shared_db:
            # Resolution order:
            #   1. If the email changed, UPDATE the row keyed by the
            #      previous email so we rename it in place (no orphan).
            #   2. Otherwise UPDATE the row keyed by the current email.
            #   3. If neither lookup matches, INSERT (self-heal for
            #      drifted/missing mirrors).
            update_sql = text(
                """
                UPDATE users SET
                    email = :email,
                    username = :username,
                    full_name = :full_name,
                    hashed_password = :hashed_password,
                    role = :role,
                    roles = CAST(:roles AS jsonb),
                    is_active = :is_active,
                    can_review = :can_review,
                    is_external = :is_external,
                    email_verified = :email_verified,
                    has_changed_password = :has_changed_password,
                    timesheet_locked = :timesheet_locked,
                    phones = CAST(:phones AS jsonb),
                    auth0_sub = :auth0_sub
                WHERE tenant_id = :tenant_id AND email = :match_email
                RETURNING id
                """
            )

            match_email = (
                previous_email
                if (previous_email and previous_email != db_user.email)
                else db_user.email
            )
            params = dict(payload, match_email=match_email)
            updated = (await shared_db.execute(update_sql, params)).first()

            if updated is None and match_email != db_user.email:
                # Rename path missed the previous-email row; fall back
                # to matching by the post-update email in case the row
                # was already renamed by an earlier mirror call.
                params["match_email"] = db_user.email
                updated = (await shared_db.execute(update_sql, params)).first()

            if updated is None:
                # No mirror exists; INSERT one. Use ON CONFLICT on the
                # composite (tenant_id, email) constraint - if two paths
                # raced and the other won first, we silently absorb the
                # collision rather than 500.
                await shared_db.execute(
                    text(
                        """
                        INSERT INTO users (
                            tenant_id, email, username, full_name,
                            hashed_password, role,
                            roles, is_active, can_review, is_external,
                            email_verified, has_changed_password,
                            timesheet_locked, phones, auth0_sub
                        )
                        VALUES (
                            :tenant_id, :email, :username, :full_name,
                            :hashed_password, :role,
                            CAST(:roles AS jsonb), :is_active, :can_review,
                            :is_external, :email_verified,
                            :has_changed_password, :timesheet_locked,
                            CAST(:phones AS jsonb), :auth0_sub
                        )
                        ON CONFLICT (tenant_id, email) DO UPDATE SET
                            username = EXCLUDED.username,
                            full_name = EXCLUDED.full_name,
                            hashed_password = EXCLUDED.hashed_password,
                            role = EXCLUDED.role,
                            roles = EXCLUDED.roles,
                            is_active = EXCLUDED.is_active,
                            can_review = EXCLUDED.can_review,
                            is_external = EXCLUDED.is_external,
                            email_verified = EXCLUDED.email_verified,
                            has_changed_password = EXCLUDED.has_changed_password,
                            timesheet_locked = EXCLUDED.timesheet_locked,
                            phones = EXCLUDED.phones,
                            auth0_sub = EXCLUDED.auth0_sub
                        """
                    ),
                    payload,
                )

            await shared_db.commit()
    except Exception as exc:
        logger.error(
            "shared-DB mirror update failed for user %s (id=%s, tenant=%s): %s",
            db_user.email, db_user.id, db_user.tenant_id, exc,
        )


async def _provision_auth0_for_new_user(db: AsyncSession, db_user: User) -> Optional[str]:
    """Create the Auth0 record for a freshly-inserted user; bind ``auth0_sub``.

    Best-effort: any failure logs and returns ``None`` so the caller
    can fall back to the legacy verification-email path. We don't want
    a transient Auth0 outage to block admins from creating users.
    """
    import logging
    from app.services import auth0_mgmt
    from app.core.config import settings as _settings

    logger = logging.getLogger(__name__)

    try:
        sub = await auth0_mgmt.create_user(
            email=db_user.email,
            full_name=db_user.full_name,
        )
    except auth0_mgmt.Auth0MgmtError as exc:
        logger.warning(
            "Auth0 provisioning failed for new user %s (id=%s): %s",
            db_user.email, db_user.id, exc,
        )
        return None

    # Bind sub on the local row. If this fails (extremely unlikely —
    # we just inserted the row a moment ago) roll back the Auth0 user
    # so we don't leave an orphan that owns this email.
    #
    # We also flip ``has_changed_password=True`` here. Auth0 owns the
    # password from this point on; the user picks their own via the
    # invite ticket without ever seeing a "temporary password". The
    # legacy "you're using a temporary password — please change it"
    # modal exists to defend against admin-created bcrypt accounts and
    # would be confusing/inaccurate for an Auth0 user.
    try:
        db_user.auth0_sub = sub
        db_user.has_changed_password = True
        db.add(db_user)
        await db.commit()
    except Exception as exc:
        logger.error(
            "Failed to bind auth0_sub for user %s (id=%s); rolling back Auth0 record: %s",
            db_user.email, db_user.id, exc,
        )
        try:
            await auth0_mgmt.delete_user(sub)
        except auth0_mgmt.Auth0MgmtError:
            pass
        return None

    # Mirror auth0_sub + has_changed_password into the shared DB stub
    # so the login flow's initial lookup sees the same flags. Best-
    # effort: if the mirror is missing or this fails, login still works
    # via the per-tenant lookup we just added to ``get_current_user``.
    try:
        from sqlalchemy import text
        from app.db import AsyncSessionLocal
        async with AsyncSessionLocal() as shared_db:
            await shared_db.execute(
                text(
                    "UPDATE users SET auth0_sub = :sub, "
                    "has_changed_password = TRUE WHERE email = :email"
                ),
                {"sub": sub, "email": db_user.email},
            )
            await shared_db.commit()
    except Exception as exc:
        logger.warning(
            "Shared-DB auth0_sub mirror failed for %s: %s",
            db_user.email, exc,
        )

    # Issue our own one-time invite token and return its URL. The user
    # will land on our /set-password page (branded, redirects after
    # success, supports a strength meter) instead of Auth0's hosted
    # form. The token's jti is stored in the per-tenant
    # password_invite_tokens table; the JWT itself is signed with our
    # SECRET_KEY.
    try:
        from app.services.password_invite import issue_invite_token, build_set_password_url
        token = await issue_invite_token(db, db_user, purpose="invite")
        await db.commit()
        return build_set_password_url(token, purpose="invite")
    except Exception as exc:
        logger.warning(
            "Local invite-token issue failed for %s (id=%s): %s",
            db_user.email, db_user.id, exc,
        )
        # User is in Auth0 (sub bound) but we couldn't issue the token.
        # An admin can resend manually; non-fatal.
        return None


async def update_user(db: AsyncSession, user: User, user_update: UserUpdate) -> User:
    """Update user fields."""
    update_data = user_update.model_dump(exclude_unset=True)

    manager_id_supplied = "manager_id" in update_data
    manager_ids_supplied = "manager_ids" in update_data
    project_ids_supplied = "project_ids" in update_data
    task_ids_supplied = "task_ids" in update_data
    manager_id = update_data.pop("manager_id", user.manager_id)
    manager_ids = update_data.pop("manager_ids", None)
    primary_manager_id = update_data.pop("primary_manager_id", None)
    project_ids = update_data.pop("project_ids", user.project_ids)
    task_ids = update_data.pop("task_ids", user.task_ids)

    if "email" in update_data and update_data["email"] is not None:
        update_data["email"] = update_data["email"].strip().lower()

    if "username" in update_data and update_data["username"] is not None:
        update_data["username"] = update_data["username"].strip().lower()

    if "full_name" in update_data and update_data["full_name"] is not None:
        update_data["full_name"] = update_data["full_name"].strip()

    if "title" in update_data:
        update_data["title"] = _normalize_profile_text(update_data["title"])

    if "phones" in update_data and update_data["phones"] is not None:
        update_data["phones"] = [p.strip() for p in update_data["phones"] if p.strip()][:3]

    if "department" in update_data:
        update_data["department"] = _normalize_profile_text(
            update_data["department"])

    # Keep the structured FK in sync. Resolve from an explicit department_id if
    # supplied, else from the (possibly just-updated) department name.
    if "department_id" in update_data or "department" in update_data:
        explicit_dept_id = update_data.pop("department_id", None)
        name_for_lookup = update_data.get("department", user.department)
        update_data["department_id"] = await _resolve_department_id(
            db,
            tenant_id=user.tenant_id,
            name=name_for_lookup,
            explicit_id=explicit_dept_id,
        )

    if "password" in update_data:
        update_data["hashed_password"] = get_password_hash(
            update_data.pop("password"))

    next_role = update_data.get("role", user.role)
    next_title = update_data.get("title", user.title)
    next_department = update_data.get("department", user.department)
    next_is_external = bool(update_data.get("is_external", user.is_external))
    _validate_role_profile(
        next_role, next_title, next_department,
        is_external=next_is_external,
    )

    # Roles list invariant: the active role must be in the allowed-roles
    # list. We normalize whichever side is supplied and validate the
    # combined state.
    if "roles" in update_data:
        supplied = update_data["roles"] or []
        # Pydantic gives us a list of UserRole enums; persist as JSONB-
        # compatible strings to keep DB shape stable.
        normalized: list[str] = []
        seen: set[str] = set()
        for entry in supplied:
            value = entry.value if hasattr(entry, "value") else str(entry)
            if value not in seen:
                seen.add(value)
                normalized.append(value)
        if not normalized:
            raise ValueError("roles must be a non-empty list")
        # Defense in depth: PLATFORM_ADMIN is a control-plane identity
        # (tenant_id IS NULL) and must never be granted to a tenant-scoped
        # user via the roles list, regardless of how this CRUD is reached.
        if user.tenant_id is not None and UserRole.PLATFORM_ADMIN.value in normalized:
            raise ValueError("PLATFORM_ADMIN cannot be assigned to a tenant user")
        active_role_value = next_role.value if hasattr(next_role, "value") else str(next_role)
        if active_role_value not in normalized:
            raise ValueError(
                "active role must be present in the roles list. "
                "Update role and roles together, or include the active "
                "role in the new roles list."
            )
        update_data["roles"] = normalized
    elif "role" in update_data:
        # role changing without roles changing: the new active role must
        # already be in the existing allowed-roles list.
        existing_roles = list(user.roles or [])
        active_role_value = next_role.value if hasattr(next_role, "value") else str(next_role)
        if active_role_value not in existing_roles:
            raise ValueError(
                f"User is not authorized to act as {active_role_value}. "
                "Add the role to the roles list before flipping the "
                "active role."
            )

    if "default_client_id" in update_data and update_data["default_client_id"] is not None:
        from app.models.client import Client
        client_result = await db.execute(
            select(Client).where(Client.id == update_data["default_client_id"])
        )
        client_row = client_result.scalar_one_or_none()
        if client_row is None or (user.tenant_id is not None and client_row.tenant_id != user.tenant_id):
            raise ValueError("default_client_id references a client from a different tenant or it doesn't exist")

    # Preserve the existing manager SET when the caller didn't touch managers.
    # Without this, a non-manager edit (e.g. title) would collapse a
    # multi-manager user down to just their primary, silently dropping the rest.
    # Query the rows directly rather than trust the relationship to be loaded.
    if not manager_ids_supplied and not manager_id_supplied:
        existing_rows = (await db.execute(
            select(EmployeeManagerAssignment).where(
                EmployeeManagerAssignment.employee_id == user.id)
        )).scalars().all()
        manager_ids = [r.manager_id for r in existing_rows]
        primary_row = next((r for r in existing_rows if r.is_primary), None)
        primary_manager_id = primary_row.manager_id if primary_row else (
            manager_ids[0] if manager_ids else None)
        manager_id = None
    elif not manager_id_supplied:
        manager_id = None  # manager_ids drives it
    if not project_ids_supplied:
        project_ids = user.project_ids
    if not task_ids_supplied:
        task_ids = user.task_ids

    # Capture which mirror-relevant fields changed BEFORE applying so the
    # mirror helper can decide whether to skip when nothing material moved.
    # Also snapshot the pre-state of email so the helper can clean up the
    # stale shared-DB row when a rename happens.
    previous_email = user.email
    mirror_fields_changed = bool(
        {"email", "username", "full_name", "hashed_password", "role", "roles",
         "is_active", "can_review", "is_external", "email_verified",
         "has_changed_password", "timesheet_locked", "phones", "auth0_sub",
         "tenant_id"}.intersection(update_data.keys())
    )

    for field, value in update_data.items():
        setattr(user, field, value)

    db.add(user)
    try:
        await db.flush()
        await _sync_user_assignments(
            db, user, next_role, manager_id, project_ids or [], task_ids or [],
            manager_ids=manager_ids, primary_manager_id=primary_manager_id)
        await db.commit()
    except ValueError:
        await db.rollback()
        raise

    # Mirror the post-update state to the shared DB. Skipped when no
    # mirror-relevant field changed (e.g. manager/project assignment-only
    # updates). Mirror failures don't roll back the per-tenant commit;
    # ops can detect divergence and backfill.
    if mirror_fields_changed:
        await _mirror_user_update_to_shared_db(user, previous_email=previous_email)

    # Expire the in-session object so the re-fetch below reloads the freshly
    # reconciled manager assignments rather than a stale identity-map copy.
    db.expire(user)
    return await get_user_by_id(db, user.id)


async def delete_user(db: AsyncSession, user_id: int) -> bool:
    """Delete user by ID, including dependent records/references.

    When the user has an Auth0 record bound (``auth0_sub``), we delete
    that first. If Auth0 fails (network, missing scope, anything other
    than 404), we abort and the local user stays — easier to retry the
    delete than to chase orphans in Auth0. A 404 from Auth0 is treated
    as success (the record is already gone).

    We also clean up the shared-DB stub mirror — the row in
    ``timesheet_db.users`` that was inserted by ``_mirror_user_to_shared_db``
    at create time. Without this, post-delete the email would still
    resolve to a phantom tenant_id during forgot-password lookups.
    """
    import logging
    _logger = logging.getLogger(__name__)

    user = await get_user_by_id(db, user_id)
    if not user:
        return False

    auth0_sub = user.auth0_sub
    user_email = user.email
    user_tenant_id = user.tenant_id
    if auth0_sub:
        from app.services import auth0_mgmt
        try:
            await auth0_mgmt.delete_user(auth0_sub, raise_on_error=True)
        except Exception as exc:
            _logger.error(
                "Auth0 delete failed for user %s (sub=%s); aborting local delete: %s",
                user_email, auth0_sub, exc,
            )
            raise

    if user:
        try:
            await db.execute(delete(UserProjectAccess).where(UserProjectAccess.user_id == user_id))
            await db.execute(
                delete(EmployeeManagerAssignment).where(
                    (EmployeeManagerAssignment.employee_id == user_id)
                    | (EmployeeManagerAssignment.manager_id == user_id)
                )
            )
            # Keep historical approval records valid by clearing approver references.
            await db.execute(
                update(TimeEntry)
                .where(TimeEntry.approved_by == user_id)
                .values(approved_by=None)
            )
            await db.execute(
                update(TimeOffRequest)
                .where(TimeOffRequest.approved_by == user_id)
                .values(approved_by=None)
            )
            # Clear created_by and updated_by audit references
            await db.execute(
                update(TimeEntry)
                .where(TimeEntry.created_by == user_id)
                .values(created_by=None)
            )
            await db.execute(
                update(TimeEntry)
                .where(TimeEntry.updated_by == user_id)
                .values(updated_by=None)
            )
            await db.execute(
                update(TimeOffRequest)
                .where(TimeOffRequest.created_by == user_id)
                .values(created_by=None)
            )
            await db.execute(
                update(TimeOffRequest)
                .where(TimeOffRequest.updated_by == user_id)
                .values(updated_by=None)
            )

            # Remove the user's owned records so seeded/demo users can be deleted cleanly.
            await db.execute(delete(TimeEntry).where(TimeEntry.user_id == user_id))
            await db.execute(delete(TimeOffRequest).where(TimeOffRequest.user_id == user_id))

            # Clear ingestion references (user might be auto-created by ingestion).
            # These tables may or may not have CASCADE/SET NULL constraints depending
            # on whether DB migrations were applied, so clear them explicitly.
            from app.models.ingestion_timesheet import IngestionTimesheet
            from app.models.activity_log import ActivityLog

            await db.execute(
                update(IngestionTimesheet)
                .where(IngestionTimesheet.employee_id == user_id)
                .values(employee_id=None)
            )
            await db.execute(
                update(IngestionTimesheet)
                .where(IngestionTimesheet.reviewer_id == user_id)
                .values(reviewer_id=None)
            )
            await db.execute(
                update(ActivityLog)
                .where(ActivityLog.actor_user_id == user_id)
                .values(actor_user_id=None)
            )

            # Clear time_entry_edit_history edited_by references
            from sqlalchemy import text as sa_text
            await db.execute(
                sa_text("UPDATE time_entry_edit_history SET edited_by = NULL WHERE edited_by = :uid"),
                {"uid": user_id},
            )
            # Clear ingestion_audit_log user_id references
            await db.execute(
                sa_text("UPDATE ingestion_audit_log SET user_id = NULL WHERE user_id = :uid"),
                {"uid": user_id},
            )

            await db.delete(user)
            await db.commit()

            # Clean up the shared-DB stub mirror (best-effort). If the
            # tenant DB ``db`` we just deleted from IS the shared DB
            # (non-isolated tenants), this is a no-op since the row's
            # already gone.
            try:
                from sqlalchemy import text as _sa_text
                from app.db import AsyncSessionLocal as _SharedSession
                async with _SharedSession() as _shared:
                    # Filter by (tenant_id, email): post-F-007 multiple
                    # tenants can share an email. Without this filter
                    # delete would clobber an unrelated tenant's user.
                    await _shared.execute(
                        _sa_text(
                            "DELETE FROM users "
                            "WHERE email = :email AND tenant_id IS NOT DISTINCT FROM :tenant_id"
                        ),
                        {"email": user_email, "tenant_id": user_tenant_id},
                    )
                    await _shared.commit()
            except Exception as exc:
                _logger.warning(
                    "Shared-DB stub cleanup failed for %s: %s",
                    user_email, exc,
                )

            return True
        except IntegrityError:
            await db.rollback()
            raise
    return False


def _apply_user_filters(query, *, q=None, role=None, status=None, audience=None,
                        no_manager=False, unverified=False):
    """Apply the User-list search/filter predicates shared by the count and
    page queries. `query` is a select() already scoped to a tenant."""
    if q:
        like = f"%{q.strip().lower()}%"
        query = query.where(
            sa_func.lower(User.full_name).like(like)
            | sa_func.lower(User.email).like(like)
            | sa_func.lower(User.username).like(like)
        )
    if role:
        query = query.where(User.role == role)
    if status == "active":
        query = query.where(User.is_active.is_(True))
    elif status == "inactive":
        query = query.where(User.is_active.is_(False))
    # Audience: internal (our staff), external (external collaborators), or
    # client (the client-portal personas). Client roles are external too, so we
    # exclude them from internal/external to keep the three buckets distinct.
    _client_roles = [UserRole.CLIENT, UserRole.CLIENT_MANAGER, UserRole.CLIENT_EMPLOYEE]
    if audience == "internal":
        query = query.where(User.is_external.is_(False), User.role.notin_(_client_roles))
    elif audience == "external":
        query = query.where(User.is_external.is_(True), User.role.notin_(_client_roles))
    elif audience == "client":
        query = query.where(User.role.in_(_client_roles))
    if unverified:
        # "Unverified" = internal users who haven't confirmed their email.
        # External users never log in (they have no verification step), so they
        # are excluded — matching the frontend attention-chip definition.
        query = query.where(User.email_verified.is_(False), User.is_external.is_(False))
    if no_manager:
        # "No manager" excludes admins/platform-admins (they're not expected to
        # report to anyone) and is expressed as NOT EXISTS so it applies in SQL
        # BEFORE pagination, keeping the page and the count in agreement.
        query = query.where(
            User.role.notin_([UserRole.ADMIN, UserRole.PLATFORM_ADMIN]),
            ~select(EmployeeManagerAssignment.employee_id)
            .where(EmployeeManagerAssignment.employee_id == User.id)
            .exists(),
        )
    return query


async def list_users(
    db: AsyncSession, tenant_id: int, skip: int = 0, limit: int = 100,
    *, q=None, role=None, status=None, audience=None, no_manager=False, unverified=False,
) -> list[User]:
    """List users for a tenant with pagination + optional search/filters."""
    base = select(User).where(User.tenant_id == tenant_id)
    base = _apply_user_filters(
        base, q=q, role=role, status=status, audience=audience,
        no_manager=no_manager, unverified=unverified,
    )
    result = await db.execute(
        base.options(
            selectinload(User.manager_assignment),
            selectinload(User.manager_assignments),
            selectinload(User.project_access),
            selectinload(User.task_access),
        )
        .order_by(User.full_name.asc())
        .offset(skip)
        .limit(limit)
    )
    return list(result.scalars().all())


async def count_users(
    db: AsyncSession, tenant_id: int,
    *, q=None, role=None, status=None, audience=None, no_manager=False, unverified=False,
) -> int:
    """Total matching users for the same filters as list_users (for paging)."""
    base = select(User).where(User.tenant_id == tenant_id)
    base = _apply_user_filters(
        base, q=q, role=role, status=status, audience=audience,
        no_manager=no_manager, unverified=unverified,
    )
    total = await db.scalar(select(sa_func.count()).select_from(base.subquery()))
    return int(total or 0)


async def list_users_by_role(db: AsyncSession, role: UserRole, tenant_id: int, skip: int = 0, limit: int = 100) -> list[User]:
    """List users by role within a tenant."""
    result = await db.execute(
        select(User)
        .where(User.role == role, User.tenant_id == tenant_id)
        .offset(skip)
        .limit(limit)
    )
    return result.scalars().all()
