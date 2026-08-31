"""What a tick means for the positions already open.

The seam this exercises did not exist: `TrailingService` was built into every
account and nothing ever handed it a tick, so trailing stops never moved and
the high and low since entry were never recorded.
"""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal

import pytest

from garuda.alerts.manager import AlertManager
from garuda.domain import Direction
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Tick
from garuda.domain.trade import Protection, Trade
from garuda.domain.trade_state import TradeExitReason
from garuda.domain.trailing import TrailConfig
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.dedup import InstrumentLookup
from garuda.trademgmt.positions import PositionWatch
from garuda.trademgmt.trailing import TrailingService

from .conftest import CALL, PUT, TODAY, a_trade, rupees

TEN = Protection(combined_stop_loss_percent=Decimal(10), combined_target_percent=Decimal(10))


class RecordingSquareOff:
    """Stands in for the queue. Only what was asked for matters here."""

    def __init__(self) -> None:
        self.requested: list[tuple[str, TradeExitReason]] = []

    async def request(self, trade: Trade, reason: TradeExitReason) -> bool:
        self.requested.append((str(trade.id), reason))
        return True


def entered(
    trade_id: str,
    instrument: InstrumentId,
    entry: str,
    *,
    direction: Direction = Direction.SHORT,
    quantity: int = 75,
    group: str = "DEFAULT",
    protection: Protection = TEN,
) -> Trade:
    trade = replace(
        a_trade(
            trade_id,
            instrument=instrument,
            direction=direction,
            group=group,
            quantity=quantity,
        ),
        protection=protection,
        signal_id=f"sig-{trade_id}",
    )
    return trade.with_entry_fill(quantity, rupees(entry), TODAY)


def watch(
    book: TradingClientManager,
    alerts: AlertManager,
    prices: dict[InstrumentId, str],
    square_off: RecordingSquareOff,
    instruments: InstrumentLookup,
) -> PositionWatch:
    trailing = TrailingService(
        book,
        _unused_modify,
        _unused_cancel,
        _unused_place,
        instruments,
        alerts,
    )
    quotes = {
        instrument: Tick(instrument=instrument, last_price=rupees(price), timestamp=TODAY)
        for instrument, price in prices.items()
    }
    return PositionWatch(book, trailing, square_off, quotes.get, alerts)  # type: ignore[arg-type]


async def _unused_modify(*args: object, **kwargs: object) -> None:
    raise AssertionError("no order should be modified here")


async def _unused_cancel(*args: object, **kwargs: object) -> None:
    raise AssertionError("no order should be cancelled here")


async def _unused_place(*args: object, **kwargs: object) -> None:
    raise AssertionError("no order should be placed here")


def a_tick(instrument: InstrumentId, price: str) -> Tick:
    return Tick(instrument=instrument, last_price=rupees(price), timestamp=TODAY)


@pytest.fixture
def book(instruments: InstrumentLookup, alerts: AlertManager) -> TradingClientManager:
    from .conftest import CLIENT, LABEL

    return TradingClientManager(CLIENT, LABEL, instruments, alerts)


# -- the group comes out whole ----------------------------------------------


