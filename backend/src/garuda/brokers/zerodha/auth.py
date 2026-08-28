"""Zerodha (Kite Connect) login.

**Operator-initiated only.** There is no automated login here: no scripted
credential post, no TOTP, no scheduled refresh. The operator clicks Login, the
browser goes to Kite, and Kite redirects back with a request token which is
exchanged for a session.

The flow, from Kite Connect v3:

1. Send the operator to ``/connect/login?v=3&api_key=...``
2. Kite redirects to the account's registered URL with ``request_token``
3. POST that token with ``checksum = sha256(api_key + request_token + api_secret)``
4. Kite answers with an access token and a public token

The checksum is why the API secret has to be stored rather than only used in a
browser: step 3 happens server-side.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx

from garuda.domain.errors import DomainError
from garuda.domain.session import BrokerSession
from garuda.protocols.broker import (
    AuthExpiredError,
    FatalBrokerError,
    RateLimitedError,
    RetryableBrokerError,
)
from garuda.protocols.clock import Clock

KITE_LOGIN_HOST = "https://kite.zerodha.com"
KITE_API_HOST = "https://api.kite.trade"
KITE_API_VERSION = "3"


@dataclass(frozen=True, slots=True)
class ZerodhaCredentials:
    """What Kite issues per account when an app is registered."""

    client_id: str
    api_key: str
    api_secret: str

    def __post_init__(self) -> None:
        for name, value in (
            ("client id", self.client_id),
            ("API key", self.api_key),
            ("API secret", self.api_secret),
        ):
            if not value:
                raise DomainError(f"Zerodha login needs an {name}")


def checksum(api_key: str, request_token: str, api_secret: str) -> str:
    """Kite's proof that the caller holds the API secret."""
    return hashlib.sha256(f"{api_key}{request_token}{api_secret}".encode()).hexdigest()


class ZerodhaAuth:
    """Builds the login URL and exchanges a request token for a session."""

    def __init__(
        self,
        credentials: ZerodhaCredentials,
        clock: Clock,
        client: httpx.AsyncClient,
        *,
        login_host: str = KITE_LOGIN_HOST,
        api_host: str = KITE_API_HOST,
    ) -> None:
        self._credentials = credentials
        self._clock = clock
        self._client = client
        self._login_host = login_host.rstrip("/")
        self._api_host = api_host.rstrip("/")

    def login_url(self) -> str:
        """Where to send the operator's browser.

        Kite redirects back to the URL registered against the app, which is why
        the engine never supplies one here.
        """
        query = urlencode({"v": KITE_API_VERSION, "api_key": self._credentials.api_key})
        return f"{self._login_host}/connect/login?{query}"

    async def exchange(self, request_token: str) -> BrokerSession:
        """Turn the redirect's request token into a session."""
        if not request_token:
            raise DomainError("Kite returned no request token; the login did not complete")

        response = await self._post(
            "/session/token",
            {
                "api_key": self._credentials.api_key,
                "request_token": request_token,
                "checksum": checksum(
                    self._credentials.api_key, request_token, self._credentials.api_secret
                ),
            },
        )
        data = _payload(response)

        access_token = data.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise FatalBrokerError("Kite accepted the login but returned no access token")

        returned_client = data.get("user_id")
        if isinstance(returned_client, str) and returned_client != self._credentials.client_id:
            # The operator logged into a different Kite account than the one
            # this trading client names. Routing orders to it would put them on
            # the wrong account.
            raise FatalBrokerError(
                f"logged in as {returned_client}, but this trading client is "
                f"{self._credentials.client_id}"
            )

        public_token = data.get("public_token")
        return BrokerSession(
            client_id=self._credentials.client_id,
            access_token=access_token,
            public_token=public_token if isinstance(public_token, str) else None,
            request_token=request_token,
            created_at=self._clock.now(),
        )

    async def _post(self, path: str, form: dict[str, str]) -> httpx.Response:
        try:
            return await self._client.post(
                f"{self._api_host}{path}",
                data=form,
                headers={"X-Kite-Version": KITE_API_VERSION},
            )
        except httpx.TimeoutException as error:
            raise RetryableBrokerError(f"Kite timed out: {error}") from error
        except httpx.HTTPError as error:
            raise RetryableBrokerError(f"Kite was unreachable: {error}") from error


def _payload(response: httpx.Response) -> dict[str, object]:
    """Normalise a Kite response into data, or into the error taxonomy."""
    if response.status_code == 429:
        raise RateLimitedError("Kite rate-limited the login")
    if response.status_code in (401, 403):
        raise AuthExpiredError(f"Kite refused the credentials: {_message(response)}")
    if response.status_code >= 500:
        raise RetryableBrokerError(f"Kite returned {response.status_code}")

    try:
        body = response.json()
    except ValueError as error:
        raise FatalBrokerError(
            f"Kite returned {response.status_code} with a body that is not JSON"
        ) from error

    if not isinstance(body, dict) or body.get("status") != "success":
        raise FatalBrokerError(f"Kite refused the login: {_message(response)}")

    data = body.get("data")
    if not isinstance(data, dict):
        raise FatalBrokerError("Kite reported success with no data")
    return data


def _message(response: httpx.Response) -> str:
    """Kite's own wording, which is what makes a failure searchable."""
    try:
        body = response.json()
    except ValueError:
        return response.text[:200]
    if isinstance(body, dict):
        message = body.get("message")
        if isinstance(message, str):
            return message
    return response.text[:200]
