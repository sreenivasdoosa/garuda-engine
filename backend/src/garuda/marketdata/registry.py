"""The instrument registry.

Everything tradable, indexed the ways the engine actually asks for it: by id,
by symbol, and — the one that matters for options — by underlying and expiry,
so a strike can be chosen without scanning a hundred thousand rows.

Rebuilt whole at day-init and swapped in atomically. A registry is never
mutated in place: a strategy resolving a strike halfway through a rebuild would
otherwise see an index missing the expiry it wants.
"""

from __future__ import annotations

from bisect import bisect_left
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from garuda.domain.enums import InstrumentKind, OptionType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import Instrument, InstrumentId


@dataclass(frozen=True)
class InstrumentRegistry:
    """An immutable index over one day's instrument master."""

    by_id: dict[InstrumentId, Instrument] = field(default_factory=dict)
    #: Broker tokens, kept beside instruments rather than on them.
    tokens: dict[InstrumentId, int] = field(default_factory=dict)
    _by_symbol: dict[tuple[str, str], Instrument] = field(default_factory=dict)
    _by_token: dict[int, Instrument] = field(default_factory=dict)
    _options: dict[tuple[InstrumentId, date], list[Instrument]] = field(default_factory=dict)
    _futures: dict[InstrumentId, list[Instrument]] = field(default_factory=dict)
    _expiries: dict[InstrumentId, list[date]] = field(default_factory=dict)

    @classmethod
    def build(
        cls,
        instruments: Iterable[Instrument],
        tokens: dict[InstrumentId, int] | None = None,
    ) -> InstrumentRegistry:
        by_id: dict[InstrumentId, Instrument] = {}
        by_symbol: dict[tuple[str, str], Instrument] = {}
        options: dict[tuple[InstrumentId, date], list[Instrument]] = defaultdict(list)
        futures: dict[InstrumentId, list[Instrument]] = defaultdict(list)
        expiries: dict[InstrumentId, set[date]] = defaultdict(set)

        for instrument in instruments:
            by_id[instrument.id] = instrument
            by_symbol[(instrument.exchange.code, instrument.trading_symbol)] = instrument

            if instrument.underlying is None or instrument.expiry is None:
                continue
            expiries[instrument.underlying].add(instrument.expiry)
            if instrument.kind is InstrumentKind.OPTION:
                options[(instrument.underlying, instrument.expiry)].append(instrument)
            elif instrument.kind is InstrumentKind.FUTURE:
                futures[instrument.underlying].append(instrument)

        for chain in options.values():
            # Sorted once, so strike selection is a binary search rather than a
            # scan on every tick.
            chain.sort(key=lambda i: (i.strike or Decimal(0), i.option_type or ""))
        for series in futures.values():
            series.sort(key=lambda i: i.expiry or date.max)

        resolved = dict(tokens or {})
        return cls(
            by_id=by_id,
            tokens=resolved,
            _by_symbol=by_symbol,
            _by_token={
                token: by_id[instrument_id]
                for instrument_id, token in resolved.items()
                if instrument_id in by_id
            },
            _options=dict(options),
            _futures=dict(futures),
            _expiries={key: sorted(value) for key, value in expiries.items()},
        )

    # -- lookups ------------------------------------------------------------

    def get(self, instrument_id: InstrumentId) -> Instrument | None:
        return self.by_id.get(instrument_id)

    def require(self, instrument_id: InstrumentId) -> Instrument:
        instrument = self.by_id.get(instrument_id)
        if instrument is None:
            raise DomainError(f"{instrument_id} is not in today's instrument master")
        return instrument

    def by_trading_symbol(self, exchange: str, symbol: str) -> Instrument | None:
        """What a broker calls it, on the venue it trades."""
        return self._by_symbol.get((exchange, symbol))

    def token_for(self, instrument_id: InstrumentId) -> int | None:
        return self.tokens.get(instrument_id)

    def by_token(self, token: int) -> Instrument | None:
        """What a broker token stands for. The direction a tick arrives in."""
        return self._by_token.get(token)

    def expiries_for(self, underlying: InstrumentId) -> Sequence[date]:
        """Every expiry with a listed derivative, soonest first."""
        return self._expiries.get(underlying, [])

    def nearest_expiry(self, underlying: InstrumentId, on: date) -> date | None:
        """The first expiry on or after a date — the weekly, usually."""
        expiries = self._expiries.get(underlying, [])
        index = bisect_left(expiries, on)
        return expiries[index] if index < len(expiries) else None

    def option_chain(self, underlying: InstrumentId, expiry: date) -> Sequence[Instrument]:
        return self._options.get((underlying, expiry), [])

    def option_at(
        self,
        underlying: InstrumentId,
        expiry: date,
        strike: Decimal,
        option_type: OptionType,
    ) -> Instrument | None:
        """One specific option. None when that strike is not listed."""
        for instrument in self._options.get((underlying, expiry), []):
            if instrument.strike == strike and instrument.option_type is option_type:
                return instrument
        return None

    def strikes_for(self, underlying: InstrumentId, expiry: date) -> Sequence[Decimal]:
        """The strikes actually listed, which is not the same as the strikes a
        strike gap implies — the far wings often are not there."""
        seen: list[Decimal] = []
        for instrument in self._options.get((underlying, expiry), []):
            if instrument.strike is not None and instrument.strike not in seen:
                seen.append(instrument.strike)
        return sorted(seen)

    def futures_for(self, underlying: InstrumentId) -> Sequence[Instrument]:
        """Listed futures, nearest expiry first."""
        return self._futures.get(underlying, [])

    def near_month_future(self, underlying: InstrumentId, on: date) -> Instrument | None:
        for instrument in self._futures.get(underlying, []):
            if instrument.expiry is not None and instrument.expiry >= on:
                return instrument
        return None

    # -- shape --------------------------------------------------------------

    def __len__(self) -> int:
        return len(self.by_id)

    @property
    def is_empty(self) -> bool:
        return not self.by_id


#: What the engine holds before the first successful load. Deliberately empty
#: rather than absent, so a lookup before day-init fails with "not in today's
#: master" instead of an attribute error somewhere unrelated.
EMPTY_REGISTRY = InstrumentRegistry()
