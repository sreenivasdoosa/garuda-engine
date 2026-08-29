"""Resolving a configured account into credentials.

The interesting cases are the ones where the account an order is *for* and the
account it is *authorised by* are not the same.
"""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest

from garuda.brokers.sessions import Account, SessionResolver, SessionUnavailableError
from garuda.domain.client import TradingClientId
from garuda.domain.session import BrokerSession

IST = ZoneInfo("Asia/Kolkata")
#: A Monday, after the morning cutoff.
NOW = datetime(2026, 8, 31, 4, 0, tzinfo=UTC)
TODAY = datetime(2026, 8, 31, 3, 0, tzinfo=UTC)
YESTERDAY = datetime(2026, 8, 30, 3, 0, tzinfo=UTC)

DEALER = TradingClientId("dealer")
CHILD = TradingClientId("child")
SOLO = TradingClientId("solo")


def account(
    name: TradingClientId,
    client_id: str,
    *,
    api_key: str | None = "key",
    uses: TradingClientId | None = None,
    market_data: bool = False,
    enabled: bool = True,
    websocket: bool = True,
    static_ip: str | None = None,
) -> Account:
    return Account(
        id=name,
        broker="zerodha",
        client_id=client_id,
        enabled=enabled,
        api_key=api_key,
        static_ip=static_ip,
        websocket_enabled=websocket,
        uses_credentials_of=uses,
        is_market_data_source=market_data,
    )


def session(client_id: str, token: str = "tok", created: datetime = TODAY) -> BrokerSession:
    return BrokerSession(client_id=client_id, access_token=token, created_at=created)


def resolver(
    accounts: list[Account], sessions: dict[TradingClientId, BrokerSession]
) -> SessionResolver:
    return SessionResolver({a.id: a for a in accounts}, sessions, timezone=IST)


class TestOwnSession:
    def test_an_account_uses_its_own_session(self) -> None:
        subject = resolver([account(SOLO, "AB1234")], {SOLO: session("AB1234")})
        credentials = subject.credentials_for(SOLO, NOW)

        assert credentials.client_id == "AB1234"
        assert credentials.access_token == "tok"
        assert not credentials.is_borrowed

    def test_an_account_with_no_session_is_refused_clearly(self) -> None:
        subject = resolver([account(SOLO, "AB1234")], {})
        with pytest.raises(SessionUnavailableError, match="no broker session"):
            subject.credentials_for(SOLO, NOW)

    def test_a_session_from_yesterday_is_refused(self) -> None:
        """Broker sessions die at a wall-clock hour, not after a duration."""
        subject = resolver([account(SOLO, "AB1234")], {SOLO: session("AB1234", created=YESTERDAY)})
        with pytest.raises(SessionUnavailableError, match="log in again"):
            subject.credentials_for(SOLO, NOW)

    def test_a_disabled_account_gets_nothing(self) -> None:
        subject = resolver([account(SOLO, "AB1234", enabled=False)], {SOLO: session("AB1234")})
        with pytest.raises(SessionUnavailableError, match="disabled"):
            subject.credentials_for(SOLO, NOW)

    def test_an_account_nobody_configured_is_refused(self) -> None:
        subject = resolver([], {})
        with pytest.raises(SessionUnavailableError, match="not a configured"):
            subject.credentials_for(SOLO, NOW)


