"""When a tranche may go on, and when it has.

A rule set that passes at 13:00:01 passes again at 13:00:02, so this is what
makes an entry happen once. Duplicate detection is the backstop; this is the
mechanism.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from garuda.domain.client import TradingClientId
from garuda.domain.errors import DomainError
from garuda.engine.tranches import (
    Tranche,
    TrancheId,
    TrancheLedger,
    TrancheState,
    cutoff_at,
)

CLIENT = TradingClientId("appa")
TODAY = date(2026, 8, 31)
ONE = datetime(2026, 8, 31, 13, 0, tzinfo=UTC)
LATER = ONE + timedelta(minutes=30)


def identity(tranche: int = 1, day: date = TODAY) -> TrancheId:
    return TrancheId(trading_client=CLIENT, strategy="straddle", tranche=tranche, trading_day=day)


def waiting(cutoff: datetime | None = None) -> Tranche:
    return Tranche(id=identity(), cutoff=cutoff)


# -- the lifecycle ----------------------------------------------------------


def test_a_tranche_starts_waiting() -> None:
    assert waiting().state is TrancheState.WAITING
    assert waiting().is_open


def test_a_tranche_that_fired_is_done() -> None:
    fired = waiting().armed(ONE, ("s1",)).fired(ONE)

    assert fired.state is TrancheState.FIRED
    assert not fired.is_open


def test_a_tranche_that_fired_is_never_entered_again() -> None:
    """The whole reason this exists."""
    fired = waiting().armed(ONE, ("s1",)).fired(ONE)

    with pytest.raises(DomainError, match="cannot go from"):
        fired.armed(LATER, ("s2",))


def test_a_tranche_cannot_fire_without_arming() -> None:
    with pytest.raises(DomainError, match="cannot go from"):
        waiting().fired(ONE)


def test_arming_with_no_signals_would_fire_nothing() -> None:
    with pytest.raises(DomainError, match="fire nothing"):
        waiting().armed(ONE, ())


def test_an_expired_tranche_stays_expired() -> None:
    expired = waiting().expired(ONE)

    with pytest.raises(DomainError, match="cannot go from"):
        expired.armed(LATER, ("s1",))


def test_an_armed_tranche_may_still_expire() -> None:
    """Signals were built and never delivered; the day moved on."""
    armed = waiting().armed(ONE, ("s1",))

    assert armed.expired(LATER).state is TrancheState.EXPIRED


def test_what_was_delivered_is_recorded() -> None:
    armed = waiting().armed(ONE, ("s1", "s2"))

    assert armed.signal_ids == ("s1", "s2")
    assert armed.armed_at == ONE


# -- why it never went on ---------------------------------------------------


def test_what_blocked_it_is_kept() -> None:
    blocked = waiting().blocked("VIX 15.2 is not below 14")

    assert blocked.blocked_by == "VIX 15.2 is not below 14"
    assert blocked.state is TrancheState.WAITING


def test_the_last_thing_that_blocked_it_becomes_the_record() -> None:
    """ "Why did tranche 3 never go on today" is otherwise unanswerable."""
    expired = waiting().blocked("VIX 15.2 is not below 14").expired(LATER)

    assert expired.blocked_by == "VIX 15.2 is not below 14"


def test_a_tranche_that_never_had_a_reason_still_says_something() -> None:
    assert waiting().expired(ONE).blocked_by == "the cutoff passed"


def test_an_explicit_reason_wins() -> None:
    expired = waiting().blocked("waiting for the breakout").expired(ONE, "the session closed")

    assert expired.blocked_by == "the session closed"


def test_arming_clears_what_was_blocking() -> None:
    armed = waiting().blocked("not yet 13:00").armed(ONE, ("s1",))

    assert armed.blocked_by is None


# -- cutoffs ----------------------------------------------------------------


def test_a_tranche_past_its_cutoff_has_expired() -> None:
    assert waiting(cutoff=ONE).has_expired(ONE)
    assert waiting(cutoff=ONE).has_expired(LATER)


def test_a_tranche_before_its_cutoff_has_not() -> None:
    assert not waiting(cutoff=LATER).has_expired(ONE)


def test_a_tranche_with_no_cutoff_never_expires_on_time() -> None:
    assert not waiting().has_expired(LATER)


def test_a_cutoff_is_its_own_time_plus_the_grace() -> None:
    assert cutoff_at(ONE, after=timedelta(minutes=30)) == LATER


def test_the_grace_never_reaches_past_the_close() -> None:
    """A tranche at 15:20 with an hour's grace has twenty minutes, because the
    market does not care about the grace."""
    close = ONE + timedelta(minutes=10)

    assert cutoff_at(ONE, after=timedelta(hours=1), close=close) == close


def test_a_tranche_with_no_time_of_its_own_runs_to_the_close() -> None:
    close = ONE + timedelta(hours=2)

    assert cutoff_at(None, after=timedelta(minutes=30), close=close) == close


# -- the ledger -------------------------------------------------------------


def test_a_tranche_is_created_on_first_sight() -> None:
    ledger = TrancheLedger(TODAY)

    tranche = ledger.open_for(identity())

    assert tranche.state is TrancheState.WAITING
    assert ledger.get(identity()) is tranche


def test_the_same_tranche_is_returned_next_time() -> None:
    """Otherwise every evaluation would start it over."""
    ledger = TrancheLedger(TODAY)
    ledger.record(ledger.open_for(identity()).blocked("not yet"))

    again = ledger.open_for(identity())

    assert again.blocked_by == "not yet"


def test_tranches_of_one_subscription_are_separate() -> None:
    ledger = TrancheLedger(TODAY)
    ledger.record(ledger.open_for(identity(1)).armed(ONE, ("s1",)).fired(ONE))

    second = ledger.open_for(identity(2))

    assert second.is_open


def test_another_day_s_tranche_does_not_belong_here() -> None:
    ledger = TrancheLedger(TODAY)

    with pytest.raises(DomainError, match="is not part of"):
        ledger.open_for(identity(day=date(2026, 9, 1)))


def test_only_open_tranches_are_worth_evaluating() -> None:
    ledger = TrancheLedger(TODAY)
    ledger.record(ledger.open_for(identity(1)).armed(ONE, ("s1",)).fired(ONE))
    ledger.open_for(identity(2))

    assert [tranche.id.tranche for tranche in ledger.open] == [2]


def test_the_cutoff_closes_out_what_is_still_open() -> None:
    ledger = TrancheLedger(TODAY)
    ledger.record(ledger.open_for(identity(1), cutoff=ONE).blocked("no breakout"))
    ledger.open_for(identity(2), cutoff=LATER)

    gone = ledger.expire_due(ONE)

    assert [tranche.id.tranche for tranche in gone] == [1]
    assert gone[0].blocked_by == "no breakout"
    assert [tranche.id.tranche for tranche in ledger.open] == [2]


def test_a_fired_tranche_is_not_expired_afterwards() -> None:
    ledger = TrancheLedger(TODAY)
    ledger.record(ledger.open_for(identity(1), cutoff=ONE).armed(ONE, ("s1",)).fired(ONE))

    assert ledger.expire_due(LATER) == []


# -- surviving a restart ----------------------------------------------------


def test_a_restart_does_not_re_enter_what_already_fired() -> None:
    fired = Tranche(id=identity(), cutoff=LATER).armed(ONE, ("s1",)).fired(ONE)
    ledger = TrancheLedger(TODAY)

    ledger.restore([fired])

    assert not ledger.open_for(identity()).is_open


def test_yesterday_s_ledger_is_not_today_s() -> None:
    stale = Tranche(id=identity(day=date(2026, 8, 28))).armed(ONE, ("s1",)).fired(ONE)
    ledger = TrancheLedger(TODAY)

    restored = ledger.restore([stale])

    assert restored == 0
    assert ledger.open_for(identity()).is_open
