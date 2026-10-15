"""Adaptive tranches and re-entry after a stop, the reference's rules."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from garuda.domain.client import TradingClientId
from garuda.domain.enums import Direction, ProductType
from garuda.domain.instrument import InstrumentId
from garuda.domain.money import Currency, Money
from garuda.domain.trade import Trade, TradeId
from garuda.domain.trade_state import TradeExitReason, TradeState
from garuda.engine.adaptive import ReEntry, TrancheResult, next_after, re_entry_for
from garuda.engine.config import ResolvedConfig

NOW = dt.datetime(2026, 10, 15, 11, 0, tzinfo=dt.UTC)


def trade(
    *,
    state: TradeState = TradeState.COMPLETED,
    entry: str = "100",
    exit: str = "140",
    reason: TradeExitReason | None = TradeExitReason.STOP_LOSS,
    direction: Direction = Direction.SHORT,
    tranche: int = 1,
    number: int = 1,
) -> Trade:
    return Trade(
        id=TradeId(f"t{number}"),
        trading_client=TradingClientId("appa"),
        instrument=InstrumentId("NFO:N25000CE"),
        strategy="s",
        direction=direction,
        product=ProductType.MIS,
        quantity=75,
        filled_quantity=75,
        state=state,
        entry=Money(Decimal(entry), Currency.INR),
        exit=Money(Decimal(exit), Currency.INR) if exit else None,
        exit_reason=reason if state is TradeState.COMPLETED else None,
        tranche=tranche,
        started_at=NOW,
        ended_at=NOW if state is TradeState.COMPLETED else None,
    )


def config(**values: object) -> ResolvedConfig:
    return ResolvedConfig("s", values)


class TestTrancheResult:
    def test_not_done_while_any_trade_is_open(self) -> None:
        assert TrancheResult.of(1, [trade(), trade(state=TradeState.ACTIVE, number=2)]) is None

    def test_pnl_sums_and_the_short_leg_names_the_reason(self) -> None:
        result = TrancheResult.of(
            1,
            [
                trade(entry="100", exit="140"),
                trade(
                    direction=Direction.LONG,
                    entry="20",
                    exit="30",
                    reason=TradeExitReason.TARGET,
                    number=2,
                ),
            ],
        )
        assert result is not None
        assert result.pnl == Decimal(-3000 + 750)
        assert result.exit_reason is TradeExitReason.STOP_LOSS


class TestCascade:
    def result(
        self, pnl: str = "-100", reason: TradeExitReason = TradeExitReason.STOP_LOSS
    ) -> TrancheResult:
        return TrancheResult(1, Decimal(pnl), reason)

    def test_the_next_tranche_goes_on(self) -> None:
        cascade = next_after(
            self.result(), config(), losses=1, profits=0, signalled=frozenset({1}), past_stop=False
        )
        assert cascade.next_tranche == 2

    def test_a_manual_exit_stops_the_cascade(self) -> None:
        cascade = next_after(
            self.result(reason=TradeExitReason.MANUAL_EXIT),
            config(),
            losses=0,
            profits=0,
            signalled=frozenset({1}),
            past_stop=False,
        )
        assert cascade.next_tranche is None

    def test_max_tranches_and_the_stop_time(self) -> None:
        capped = next_after(
            self.result(),
            config(max_tranches=1),
            losses=1,
            profits=0,
            signalled=frozenset({1}),
            past_stop=False,
        )
        assert capped.next_tranche is None
        late = next_after(
            self.result(), config(), losses=1, profits=0, signalled=frozenset({1}), past_stop=True
        )
        assert late.next_tranche is None

    def test_the_zero_dte_stop_rules(self) -> None:
        losing = next_after(
            self.result(),
            config(stop_after_loss_tranches=3),
            losses=3,
            profits=0,
            signalled=frozenset({1}),
            past_stop=False,
        )
        assert losing.next_tranche is None
        winning = next_after(
            self.result("100", TradeExitReason.TARGET),
            config(stop_after_profit_tranches=2),
            losses=0,
            profits=2,
            signalled=frozenset({1}),
            past_stop=False,
        )
        assert winning.next_tranche is None


class TestReEntry:
    def test_a_stopped_short_at_a_loss_re_enters_at_its_entry(self) -> None:
        decision = re_entry_for(
            trade(), config(re_entry=True, max_reentries=2), done=0, now=NOW, cutoff=None
        )
        assert isinstance(decision, ReEntry)
        assert decision.trigger == Decimal(100)
        assert decision.attempt == 1

    def test_the_conditions_that_refuse_it(self) -> None:
        assert isinstance(re_entry_for(trade(), config(), done=0, now=NOW, cutoff=None), str)
        on = config(re_entry=True, max_reentries=1, min_reentry_loss_percentage=50)
        assert "under" in str(re_entry_for(trade(), on, done=0, now=NOW, cutoff=None))
        assert "limit" in str(
            re_entry_for(trade(), config(re_entry=True), done=1, now=NOW, cutoff=None)
        )
        target = trade(reason=TradeExitReason.TARGET)
        assert "not a stop" in str(
            re_entry_for(target, config(re_entry=True), done=0, now=NOW, cutoff=None)
        )
        assert "cutoff" in str(
            re_entry_for(trade(), config(re_entry=True), done=0, now=NOW, cutoff=NOW)
        )
