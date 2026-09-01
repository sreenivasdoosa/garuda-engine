"""Logging a data provider in. Operator-initiated, always.

There is no automated login anywhere here: no stored password posted to a form,
no TOTP, no scheduled refresh. The reference market-data service has all three;
they are deliberately not ported. An expired session stops market data and says
so, and the operator clicks Login.

Two shapes, and which one a provider uses is a fact about the vendor:

**Redirect** — Zerodha, Fyers, Dhan. The engine builds a URL, the operator's
browser goes there and comes back to the registered callback with a short-lived
code, and the engine exchanges that code for a token server-side. The exchange
needs the API secret, which is why the secret is stored rather than only used
in the browser.

**Direct** — XTS, TrueData. The engine posts the credentials and gets a token
back. No browser, so the Login button just calls the API and waits.

Vendor hosts are constants here rather than configuration: they are facts about
someone else's service, and a typo in one would stop market data in a way that
looks exactly like an outage.
"""

from __future__ import annotations

import hashlib
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx

from garuda.domain.errors import DomainError
from garuda.marketdata.providers.credentials import ProviderCredentials, ProviderSession
from garuda.protocols.clock import Clock

# -- vendor endpoints -------------------------------------------------------

KITE_LOGIN = "https://kite.zerodha.com/connect/login"
KITE_API = "https://api.kite.trade"
FYERS_AUTH = "https://api-t1.fyers.in/api/v3/generate-authcode"
FYERS_API = "https://api-t1.fyers.in/api/v3"
DHAN_AUTH = "https://auth.dhan.co/consent-login"
DHAN_API = "https://auth.dhan.co"
TRUEDATA_AUTH = "https://auth.truedata.in"


class ProviderLoginError(DomainError):
    """The login did not complete. The message is for the operator."""


@dataclass(frozen=True, slots=True)
class LoginStart:
    """What the Console does next to log this provider in.

    `url` set means send the browser there. `url` None means the login already
    happened in this call -- a direct provider -- and `session` holds it.
    """

    provider: str
    url: str | None = None
    session: ProviderSession | None = None

    @property
    def needs_browser(self) -> bool:
        return self.url is not None


