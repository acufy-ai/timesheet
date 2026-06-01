from abc import ABC, abstractmethod
from app.models.time_entry import TimeEntry
from app.models.project import Project
import logging

logger = logging.getLogger(__name__)


class QuickBooksService(ABC):
    """
    Abstract base class for QuickBooks integration.
    This allows pluggable implementations and future QB API integration.
    """

    @abstractmethod
    async def push_time_activity(self, entry: TimeEntry) -> str:
        """
        Push an approved time entry to QuickBooks as a TimeActivity.

        Args:
            entry: The TimeEntry to push

        Returns:
            str: The QuickBooks TimeActivity ID
        """
        pass

    @abstractmethod
    async def sync_project(self, project: Project) -> str:
        """
        Sync a project to QuickBooks.

        Args:
            project: The Project to sync

        Returns:
            str: The QuickBooks Project ID
        """
        pass

    @abstractmethod
    async def sync_customer(self, customer_name: str) -> str:
        """
        Sync a customer to QuickBooks.

        Args:
            customer_name: The name of the customer

        Returns:
            str: The QuickBooks Customer ID
        """
        pass


class QuickBooksServiceMock(QuickBooksService):
    """
    Mock implementation of QuickBooksService for development and testing.
    In production, replace with actual QB API implementation.
    """

    async def push_time_activity(self, entry: TimeEntry) -> str:
        """Mock: log time activity push."""
        activity_id = f"QB-TID-{entry.id}-{entry.user_id}"
        logger.info(
            f"[MOCK QB] Would push time activity for entry {entry.id}: {activity_id}")
        return activity_id

    async def sync_project(self, project: Project) -> str:
        """Mock: log project sync."""
        project_id = f"QB-PID-{project.id}"
        logger.info(f"[MOCK QB] Would sync project {project.id}: {project_id}")
        return project_id

    async def sync_customer(self, customer_name: str) -> str:
        """Mock: log customer sync."""
        customer_id = f"QB-CID-{hash(customer_name) % 10000}"
        logger.info(
            f"[MOCK QB] Would sync customer '{customer_name}': {customer_id}")
        return customer_id


# Global instance
_qb_service: QuickBooksService = QuickBooksServiceMock()


def get_quickbooks_service() -> QuickBooksService:
    """Get the current QuickBooks service instance.

    Emits a one-shot warning when the active service is the mock and
    we're not in DEBUG mode — so a misconfigured prod deploy that
    accidentally keeps the mock doesn't silently fabricate QB IDs for
    real customer data.
    """
    global _qb_service_warned
    if isinstance(_qb_service, QuickBooksServiceMock):
        try:
            from app.core.config import settings
            if not settings.debug and not _qb_service_warned:
                logger.warning(
                    "QuickBooks integration is using the MOCK service in a non-DEBUG environment. "
                    "Real customer data will receive fabricated QB IDs. "
                    "Set DEBUG=true (dev) or wire a real QuickBooksService implementation (prod)."
                )
                _qb_service_warned = True
        except Exception:
            # Defensive: never let the warning short-circuit the integration.
            pass
    return _qb_service


# Tracks whether we've already emitted the "mock in prod" warning so
# logs aren't flooded on every call.
_qb_service_warned: bool = False


def set_quickbooks_service(service: QuickBooksService):
    """Set the QuickBooks service instance (for testing or swapping implementations)."""
    global _qb_service, _qb_service_warned
    _qb_service = service
    _qb_service_warned = False
