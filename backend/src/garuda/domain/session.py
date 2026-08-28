"""Broker sessions.

A broker session is the thing that authorises orders. It is created when the
operator completes a login and it dies on a schedule the broker sets.

**Indian broker sessions expire at a fixed hour, not after a duration.** A
token issued at 09:00 and one issued at 15:00 both stop working at the same
moment the next morning, so "created less than N hours ago" is the wrong
question. The right one is whether the session predates today's cutoff.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time
from zoneinfo import ZoneInfo

from garuda.domain.calendar import require_aware
from garuda.domain.errors import DomainError

#: When broker sessions from the previous day stop being usable. Brokers
#: invalidate overnight; this is the hour by which that has certainly happened.
DEFAULT_SESSION_CUTOFF = time(7, 30)


@dataclass(frozen=True, slots=True)
class BrokerSession:
    """What a completed login produced.

    Persisted, so a restart does not force a manual re-login. The operator
    authorised the session; restarting the process is not a new authorisation.
    """

    client_id: str
    access_token: str
    created_at: datetime
    #: Zerodha issues one alongside the access token; XTS-style brokers do not.
    public_token: str | None = None
    #: The OAuth intermediate, kept because a failed exchange is otherwise
    #: undiagnosable.
    request_token: str | None = None
    #: Per-session endpoint, for brokers that hand one back at login rather
    #: than publishing a fixed one.
    server_url: str | None = None

    def __post_init__(self) -> None:
        require_aware(self.created_at)
        if not self.access_token:
            raise DomainError(f"{self.client_id}: a session without an access token is not one")
        if not self.client_id:
            raise DomainError("a session must name the account it belongs to")

    def is_expired(
        self,
        now: datetime,
        *,
        timezone: ZoneInfo,
        cutoff: time = DEFAULT_SESSION_CUTOFF,
    ) -> bool:
        """Whether this session predates today's cutoff in the venue's zone.

        The comparison is in local time because the cutoff is a wall-clock hour
        the broker chose, not an instant.

        A session created before today's cutoff is expired even when the cutoff
        has not yet passed. That is deliberately conservative: treating a live
        session as dead costs one operator-initiated login, while treating a
        dead one as live means orders failing at the open with an
        authentication error nobody is watching for.
        """
        require_aware(now)
        local_now = now.astimezone(timezone)
        today_cutoff = datetime.combine(local_now.date(), cutoff, tzinfo=timezone)
        return self.created_at.astimezone(timezone) < today_cutoff

    def belongs_to(self, client_id: str) -> bool:
        """Guards against a cached session being reused on the wrong account."""
        return self.client_id == client_id
