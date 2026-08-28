"""Zerodha login.

Driven against a fake transport, so the whole flow is exercised without a
network or an account.
"""

from __future__ import annotations

from datetime import UTC, datetime, time
from zoneinfo import ZoneInfo

import httpx
import pytest

from garuda.brokers.zerodha import ZerodhaAuth, ZerodhaCredentials, checksum
from garuda.core.clock import ReplayClock
from garuda.domain.errors import DomainError
from garuda.domain.session import BrokerSession
from garuda.protocols.broker import (
    AuthExpiredError,
    FatalBrokerError,
    RateLimitedError,
    RetryableBrokerError,
)

T0 = datetime(2026, 8, 27, 9, 0, tzinfo=UTC)
IST = ZoneInfo("Asia/Kolkata")
CREDENTIALS = ZerodhaCredentials(client_id="AB1234", api_key="key123", api_secret="secret456")


def responder(
    status: int = 200, body: object | None = None, capture: list[httpx.Request] | None = None
) -> httpx.AsyncClient:
    def handle(request: httpx.Request) -> httpx.Response:
        if capture is not None:
            capture.append(request)
        payload = (
            body
            if body is not None
            else {
                "status": "success",
                "data": {
                    "user_id": "AB1234",
                    "access_token": "access-token-value",
                    "public_token": "public-token-value",
                },
            }
        )
        return httpx.Response(status, json=payload)

    return httpx.AsyncClient(transport=httpx.MockTransport(handle))


def auth(client: httpx.AsyncClient) -> ZerodhaAuth:
    return ZerodhaAuth(CREDENTIALS, ReplayClock(T0), client)


class TestCredentials:
    @pytest.mark.parametrize("missing", ["client_id", "api_key", "api_secret"])
    def test_incomplete_credentials_are_refused(self, missing):
        fields = {"client_id": "AB1234", "api_key": "k", "api_secret": "s", missing: ""}
        with pytest.raises(DomainError, match="needs an"):
            ZerodhaCredentials(**fields)


class TestLoginUrl:
    async def test_it_points_at_kite_with_the_api_key(self):
        async with responder() as client:
            url = auth(client).login_url()
        assert url.startswith("https://kite.zerodha.com/connect/login?")
        assert "api_key=key123" in url
        assert "v=3" in url

    async def test_it_carries_no_redirect(self):
        """Kite redirects to the URL registered against the app, not one we pass."""
        async with responder() as client:
            assert "redirect" not in auth(client).login_url()

    async def test_it_never_contains_the_secret(self):
        async with responder() as client:
            assert "secret456" not in auth(client).login_url()


class TestChecksum:
    def test_it_is_the_documented_sha256(self):
        import hashlib

        expected = hashlib.sha256(b"keyrequestsecret").hexdigest()
        assert checksum("key", "request", "secret") == expected

    def test_a_different_secret_gives_a_different_checksum(self):
        assert checksum("k", "r", "s1") != checksum("k", "r", "s2")


class TestExchange:
    async def test_a_successful_exchange_produces_a_session(self):
        async with responder() as client:
            session = await auth(client).exchange("request-token")

        assert isinstance(session, BrokerSession)
        assert session.access_token == "access-token-value"
        assert session.public_token == "public-token-value"
        assert session.client_id == "AB1234"
        assert session.created_at == T0

    async def test_the_request_token_is_kept(self):
        """A failed exchange is otherwise undiagnosable."""
        async with responder() as client:
            session = await auth(client).exchange("request-token")
        assert session.request_token == "request-token"

    async def test_the_checksum_proves_we_hold_the_secret(self):
        captured: list[httpx.Request] = []
        async with responder(capture=captured) as client:
            await auth(client).exchange("request-token")

        (request,) = captured
        body = dict(pair.split("=", 1) for pair in request.content.decode().split("&"))
        assert body["checksum"] == checksum("key123", "request-token", "secret456")
        assert "api_secret" not in body, "the secret itself is never sent"

    async def test_an_empty_request_token_is_refused_before_any_call(self):
        captured: list[httpx.Request] = []
        async with responder(capture=captured) as client:
            with pytest.raises(DomainError, match="did not complete"):
                await auth(client).exchange("")
        assert captured == []


class TestWrongAccount:
    async def test_logging_into_a_different_kite_account_is_refused(self):
        """Routing orders to it would put them on the wrong account."""
        body = {
            "status": "success",
            "data": {"user_id": "ZZ9999", "access_token": "t"},
        }
        async with responder(body=body) as client:
            with pytest.raises(FatalBrokerError, match="logged in as ZZ9999"):
                await auth(client).exchange("request-token")


