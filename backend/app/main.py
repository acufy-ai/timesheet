import logging

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from app.core.config import settings
from app.core.permissions import shadow_check
from app.core.rate_limit import limiter
from app.db import AsyncSessionLocal, init_db, close_db
from app.api import (
    admin,
    approvals,
    attention_signals,
    auth,
    _invitation_endpoints,
    clients,
    client_extras,
    client_portal,
    contracts,
    dashboard,
    dashboards,
    dashboards_public,
    departments,
    titles,
    holidays,
    ingestion,
    leave_types,
    mailboxes,
    notifications,
    platform_dashboard,
    platform_settings,
    projects,
    sync,
    tasks,
    tenants,
    time_off,
    time_off_approvals,
    timesheets,
    users,
)
from app.models.mailbox import Mailbox  # noqa: F401
from app.models.ingested_email import IngestedEmail  # noqa: F401
from app.models.email_attachment import EmailAttachment  # noqa: F401
from app.models.ingestion_timesheet import (  # noqa: F401
    IngestionTimesheet,
    IngestionTimesheetLineItem,
    IngestionAuditLog,
)
from app.models.tenant import Tenant  # noqa: F401 — registers Tenant with Base.metadata
from app.models.tenant_settings import TenantSettings  # noqa: F401
from app.models.platform_settings import PlatformSettings  # noqa: F401
from app.models.sent_reminder import SentReminder  # noqa: F401 — registers table on Base.metadata
from app.models.user import UserRole

logger = logging.getLogger(__name__)

# Lifespan handler for startup/shutdown


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup. Run the encryption self-test FIRST so a misconfigured
    # ENCRYPTION_KEY fails the boot loudly here rather than silently
    # breaking SMTP / OAuth credential decryption at request time.
    from app.services.encryption import self_test as encryption_self_test
    encryption_self_test()
    logger.info("Encryption self-test passed")
    await init_db()
    logger.info("Database initialized")
    yield
    # Shutdown
    await close_db()
    logger.info("Database connection closed")


# Create FastAPI app
# Interactive docs and the OpenAPI schema expose the full API surface to anyone
# who can reach the host. Serve them only in debug/dev; disable in production
# (DEBUG unset/false) so an anonymous caller can't enumerate every route.
app = FastAPI(
    title="Timesheet API",
    description="Time tracking and approval system for IT consulting",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs" if settings.debug else None,
    redoc_url="/redoc" if settings.debug else None,
    openapi_url="/openapi.json" if settings.debug else None,
)

# Rate limiting. SlowAPIMiddleware makes the limiter's default_limits apply to
# EVERY route (not just the ones with an explicit @limiter.limit decorator), so
# lists/exports/dashboards can no longer be hammered freely.
from slowapi.middleware import SlowAPIMiddleware

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

# Configure CORS — explicitly list allowed methods and headers
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.effective_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "If-None-Match",  # for conditional GET round trip (ETag, /auth/me, /tenants/mine)
        "X-Service-Token",
        "X-Tenant-ID",
        # Per-tab refresh-cookie scoping: lets two accounts in two tabs of the
        # same browser keep independent sessions (cookie named per tab id).
        "X-Tab-Id",
        # Platform-admin cross-tenant writes (e.g. creating an ADMIN in
        # a target tenant from the platform UI) carry the destination
        # tenant slug here so ``get_tenant_db`` can route to the right
        # per-tenant database.
        "X-Tenant-Slug",
    ],
    # Headers the browser allows JS to READ from cross-origin responses.
    # Without ETag here, axios sees response.headers.etag as undefined
    # and the conditional-GET cache never gets populated. X-Request-Id
    # is exposed so the frontend can correlate logs with backend traces.
    expose_headers=["ETag", "X-Request-Id", "X-Total-Count"],
)


_access_logger = logging.getLogger("app.access")