class ProviderAuth(ABC):
    """How one provider is logged in."""

    def __init__(
        self, credentials: ProviderCredentials, clock: Clock, client: httpx.AsyncClient
    ) -> None:
        self._credentials = credentials
        self._clock = clock
        self._client = client

    @property
    def provider(self) -> str:
        return self._credentials.provider

    @abstractmethod
    async def begin(self) -> LoginStart:
        """Start a login: a URL to visit, or a completed session."""

    async def complete(self, code: str) -> ProviderSession:
        """Finish a redirect login with whatever came back on the callback."""
        del code  # a direct provider has nothing to finish
        raise ProviderLoginError(
            f"{self.provider} does not use a browser redirect, so there is nothing to complete"
        )

    # -- shared helpers ----------------------------------------------------

    def _session(self, token: str, client_id: str | None = None) -> ProviderSession:
        """Build a session, refusing one that belongs to another account.

        A token for the wrong account is worse than no token: prices would
        arrive, from someone else's entitlements, and nothing would look wrong.
        """
        expected = self._credentials.client_id
        if expected and client_id and client_id != expected:
            raise ProviderLoginError(
                f"{self.provider}: logged in as {client_id}, but this provider is "
                f"configured for {expected}"
            )
        return ProviderSession(
            provider=self.provider,
            access_token=token,
            obtained_at=self._clock.now(),
            client_id=client_id or expected,
            borrowed_from=self._credentials.borrowed_from,
        )

    async def _post(
        self,
        url: str,
        *,
        json: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        try:
            response = await self._client.post(url, json=json, data=data, headers=headers)
        except httpx.HTTPError as error:
            raise ProviderLoginError(f"{self.provider}: could not reach {url} ({error})") from None
        return self._payload(response, url)

    def _payload(self, response: httpx.Response, url: str) -> dict[str, Any]:
        try:
            body = response.json()
        except ValueError:
            raise ProviderLoginError(
                f"{self.provider}: {url} answered {response.status_code} with "
                f"{response.text[:200]!r}, which is not JSON"
            ) from None
        if not isinstance(body, dict):
            raise ProviderLoginError(f"{self.provider}: {url} answered an unexpected shape")
        if response.status_code >= 400:
            raise ProviderLoginError(
                f"{self.provider}: login refused ({response.status_code}) — "
                f"{_message(body) or response.text[:200]}"
            )
        return body


def _message(body: dict[str, Any]) -> str | None:
    for key in ("message", "error_description", "errorMessage", "description", "error"):
        value = body.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _token_of(body: dict[str, Any], *names: str) -> str:
    for name in names:
        value = body.get(name)
        if isinstance(value, str) and value:
            return value
    # Some vendors nest the useful part one level down.
    for container in ("data", "result", "d"):
        nested = body.get(container)
        if isinstance(nested, dict):
            for name in names:
                value = nested.get(name)
                if isinstance(value, str) and value:
                    return value
    raise ProviderLoginError(f"the login succeeded but returned no {names[0]}")


def _nested_str(body: dict[str, Any], *names: str) -> str | None:
    for name in names:
        value = body.get(name)
        if isinstance(value, str) and value:
            return value
    for container in ("data", "result", "d"):
        nested = body.get(container)
        if isinstance(nested, dict):
            for name in names:
                value = nested.get(name)
                if isinstance(value, str) and value:
                    return value
    return None


# -- redirect providers -----------------------------------------------------


class ZerodhaAuth(ProviderAuth):
    """Kite Connect v3.

    The redirect URL is registered against the app in Kite's console, not sent
    here — which is why nothing below supplies one. Kite has no `state`
    parameter either, which is why the callback path carries the identity.
    """

    async def begin(self) -> LoginStart:
        query = urlencode({"v": "3", "api_key": self._credentials.api_key})
        return LoginStart(provider=self.provider, url=f"{KITE_LOGIN}?{query}")

    async def complete(self, code: str) -> ProviderSession:
        if not code:
            raise ProviderLoginError("Kite returned no request token; the login did not complete")
        if not self._credentials.api_secret:
            raise ProviderLoginError(
                "Kite needs the API secret to exchange the request token, and none is stored"
            )
        checksum = hashlib.sha256(
            f"{self._credentials.api_key}{code}{self._credentials.api_secret}".encode()
        ).hexdigest()
        body = await self._post(
            f"{KITE_API}/session/token",
            data={
                "api_key": self._credentials.api_key,
                "request_token": code,
                "checksum": checksum,
            },
            headers={"X-Kite-Version": "3"},
        )
        data = body.get("data") if isinstance(body.get("data"), dict) else body
        assert isinstance(data, dict)
        return self._session(_token_of(data, "access_token"), _nested_str(data, "user_id"))


class FyersAuth(ProviderAuth):
    """Fyers API v3. Unlike Kite it does take a redirect URI and a `state`."""

    async def begin(self) -> LoginStart:
        if not self._credentials.redirect_url:
            raise ProviderLoginError(
                "Fyers sends the auth code to a redirect URI it is given, so one must be "
                "configured and registered in the Fyers app"
            )
        query = urlencode(
            {
                "client_id": self._credentials.api_key,
                "redirect_uri": self._credentials.redirect_url,
                "response_type": "code",
                "state": self.provider,
            }
        )
        return LoginStart(provider=self.provider, url=f"{FYERS_AUTH}?{query}")

    async def complete(self, code: str) -> ProviderSession:
        if not code:
            raise ProviderLoginError("Fyers returned no auth code; the login did not complete")
        # Fyers signs the exchange with sha256(app_id:app_secret) rather than
        # sending the secret itself.
        app_hash = hashlib.sha256(
            f"{self._credentials.api_key}:{self._credentials.api_secret}".encode()
        ).hexdigest()
        body = await self._post(
            f"{FYERS_API}/validate-authcode",
            json={"grant_type": "authorization_code", "appIdHash": app_hash, "code": code},
        )
        return self._session(_token_of(body, "access_token"), self._credentials.client_id)


class DhanAuth(ProviderAuth):
    """Dhan's consent flow: request a consent id, send the operator to approve
    it, then exchange the returned token id."""

    async def begin(self) -> LoginStart:
        body = await self._request_consent()
        consent = _token_of(body, "consentId", "consent_id")
        query = urlencode({"consentId": consent})
        return LoginStart(provider=self.provider, url=f"{DHAN_AUTH}?{query}")

    async def _request_consent(self) -> dict[str, Any]:
        try:
            response = await self._client.get(
                f"{DHAN_API}/app/generate-consent",
                headers={
                    "app_id": self._credentials.api_key,
                    "app_secret": self._credentials.api_secret,
                },
            )
        except httpx.HTTPError as error:
            raise ProviderLoginError(f"Dhan: could not reach the consent API ({error})") from None
        return self._payload(response, f"{DHAN_API}/app/generate-consent")

    async def complete(self, code: str) -> ProviderSession:
        if not code:
            raise ProviderLoginError("Dhan returned no token id; the login did not complete")
        try:
            response = await self._client.get(
                f"{DHAN_API}/app/consumeApp-consent",
                params={"tokenId": code},
                headers={
                    "app_id": self._credentials.api_key,
                    "app_secret": self._credentials.api_secret,
                },
            )
        except httpx.HTTPError as error:
            raise ProviderLoginError(f"Dhan: could not reach the consent API ({error})") from None
        body = self._payload(response, "consumeApp-consent")
        return self._session(
            _token_of(body, "accessToken", "access_token"),
            _nested_str(body, "dhanClientId", "clientId"),
        )


# -- direct providers -------------------------------------------------------


class XtsAuth(ProviderAuth):
    """XTS market data. Its market-data key and secret are issued separately
    from its trading ones, which is why this provider always holds its own."""

    def __init__(
        self,
        credentials: ProviderCredentials,
        clock: Clock,
        client: httpx.AsyncClient,
        *,
        base_url: str,
    ) -> None:
        super().__init__(credentials, clock, client)
        self._base = base_url.rstrip("/")

    async def begin(self) -> LoginStart:
        body = await self._post(
            f"{self._base}/auth/login",
            json={
                "appKey": self._credentials.api_key,
                "secretKey": self._credentials.api_secret,
                "source": "WEBAPI",
            },
        )
        session = self._session(_token_of(body, "token"), _nested_str(body, "userID", "userId"))
        return LoginStart(provider=self.provider, session=session)


class TrueDataAuth(ProviderAuth):
    """TrueData: a username and password for an OAuth password grant. Not a
    broker -- there is nothing to trade through it, only prices."""

    async def begin(self) -> LoginStart:
        body = await self._post(
            f"{TRUEDATA_AUTH}/token",
            data={
                "username": self._credentials.api_key,
                "password": self._credentials.api_secret,
                "grant_type": "password",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        session = self._session(_token_of(body, "access_token"), self._credentials.api_key)
        return LoginStart(provider=self.provider, session=session)


#: Which class logs each provider in.
AUTH_BY_PROVIDER: dict[str, type[ProviderAuth]] = {
    "zerodha": ZerodhaAuth,
    "fyers": FyersAuth,
    "dhan": DhanAuth,
    "xts": XtsAuth,
    "truedata": TrueDataAuth,
}

#: The providers whose login goes through the operator's browser.
REDIRECT_PROVIDERS = frozenset({"zerodha", "fyers", "dhan"})


def auth_for(
    credentials: ProviderCredentials,
    clock: Clock,
    client: httpx.AsyncClient,
    *,
    xts_base_url: str = "",
) -> ProviderAuth:
    kind = AUTH_BY_PROVIDER.get(credentials.provider)
    if kind is None:
        raise ProviderLoginError(f"{credentials.provider} has no login flow here")
    if kind is XtsAuth:
        if not xts_base_url:
            raise ProviderLoginError(
                "XTS is reached at an address its vendor gives each customer, and none is set"
            )
        return XtsAuth(credentials, clock, client, base_url=xts_base_url)
    return kind(credentials, clock, client)
