"""Building an engine out of whatever configuration exists.

The behaviour that matters is what happens when a piece is missing. An engine
that refuses to start because one account has not logged in is useless at six
in the morning, which is exactly when it is started.
"""

from __future__ import annotations

from .conftest import AMMA, APPA, EngineBuilder, account, session


def test_an_account_with_a_session_is_ready_to_trade(build_with: EngineBuilder) -> None:
    engine = build_with([account(APPA, "AB1234")], {APPA: session("AB1234")})

    assert set(engine.parts.clients) == {APPA}
    assert engine.parts.unavailable == {}


def test_one_expired_session_does_not_stop_the_other_accounts(build_with: EngineBuilder) -> None:
    """An operator with two accounts and one login should trade on one."""
    engine = build_with(
        [account(APPA, "AB1234"), account(AMMA, "CD5678")],
        {APPA: session("AB1234")},
    )

    assert set(engine.parts.clients) == {APPA}
    assert set(engine.parts.unavailable) == {AMMA}


def test_an_account_that_cannot_trade_is_reported_by_name(build_with: EngineBuilder) -> None:
    engine = build_with([account(AMMA, "CD5678")], {})

    assert "Amma (zerodha:CD5678)" in engine.parts.unavailable[AMMA]


def test_a_disabled_account_is_refused_rather_than_forgotten(build_with: EngineBuilder) -> None:
    """It must still appear, or an operator cannot tell it from a typo."""
    engine = build_with([account(APPA, "AB1234", enabled=False)], {APPA: session("AB1234")})

    assert engine.parts.clients == {}
    assert engine.parts.unavailable[APPA] == "the account is disabled"
    assert APPA in engine.parts.accounts


def test_every_configured_account_is_kept_whether_it_trades_or_not(
    build_with: EngineBuilder,
) -> None:
    engine = build_with(
        [account(APPA, "AB1234"), account(AMMA, "CD5678")], {APPA: session("AB1234")}
    )

    assert set(engine.parts.accounts) == {APPA, AMMA}


def test_no_market_data_account_means_no_feed_but_still_an_engine(
    build_with: EngineBuilder,
) -> None:
    """Nothing has prices. That is worth saying, not worth refusing to start."""
    engine = build_with([account(APPA, "AB1234")], {APPA: session("AB1234")})

    assert engine.parts.market_data is None
    assert engine.parts.clients


def test_a_nominated_market_data_account_gets_a_feed(build_with: EngineBuilder) -> None:
    engine = build_with([account(APPA, "AB1234", market_data=True)], {APPA: session("AB1234")})

    assert engine.parts.market_data is not None


def test_disabling_the_market_data_account_takes_the_feed_with_it(
    build_with: EngineBuilder,
) -> None:
    """Disabled means disabled for everything, not only for placing orders.

    An operator who wants prices without trades leaves the account enabled and
    subscribes it to nothing; the flag is not a way to say "data only".
    """
    engine = build_with(
        [account(APPA, "AB1234", market_data=True, enabled=False)],
        {APPA: session("AB1234")},
    )

    assert engine.parts.market_data is None
    assert engine.parts.clients == {}


def test_every_client_shares_one_price_source(build_with: EngineBuilder) -> None:
    """A price is a fact about the market, not about an account."""
    engine = build_with(
        [account(APPA, "AB1234"), account(AMMA, "CD5678")],
        {APPA: session("AB1234"), AMMA: session("CD5678")},
    )

    assert len(engine.parts.clients) == 2
    assert engine.parts.hub is not None


def test_the_loops_are_built_once_not_per_access(build_with: EngineBuilder) -> None:
    """Registering one object and stopping another would leave loops running."""
    engine = build_with([account(APPA, "AB1234")], {APPA: session("AB1234")})

    assert engine.loops is engine.loops


def test_each_client_gets_its_own_book(build_with: EngineBuilder) -> None:
    engine = build_with(
        [account(APPA, "AB1234"), account(AMMA, "CD5678")],
        {APPA: session("AB1234"), AMMA: session("CD5678")},
    )

    books = {client.book.trading_client for client in engine.parts.clients.values()}
    assert books == {APPA, AMMA}


def test_the_coordinator_the_loop_uses_is_the_one_on_the_parts(build_with: EngineBuilder) -> None:
    """Two coordinators would each see half the outstanding leg decisions."""
    engine = build_with([account(APPA, "AB1234")], {APPA: session("AB1234")})

    client = engine.parts.clients[APPA]
    assert client.loop._coordinator is client.coordinator


def test_no_accounts_at_all_still_builds(build_with: EngineBuilder) -> None:
    engine = build_with([], {})

    assert engine.parts.clients == {}
    assert "trading: none" in engine.describe()


def test_the_description_names_who_is_trading(build_with: EngineBuilder) -> None:
    engine = build_with([account(APPA, "AB1234")], {APPA: session("AB1234")})

    assert "Appa (zerodha:AB1234)" in engine.describe()


def test_a_dealer_session_authorises_the_accounts_that_borrow_it(build_with: EngineBuilder) -> None:
    """One access token across several client ids, which is the dealer setup."""
    engine = build_with(
        [account(APPA, "AB1234"), account(AMMA, "CD5678", uses=APPA)],
        {APPA: session("AB1234")},
    )

    assert set(engine.parts.clients) == {APPA, AMMA}