@app.middleware("http")
async def request_logging(request: Request, call_next):
    """Structured per-request log + X-Request-Id propagation.

    Generates a UUID for every request, stamps it on the response header
    so clients (and downstream services) can correlate, and emits a
    single INFO line at completion with method, path, status, duration,
    user id and tenant id when available. The middleware runs BEFORE
    security headers so the request id is available even on responses
    that error out early.
    """
    import time
    import uuid

    request_id = request.headers.get("X-Request-Id") or uuid.uuid4().hex
    request.state.request_id = request_id
    start = time.perf_counter()

    response: Response = await call_next(request)
    duration_ms = int((time.perf_counter() - start) * 1000)
    response.headers["X-Request-Id"] = request_id

    # current_user is set on request.state by the auth dependencies when
    # they fire. Health checks and unauthenticated routes leave it None.
    current_user = getattr(request.state, "current_user", None)
    user_id = getattr(current_user, "id", None) if current_user else None
    tenant_id = getattr(current_user, "tenant_id", None) if current_user else None

    _access_logger.info(
        "%s %s -> %d (%dms) user_id=%s tenant_id=%s rid=%s",
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
        user_id,
        tenant_id,
        request_id,
    )
    return response


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    """Reject oversized request bodies via the declared Content-Length, before
    the body is read into memory.

    Without this an unauthenticated caller could POST a 100MB body (e.g. to
    /auth/login) and pin a worker + buffer it in memory — a cheap DoS. JSON
    and form bodies are capped tight; multipart (file uploads) gets a larger
    ceiling. We deliberately only inspect the Content-Length header and do NOT
    consume the request stream here: reading + re-supplying the body conflicts
    with Starlette's BaseHTTPMiddleware request lifecycle. Real HTTP clients
    always send Content-Length for a buffered body, so this covers the attack;
    the password field length cap backstops the rare chunked case.
    """
    from fastapi.responses import JSONResponse

    content_type = (request.headers.get("content-type") or "").lower()
    is_multipart = content_type.startswith("multipart/form-data")
    limit = settings.max_upload_body_bytes if is_multipart else settings.max_json_body_bytes

    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            declared = int(cl)
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length."})
        if declared > limit:
            return JSONResponse(status_code=413, content={"detail": "Request body too large."})

    return await call_next(request)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    if not settings.debug:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    # Strict default CSP; OAuth popup overrides for postMessage inline script.
    if "content-security-policy" not in {h.lower() for h in response.headers}:
        response.headers["Content-Security-Policy"] = (
            "default-src 'none'; "
            "frame-ancestors 'none'; "
            "base-uri 'none'; "
            "form-action 'none'"
        )
    return response


@app.middleware("http")
async def shadow_pending_approvals_permission_check(request: Request, call_next):
    response: Response = await call_next(request)

    if request.method != "GET" or request.url.path != "/approvals/pending":
        return response
    if response.status_code >= 400:
        return response

    current_user = getattr(request.state, "current_user", None)
    if current_user is None:
        return response

    permission = "time_entry.approve"
    try:
        async with AsyncSessionLocal() as db:
            await shadow_check(
                db,
                current_user,
                permission,
                old_decision=True,
                context="GET /approvals/pending",
            )
    except Exception as exc:  # pragma: no cover - defensive only
        logger.error("shadow middleware failed for approvals pending: %s", exc)

    return response

# Include routers
app.include_router(auth.router)
app.include_router(_invitation_endpoints.router)
app.include_router(users.router)
app.include_router(clients.router)
app.include_router(contracts.router)
app.include_router(client_extras.router)
app.include_router(client_extras.notes_router)
app.include_router(client_portal.router)
app.include_router(departments.router)
app.include_router(titles.router)
app.include_router(holidays.router)
app.include_router(leave_types.router)
app.include_router(projects.router)
app.include_router(tasks.router)
app.include_router(timesheets.router)
app.include_router(approvals.router)
app.include_router(time_off.router)
app.include_router(time_off_approvals.router)
app.include_router(dashboard.router)
app.include_router(dashboards.router)
app.include_router(dashboards_public.router)  # unauthenticated public share view
app.include_router(notifications.router)
app.include_router(tenants.router)
app.include_router(platform_settings.router)
app.include_router(platform_dashboard.router)
app.include_router(sync.router)
app.include_router(mailboxes.router)
app.include_router(mailboxes.oauth_router)
app.include_router(ingestion.router)
app.include_router(admin.router)
app.include_router(attention_signals.router)


@app.get("/health")
@limiter.exempt
async def health_check():
    """Health check endpoint. Exempt from rate limiting so load-balancer and
    container health probes (which poll frequently) are never throttled."""
    return {"status": "ok"}


@app.get("/")
async def root():
    """Root endpoint. In production this is intentionally terse — no version
    or docs URLs are disclosed to anonymous callers. Use /health for liveness."""
    if settings.debug:
        return {
            "name": "Timesheet API",
            "version": "1.0.0",
            "docs": "/docs",
            "openapi": "/openapi.json",
        }
    return {"status": "ok"}