class TestErrorTaxonomy:
    async def test_rate_limiting_is_retryable(self):
        async with responder(status=429) as client:
            with pytest.raises(RateLimitedError):
                await auth(client).exchange("request-token")

    @pytest.mark.parametrize("status", [401, 403])
    async def test_refused_credentials_are_auth_expired(self, status):
        body = {"status": "error", "message": "Invalid `api_key` or `access_token`."}
        async with responder(status=status, body=body) as client:
            with pytest.raises(AuthExpiredError, match="Invalid"):
                await auth(client).exchange("request-token")

    async def test_a_server_error_is_retryable(self):
        async with responder(status=502) as client:
            with pytest.raises(RetryableBrokerError):
                await auth(client).exchange("request-token")

    async def test_a_timeout_is_retryable(self):
        def handle(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectTimeout("timed out")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            with pytest.raises(RetryableBrokerError, match="timed out"):
                await auth(client).exchange("request-token")

    async def test_an_error_status_in_the_body_is_fatal(self):
        body = {"status": "error", "message": "Token is invalid or has expired."}
        async with responder(body=body) as client:
            with pytest.raises(FatalBrokerError, match="Token is invalid"):
                await auth(client).exchange("request-token")

    async def test_success_without_an_access_token_is_fatal(self):
        async with responder(body={"status": "success", "data": {"user_id": "AB1234"}}) as client:
            with pytest.raises(FatalBrokerError, match="no access token"):
                await auth(client).exchange("request-token")

    async def test_a_non_json_body_is_fatal_and_says_so(self):
        def handle(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="<html>maintenance</html>")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            with pytest.raises(FatalBrokerError, match="not JSON"):
                await auth(client).exchange("request-token")

    async def test_the_brokers_own_wording_is_preserved(self):
        """It is what makes a failure searchable in Kite's documentation."""
        body = {"status": "error", "message": "The user has not authorised this app."}
        async with responder(body=body) as client:
            with pytest.raises(FatalBrokerError, match="has not authorised this app"):
                await auth(client).exchange("request-token")


class TestSessionExpiry:
    def session(self, created: datetime) -> BrokerSession:
        return BrokerSession(client_id="AB1234", access_token="t", created_at=created)

    def test_a_session_created_this_morning_is_live_all_day(self):
        session = self.session(datetime(2026, 8, 27, 9, 0, tzinfo=IST))
        assert not session.is_expired(datetime(2026, 8, 27, 15, 25, tzinfo=IST), timezone=IST)

    def test_yesterdays_session_is_expired(self):
        session = self.session(datetime(2026, 8, 26, 9, 0, tzinfo=IST))
        assert session.is_expired(datetime(2026, 8, 27, 10, 0, tzinfo=IST), timezone=IST)

    def test_it_expires_on_a_cutoff_not_after_a_duration(self):
        """A token issued at 09:00 and one at 15:00 die at the same moment."""
        morning = self.session(datetime(2026, 8, 26, 9, 0, tzinfo=IST))
        evening = self.session(datetime(2026, 8, 26, 15, 0, tzinfo=IST))
        next_day = datetime(2026, 8, 27, 10, 0, tzinfo=IST)
        assert morning.is_expired(next_day, timezone=IST)
        assert evening.is_expired(next_day, timezone=IST)

    def test_yesterdays_session_is_expired_even_before_the_cutoff(self):
        """Conservative on purpose: a dead session read as live fails at the open."""
        session = self.session(datetime(2026, 8, 26, 15, 0, tzinfo=IST))
        assert session.is_expired(datetime(2026, 8, 27, 6, 0, tzinfo=IST), timezone=IST)

    def test_the_cutoff_is_configurable(self):
        session = self.session(datetime(2026, 8, 27, 7, 0, tzinfo=IST))
        assert not session.is_expired(
            datetime(2026, 8, 27, 9, 0, tzinfo=IST), timezone=IST, cutoff=time(6, 0)
        )
        assert session.is_expired(
            datetime(2026, 8, 27, 9, 0, tzinfo=IST), timezone=IST, cutoff=time(8, 0)
        )

    def test_a_session_for_another_account_is_not_reused(self):
        assert self.session(T0).belongs_to("AB1234")
        assert not self.session(T0).belongs_to("CD5678")

    def test_a_session_without_a_token_is_refused(self):
        with pytest.raises(DomainError, match="without an access token"):
            BrokerSession(client_id="AB1234", access_token="", created_at=T0)
