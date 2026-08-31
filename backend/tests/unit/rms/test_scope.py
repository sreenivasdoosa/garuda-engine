"""Which row of risk configuration applies to which order.

The shape these are written against is the reference engine's real data: rows
scoped by exchange and underlying, every one of them naming a segment, and a
`config_level` label that disagrees with its own scope columns often enough to
be worthless as a signal.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from garuda.domain import Currency, Money
from garuda.domain.client import TradingClientId
from garuda.domain.enums import (
    ExerciseStyle,
    InstrumentKind,
    OptionType,
    Segment,
    SettlementType,
)
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.rms.limits import RiskLimits
from garuda.rms.scope import NO_LIMITS, LimitBook, LimitScope, ScopedLimits

APPA = TradingClientId("appa")
AMMA = TradingClientId("amma")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


@pytest.fixture
def crude_option(mcx: Exchange) -> Instrument:
    return Instrument(
        id=InstrumentId("MCX:CRUDEOIL25SEP5900CE"),
        exchange=mcx,
        segment=Segment.COMMODITY,
        kind=InstrumentKind.OPTION,
        trading_symbol="CRUDEOIL25SEP5900CE",
        lot_size=100,
        tick_size=Decimal("1"),
        underlying=InstrumentId("MCX:CRUDEOIL"),
        expiry=date(2026, 9, 16),
        strike=Decimal("5900"),
        option_type=OptionType.CALL,
        exercise_style=ExerciseStyle.EUROPEAN,
        settlement_type=SettlementType.PHYSICAL,
    )


@pytest.fixture
def reliance(nse: Exchange) -> Instrument:
    return Instrument(
        id=InstrumentId("NSE:RELIANCE"),
        exchange=nse,
        segment=Segment.EQUITY,
        kind=InstrumentKind.EQUITY,
        trading_symbol="RELIANCE",
        lot_size=1,
        tick_size=Decimal("0.05"),
    )


# -- what applies -----------------------------------------------------------


def test_nothing_configured_enforces_nothing(reliance: Instrument) -> None:
    assert NO_LIMITS.for_(reliance, APPA) == RiskLimits()


def test_an_unscoped_row_applies_to_everything(reliance: Instrument) -> None:
    book = LimitBook((ScopedLimits(LimitScope(), RiskLimits(max_order_quantity=50)),))

    assert book.for_(reliance, APPA).max_order_quantity == 50


def test_a_row_for_another_exchange_does_not_apply(reliance: Instrument) -> None:
    book = LimitBook((ScopedLimits(LimitScope(exchange="MCX"), RiskLimits(max_order_quantity=50)),))

    assert book.for_(reliance, APPA).max_order_quantity is None


def test_a_row_for_another_account_does_not_apply(reliance: Instrument) -> None:
    book = LimitBook(
        (ScopedLimits(LimitScope(trading_client="amma"), RiskLimits(max_order_quantity=50)),)
    )

    assert book.for_(reliance, APPA).max_order_quantity is None
    assert book.for_(reliance, AMMA).max_order_quantity == 50


def test_an_equity_row_does_not_apply_to_an_option(crude_option: Instrument) -> None:
    """The defect this replaced. Every row in the reference names a segment,
    so reading "the global row" and taking the first of them applied equity
    limits to an options order."""
    book = LimitBook(
        (
            ScopedLimits(LimitScope(kind=InstrumentKind.OPTION), RiskLimits(min_volume=25_000)),
            # Listed last, and equally specific, so it would win on order
            # alone if the kind were not read.
            ScopedLimits(LimitScope(kind=InstrumentKind.EQUITY), RiskLimits(min_volume=10_000)),
        )
    )

    assert book.for_(crude_option, APPA).min_volume == 25_000


def test_a_symbol_row_matches_the_underlying_not_only_the_contract(
    crude_option: Instrument,
) -> None:
    """A row naming CRUDEOIL is about every crude option, not about one
    strike -- which is how the reference's own rows are written."""
    book = LimitBook((ScopedLimits(LimitScope(symbol="CRUDEOIL"), RiskLimits(min_volume=5_000)),))

    assert book.for_(crude_option, APPA).min_volume == 5_000


def test_a_row_for_another_underlying_does_not_apply(crude_option: Instrument) -> None:
    book = LimitBook((ScopedLimits(LimitScope(symbol="NATURALGAS"), RiskLimits(min_volume=5_000)),))

    assert book.for_(crude_option, APPA).min_volume is None


