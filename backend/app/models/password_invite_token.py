from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base


class PasswordInviteToken(Base):
    """One-time-use token for the local password-set / forgot-password flow.

    Replaces Auth0's hosted password-reset ticket. We issue a signed JWT
    that the user clicks in their email, lands on our ``/set-password``
    page, picks a password; backend then verifies the JTI against this
    table (one-time use), calls Auth0's Management API to set the
    password, and marks ``consumed_at``.

    ``purpose`` distinguishes flows:
      - ``invite``  : admin-created user, first-time setup
      - ``reset``   : user-initiated forgot-password
    """

    __tablename__ = "password_invite_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    jti: Mapped[str] = mapped_column(
        String(64), nullable=False, unique=True, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    purpose: Mapped[str] = mapped_column(String(32), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    consumed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    user = relationship("User")