async def test_a_group_past_its_combined_stop_comes_out(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    """270 taken in, 297 to close: down 27, which is the 10%."""
    book.add_trade(entered("t-call", CALL, "150"))
    book.add_trade(entered("t-put", PUT, "120"))
    square_off = RecordingSquareOff()
    subject = watch(book, alerts, {CALL: "170", PUT: "127"}, square_off, instruments)

    report = await subject.on_tick(a_tick(CALL, "170"))

    assert report.groups_exited == 1
    assert sorted(square_off.requested) == [
        ("t-call", TradeExitReason.GROUP_STOP_LOSS),
        ("t-put", TradeExitReason.GROUP_STOP_LOSS),
    ]


async def test_every_leg_is_asked_out_not_only_the_one_that_ticked(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    """A combined level is the group's, so the group leaves. The ordering
    between legs is the coordinator's business, not this one's."""
    book.add_trade(entered("t-call", CALL, "150"))
    book.add_trade(entered("t-put", PUT, "120"))
    square_off = RecordingSquareOff()
    subject = watch(book, alerts, {CALL: "170", PUT: "127"}, square_off, instruments)

    await subject.on_tick(a_tick(CALL, "170"))

    assert {trade for trade, _ in square_off.requested} == {"t-call", "t-put"}


async def test_a_group_at_its_combined_target_comes_out(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    book.add_trade(entered("t-call", CALL, "150"))
    book.add_trade(entered("t-put", PUT, "120"))
    square_off = RecordingSquareOff()
    subject = watch(book, alerts, {CALL: "130", PUT: "113"}, square_off, instruments)

    await subject.on_tick(a_tick(CALL, "130"))

    assert [reason for _, reason in square_off.requested] == [
        TradeExitReason.GROUP_TARGET,
        TradeExitReason.GROUP_TARGET,
    ]


async def test_a_group_inside_its_levels_stays(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    book.add_trade(entered("t-call", CALL, "150"))
    book.add_trade(entered("t-put", PUT, "120"))
    square_off = RecordingSquareOff()
    subject = watch(book, alerts, {CALL: "200", PUT: "65"}, square_off, instruments)

    report = await subject.on_tick(a_tick(CALL, "200"))

    assert report.groups_checked == 1
    assert square_off.requested == []


async def test_a_group_is_only_asked_out_once(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    """The level stays true for every tick after it is crossed, and re-asking
    on each would bury the log and re-run the arithmetic all day."""
    book.add_trade(entered("t-call", CALL, "150"))
    book.add_trade(entered("t-put", PUT, "120"))
    square_off = RecordingSquareOff()
    subject = watch(book, alerts, {CALL: "170", PUT: "127"}, square_off, instruments)

    await subject.on_tick(a_tick(CALL, "170"))
    await subject.on_tick(a_tick(CALL, "171"))
    await subject.on_tick(a_tick(CALL, "172"))

    assert len(square_off.requested) == 2


async def test_another_group_is_untouched(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    """Groups are separate positions. One reaching its level says nothing
    about the other, even in the same instrument."""
    book.add_trade(entered("t-call", CALL, "150", group="A"))
    book.add_trade(entered("t-put", PUT, "120", group="A"))
    book.add_trade(entered("t-call-b", CALL, "300", group="B", protection=Protection()))
    square_off = RecordingSquareOff()
    subject = watch(book, alerts, {CALL: "170", PUT: "127"}, square_off, instruments)

    await subject.on_tick(a_tick(CALL, "170"))

    assert {trade for trade, _ in square_off.requested} == {"t-call", "t-put"}


async def test_a_group_with_no_combined_level_is_never_exited_on_one(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    book.add_trade(entered("t-call", CALL, "150", protection=Protection()))
    book.add_trade(entered("t-put", PUT, "120", protection=Protection()))
    square_off = RecordingSquareOff()
    subject = watch(book, alerts, {CALL: "900", PUT: "900"}, square_off, instruments)

    await subject.on_tick(a_tick(CALL, "900"))

    assert square_off.requested == []


# -- when it cannot be evaluated -------------------------------------------


async def test_a_leg_with_no_quote_is_reported_not_ignored(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    """A group whose level cannot be computed is unprotected, and reading that
    as "held" makes it indistinguishable from one that is simply fine."""
    book.add_trade(entered("t-call", CALL, "150"))
    book.add_trade(entered("t-put", PUT, "120"))
    square_off = RecordingSquareOff()
    subject = watch(book, alerts, {CALL: "170"}, square_off, instruments)

    report = await subject.on_tick(a_tick(CALL, "170"))

    assert report.unavailable
    assert square_off.requested == []


async def test_a_group_with_a_leg_still_entering_is_not_valued_on_the_rest(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    """A straddle with one side still resting is not a one-legged straddle.
    Valued on the filled leg alone, this group is 27 points against its 150
    entry and the combined stop would fire on half a position."""
    book.add_trade(entered("t-call", CALL, "150"))
    book.add_trade(a_trade("t-put", instrument=PUT, group="DEFAULT", signal_id="sig-2"))
    square_off = RecordingSquareOff()
    subject = watch(book, alerts, {CALL: "200", PUT: "127"}, square_off, instruments)

    report = await subject.on_tick(a_tick(CALL, "200"))

    assert report.unavailable
    assert square_off.requested == []


async def test_a_tick_for_an_instrument_nothing_holds_does_nothing(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    square_off = RecordingSquareOff()
    subject = watch(book, alerts, {CALL: "170"}, square_off, instruments)

    report = await subject.on_tick(a_tick(CALL, "170"))

    assert report.groups_checked == 0
    assert square_off.requested == []


# -- the high and low, which nothing was recording -------------------------


async def test_the_extremes_since_entry_are_recorded(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    """Trailing measures from these, and nothing was updating them: the
    service that does was built into every account and never handed a tick."""
    book.add_trade(entered("t-call", CALL, "150", protection=Protection()))
    square_off = RecordingSquareOff()
    subject = watch(book, alerts, {CALL: "160"}, square_off, instruments)

    await subject.on_tick(a_tick(CALL, "160"))
    await subject.on_tick(a_tick(CALL, "140"))

    seen = book.trade(a_trade("t-call").id)
    assert seen is not None
    assert seen.high_since_entry == rupees("160")
    assert seen.low_since_entry == rupees("140")


async def test_legs_configured_with_different_levels_leave_the_group_unlevelled(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    """A real misconfiguration, and picking a winner would apply a stop nobody
    configured to half the legs."""
    book.add_trade(entered("t-call", CALL, "150"))
    book.add_trade(
        entered("t-put", PUT, "120", protection=Protection(combined_stop_loss_percent=Decimal(25)))
    )
    square_off = RecordingSquareOff()
    subject = watch(book, alerts, {CALL: "170", PUT: "127"}, square_off, instruments)

    report = await subject.on_tick(a_tick(CALL, "170"))

    assert report.unavailable
    assert square_off.requested == []


async def test_a_leg_without_levels_does_not_turn_the_group_off(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    """A hedge added without combined percentages is still part of the group,
    and must not turn its stop off -- which taking the levels from whichever
    leg the book's index yielded first would do on some ticks and not others."""
    book.add_trade(entered("t-call", CALL, "150"))
    book.add_trade(entered("t-put", PUT, "120", protection=Protection()))
    square_off = RecordingSquareOff()
    subject = watch(book, alerts, {CALL: "170", PUT: "127"}, square_off, instruments)

    await subject.on_tick(a_tick(CALL, "170"))

    assert {trade for trade, _ in square_off.requested} == {"t-call", "t-put"}


async def test_a_leg_on_its_way_out_is_not_counted(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    """Its exit is already decided, and counting it would measure a position
    being dismantled."""
    book.add_trade(entered("t-call", CALL, "150"))
    book.add_trade(replace(entered("t-put", PUT, "120"), exiting_for=TradeExitReason.SQUARE_OFF))
    square_off = RecordingSquareOff()
    # 170 against a 150 entry is past a 10% stop on the call alone, and the
    # put's 127 would not be, so what comes out says which legs were counted.
    subject = watch(book, alerts, {CALL: "170", PUT: "127"}, square_off, instruments)

    await subject.on_tick(a_tick(CALL, "170"))

    assert {trade for trade, _ in square_off.requested} == {"t-call"}


# -- what else the tick pass does ------------------------------------------


async def test_a_stop_that_has_earned_a_step_is_trailed(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    """The whole reason this pass exists. A short at 100 with its stop at 110
    has ten points of risk; ten points of profit earns one step, so the stop
    comes down to 100. Nothing was handing the trailing service a tick, so
    this never happened."""
    trailed = replace(
        a_trade("t-call", instrument=CALL, direction=Direction.SHORT),
        protection=Protection(
            stop_loss=rupees("110"),
            initial_stop_loss=rupees("110"),
            is_trailing=True,
            trail=TrailConfig(),
            dont_place_stop_loss_order=True,
        ),
        signal_id="sig-t",
    ).with_entry_fill(75, rupees("100"), TODAY)
    book.add_trade(trailed)
    square_off = RecordingSquareOff()
    subject = watch(book, alerts, {CALL: "90"}, square_off, instruments)

    report = await subject.on_tick(a_tick(CALL, "90"))

    assert report.trailed == 1
    moved = book.trade(trailed.id)
    assert moved is not None
    assert moved.protection.stop_loss == rupees("100")


async def test_a_trade_that_has_finished_is_not_watched(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    """A closed position is not a position. The group it belonged to has no
    legs left, so there is nothing to check."""
    done = entered("t-call", CALL, "150").closed(rupees("170"), TradeExitReason.STOP_LOSS, TODAY)
    book.add_trade(done)
    square_off = RecordingSquareOff()
    subject = watch(book, alerts, {CALL: "170"}, square_off, instruments)

    report = await subject.on_tick(a_tick(CALL, "170"))

    assert report.watched == 0
    assert report.groups_checked == 0
    assert square_off.requested == []


async def test_a_group_whose_legs_have_all_left_is_not_checked(
    book: TradingClientManager, alerts: AlertManager, instruments: InstrumentLookup
) -> None:
    """Every leg is on its way out, so there is nothing left to measure and
    nothing to ask out again."""
    book.add_trade(replace(entered("t-call", CALL, "150"), exiting_for=TradeExitReason.SQUARE_OFF))
    book.add_trade(replace(entered("t-put", PUT, "120"), exiting_for=TradeExitReason.SQUARE_OFF))
    square_off = RecordingSquareOff()
    subject = watch(book, alerts, {CALL: "170", PUT: "127"}, square_off, instruments)

    report = await subject.on_tick(a_tick(CALL, "170"))

    assert report.groups_checked == 0
    assert square_off.requested == []