class TestABorrowedSession:
    """A dealer terminal: one login, several accounts."""

    def dealer_setup(self) -> SessionResolver:
        return resolver(
            [
                account(DEALER, "DEAL01", api_key="dealer-key"),
                account(CHILD, "CHILD9", api_key=None, uses=DEALER),
            ],
            {DEALER: session("DEAL01", token="dealer-token")},
        )

    def test_the_token_comes_from_the_account_that_logged_in(self) -> None:
        credentials = self.dealer_setup().credentials_for(CHILD, NOW)
        assert credentials.access_token == "dealer-token"
        assert credentials.api_key == "dealer-key"
        assert credentials.authenticated_as == DEALER
        assert credentials.is_borrowed

    def test_the_client_id_stays_the_account_the_order_is_for(self) -> None:
        """Both are needed: the token from one, the account from the other."""
        credentials = self.dealer_setup().credentials_for(CHILD, NOW)
        assert credentials.client_id == "CHILD9"
        assert credentials.trading_client == CHILD

    def test_the_route_is_the_trading_accounts_own(self) -> None:
        """A dealer session is shared; a whitelisted address is not."""
        subject = resolver(
            [
                account(DEALER, "DEAL01"),
                account(CHILD, "CHILD9", uses=DEALER, static_ip="203.0.113.7"),
            ],
            {DEALER: session("DEAL01")},
        )
        assert subject.credentials_for(CHILD, NOW).static_ip == "203.0.113.7"

    def test_a_child_whose_dealer_never_logged_in_says_which(self) -> None:
        subject = resolver([account(DEALER, "DEAL01"), account(CHILD, "CHILD9", uses=DEALER)], {})
        with pytest.raises(SessionUnavailableError, match="it uses dealer's"):
            subject.credentials_for(CHILD, NOW)

    def test_accounts_borrowing_in_a_loop_are_refused(self) -> None:
        """Otherwise resolution never terminates."""
        subject = resolver(
            [
                account(DEALER, "DEAL01", uses=CHILD),
                account(CHILD, "CHILD9", uses=DEALER),
            ],
            {},
        )
        with pytest.raises(SessionUnavailableError, match="in a loop"):
            subject.credentials_for(CHILD, NOW)

    def test_a_dealers_own_expired_session_stops_every_child(self) -> None:
        subject = resolver(
            [account(DEALER, "DEAL01"), account(CHILD, "CHILD9", uses=DEALER)],
            {DEALER: session("DEAL01", created=YESTERDAY)},
        )
        with pytest.raises(SessionUnavailableError, match="log in again"):
            subject.credentials_for(CHILD, NOW)


class TestTheMarketDataAccount:
    def test_the_flagged_account_provides_the_feed(self) -> None:
        subject = resolver(
            [account(SOLO, "AB1234"), account(DEALER, "DEAL01", market_data=True)],
            {DEALER: session("DEAL01", token="feed-token")},
        )
        assert subject.market_data_client() == DEALER
        assert subject.market_data_credentials(NOW).access_token == "feed-token"

    def test_it_need_not_be_an_account_that_trades(self) -> None:
        """A login and nothing else: no capital, no strategies."""
        subject = resolver(
            [account(SOLO, "DATA01", market_data=True, websocket=False)],
            {SOLO: session("DATA01")},
        )
        assert subject.market_data_client() == SOLO
        assert subject.streaming_clients() == []

    def test_with_none_chosen_the_refusal_says_what_it_costs(self) -> None:
        """Every strategy's prices, not one account's."""
        subject = resolver([account(SOLO, "AB1234")], {SOLO: session("AB1234")})
        assert subject.market_data_client() is None
        with pytest.raises(SessionUnavailableError, match="no ticks and no quotes"):
            subject.market_data_credentials(NOW)

    def test_a_market_data_account_that_has_not_logged_in_is_refused(self) -> None:
        subject = resolver([account(SOLO, "AB1234", market_data=True)], {})
        with pytest.raises(SessionUnavailableError, match="no broker session"):
            subject.market_data_credentials(NOW)

    def test_it_can_borrow_a_dealers_session_like_any_other_account(self) -> None:
        subject = resolver(
            [
                account(DEALER, "DEAL01", api_key="dealer-key"),
                account(CHILD, "CHILD9", uses=DEALER, market_data=True),
            ],
            {DEALER: session("DEAL01", token="dealer-token")},
        )
        assert subject.market_data_credentials(NOW).access_token == "dealer-token"


class TestWhoGetsAStream:
    def test_only_enabled_accounts_with_the_socket_turned_on(self) -> None:
        subject = resolver(
            [
                account(SOLO, "AB1234"),
                account(DEALER, "DEAL01", websocket=False),
                account(CHILD, "CHILD9", enabled=False),
            ],
            {},
        )
        assert [a.id for a in subject.streaming_clients()] == [SOLO]
