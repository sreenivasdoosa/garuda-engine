"""Kite Connect over HTTP.

Every trading call goes through here, so the auth header, the response
envelope and -- above all -- the translation from Kite's error vocabulary into
the engine's closed taxonomy exist once.

**The reason for a rejection is in the body, not the status line.** The
reference engine spent a long time logging empty rejection messages because
the SDK's exception carried Kite's reason in a public field its ``getMessage``
did not return; the real text ("Market orders without market protection are
not allowed via API") only surfaced when someone read the field directly.
Talking to the API rather than an SDK removes the trap, but the lesson stands:
the body's ``message`` is the operator's only account of what went wrong, and
it is carried on every error raised here.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from garuda.protocols.broker import (
    AuthExpiredError,
    BrokerError,
    FatalBrokerError,
    OrderRejectedError,
    RateLimitedError,
    RetryableBrokerError,
)

logger = logging.getLogger(__name__)

KITE_API_HOST = "https://api.kite.trade"
KITE_API_VERSION = "3"

#: Kite's error_type values, mapped to what the engine does about them.
#:
#: An unmapped type becomes fatal rather than retryable. Retrying something
#: nobody has classified is how a rejected order becomes six rejected orders.
_ERROR_TYPES: dict[str, type[BrokerError]] = {
    # The session is gone. Trading halts for this client until the operator
    # logs in again; nothing here re-authenticates on its own.
    "TokenException": AuthExpiredError,
    # The account may not do this at all -- an unsubscribed segment, a
    # disabled API. Retrying cannot help and neither can a new session.
    "PermissionException": FatalBrokerError,
    "UserException": FatalBrokerError,
    # The order itself was refused: price band, margin, freeze quantity,
    # market protection. The engine keeps its session and moves on.
    "OrderException": OrderRejectedError,
    "InputException": OrderRejectedError,
    "MarginException": OrderRejectedError,
    "HoldingException": OrderRejectedError,
    # The far side, not us.
    "NetworkException": RetryableBrokerError,
    "GatewayException": RetryableBrokerError,
    "DataException": RetryableBrokerError,
    "GeneralException": RetryableBrokerError,
    "TooManyRequestsException": RateLimitedError,
}


class KiteClient:
    """Signed, envelope-aware access to Kite's REST API."""

    def __init__(
        self,
        api_key: str,
        access_token: str,
        client: httpx.AsyncClient,
        *,
        host: str = KITE_API_HOST,
    ) -> None:
        self._api_key = api_key
        self._access_token = access_token
        self._client = client
        self._host = host.rstrip("/")

    @property
    def headers(self) -> dict[str, str]:
        return {
            "X-Kite-Version": KITE_API_VERSION,
            "Authorization": f"token {self._api_key}:{self._access_token}",
        }

    async def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        return await self._request("GET", path, params=params)

    async def post(self, path: str, form: dict[str, Any]) -> Any:
        return await self._request("POST", path, form=form)

    async def put(self, path: str, form: dict[str, Any]) -> Any:
        return await self._request("PUT", path, form=form)

    async def delete(self, path: str, form: dict[str, Any] | None = None) -> Any:
        return await self._request("DELETE", path, form=form)

    async def _request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        form: dict[str, Any] | None = None,
    ) -> Any:
        url = f"{self._host}{path}"
        try:
            response = await self._client.request(
                method,
                url,
                headers=self.headers,
                params=params,
                # Kite takes form encoding, not JSON, on every write.
                data={k: v for k, v in (form or {}).items() if v is not None} or None,
            )
        except httpx.TimeoutException as error:
            # A timeout is not a failure to place: the order may well have
            # reached the exchange. The caller retries with the same client
            # order id, which is what makes that safe.
            raise RetryableBrokerError(f"{method} {path} timed out: {error}") from error
        except httpx.HTTPError as error:
            raise RetryableBrokerError(f"{method} {path} failed: {error}") from error

        return self._unwrap(response, method, path)

    def _unwrap(self, response: httpx.Response, method: str, path: str) -> Any:
        try:
            payload = response.json()
        except ValueError:
            payload = None

        if not isinstance(payload, dict):
            # HTML from a proxy, an empty body from a gateway. Retryable
            # because it says nothing about the request, only about the path
            # it took.
            raise RetryableBrokerError(
                f"{method} {path}: HTTP {response.status_code} with an unreadable body"
            )

        if payload.get("status") == "success":
            return payload.get("data")

        message = str(payload.get("message") or f"HTTP {response.status_code}")
        error_type = str(payload.get("error_type") or "")
        failure = _ERROR_TYPES.get(error_type)

        if failure is None:
            failure = self._by_status(response.status_code)
            logger.warning(
                "kite returned an unmapped error_type %r on %s %s: %s",
                error_type,
                method,
                path,
                message,
            )

        raise failure(f"{message} [{error_type or response.status_code}]")

    @staticmethod
    def _by_status(status_code: int) -> type[BrokerError]:
        if status_code == 429:
            return RateLimitedError
        if status_code in (401, 403):
            return AuthExpiredError
        if status_code >= 500:
            return RetryableBrokerError
        return FatalBrokerError