def test_a_symbol_row_matches_a_plain_equity_by_its_own_name(reliance: Instrument) -> None:
    book = LimitBook((ScopedLimits(LimitScope(symbol="RELIANCE"), RiskLimits(min_volume=5_000)),))

    assert book.for_(reliance, APPA).min_volume == 5_000


# -- how they combine -------------------------------------------------------


def test_the_narrower_row_wins_the_field_they_share(crude_option: Instrument) -> None:
    book = LimitBook(
        (
            ScopedLimits(LimitScope(), RiskLimits(min_volume=50_000)),
            ScopedLimits(LimitScope(symbol="CRUDEOIL"), RiskLimits(min_volume=5_000)),
        )
    )

    assert book.for_(crude_option, APPA).min_volume == 5_000


def test_order_in_the_table_does_not_decide_it(crude_option: Instrument) -> None:
    """Specificity decides, not the order rows came back from the database."""
    book = LimitBook(
        (
            ScopedLimits(LimitScope(symbol="CRUDEOIL"), RiskLimits(min_volume=5_000)),
            ScopedLimits(LimitScope(), RiskLimits(min_volume=50_000)),
        )
    )

    assert book.for_(crude_option, APPA).min_volume == 5_000


def test_the_narrower_row_inherits_what_it_does_not_set(crude_option: Instrument) -> None:
    """The point of merging rather than replacing. A row saying only "crude
    needs five thousand lots" must not blank the order value cap."""
    book = LimitBook(
        (
            ScopedLimits(
                LimitScope(),
                RiskLimits(min_volume=50_000, max_order_value=rupees("500000")),
            ),
            ScopedLimits(LimitScope(symbol="CRUDEOIL"), RiskLimits(min_volume=5_000)),
        )
    )

    resolved = book.for_(crude_option, APPA)

    assert resolved.min_volume == 5_000
    assert resolved.max_order_value == rupees("500000")


def test_an_account_row_beats_an_exchange_row(crude_option: Instrument) -> None:
    """A limit set against one account is about that account's funding, and a
    venue-wide default cannot know it."""
    book = LimitBook(
        (
            ScopedLimits(LimitScope(exchange="MCX"), RiskLimits(max_order_quantity=1000)),
            ScopedLimits(LimitScope(trading_client="appa"), RiskLimits(max_order_quantity=100)),
        )
    )

    assert book.for_(crude_option, APPA).max_order_quantity == 100


def test_a_symbol_row_beats_an_account_row(crude_option: Instrument) -> None:
    book = LimitBook(
        (
            ScopedLimits(LimitScope(trading_client="appa"), RiskLimits(max_order_quantity=100)),
            ScopedLimits(LimitScope(symbol="CRUDEOIL"), RiskLimits(max_order_quantity=20)),
        )
    )

    assert book.for_(crude_option, APPA).max_order_quantity == 20


def test_a_segment_narrows_rather_than_competes(crude_option: Instrument) -> None:
    """An exchange row for options is narrower than an exchange row for
    anything, and both are wider than a row naming the underlying."""
    book = LimitBook(
        (
            ScopedLimits(
                LimitScope(exchange="MCX", kind=InstrumentKind.OPTION),
                RiskLimits(min_volume=25_000),
            ),
            # Listed last, so only the segment makes the row above narrower.
            ScopedLimits(LimitScope(exchange="MCX"), RiskLimits(min_volume=50_000)),
        )
    )

    assert book.for_(crude_option, APPA).min_volume == 25_000


def test_the_reference_shape_resolves_the_way_it_reads(crude_option: Instrument) -> None:
    """All four of the reference's real rows for a crude option at once: a
    global equity row that must not apply, a global options row, an
    MCX options row, and the row naming CRUDEOIL."""
    book = LimitBook(
        (
            ScopedLimits(
                LimitScope(kind=InstrumentKind.EQUITY),
                RiskLimits(min_volume=10_000, max_spread_fraction=Decimal("0.005")),
            ),
            ScopedLimits(
                LimitScope(kind=InstrumentKind.OPTION),
                RiskLimits(min_volume=30_000, stale_quote_after=None),
            ),
            ScopedLimits(
                LimitScope(exchange="MCX", kind=InstrumentKind.OPTION),
                RiskLimits(min_volume=25_000, max_spread_fraction=Decimal("0.02")),
            ),
            ScopedLimits(
                LimitScope(exchange="MCX", symbol="CRUDEOIL", kind=InstrumentKind.OPTION),
                RiskLimits(min_volume=5_000),
            ),
        )
    )

    resolved = book.for_(crude_option, APPA)

    assert resolved.min_volume == 5_000
    assert resolved.max_spread_fraction == Decimal("0.02")
