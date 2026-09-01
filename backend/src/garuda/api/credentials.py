"""The admin password, where an operator can change it.

In the database rather than in settings, because a password that needs a file
edited and a process restarted is a password nobody changes. `system_config`
holds it as an Argon2 hash under one property.

**The first run seeds it and says so.** An engine with no row yet takes the
configured default, hashes it, writes it, and logs a warning naming the fact.
After that the row is the only authority: changing the setting does nothing,
which is the point -- one place decides, and it is the one the Console can
edit.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from garuda.api.tokens import DEFAULT_ADMIN_PASSWORD, hash_password, password_matches
from garuda.persistence.uow import UnitOfWork

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

#: Where the hash lives. Named like the reference's properties.
ADMIN_PASSWORD = "admin.password.hash"

#: The shortest password this will accept. Not a policy, a floor: an operator
#: choosing something short on their own machine is their business, and four
#: characters is a typo rather than a choice.
MINIMUM_LENGTH = 8


class AdminCredentials:
    """Reads and changes the one password there is."""

    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
        clock: Clock,
        *,
        first_run_password: str = DEFAULT_ADMIN_PASSWORD,
    ) -> None:
        self._sessions = sessions
        self._clock = clock
        self._first_run = first_run_password

    async def ensure(self) -> None:
        """Put a password in place if there is none. Idempotent."""
        async with UnitOfWork(self._sessions) as uow:
            if await uow.repositories.system_config.value_of(ADMIN_PASSWORD) is not None:
                return
            await uow.repositories.system_config.put(
                ADMIN_PASSWORD, hash_password(self._first_run), self._clock.now()
            )
        if self._first_run == DEFAULT_ADMIN_PASSWORD:
            logger.warning(
                "the admin account has been created with its first-run password; change it "
                "from the Console before this reaches anything but your own machine"
            )
        else:
            logger.info("the admin account has been created with the configured password")

    async def matches(self, offered: str) -> bool:
        async with UnitOfWork(self._sessions) as uow:
            stored = await uow.repositories.system_config.value_of(ADMIN_PASSWORD)
        return stored is not None and password_matches(stored, offered)

    async def change(self, current: str, replacement: str) -> str | None:
        """Change it. Returns why not, or None when it changed.

        The current password is required even though there is one identity and
        it is already signed in: a session left open on an unlocked machine is
        exactly the case this stops.
        """
        if len(replacement) < MINIMUM_LENGTH:
            return f"a password of {MINIMUM_LENGTH} characters or more, please"
        if replacement == current:
            return "that is the password you already have"
        if not await self.matches(current):
            return "that is not the current password"

        async with UnitOfWork(self._sessions) as uow:
            await uow.repositories.system_config.put(
                ADMIN_PASSWORD, hash_password(replacement), self._clock.now()
            )
        logger.info("the admin password was changed")
        return None
